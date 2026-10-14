/**
 * tests/reduce-quality.test.ts —— 配色质量三大增强的回归用例（Vitest）。
 * 覆盖：色度门控（黑发不变棕）、高光保护（瞳孔反光保留）、近似色号合并（一片黑一个色号）。
 * 全部用合成数据，不依赖真实图片与色板。
 */
import { describe, expect, it } from 'vitest';
import { applyChromaGate, reduceToPaletteGrid, type ReduceOpts } from '@/imaging/pipeline';
import { isNearWhiteRGB, pixelateFromRgba, type PixelateSource } from '@/imaging/pixelate';
import { rgbToLab } from '@/color/convert';
import { deltaE2000 } from '@/color/deltaE';
import type { BeadColor } from '@/core/types';

function bead(id: string, code: string, rgb: [number, number, number]): BeadColor {
  return { id, code, name: code, hex: '', rgb, lab: rgbToLab(rgb), builtin: true, series: 'T' };
}

/** 测试色板：两个肉眼难分的近黑号（ΔE<2.8）、深棕、中性灰、纯白、正红 */
const PALETTE: BeadColor[] = [
  bead('blk', 'B20', [20, 20, 20]),
  bead('blk2', 'B24', [24, 24, 24]),
  bead('brown', 'BR', [58, 36, 24]),
  bead('gray', 'G96', [96, 96, 96]),
  bead('white', 'W250', [250, 250, 250]),
  bead('red', 'R', [204, 34, 34]),
];

const BASE_OPTS: ReduceOpts = {
  colorCount: 32,
  dither: false,
  fewColorExact: true,
  despeckle: false,
  mergeSimilarColors: false,
  kmeansRefine: false,
  chromaGate: false,
  highlightProtect: false,
  paletteDedup: false,
};

/** packed rgb → Uint32 */
const px = (r: number, g: number, b: number): number => ((r << 16) | (g << 8) | b) >>> 0;

describe('isNearWhiteRGB（高光判定）', () => {
  it('纯白/纸白/微暖白命中，彩色与暗色不命中', () => {
    expect(isNearWhiteRGB(255, 255, 255)).toBe(true);
    expect(isNearWhiteRGB(240, 240, 240)).toBe(true);
    expect(isNearWhiteRGB(255, 246, 232)).toBe(true); // 微暖 catchlight
    expect(isNearWhiteRGB(220, 220, 220)).toBe(false); // 亮度不足
    expect(isNearWhiteRGB(255, 200, 120)).toBe(false); // 彩色高光
  });
});

describe('applyChromaGate（色度门控）', () => {
  it('暖黑折算成同亮度中性灰，鲜艳色与纯灰不动，幂等', () => {
    const cells = Uint32Array.from([
      px(34, 23, 18), // #221712 暖黑（黑发典型值）
      px(204, 34, 34), // 正红
      px(100, 100, 100), // 纯灰
      0, // 空格
    ]);
    const out = applyChromaGate(cells);
    expect(out).not.toBe(cells); // 纯函数：返回新数组
    // 暖黑 → r===g===b
    const y = out[0];
    expect((y >>> 16) & 0xff).toBe((y >>> 8) & 0xff);
    expect((y >>> 8) & 0xff).toBe(y & 0xff);
    // 鲜艳色与纯灰保持不变
    expect(out[1]).toBe(px(204, 34, 34));
    expect(out[2]).toBe(px(100, 100, 100));
    expect(out[3]).toBe(0);
    // 幂等
    expect(applyChromaGate(out)).toEqual(out);
  });

  it('端到端：暖黑发区 + 门控 → 全部落到黑系色号，深棕不被选用', () => {
    // 12×12 板：100 格暖黑变体（C*≈5–8 的 JPEG 噪声暖偏）+ 44 格正红
    const cells = new Uint32Array(144);
    for (let i = 0; i < 144; i++) {
      const warm = [
        [34, 23, 18],
        [25, 20, 18],
        [29, 22, 17],
        [22, 18, 15],
      ][i % 4];
      cells[i] = i < 100 ? px(warm[0], warm[1], warm[2]) : px(204, 34, 34);
    }
    const r = reduceToPaletteGrid(cells, 12, 12, PALETTE, { ...BASE_OPTS, chromaGate: true, paletteDedup: true });
    const used = r.usedColorIndices.map((i) => PALETTE[i].id);
    expect(used).not.toContain('brown');
    // 黑区全部同一种色号（噪点被门控塌缩 + 近似色号合并）
    const blackRegion = new Set<number>();
    for (let i = 0; i < 100; i++) blackRegion.add(r.beads[i]);
    expect(blackRegion.size).toBe(1);
    expect(PALETTE[[...blackRegion][0]! - 1].id).toMatch(/^blk/);
  });
});

