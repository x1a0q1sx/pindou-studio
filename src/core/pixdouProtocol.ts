/**
 * core/pixdouProtocol.ts —— 颂拼豆（PIXDOU）0x54 帧解析纯函数。
 *
 * 与酷猫开放协议（vbProtocol.ts）并列的第二套协议。**请求与响应同构**：
 *   [0x54][cmd][len16BE = payload + 2][payload…][cks16BE]
 *   total = len16 + 4 ；cks16 = (前 total-2 字节求和) & 0xFFFF（大端存放）
 *   特例：cmd==0 且 len16==5 → total = 11（分片应答的短帧形式）
 *   最短可解析帧：cmd!=0 → 7B；cmd==0 → 11B
 *
 * 依据（2026-09-23 实机联调验证）：
 *   · 帧规则按 App 实发帧逐帧归纳；注意同步字节是 0x54——协议分析时曾误读为 0xA8
 *     （那是解析器内部把 0x54 左移 1 位的标记值），修正后解析全部通过；
 *   · 18/18 条 App 实发帧（0x0A/0x06/0x00×N/0x01）逐帧通过本规则校验；
 *   · 回码匹配规则：`item[1]==cmd` 且结果字节 `item[4]==1`（无 packetId）
 *     或 `item[8]==1`（有 packetId，payload 前 4B 为 u32be 序号）。
 *
 * 本文件只做"看得见"：解析 + 摘要 + 校验，不做状态机。
 */
import { hexToBytes } from './vbProtocol';

export interface PixdouFrame {
  /** 兼容旧字段：恒为 req（本协议请求/响应同构，方向由上下文判断） */
  dir: 'req' | 'resp';
  cmd: number;
  /** payload（不含校验）hex */
  payload: string;
  /** 校验和是否吻合 */
  ok: boolean;
}

/** 解析一帧（单帧输入；不处理粘包——旁路每事件就是一帧） */
export function parsePixdou(hex: string): PixdouFrame | null {
  const b = hexToBytes(hex);
  if (b.length < 7) return null;
  if (b[0] !== 0x54) return null;
  const cmd = b[1]!;
  const len = (b[2]! << 8) | b[3]!;
  if (len < 2) return null;
  // cmd==0 的短帧特例：len==5 → 总长 11；其余一律 total = len + 4
  const total = cmd === 0 && len === 5 ? 11 : len + 4;
  if (b.length !== total) return null;
  let s = 0;
  for (let i = 0; i < total - 2; i++) s += b[i]!;
  const given = (b[total - 2]! << 8) | b[total - 1]!;
  const payload = hexBytes(b.slice(4, total - 2));
  return { dir: 'req', cmd, payload, ok: (s & 0xffff) === given };
}

/** 帧 → 一行人类可读摘要（日志用） */
export function pixdouSummary(hex: string): string {
  const f = parsePixdou(hex);
  if (!f) return `PIXDOU 无法解析（${hex.length / 2}B）`;
  const tag = '←';
  const bad = f.ok ? '' : ' ⚠校验';
  switch (f.cmd) {
    case 0x01: return `${tag} 节目完成 ${f.payload}${bad}`;
    case 0x06: return `${tag} 新增临时节目 ${fmtProgram(f.payload)}${bad}`;
    case 0x00: return `${tag} 节目分片 ${fmtChunk(f.payload)}${bad}`;
    case 0x09: return `${tag} 板信息/节目查询 [${f.payload}]${bad}`;
    case 0x0a: return `${tag} 屏幕/状态 ${f.payload}${bad}`;
    default: return `${tag} cmd=0x${f.cmd.toString(16).padStart(2, '0')} [${f.payload}]${bad}`;
  }
}

/** 板→App 的标准回码帧（App 匹配器要求结果字节=1） */
export function pixdouAck(cmd: number, payload: number[]): number[] {
  const len = payload.length + 2;
  const b = [0x54, cmd, (len >> 8) & 0xff, len & 0xff, ...payload];
  let s = 0;
  for (const v of b) s = (s + v) & 0xffff;
  return [...b, (s >> 8) & 0xff, s & 0xff];
}

/** 分片应答：payload = u32be(idx) + [0x01] */
export function pixdouChunkAck(index: number): number[] {
  return pixdouAck(0x00, [(index >>> 24) & 0xff, (index >>> 16) & 0xff, (index >>> 8) & 0xff, index & 0xff, 0x01]);
}

