/**
 * tests/castProto.test.ts —— 手机投图协议纯函数用例（Vitest，Node 环境）。
 * 覆盖 dataUrl 校验/解码/超限拒绝、File 构造与文件名消毒、字节粗算、图 B 默认配色契约。
 */
import { describe, expect, it } from 'vitest';
import {
  dataUrlToBytes,
  dataUrlToFile,
  dataUrlByteSize,
  CAST_MAX_BYTES,
  CAST_B_REDUCE,
} from '@/core/castProto';

/** 3×3 png 的最小合法 dataUrl（内容随意，只要 base64 可解） */
const OK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

describe('dataUrlToBytes', () => {
  it('合法 png dataUrl → 非空字节', () => {
    const bytes = dataUrlToBytes(OK_PNG);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBeGreaterThan(0);
  });
  it('拒绝非图片 / 非 base64 / 缺前缀', () => {
    expect(dataUrlToBytes('data:image/svg+xml;base64,AAA')).toBeNull(); // svg 不在白名单
    expect(dataUrlToBytes('data:text/plain;base64,AAA')).toBeNull();
    expect(dataUrlToBytes('http://evil/x.png')).toBeNull();
    expect(dataUrlToBytes('data:image/png,notbase64')).toBeNull();
    expect(dataUrlToBytes('')).toBeNull();
  });
  it('webp/jpeg/gif 允许', () => {
    for (const m of ['jpeg', 'webp', 'gif']) {
      expect(dataUrlToBytes(`data:image/${m};base64,AAAA`)).not.toBeNull();
    }
  });
});

describe('dataUrlToFile', () => {
  it('构造 File 且 mime/名字正确', () => {
    const f = dataUrlToFile(OK_PNG, 'cat.png', 'image/png');
    expect(f).toBeInstanceOf(File);
    expect(f!.type).toBe('image/png');
    expect(f!.name).toBe('cat.png');
  });
  it('文件名消毒：路径分隔符被替换，空名回退默认', () => {
    const f = dataUrlToFile(OK_PNG, '../../etc/passwd', 'image/png');
    expect(f!.name).not.toContain('/');
    expect(f!.name).not.toContain('..');
    expect(dataUrlToFile(OK_PNG, '', 'image/png')!.name).toBe('手机图片.png');
  });
  it('非法 dataUrl → null', () => {
    expect(dataUrlToFile('nonsense', 'x.png', 'image/png')).toBeNull();
  });
});

describe('dataUrlByteSize', () => {
  it('按 base64 长度 ×3/4 粗算（无逗号退回全长）', () => {
    const size = dataUrlByteSize('data:image/png;base64,AAAAAAAA'); // 8 字符 → 6 字节
    expect(size).toBe(6);
    expect(dataUrlByteSize('abc')).toBe(3);
  });
});

describe('CAST_B_REDUCE（图 B 自动落图默认）', () => {
  it('三增强全开、dither 关、色数 32', () => {
    expect(CAST_B_REDUCE.chromaGate).toBe(true);
    expect(CAST_B_REDUCE.highlightProtect).toBe(true);
    expect(CAST_B_REDUCE.paletteDedup).toBe(true);
    expect(CAST_B_REDUCE.dither).toBe(false);
    expect(CAST_B_REDUCE.colorCount).toBe(32);
  });
});

describe('CAST_MAX_BYTES', () => {
  it('解码字节数超上限即拒（防大文件拖垮落图）', () => {
    // base64 每 4 字符 ≈ 3 字节：造 2 倍上限的 base64 → 解码约 1.5× 字节上限
    const big = 'data:image/png;base64,' + 'A'.repeat(CAST_MAX_BYTES * 2);
    expect(dataUrlToBytes(big)).toBeNull();
  });
});