describe('paletteDedup（近似色号合并）', () => {
  it('两个量化色映射到 ΔE<2.8 的近黑色号时合并为一个；关闭则保留两个', () => {
    // 前置：色板上两个近黑号确实低于 JND
    const de = deltaE2000(rgbToLab([20, 20, 20]), rgbToLab([24, 24, 24]));
    expect(de).toBeLessThan(2.8);

    // 8×8：32 格近黑 + 32 格 #2a2a2a（两者 ΔE>8，不会被 mergeSimilar 预合并）。
    // 注意不能用纯黑 (0,0,0)——packed 0 是「空格」契约值。
    const cells = new Uint32Array(64);
    for (let i = 0; i < 64; i++) cells[i] = i < 32 ? px(5, 5, 5) : px(42, 42, 42);

    const on = reduceToPaletteGrid(cells, 8, 8, PALETTE, { ...BASE_OPTS, paletteDedup: true });
    expect(on.usedColorIndices.length).toBe(1);
    // 并列格数 → 保留索引小者（blk）
    expect(PALETTE[on.usedColorIndices[0]!].id).toBe('blk');
    for (let i = 0; i < 64; i++) expect(on.beads[i]).toBe(on.usedColorIndices[0]! + 1);

    const off = reduceToPaletteGrid(cells, 8, 8, PALETTE, { ...BASE_OPTS, paletteDedup: false });
    expect(off.usedColorIndices.length).toBe(2);
  });
});

describe('highlightProtect（高光保护采样）', () => {
  /** 8×8 源图 → 4×4 格：每格 2×2 像素 = 1 白 + 3 暗（白占比 25% ≥ 阈值 6%） */
  function eyeSource(): PixelateSource {
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const white = x % 2 === 0 && y % 2 === 0; // 每格左上角像素为白
        const i = (y * 8 + x) * 4;
        const v = white ? 255 : 16;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return { data, width: 8, height: 8 };
  }

  const pixOpts = (highlightProtect: boolean) => ({
    cols: 4,
    rows: 4,
    sampling: 'area-average' as const,
    preprocess: { brightness: 0, contrast: 0, saturation: 0 },
    transparentAsEmpty: true,
    samplingCap: 60000,
    highlightProtect,
  });

  it('开启：近白占比达标的格子用高光簇均值（→白）；关闭：被均值成暗糊色', () => {
    const on = pixelateFromRgba(eyeSource(), pixOpts(true));
    expect(on.cells[0]).toBe(px(255, 255, 255));
    const off = pixelateFromRgba(eyeSource(), pixOpts(false));
    // 无保护时 1 白 + 3 暗在线性光平均后约 138（远达不到白）
    expect((off.cells[0] >>> 16) & 0xff).toBeLessThan(200);
  });

  it('端到端：K 色被暗部占满时白色高光簇仍被强制保留', () => {
    // 8×8 板：40 格近黑 + 20 格中灰 + 4 格纯白（2×2 眼部高光）+ 4 格留空
    const cells = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      if (i >= 60) { cells[i] = 0; continue; }
      if (i >= 56) { cells[i] = px(250, 250, 250); continue; }
      cells[i] = i % 3 === 0 ? px(96, 96, 96) : px(5, 5, 5);
    }
    // 白色块放在 56–59（连成 2×2 一半）：手工摆成连续 2×2
    cells.fill(0, 56);
    cells[34] = px(250, 250, 250);
    cells[35] = px(250, 250, 250);
    cells[42] = px(250, 250, 250);
    cells[43] = px(250, 250, 250);

    const opts = { ...BASE_OPTS, colorCount: 2, fewColorExact: false, despeckle: true };
    const on = reduceToPaletteGrid(cells, 8, 8, PALETTE, { ...opts, highlightProtect: true });
    const usedOn = on.usedColorIndices.map((i) => PALETTE[i].id);
    expect(usedOn).toContain('white');
    // 眼部高光格就是白色号
    expect(on.beads[34]).toBe(PALETTE.findIndex((c) => c.id === 'white') + 1);

    const off = reduceToPaletteGrid(cells, 8, 8, PALETTE, { ...opts, highlightProtect: false });
    expect(off.usedColorIndices.map((i) => PALETTE[i].id)).not.toContain('white');
  });
});
