/**
 * src/imaging/pipeline.ts —— 图片像素化 + 自动配色纯算法核心（编排层）。
 *
 * 【设计铁律】不含任何 DOM / Worker / OffscreenCanvas API，
 * 输入输出全部用普通对象与 typed array，可在 Node / Worker / 主线程无缝执行。
 *
 * 流水线：fitRect → pixelateFromRgba → reduceToPaletteGrid（含量化+匹配+可选抖动）
 *
 * 像素化逻辑已抽取至 ./pixelate.ts，本文件通过 re-export 保持对外 API 签名完全一致。
 */
import type { BeadColor } from '../core/types';
import { medianCut, mergeSimilar, refineWithKMeans, type QuantizedColor } from '../color/quantize';
import { matchManyToPalette, type PaletteMatchEntry } from '../color/match';
import { rgbToHex, rgbToHsl, hslToRgb, rgbToLab, type Rgb } from '../color/convert';
import { deltaE2000 } from '../color/deltaE';
import { isNearWhiteRGB } from './pixelate';

/* ==================== re-export from pixelate.ts ==================== */

export type {
  Rect,
  FitRectResult,
  PixelateSource,
  PreprocessOpts,
  SamplingMethod,
  PixelateOpts,
  PixelateResult,
} from './pixelate';

export { fitRect, pixelateFromRgba } from './pixelate';

/* ==================== 本文件类型 ==================== */

export interface ReduceOpts {
  /** 目标颜色数 K，2–64 */
  colorCount: number;
  /** 是否启用 Floyd-Steinberg 抖动 */
  dither: boolean;
  /** 少量色优化：非空格唯一色 ≤ K 时跳过 Median Cut，精确保留原图色
   *  （像素画 / 线稿 / logo 零量化损失；> K 时自动回退正常量化）。默认开启。 */
  fewColorExact?: boolean;
  /** 去杂色（缺陷 #34）：清理「孤立点」——8 邻域内无任何同色的豆子（抗锯齿/JPEG 噪点
   *  的典型产物），用邻域中出现最多的颜色替换。两轮迭代，邻居不足 4 个不判定。
   *  默认开启。 */
  despeckle?: boolean;
  /** K-means 精修（借鉴 libimagequant/pngquant）：以 Median Cut 结果为种子在
   *  CIE Lab 空间跑几轮 Lloyd 迭代，显著降低整体 ΔE（颜色不准的根治手段）。默认开启。 */
  kmeansRefine?: boolean;
    /** 近似色合并（缺陷 #34）：量化结果先按 ΔE2000 贪心合并感知接近的颜色（按格数加权
     *  求均值），再匹配色板——大幅减少「同一块区域被拆成几种碎杂色」。默认开启，阈值 8。 */
  mergeSimilarColors?: boolean;
  /** 色度门控（黑发变棕根治）：CIE Lab 彩度 C* < 9 的格子（近黑/近白/低饱和灰）
   *  先折算成同亮度中性灰再参与量化——暗部 JPEG 噪点/白平衡带来的微弱暖偏
   *  （黑发 C*≈5–8）不再被放大成棕色号，纯色区域也不再被噪声拆成多个色号。
   *  默认开启。 */
  chromaGate?: boolean;
  /** 高光色保障（瞳孔反光糊掉根治）：量化结果里若没有任何颜色覆盖图中近白高光簇
   *  （K 色全被暗部占掉时 Median Cut 不会为几个白格开簇），把高光簇均值直接追加
   *  进量化结果，保证匹配后必有白色号可落。配合 pixelate 的高光保护采样使用。默认开启。 */
  highlightProtect?: boolean;
  /** 近似色号合并（一片黑多个色号根治）：匹配完成后，两个**已使用**色号若
   *  ΔE2000 < 2.8（低于人眼分辨阈 JND），格数少的并入格数多的。默认开启。 */
  paletteDedup?: boolean;
}

