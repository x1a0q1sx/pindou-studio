/**
 * tests/pixdouProtocol.test.ts —— 颂拼豆/PIXDOU 帧解析纯函数用例。
 * 帧规则以实机验证为准（2026-09-23，18/18 条 App 实发帧通过）：
 *   [0x54][cmd][len16=payload+2][payload][cks16BE]，total = len16+4，
 *   特例 cmd==0 && len16==5 → total=11。
 */
import { describe, expect, it } from 'vitest';
import {
  assembleProgram, bytesToHex, extractGif, parseChunkPayload, parsePixdou,
  parseProgramHeader, pixdouAck, pixdouChunkAck, pixdouSummary, programDimensions,
} from '@/core/pixdouProtocol';

/** [54 cmd len(=payload+2) payload cks16BE] */
function frame(cmd: number, payload: number[]): string {
  const lf = payload.length + 2;
  const b = [0x54, cmd, (lf >> 8) & 0xff, lf & 0xff, ...payload];
  let s = 0;
  for (const v of b) s = (s + v) & 0xffff;
  return bytesToHex([...b, (s >> 8) & 0xff, s & 0xff]);
}

describe('parsePixdou —— 真实帧样本（App 实发）', () => {
  it('0x0A 开屏（7B）', () => {
    const f = parsePixdou('540a0003000061')!;
    expect(f).toMatchObject({ cmd: 0x0a, payload: '00', ok: true });
  });
  it('0x06 新增临时节目（17B）', () => {
    const f = parsePixdou('5406000dd306d4ba000004310000000303')!;
    expect(f).toMatchObject({ cmd: 0x06, ok: true });
    expect(f.payload).toBe('d306d4ba00000431000000');
  });
  it('0x00 分片（192B，180B 数据）', () => {
    const f = parsePixdou(frame(0x00, [0, 0, 0, 0, 0, 0xb4, ...new Array(180).fill(0xaa)]))!;
    expect(f).toMatchObject({ cmd: 0x00, ok: true });
    expect(f.payload.startsWith('0000000000b4')).toBe(true);
  });
  it('0x01 完成（7B）', () => {
    const f = parsePixdou('54010003010059')!;
    expect(f).toMatchObject({ cmd: 0x01, payload: '01', ok: true });
  });
  it('校验和错误被标记', () => {
    const f = parsePixdou('540a0003000062')!;
    expect(f.ok).toBe(false);
  });
  it('短帧特例：cmd=0 且 len16=5 → total=11（分片应答短帧形式）', () => {
    // 54 00 0005 + 5B 载荷 + 2B 校验和（BE16(Σ帧前 total-2=9 字节)）；若无特例
    // 按 total=len16+4=9 校验长度会直接拒收
    const b = [0x54, 0x00, 0x00, 0x05, 0, 0, 0, 2, 0x01];
    let s = 0;
    for (const v of b) s = (s + v) & 0xffff;
    const hex = bytesToHex([...b, (s >> 8) & 0xff, s & 0xff]);
    expect(hex.length).toBe(22); // 11B
    expect(parsePixdou(hex)).toMatchObject({ cmd: 0, payload: '0000000201', ok: true });
  });
  it('非 0x54 头返回 null', () => {
    expect(parsePixdou('02ff80000102')).toBeNull();
    expect(parsePixdou('a80a000500000000b7')).toBeNull(); // 旧的错误 0xA8 头
  });
});

describe('parsePixdou —— 回码帧（板→App，同构）', () => {
  it('0x06 应答：54 06 00 03 01 00 5e', () => {
    const f = parsePixdou(bytesToHex(pixdouAck(0x06, [0x01])))!;
    expect(f).toMatchObject({ cmd: 0x06, payload: '01', ok: true });
  });
  it('0x00 分片应答：idx=3 → 54 00 00 07 00000003 01 00 5f', () => {
    const hex = bytesToHex(pixdouChunkAck(3));
    expect(hex).toBe('54000007000000030100 5f'.replace(' ', ''));
    const f = parsePixdou(hex)!;
    expect(f).toMatchObject({ cmd: 0x00, payload: '0000000301', ok: true });
  });
  it('0x01 完成应答', () => {
    expect(bytesToHex(pixdouAck(0x01, [0x01]))).toBe('54010003010059');
  });
  it('0x0A 开屏应答', () => {
    expect(bytesToHex(pixdouAck(0x0a, [0x01]))).toBe('540a0003010062');
  });
});

describe('pixdouSummary', () => {
  it('新增节目 0x06（总长 300B）', () => {
    const hex = frame(0x06, [0x11, 0x22, 0x33, 0x44, 0, 0, 0x01, 0x2c, 0, 0, 0]);
    expect(pixdouSummary(hex)).toContain('新增临时节目');
    expect(pixdouSummary(hex)).toContain('总长=300B');
  });
  it('分片 0x00（#6 200B）', () => {
    const payload = [0, 0, 0, 5, 0, 0xc8, 1, 2, 3];
    expect(pixdouSummary(frame(0x00, payload))).toContain('#6 200B');
  });
  it('分片应答（5B payload）识别为应答', () => {
    expect(pixdouSummary(bytesToHex(pixdouChunkAck(2)))).toContain('应答 idx=2');
  });
  it('完成 0x01', () => {
    expect(pixdouSummary(frame(0x01, [1]))).toContain('节目完成');
  });
  it('无法解析的短帧', () => {
    expect(pixdouSummary('540a00')).toContain('无法解析');
  });
});

