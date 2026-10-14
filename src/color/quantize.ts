/**
 * color/quantize.ts —— 手写 Median Cut 颜色量化（纯函数，零依赖）。
 *
 * 算法（Heckbert 1982, "Color Image Quantization for Frame Buffer Display"）：
 * 1. 所有样本像素放入一个 RGB 立方体盒子；
 * 2. 取盒内在**最长轴**（跨度最大的分量）上排序，以**中位数**切成两个盒；
 * 3. 递归切分到 k 个盒（最大盒优先）；
 * 4. 每盒按**像素数量加权**求平均色（成员即权重 1 的样本，等价于按数量加权）。
 *
 * 性能实现：像素打包为 Uint32（r<<16|g<<8|b），盒子 = 工作数组上的连续区间；
 * 中位数用 quickselect（Hoare 分区，O(n)）而非全排序，总体 O(n log k)，
 * 全程零对象分配（60k 像素 × 24 色实测毫秒级）。
 *
 * * 采样上限：像素化阶段（imaging/pixelate.ts）对超过上限的图像按比例跳采样。
 * 忽略全透明像素（alpha < 8）。
 */
import { labToRgb, rgbToHex, rgbToLab, type Lab, type Rgb } from './convert';
import { deltaE2000 } from './deltaE';

export interface QuantizedColor {
  rgb: Rgb;
  hex: string;
  count: number;
}

/** medianCut 输入样本：ImageData 的 RGBA 字节数组，或 [[r,g,b](,a)] 列表 */
export type SampleSource = Uint8ClampedArray | number[][];

/**
 * quickselect：把 a[lo..hi) 重排，使 a[k] 为第 k 小（升序语义），
 * 左侧全部 ≤ a[k]，右侧全部 ≥ a[k]。三路分区（Dutch National Flag），
 * 均摊 O(n)，重复值多时更快且保证区间严格收缩。
 */
function quickselect(a: Uint32Array, lo: number, hi: number, k: number, shift: number): void {
  while (hi - lo > 1) {
    const pivot = (a[(lo + hi) >> 1] >>> shift) & 0xff;
    let lt = lo;
    let gt = hi - 1;
    let i = lo;
    while (i <= gt) {
      const v = (a[i] >>> shift) & 0xff;
      if (v < pivot) {
        const t = a[i]; a[i] = a[lt]; a[lt] = t; lt++; i++;
      } else if (v > pivot) {
        const t = a[i]; a[i] = a[gt]; a[gt] = t; gt--;
      } else {
        i++;
      }
    }
    // 此时 [lo,lt) < pivot，[lt,gt] == pivot，(gt,hi) > pivot
    if (k < lt) hi = lt;
    else if (k > gt) lo = gt + 1;
    else return; // k 落在等于 pivot 的区间，已就位
  }
}

/**
 * Median Cut：把样本量化为 k 个代表色，按 count 降序输出。
 * k ≤ 0 或空样本返回 []；样本不足 k 时返回实际盒数（全同色时提前收敛）。
 */