/** 去杂色默认参数：孤立判定 + 迭代轮数 + 「有意细节」保留阈值（ΔE2000） */
const DESPECKLE_MIN_NEIGHBORS = 4;
const DESPECKLE_ITERATIONS = 3;
/** 孤立点与邻域主色的色差超过该值 → 视为有意设计的高对比细节（如眼睛、点缀），保留 */
const DETAIL_KEEP_DELTA_E = 12;

/**
 * 智能去杂色（缺陷 #34 v2）：
 *  - 孤立点（8 邻域无同色）且颜色**接近**邻域主色（ΔE2000 ≤ 12）→ 抗锯齿/JPEG 噪点，并入主色；
 *  - 孤立点但与邻域主色**色差很大** → 有意设计的高对比细节（眼睛、花纹点缀），**保留**。
 * 旧版一刀切清掉所有孤立点，会把单像素细节也洗掉——正是「细节保留不够」的原因之一。
 * 每轮在快照上判定、写入新数组，最多三轮。
 */
function despeckleBeads(
  beads: Uint16Array<ArrayBuffer>,
  cols: number,
  rows: number,
  paletteRgb: Array<[number, number, number]>,
): Uint16Array<ArrayBuffer> {
  // 预计算色板 Lab（孤立点判定用 ΔE2000）
  const paletteLabs = paletteRgb.map((rgb) => rgbToLab(rgb));
  const cur = beads.slice();
  for (let it = 0; it < DESPECKLE_ITERATIONS; it++) {
    const next = cur.slice();
    let changed = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const v = cur[i];
        if (v === 0) continue;
        const counts = new Map<number, number>();
        let neighbors = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
            const nv = cur[rr * cols + cc];
            if (nv === 0) continue;
            neighbors++;
            counts.set(nv, (counts.get(nv) ?? 0) + 1);
          }
        }
        if (neighbors < DESPECKLE_MIN_NEIGHBORS) continue;
        if ((counts.get(v) ?? 0) > 0) continue; // 还有同色邻居 → 不是孤立点
        // 邻域众数色（并列取索引小者，保证确定性）
        let dominant = 0;
        let bestN = 0;
        for (const [k, n] of counts) {
          if (n > bestN || (n === bestN && k < dominant)) {
            dominant = k;
            bestN = n;
          }
        }
        if (dominant <= 0) continue;
        // 细节保留：与主色色差大 → 有意设计，不动
        const cellLab = rgbToLab(paletteRgb[v - 1]);
        if (deltaE2000(cellLab, paletteLabs[dominant - 1]) > DETAIL_KEEP_DELTA_E) continue;
        next[i] = dominant;
        changed++;
      }
    }
    cur.set(next);
    if (changed === 0) break;
  }
  return cur;
}

/* ==================== 色度门控（黑发变棕根治） ==================== */

/** 色度门控默认阈值：CIE Lab 彩度低于该值的格子按中性灰处理（黑发 C*≈5–8） */
export const CHROMA_GATE_C = 9;

/**
 * 色度门控：把 C* < threshold 的格子（近黑/近白/低饱和灰）折算成同亮度（Rec.709）
 * 的中性灰。暗部 JPEG 噪点/白平衡带来的微弱暖偏，在 ΔE2000 亮度主导的暗区里
 * 常以毫厘之差输给深棕色号——门控后黑发只会落到黑/深灰号上；一片纯黑区域的
 * 噪点色也会先塌缩成同一灰阶，合并后只剩一个色号。纯灰 C* = 0，重复门控幂等。
 * 返回新数组（纯函数，不改输入）。
 */
export function applyChromaGate(cells: Uint32Array, threshold: number = CHROMA_GATE_C): Uint32Array {
  const out = cells.slice();
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (v === 0) continue;
    const r = (v >>> 16) & 0xff;
    const g = (v >>> 8) & 0xff;
    const b = v & 0xff;
    const [, cA, cB] = rgbToLab([r, g, b]);
    if (Math.hypot(cA, cB) >= threshold) continue;
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    out[i] = ((y << 16) | (y << 8) | y) >>> 0;
  }
  return out;
}