/* ---------------- 节目组装与 GIF 提取（实测布局） ---------------- */

/** 构造一段真实布局的节目数据：46B 头 + GIF */
function makeProgram(gif: number[], w = 104, h = 104): number[] {
  const head = new Array(46).fill(0);
  head[4] = 1;              // 分区数 = 1
  head[28] = (w >> 8) & 0xff; head[29] = w & 0xff;   // 宽
  head[30] = (h >> 8) & 0xff; head[31] = h & 0xff;   // 高
  head[34] = 6;             // 数据类型 6 = GIF
  return [...head, ...gif];
}
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x68, 0x00, 0x68, 0x00];

describe('节目分片组装', () => {
  it('parseChunkPayload：idx + 长度 + 数据', () => {
    const payload = [...[0, 0, 0, 3], 0, 0xb4, ...new Array(180).fill(0xab)];
    const r = parseChunkPayload(bytesToHex(payload))!;
    expect(r.index).toBe(3);
    expect(r.data.length).toBe(180);
    expect(r.data[0]).toBe(0xab);
  });
  it('parseChunkPayload：clen 大于实载时按实际字节静默截断', () => {
    // 声明 100B（0x0064），实载只有 2B
    const payload = [...[0, 0, 0, 7], 0x00, 0x64, 0xaa, 0xbb];
    const r = parseChunkPayload(bytesToHex(payload))!;
    expect(r.index).toBe(7);
    expect(r.data).toEqual([0xaa, 0xbb]);
  });
  it('parseChunkPayload：载荷不足 6B 返回 null', () => {
    expect(parseChunkPayload('')).toBeNull();
    expect(parseChunkPayload('00000000')).toBeNull();   // 4B（只有 idx）
    expect(parseChunkPayload('0000000000')).toBeNull(); // 5B（clen 缺低字节）
  });
  it('assembleProgram：按序拼接', () => {
    const chunks = new Map<number, number[]>([[1, [3, 4]], [0, [1, 2]]]);
    expect(assembleProgram(chunks)).toEqual([1, 2, 3, 4]);
  });
  it('assembleProgram：缺片返回 null', () => {
    const chunks = new Map<number, number[]>([[0, [1]], [2, [3]]]);
    expect(assembleProgram(chunks)).toBeNull();
  });
  it('assembleProgram：长度不符返回 null', () => {
    const chunks = new Map<number, number[]>([[0, [1, 2]]]);
    expect(assembleProgram(chunks, 5)).toBeNull();
    expect(assembleProgram(chunks, 2)).toEqual([1, 2]);
  });
});

describe('节目解析（GIF + 尺寸）', () => {
  it('extractGif：实测偏移 46', () => {
    const prog = makeProgram(GIF89A);
    const ex = extractGif(prog)!;
    expect(ex.offset).toBe(46);
    expect(ex.gif).toEqual(GIF89A);
  });
  it('extractGif：无 GIF 返回 null', () => {
    expect(extractGif(new Array(60).fill(0))).toBeNull();
  });
  it('programDimensions：实测 104×104 在偏移 28/30', () => {
    expect(programDimensions(makeProgram(GIF89A))).toEqual({ w: 104, h: 104 });
    expect(programDimensions(makeProgram(GIF89A, 52, 52))).toEqual({ w: 52, h: 52 });
    expect(programDimensions(new Array(20).fill(0))).toBeNull();
  });
  it('parseProgramHeader：id + 总长', () => {
    const hdr = parseProgramHeader('d306d4ba00000431000000')!;
    expect(hdr.id).toBe(0xd306d4ba);
    expect(hdr.total).toBe(0x431);
  });
  it('完整链路：0x06 头 → 分片 → 组装 → 提取 GIF', () => {
    const gif = [...GIF89A, ...new Array(100).fill(0x5a)];
    const prog = makeProgram(gif);
    const header = parseProgramHeader(bytesToHex([...new Array(4).fill(0), ...u32(prog.length)]))!;
    expect(header.total).toBe(prog.length);
    const chunks = new Map<number, number[]>();
    for (let i = 0; i * 180 < prog.length; i++) chunks.set(i, prog.slice(i * 180, (i + 1) * 180));
    const assembled = assembleProgram(chunks, header.total)!;
    expect(assembled).toEqual(prog);
    const ex = extractGif(assembled)!;
    expect(ex.gif).toEqual(gif);
    expect(programDimensions(assembled)).toEqual({ w: 104, h: 104 });
  });
});

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