export function medianCut(samples: SampleSource, k: number): QuantizedColor[] {
  const ids = packSamples(samples);
  const n = ids.length;
  if (n === 0 || k <= 0) return [];

  // 盒子 = ids 上的连续区间 [start, start+len)
  const boxes: { start: number; len: number }[] = [{ start: 0, len: n }];

  while (boxes.length < k) {
    // 选成员最多的盒
    let bi = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].len >= 2 && (bi === -1 || boxes[i].len > boxes[bi].len)) bi = i;
    }
    if (bi === -1) break;
    const { start, len } = boxes[bi];

    // 扫描成员求三轴范围 → 选最长轴
    let rLo = 255, rHi = 0, gLo = 255, gHi = 0, bLo = 255, bHi = 0;
    for (let i = start; i < start + len; i++) {
      const p = ids[i];
      const r = (p >>> 16) & 0xff, g = (p >>> 8) & 0xff, b = p & 0xff;
      if (r < rLo) rLo = r;
      if (r > rHi) rHi = r;
      if (g < gLo) gLo = g;
      if (g > gHi) gHi = g;
      if (b < bLo) bLo = b;
      if (b > bHi) bHi = b;
    }
    const dr = rHi - rLo, dg = gHi - gLo, db = bHi - bLo;
    const axis = dr >= dg && dr >= db ? 0 : dg >= db ? 1 : 2;
    if ((axis === 0 ? dr : axis === 1 ? dg : db) === 0) break; // 盒内单色，无法再切
    const shift = (2 - axis) * 8;

    // 中位数分区：a[mid] 为第 mid 小，左侧 ≤ 它
    const mid = start + (len >> 1);
    quickselect(ids, start, start + len, mid, shift);
    const medVal = (ids[mid] >>> shift) & 0xff;

    // 首选「通道值 < medVal」为左盒（把等值像素留在同一盒）。
    // 但重复色样本下（像素图/色块图极常见），medVal 可能恰为盒内最小值 →
    // 左盒为空；或恰为最大值 → 右盒为空。空盒会污染输出（count=0、均值 NaN
    // 经 rgbToHex 兜底成假 #000000）。此时回退到「中位数位置」切分：
    // len ≥ 2 时 mid 严格落在 (start, start+len)，两半必非空。
    let split = start;
    while (split < start + len && ((ids[split] >>> shift) & 0xff) < medVal) split++;
    if (split <= start || split >= start + len) split = mid;

    boxes.splice(bi, 1, { start, len: split - start }, { start: split, len: start + len - split });
  }

  // 每盒按像素数量加权求平均色
  const out: QuantizedColor[] = boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (let i = box.start; i < box.start + box.len; i++) {
      r += (ids[i] >>> 16) & 0xff;
      g += (ids[i] >>> 8) & 0xff;
      b += ids[i] & 0xff;
    }
    const rgb: Rgb = [
      Math.round(r / box.len),
      Math.round(g / box.len),
      Math.round(b / box.len),
    ];
    return { rgb, hex: rgbToHex(rgb[0], rgb[1], rgb[2]), count: box.len };
  });
  return out.sort((a, b) => b.count - a.count);
}

/** 把 RGBA 字节数组或数字列表打包为 Uint32 像素数组（忽略 alpha < 8 的全透明像素） */
function packSamples(samples: SampleSource): Uint32Array {
  if (samples instanceof Uint8ClampedArray) {
    const total = Math.floor(samples.length / 4);
    const out = new Uint32Array(total);
    let m = 0;
    for (let i = 0; i < total; i++) {
      if (samples[i * 4 + 3] < 8) continue;
      out[m++] = (samples[i * 4] << 16) | (samples[i * 4 + 1] << 8) | samples[i * 4 + 2];
    }
    return m === total ? out : out.slice(0, m);
  }
  const out = new Uint32Array(samples.length);
  let m = 0;
  for (const s of samples) {
    if (s.length >= 4 && s[3] < 8) continue;
    out[m++] = (((s[0] & 0xff) << 16) | ((s[1] & 0xff) << 8) | (s[2] & 0xff)) >>> 0;
  }
  return m === samples.length ? out : out.slice(0, m);
}