/* ==================== 近似色号合并（一片黑多个色号根治） ==================== */

/** 近似色号合并阈值：ΔE2000 低于该值 ≈ 人眼难分辨（JND ≈ 2.3，取略宽的 2.8） */
export const PALETTE_JND_DE = 2.8;

/**
 * 匹配后的色号去重：两个**已使用**色号若 ΔE2000 < PALETTE_JND_DE（色板上肉眼难分
 * 的相邻色，如多个近黑号），把格数少的并入格数多的（并列留索引小者，保证确定性），
 * 重复直到不再有可合并对。就地修改 beads。这是「同一片纯色被拆成几种色号」的
 * 最后一道闸——量化阶段的 mergeSimilar 管不到「不同量化色恰好映射到近邻色号」的情形。
 */
function dedupPaletteJND(beads: Uint16Array, paletteColors: BeadColor[]): void {
  const labs = paletteColors.map((c) => rgbToLab(c.rgb));
  const counts = new Map<number, number>();
  for (let i = 0; i < beads.length; i++) {
    const v = beads[i];
    if (v !== 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (;;) {
    const used = Array.from(counts.keys());
    let keep = -1;
    let drop = -1;
    for (let a = 0; a < used.length && keep < 0; a++) {
      for (let b = a + 1; b < used.length; b++) {
        const ia = used[a]!;
        const ib = used[b]!;
        if (deltaE2000(labs[ia - 1], labs[ib - 1]) >= PALETTE_JND_DE) continue;
        const ca = counts.get(ia) ?? 0;
        const cb = counts.get(ib) ?? 0;
        keep = ca > cb ? ia : ca < cb ? ib : Math.min(ia, ib);
        drop = keep === ia ? ib : ia;
        break;
      }
    }
    if (keep < 0) break;
    const total = (counts.get(keep) ?? 0) + (counts.get(drop) ?? 0);
    for (let i = 0; i < beads.length; i++) {
      if (beads[i] === drop) beads[i] = keep;
    }
    counts.set(keep, total);
    counts.delete(drop);
  }
}

/** 高光色保障：量化结果与近白高光簇的最大允许色差（超过则视为「高光被吞」追加簇色） */
const HL_QUANT_DELTA_E = 10;

/* ==================== 鲜艳度增强（缺陷 #39） ==================== */

/** vibrance 增强量：低饱和色提升多、高饱和色几乎不动（保护肤色与已鲜艳色） */
const VIBRANCE_AMOUNT = 0.18;

/**
 * 对量化代表色做 vibrance 提升。区域平均 + 中位数切箱的均值化会系统性压饱和度
 * （红白边缘混成粉、暗部混成灰）——这是「颜色不鲜艳」的主因之一。HSL 的 S 按
 * s×(1+amount×(1-s)) 提升：s=0 的中性色不动（肤色/灰阶安全），s≈0.9 的艳色几乎不变。
 * 仅用于 Median Cut 量化路径；少量色精确路径本就零损失，不做增强。
 */
export function applyVibranceToQuantized(quantized: QuantizedColor[], amount = VIBRANCE_AMOUNT): QuantizedColor[] {
  return quantized.map((qc) => {
    // 注意：convert.ts 的 rgbToHsl/hslToRgb 的 S/L 是 0–100 刻度，先归一到 0–1 参与计算
    const [h, s100, l100] = rgbToHsl(qc.rgb);
    const s = s100 / 100;
    const s2 = Math.min(1, s * (1 + amount * (1 - s)));
    const s100b = s2 * 100;
    if (s100b <= s100 + 1e-6) return qc;
    const rgb = hslToRgb([h, s100b, l100]);
    return { rgb, hex: rgbToHex(rgb[0], rgb[1], rgb[2]), count: qc.count };
  });
}
export interface ColorMappingEntry {
  fromHex: string;
  toColorIndex: number;
  deltaE: number;
}

export interface ReduceResult {
  /** palette 索引+1，0=空格。可直接传给 store.replaceBeads */
  beads: Uint16Array;
  /** 用到的 palette 颜色索引（0-based） */
  usedColorIndices: number[];
  /** 量化后的 K 色（hex + count） */
  quantized: { hex: string; count: number }[];
  /** 最大色差 */
  maxDeltaE: number;
  /** 量化色 → palette 色的映射表 */
  mapping: ColorMappingEntry[];
}

/* ==================== Floyd-Steinberg 抖动 ==================== */

/**
 * Floyd-Steinberg 误差扩散抖动（在 cell 网格上操作）。
 * @param cellFloats  Float32Array(n*3)，每格的 RGB 浮点值（会被就地修改）
 * @param emptyMask   Uint8Array(n)，1=空格不参与抖动
 * @param targets     目标颜色的 RGB（已匹配到 palette 的 K 色）
 * @param cols/rows   网格尺寸
 * @returns 每格的 target 索引（Uint8Array），空格处为 255
 */
export function ditherFloydSteinberg(
  cellFloats: Float32Array,
  emptyMask: Uint8Array,
  targets: Array<[number, number, number]>,
  cols: number,
  rows: number,
  onProgress?: (fraction: number) => void,
): Uint8Array {
  const n = cols * rows;
  const result = new Uint8Array(n).fill(255);
  const targetCount = targets.length;
  if (targetCount === 0) return result;

  // 工作副本（误差扩散会修改像素值）
  const buf = new Float32Array(cellFloats);
  const progressEvery = Math.max(1, Math.ceil(rows / 20));

  for (let row = 0; row < rows; row++) {
    if (onProgress && row % progressEvery === 0) onProgress(row / rows);
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (emptyMask[i] === 1) continue;

      const ri = i * 3;
      // 裁剪当前值
      const cr = Math.min(255, Math.max(0, buf[ri]));
      const cg = Math.min(255, Math.max(0, buf[ri + 1]));
      const cb = Math.min(255, Math.max(0, buf[ri + 2]));

      // 找最近的目标色
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let t = 0; t < targetCount; t++) {
        const dr = cr - targets[t][0];
        const dg = cg - targets[t][1];
        const db = cb - targets[t][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = t;
        }
      }
      result[i] = bestIdx;

      // 误差
      const er = cr - targets[bestIdx][0];
      const eg = cg - targets[bestIdx][1];
      const eb = cb - targets[bestIdx][2];

      // 扩散到邻居（注意边界）
      // 右: 7/16
      if (col + 1 < cols && emptyMask[i + 1] === 0) {
        const ni = (i + 1) * 3;
        buf[ni] += er * 7 / 16;
        buf[ni + 1] += eg * 7 / 16;
        buf[ni + 2] += eb * 7 / 16;
      }
      // 左下: 3/16
      if (row + 1 < rows && col - 1 >= 0 && emptyMask[(row + 1) * cols + col - 1] === 0) {
        const ni = ((row + 1) * cols + col - 1) * 3;
        buf[ni] += er * 3 / 16;
        buf[ni + 1] += eg * 3 / 16;
        buf[ni + 2] += eb * 3 / 16;
      }
      // 下: 5/16
      if (row + 1 < rows && emptyMask[(row + 1) * cols + col] === 0) {
        const ni = ((row + 1) * cols + col) * 3;
        buf[ni] += er * 5 / 16;
        buf[ni + 1] += eg * 5 / 16;
        buf[ni + 2] += eb * 5 / 16;
      }
      // 右下: 1/16
      if (row + 1 < rows && col + 1 < cols && emptyMask[(row + 1) * cols + col + 1] === 0) {
        const ni = ((row + 1) * cols + col + 1) * 3;
        buf[ni] += er * 1 / 16;
        buf[ni + 1] += eg * 1 / 16;
        buf[ni + 2] += eb * 1 / 16;
      }
    }
  }

  return result;
}

