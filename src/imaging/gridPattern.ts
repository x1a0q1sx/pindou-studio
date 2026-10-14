/**
 * src/imaging/gridPattern.ts —— 色号图纸模式：把「每格印着色号文字的图纸页」按网格
 * 逐格采样成 cells（与 pixelateFromRgba 输出同构，可直接喂 reduceToPaletteGrid）。
 *
 * 思路：这类图每个格子 = 底色填充 + 中央深色色号文字 + 细网格线。对照片式的
 * 「平均采样」会被文字像素污染；这里改为**逐格众数色**：
 *   1. 每格只取中央窗口（默认 14%–86%，避开格线与边缘锯齿）；
 *   2. 像素按 RGB 各 4bit 量化进直方图，取众数桶；
 *   3. 众数桶内像素求均值 → 该格颜色。
 * 文字笔画在格子中央窗口里永远是少数派 → 众数即底色；纯黑格子文字与底色同色，天然正确。
 * 全透明格输出 0（空格），与 cells 契约一致。
 */
import type { RgbaData } from '@/imaging/loader';

export interface GridSampleResult {
  /** 打包格式 (r<<16)|(g<<8)|b，0=空格；长度 cols*rows */
  cells: Uint32Array;
  cols: number;
  rows: number;
}

export interface GridSampleOpts {
  /** 中央采样窗口起点比例（0–0.5，默认 0.14） */
  insetStart?: number;
  /** 中央采样窗口终点比例（0.5–1，默认 0.86） */
  insetEnd?: number;
}

/** 众数桶：RGB 各 4bit 量化 → 12bit 桶索引 */
const BUCKET_BITS = 4;
const BUCKET_COUNT = 1 << (BUCKET_BITS * 3);

export function sampleGridCells(src: RgbaData, cols: number, rows: number, opts: GridSampleOpts = {}): GridSampleResult {
  const W = Math.max(1, Math.floor(cols));
  const H = Math.max(1, Math.floor(rows));
  const cells = new Uint32Array(W * H);
  const sw = src.width, sh = src.height;
  if (sw <= 0 || sh <= 0 || sw * sh !== src.data.length / 4) return { cells, cols: W, rows: H };

  const insetStart = Math.min(0.5, Math.max(0, opts.insetStart ?? 0.14));
  const insetEnd = Math.max(insetStart + 0.01, Math.min(1, opts.insetEnd ?? 0.86));
  const cellW = sw / W;
  const cellH = sh / H;

  const hist = new Uint32Array(BUCKET_COUNT);
  const sumR = new Float64Array(BUCKET_COUNT);
  const sumG = new Float64Array(BUCKET_COUNT);
  const sumB = new Float64Array(BUCKET_COUNT);

  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const x0 = Math.max(0, Math.floor(gx * cellW + cellW * insetStart));
      let x1 = Math.min(sw, Math.ceil(gx * cellW + cellW * insetEnd));
      const y0 = Math.max(0, Math.floor(gy * cellH + cellH * insetStart));
      let y1 = Math.min(sh, Math.ceil(gy * cellH + cellH * insetEnd));
      if (x1 <= x0) x1 = Math.min(sw, x0 + 1); // 极窄格兜底，保证至少 1px 采样窗
      if (y1 <= y0) y1 = Math.min(sh, y0 + 1);

      hist.fill(0); sumR.fill(0); sumG.fill(0); sumB.fill(0);
      let counted = 0;
      for (let y = y0; y < y1; y++) {
        let p = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) {
          const a = src.data[p + 3];
          if (a < 128) continue; // 透明像素不参与
          const r = src.data[p], g = src.data[p + 1], b = src.data[p + 2];
          const bucket = ((r >> (8 - BUCKET_BITS)) << (BUCKET_BITS * 2))
            | ((g >> (8 - BUCKET_BITS)) << BUCKET_BITS)
            | (b >> (8 - BUCKET_BITS));
          hist[bucket]++;
          sumR[bucket] += r; sumG[bucket] += g; sumB[bucket] += b;
          counted++;
        }
      }
      if (counted === 0) { cells[gy * W + gx] = 0; continue; }

      let best = 0, bestN = 0;
      for (let b = 0; b < BUCKET_COUNT; b++) {
        if (hist[b] > bestN) { bestN = hist[b]; best = b; }
      }
      const r = Math.round(sumR[best] / bestN);
      const g = Math.round(sumG[best] / bestN);
      const b = Math.round(sumB[best] / bestN);
      cells[gy * W + gx] = ((r << 16) | (g << 8) | b) >>> 0;
    }
  }
  return { cells, cols: W, rows: H };
}