/** 字节数组 → hex */
export function bytesToHex(b: number[]): string {
  return b.map((v) => (v & 0xff).toString(16).padStart(2, '0')).join('');
}

/** 节目分片缓存：index → 数据字节 */
export type PixdouChunks = Map<number, number[]>;

/** 分片载荷解析结果：{ index, data }（0x00 请求帧） */
export function parseChunkPayload(payloadHex: string): { index: number; data: number[] } | null {
  const b = hexToBytes(payloadHex);
  if (b.length < 6) return null;
  const index = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const clen = (b[4]! << 8) | b[5]!;
  const data = b.slice(6, 6 + clen);
  return { index, data };
}

/** 拼接全部已收分片（按 index 升序）；缺片返回 null */
export function assembleProgram(chunks: PixdouChunks, expectedLen?: number): number[] | null {
  if (chunks.size === 0) return null;
  const keys = [...chunks.keys()].sort((a, b) => a - b);
  for (let i = 0; i < keys.length; i++) if (keys[i] !== i) return null; // 缺片
  const out: number[] = [];
  for (const k of keys) out.push(...chunks.get(k)!);
  if (expectedLen !== undefined && out.length !== expectedLen) return null;
  return out;
}

/**
 * 从节目数据中取出内嵌 GIF。
 * 节目布局（vendor JS convert()）：u32be(crc32c) + [1,0,0,0] + 4×u32be(0) +
 * 分区头(u16be×2 + u16be 宽 + u16be 高 + 保留3 + 类型1 + …) + GIF 原始字节。
 * GIF 实测从偏移 46 开始；这里用魔数扫描（兼容其他保留区长度）。
 */
export function extractGif(program: number[]): { gif: number[]; offset: number } | null {
  const magic = [0x47, 0x49, 0x46, 0x38]; // "GIF8"
  for (let i = 0; i + 5 < program.length; i++) {
    if (program[i] !== magic[0] || program[i + 1] !== magic[1]
      || program[i + 2] !== magic[2] || program[i + 3] !== magic[3]) continue;
    const v = program[i + 4]! * 256 + program[i + 5]!; // "7a"/"9a"
    if (v !== 0x3761 && v !== 0x3961) continue;
    return { gif: program.slice(i), offset: i };
  }
  return null;
}

/**
 * 节目分区头里的点阵尺寸（实测布局）。
 * programData = u32be(crc32c) + [1,0,0,0] + 4×u32be(0) + partition…
 * partition   = u16be(x0) + u16be(y0) + **u16be(宽) + u16be(高)** + 000 + 06 + …
 * → 宽度在偏移 28、高度在偏移 30（实测帧样本 0068 0068 = 104×104）。
 */
export function programDimensions(program: number[]): { w: number; h: number } | null {
  if (program.length < 32) return null;
  const w = (program[28]! << 8) | program[29]!;
  const h = (program[30]! << 8) | program[31]!;
  return w > 0 && h > 0 ? { w, h } : null;
}

/** 0x06 新增节目载荷 → { id, total } */
export function parseProgramHeader(payloadHex: string): { id: number; total: number } | null {
  const b = hexToBytes(payloadHex);
  if (b.length < 8) return null;
  return { id: ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0, total: ((b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!) >>> 0 };
}

function fmtProgram(payload: string): string {
  const b = hexToBytes(payload);
  if (b.length < 8) return payload ? `[${payload}]` : '';
  const id = u32be(b, 0);
  const total = u32be(b, 4);
  return `id=${id >>> 0} 总长=${total}B`;
}

function fmtChunk(payload: string): string {
  const b = hexToBytes(payload);
  if (b.length < 4) return payload ? `[${payload}]` : '';
  const idx = u32be(b, 0);
  // 回码短帧（5B payload）：u32 idx + 状态
  if (b.length === 5) return `应答 idx=${idx} 状态=${b[4] ?? '-'}`;
  if (b.length < 6) return `[${payload}]`;
  const clen = (b[4]! << 8) | b[5]!;
  return `#${idx + 1} ${clen}B（实载 ${Math.max(0, b.length - 6)}B）`;
}

function u32be(b: number[], at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) | 0;
}

function hexBytes(b: number[]): string {
  return b.map((v) => v.toString(16).padStart(2, '0')).join('');
}