/* ==================== reduceToPaletteGrid ==================== */

/**
 * 量化+匹配+可选抖动的唯一入口。必须传入 cols/rows：Floyd–Steinberg 的误差
 * 扩散按行扫描，非方阵网格用 sqrt 推断尺寸会打乱扫描顺序（历史缺陷，已移除该路径）。
 */
export function reduceToPaletteGrid(
  cells: Uint32Array,
  cols: number,
  rows: number,
  paletteColors: BeadColor[],
  opts: ReduceOpts,
  onProgress?: (fraction: number) => void,
): ReduceResult {
  const n = cells.length;
  const beads = new Uint16Array(n);
  const { colorCount, dither } = opts;
  const K = Math.max(2, Math.min(64, colorCount));

  if (paletteColors.length === 0) {
    return { beads, usedColorIndices: [], quantized: [], maxDeltaE: 0, mapping: [] };
  }

  // 0. 色度门控：低彩度格子（近黑/近白/灰，C* < 9）先折算成同亮度中性灰，
  //    后续收集/量化/逐格归属全部使用门控后的 workCells（黑发不再变棕、
  //    纯色区域的噪点色先塌缩成同一灰阶）。灰色彩度为 0，重复门控幂等。
  const workCells = opts.chromaGate !== false ? applyChromaGate(cells) : cells;

  // 1. 收集非空格样本 + 统计唯一色（少量色优化的判定依据，一遍循环顺带完成）
  //    进度段位（0..1）：收集 0–0.08 · 量化 0.08–0.55 · 合并/匹配 0.55–0.70 ·
  //    抖动/最近邻 0.70–0.92 · 去杂色 0.92–1
  const emptyMask = new Uint8Array(n);
  const uniq = new Map<number, number>(); // packed rgb → 格数
  const collectEvery = Math.max(1, Math.ceil(n / 20));
  for (let i = 0; i < n; i++) {
    if (onProgress && i % collectEvery === 0) onProgress((i / n) * 0.08);
    const v = workCells[i];
    if (v === 0) {
      emptyMask[i] = 1;
    } else {
      uniq.set(v, (uniq.get(v) ?? 0) + 1);
    }
  }

  if (uniq.size === 0) {
    return { beads, usedColorIndices: [], quantized: [], maxDeltaE: 0, mapping: [] };
  }

  // 2. 量化。少量色优化：唯一色 ≤ K 时跳过 Median Cut，把原图色**原样**
  //    作为量化结果——像素画/线稿/logo 的颜色零损失，也省掉一次采样与切箱。
  //    超过 K 则走正常 Median Cut。两种产物的下游（匹配/抖动/最近邻）完全一致。
  let quantized: QuantizedColor[];
  /** 是否走了 Median Cut 量化路径（true = 均值化导致饱和度损失，需要 vibrance 补偿） */
  let usedMedianCut = false;
  if (opts.fewColorExact !== false && uniq.size <= K) {
    quantized = [...uniq.entries()]
      .map(([v, count]) => {
        const rgb: [number, number, number] = [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
        return { rgb, hex: rgbToHex(rgb[0], rgb[1], rgb[2]), count };
      })
      .sort((a, b) => b.count - a.count);
  } else {
    const samples: number[][] = [];
    for (let i = 0; i < n; i++) {
      const v = workCells[i];
      if (v !== 0) samples.push([(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, 255]);
    }
    onProgress?.(0.08);
    quantized = medianCut(samples, K);
    usedMedianCut = true;

    // K-means 精修（借鉴 libimagequant/pngquant）：Lab 空间 Lloyd 迭代降低整体 ΔE
    if (opts.kmeansRefine !== false) {
      onProgress?.(0.2);
      quantized = refineWithKMeans(samples, quantized);
    }
  }
  onProgress?.(0.55);

  // 2.4 鲜艳度增强（缺陷 #39）：仅在量化路径生效。区域平均 + 切箱均值化系统性压饱和度，
  //     补偿后匹配到的豆色才接近原图观感。少量色精确路径承诺「原色直通」，不做增强。
  if (usedMedianCut) {
    quantized = applyVibranceToQuantized(quantized);
  }

  // 2.5 近似色合并（缺陷 #34）：感知上接近的量化色先两两合并（ΔE2000 < 8，按格数加权
  //     平均 RGB），再拿合并后的代表色去匹配色板。抗锯齿/JPEG 噪点常把同一块平坦区域
  //     切成 3–4 种肉眼难分的碎色，各配一个不同色号——这正是「杂色多、颜色怪」的主因。
  //     少量色精确路径本身无量化噪声，但 AA 边缘混色同样存在，合并同样适用。
  if (opts.mergeSimilarColors !== false && quantized.length > 1) {
    const merged = mergeSimilar(quantized, 8);
    if (merged.length >= 1) quantized = merged;
  }

  // 2.8 高光色保障：高光保护采样产出的近白格子（瞳孔反光等）如果没被量化保留
  //     （K 色全被暗部占掉时 Median Cut 不会为几个白格开簇），把高光簇均值直接
  //     追加进量化结果，保证匹配后必有白色号可落。
  if (opts.highlightProtect !== false) {
    let hlCells = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      const v = workCells[i];
      if (v === 0) continue;
      const r = (v >>> 16) & 0xff;
      const g = (v >>> 8) & 0xff;
      const b = v & 0xff;
      if (isNearWhiteRGB(r, g, b)) {
        hlCells++;
        sr += r;
        sg += g;
        sb += b;
      }
    }
    if (hlCells > 0) {
      const rgb: Rgb = [Math.round(sr / hlCells), Math.round(sg / hlCells), Math.round(sb / hlCells)];
      const lab = rgbToLab(rgb);
      const covered = quantized.some((qc) => deltaE2000(lab, rgbToLab(qc.rgb)) < HL_QUANT_DELTA_E);
      if (!covered) {
        quantized.push({ rgb, hex: rgbToHex(rgb[0], rgb[1], rgb[2]), count: hlCells });
      }
    }
  }

  // 3. 匹配到 palette
  onProgress?.(0.62);
  const fakePalette = { colors: paletteColors } as Parameters<typeof matchManyToPalette>[1];
  const matchMap = matchManyToPalette(quantized, fakePalette);
  onProgress?.(0.66);

  // 4. 映射表
  const quantizedToPaletteIdx: number[] = [];
  const mapping: ColorMappingEntry[] = [];
  let maxDeltaE = 0;

  for (const qc of quantized) {
    const entry: PaletteMatchEntry | undefined = matchMap.get(qc.hex);
    if (entry) {
      quantizedToPaletteIdx.push(entry.index);
      mapping.push({ fromHex: qc.hex, toColorIndex: entry.index, deltaE: entry.deltaE });
      if (entry.deltaE > maxDeltaE) maxDeltaE = entry.deltaE;
    } else {
      quantizedToPaletteIdx.push(0);
      mapping.push({ fromHex: qc.hex, toColorIndex: 0, deltaE: 0 });
    }
  }

  const targetRGBs: Array<[number, number, number]> = quantized.map((qc) => [qc.rgb[0], qc.rgb[1], qc.rgb[2]]);

  if (dither) {
    // Floyd-Steinberg（正确的 cols×rows 网格）
    const cellFloats = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = workCells[i];
      if (v !== 0) {
        cellFloats[i * 3] = (v >>> 16) & 0xff;
        cellFloats[i * 3 + 1] = (v >>> 8) & 0xff;
        cellFloats[i * 3 + 2] = v & 0xff;
      }
    }
    const ditherResult = ditherFloydSteinberg(
      cellFloats, emptyMask, targetRGBs, cols, rows,
      onProgress ? (f: number) => onProgress(0.7 + f * 0.22) : undefined,
    );
    for (let i = 0; i < n; i++) {
      if (emptyMask[i] === 1) {
        beads[i] = 0;
      } else {
        const qi = ditherResult[i];
        beads[i] = qi < quantizedToPaletteIdx.length ? quantizedToPaletteIdx[qi] + 1 : 1;
      }
    }
  } else {
    // 简单最近邻
    const nnEvery = Math.max(1, Math.ceil(n / 20));
    for (let i = 0; i < n; i++) {
      if (onProgress && i % nnEvery === 0) onProgress(0.7 + (i / n) * 0.22);
      if (emptyMask[i] === 1) { beads[i] = 0; continue; }
      const v = workCells[i];
      const r = (v >>> 16) & 0xff;
      const g = (v >>> 8) & 0xff;
      const b = v & 0xff;
      let bestQ = 0, bestDist = Infinity;
      for (let q = 0; q < targetRGBs.length; q++) {
        const dr = r - targetRGBs[q][0];
        const dg = g - targetRGBs[q][1];
        const db = b - targetRGBs[q][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) { bestDist = dist; bestQ = q; }
      }
      beads[i] = quantizedToPaletteIdx[bestQ] + 1;
    }
  }

  // 5. 近似色号合并：色板上 ΔE2000 < 2.8（肉眼难分）的两个已用色号，格数少的
  //    并入格数多的——「一片黑识别出好几个色号」的最后一道闸。放在去杂色之前，
  //    让去杂色在最终色号集合上判定孤立点。抖动开启时照常执行：ΔE < JND 的
  //    色号间抖动本身不可见，合并不损失观感。
  onProgress?.(0.92);
  if (opts.paletteDedup !== false) dedupPaletteJND(beads, paletteColors);

  // 6. 去杂色（缺陷 #34）：孤立点清理。抖动开启时跳过——Floyd–Steinberg 的孤立点
  //    是有意的混色手段，清掉等于白抖。
  let finalBeads = beads;
  if (opts.despeckle !== false && !dither) {
    finalBeads = despeckleBeads(
      beads,
      cols,
      rows,
      paletteColors.map((c) => c.rgb),
    );
  }
  // usedColorIndices 一律从最终 beads 重算（dedup/去杂都可能移除色号；映射表仅作展示）
  const stillUsed = new Set<number>();
  for (let i = 0; i < finalBeads.length; i++) {
    if (finalBeads[i] !== 0) stillUsed.add(finalBeads[i] - 1);
  }
  const usedIndices = Array.from(stillUsed).sort((a, b) => a - b);
  onProgress?.(1);

  return {
    beads: finalBeads,
    usedColorIndices: usedIndices,
    quantized: quantized.map((qc) => ({ hex: qc.hex, count: qc.count })),
    maxDeltaE,
    mapping,
  };
}