export function mergeSimilar(colors: QuantizedColor[], maxDeltaE: number): QuantizedColor[] {
  const labs = colors.map((c) => rgbToLab(c.rgb));
  const out: QuantizedColor[] = [];
  const outLabs: Lab[] = [];
  for (let i = 0; i < colors.length; i++) {
    let merged = false;
    for (let j = 0; j < out.length; j++) {
      if (deltaE2000(labs[i], outLabs[j]) < maxDeltaE) {
        const total = out[j].count + colors[i].count;
        const rgb: Rgb = [
          Math.round((out[j].rgb[0] * out[j].count + colors[i].rgb[0] * colors[i].count) / total),
          Math.round((out[j].rgb[1] * out[j].count + colors[i].rgb[1] * colors[i].count) / total),
          Math.round((out[j].rgb[2] * out[j].count + colors[i].rgb[2] * colors[i].count) / total),
        ];
        out[j] = { rgb, hex: rgbToHex(rgb[0], rgb[1], rgb[2]), count: total };
        outLabs[j] = rgbToLab(rgb);
        merged = true;
        break;
      }
    }
    if (!merged) {
      out.push(colors[i]);
      outLabs.push(labs[i]);
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/* ==================== K-means 精修（借鉴 libimagequant / pngquant） ==================== */

/** K-means 精修参数（全部有默认值，一般不传） */
export interface KMeansOptions {
  /** 最大迭代轮数（libimagequant 量级：个位数轮即可显著降 ΔE） */
  iterations?: number;
  /** 参与 K-means 的样本上限（等距子采样；性能保险丝） */
  maxSamples?: number;
  /** 收敛阈值：所有重心的平均 Lab 位移小于该值时提前结束 */
  epsilon?: number;
}

/**
 * K-means（Lloyd）精修：以 Median Cut 的结果为初始种子，在 **CIE Lab 空间**做
 * 「归属 → 重心」迭代。纯中位切分的代表色是一次性均值（贪心切分的次优解），
 * 这是 pngquant/libimagequant 输出质量明显更好的代表原因——几轮精修即可显著降低
 * 整体 ΔE（颜色不准、发灰的根源之一）。距离用 Lab 欧氏（K-means 归属用不着 ΔE2000）。
 * 空簇保留原重心（色板大小稳定，下游匹配/映射不变）。
 */

export function refineWithKMeans(
  samples: number[][],
  initial: QuantizedColor[],
  opts: KMeansOptions = {},
): QuantizedColor[] {
  const iterations = Math.max(1, Math.min(16, opts.iterations ?? 8));
  const maxSamples = Math.max(256, opts.maxSamples ?? 12000);
  const epsilon = opts.epsilon ?? 0.5;

  if (initial.length === 0 || samples.length === 0) return initial;

  // 1. 等距子采样（性能保险丝）并转 Lab——K-means 全程在感知空间进行
  const step = Math.max(1, Math.ceil(samples.length / maxSamples));
  const pts: Lab[] = [];
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i];
    pts.push(rgbToLab([s[0], s[1], s[2]]));
  }

  // 2. 种子 = Median Cut 的初始色板
  const centroids: Lab[] = initial.map((qc) => rgbToLab(qc.rgb));

  // 3. Lloyd 迭代：归属 → 重心
  const assign = new Int32Array(pts.length);
  for (let it = 0; it < iterations; it++) {
    let moved = 0;

    // 归属：Lab 欧氏平方（K-means 归属用不着 ΔE2000 的精细度）
    for (let p = 0; p < pts.length; p++) {
      const lab = pts[p];
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < centroids.length; k++) {
        const c = centroids[k];
        const dl = lab[0] - c[0];
        const da = lab[1] - c[1];
        const db = lab[2] - c[2];
        const d = dl * dl + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      assign[p] = best;
    }

    // 重心：Lab 均值；空簇保留原重心（色板大小稳定，下游映射不变）
    let drift = 0;
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (let p = 0; p < pts.length; p++) {
      const s = sums[assign[p]];
      s[0] += pts[p][0];
      s[1] += pts[p][1];
      s[2] += pts[p][2];
      s[3]++;
    }
    for (let k = 0; k < centroids.length; k++) {
      if (sums[k][3] === 0) continue;
      const nl = sums[k][0] / sums[k][3];
      const na = sums[k][1] / sums[k][3];
      const nb = sums[k][2] / sums[k][3];
      const c = centroids[k];
      drift += Math.sqrt((nl - c[0]) * (nl - c[0]) + (na - c[1]) * (na - c[1]) + (nb - c[2]) * (nb - c[2]));
      centroids[k] = [nl, na, nb];
      moved++;
    }

    // 收敛：无有效簇更新，或平均位移足够小
    if (moved === 0 || drift / centroids.length < epsilon) break;
  }

  // 4. 重心 → RGB 色板；count 按归属样本份额折算（供合并加权与用量展示）
  const counts = new Array(centroids.length).fill(0);
  for (let p = 0; p < pts.length; p++) counts[assign[p]]++;
  const share = samples.length / Math.max(1, pts.length);
  return centroids.map((lab, k) => {
    // Lab → RGB 走 convert.ts 的既有实现（自写反推公式在暗区有误，曾导致系统性色偏）
    const rgbClamped: Rgb = labToRgb(lab).map((v) =>
      Math.max(0, Math.min(255, Math.round(v))),
    ) as Rgb;
    return {
      rgb: rgbClamped,
      hex: rgbToHex(rgbClamped[0], rgbClamped[1], rgbClamped[2]),
      count: Math.max(1, Math.round(counts[k] * share)),
    };
  });
}