/* ==================== buildPreview ==================== */

export interface PreviewResult {
  /** cols×rows 的 hex 色值矩阵（null=空格） */
  grid: (string | null)[];
  cols: number;
  rows: number;
  colorCount: number;
}

/**
 * 生成小尺寸预览用的色值矩阵（供 ColorReduceDialog 多档对比）。
 * 对指定 colorCount 快速执行量化+匹配，返回每格 hex。
 */
export function buildPreview(
  cells: Uint32Array,
  cols: number,
  rows: number,
  paletteColors: BeadColor[],
  colorCount: number,
  dither: boolean,
  fewColorExact = true,
  extra?: {
    despeckle?: boolean;
    mergeSimilarColors?: boolean;
    chromaGate?: boolean;
    highlightProtect?: boolean;
    paletteDedup?: boolean;
  },
): PreviewResult {
  const result = reduceToPaletteGrid(cells, cols, rows, paletteColors, {
    colorCount,
    dither,
    fewColorExact,
    despeckle: extra?.despeckle,
    mergeSimilarColors: extra?.mergeSimilarColors,
    chromaGate: extra?.chromaGate,
    highlightProtect: extra?.highlightProtect,
    paletteDedup: extra?.paletteDedup,
  });
  const grid: (string | null)[] = new Array(cols * rows);
  for (let i = 0; i < result.beads.length; i++) {
    const v = result.beads[i];
    if (v === 0) {
      grid[i] = null;
    } else {
      const c = paletteColors[v - 1];
      grid[i] = c ? c.hex : null;
    }
  }
  return {
    grid,
    cols,
    rows,
    colorCount: result.usedColorIndices.length,
  };
}
