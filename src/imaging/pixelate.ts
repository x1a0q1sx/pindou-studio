/**
 * src/imaging/pixelate.ts —— 缩放裁剪与像素化纯算法。
 *
 * 职责：fitRect（cover/contain/stretch 适配）、预处理（亮度/对比度/饱和度）、
 *       区域平均采样 / 中心取样、透明像素处理、60000 采样上限跳采样。
 *
 * 【设计铁律】不含任何 DOM / Worker / OffscreenCanvas API，
 * 纯数学 + typed array 操作，可在 Node / Worker / 主线程无缝执行。
 */
import type { FitMode } from '../core/types';

/* ==================== 类型 ==================== */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FitRectResult {
  /** 源图上要采样的矩形 */
  src: Rect;
  /** 目标网格中要填充的区域（格子坐标） */
  dst: Rect;
}

export interface PixelateSource {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PreprocessOpts {
  brightness: number; // -100 ~ +100
  contrast: number;   // -100 ~ +100
  saturation: number; // -100 ~ +100
}

export type SamplingMethod = 'area-average' | 'center';

export interface PixelateOpts {
  cols: number;
  rows: number;
  sampling: SamplingMethod;
  preprocess: PreprocessOpts;
  transparentAsEmpty: boolean;
  /** 采样像素上限，超出按比例跳采样（默认 60000） */
  samplingCap: number;
  /** fitRect 结果（源矩形 + 目标区域），可选（不提供则 stretch 全幅） */
  fit?: FitRectResult;
  /** 成品拼豆逆向：输入已完成的实物拼豆照片/图纸，按用户对齐的网格
   *  逐豆取色（豆心圆盘采样避开豆间黑缝），输出与普通像素化同契约的 cells。 */
  beadGrid?: { angleDeg: number; offsetX: number; offsetY: number; radiusRatio: number };
  /** 四角透视校正（逆向对位增强）：把拍歪的拼豆区域拉正后再逐豆采样。
   *  corners = 拼豆区域四角在**工作图（已裁剪）**上的归一化坐标（0..1），
   *  顺序：左上 → 右上 → 右下 → 左下。undefined/null = 不校正。 */
  perspective?: { corners: Array<{ x: number; y: number }> };
    /** 去背景：tolerance 0–100（映射为 RGB 欧氏距离 0–160）。
   *  从图片四边取色识别背景色，把与背景色**连通**的相似区域清成透明（后续按
   *  transparentAsEmpty 变空格）。只沿边缘洪泛，主体内部的同色区域不受影响。 */
  bgRemove?: { tolerance: number };
  /** 高光保护（瞳孔反光等小面积近白高光）：格内近白像素占比 ≥ HL_MIN_FRACTION 时，
   *  该格改用高光簇的均值而非整体均值——黑瞳孔里的 2px 白反光不再被大片暗部
   *  平均成糊色。仅 area-average 采样路径生效。默认关闭（由调用方按需开启）。 */
  highlightProtect?: boolean;
}

export interface PixelateResult {
  /** 每格平均 RGB 打包为 Uint32 (r<<16|g<<8|b)，0 = 空格/透明 */
  cells: Uint32Array;
  cols: number;
  rows: number;
  /** 实际采样像素数（用于验证 samplingCap） */
  sampledPixels: number;
}

/* ==================== fitRect ==================== */

/**
 * 根据 FitMode 计算源矩形与目标区域。
 * - cover: 保持比例裁满目标（可能裁掉源的一部分）
 * - contain: 保持比例内嵌（目标可能有空白区域）
 * - stretch: 拉伸填满目标
 */
export function fitRect(
  srcW: number,
  srcH: number,
  dstCols: number,
  dstRows: number,
  mode: FitMode,
): FitRectResult {
  if (srcW <= 0 || srcH <= 0 || dstCols <= 0 || dstRows <= 0) {
    return { src: { x: 0, y: 0, w: Math.max(1, srcW), h: Math.max(1, srcH) }, dst: { x: 0, y: 0, w: dstCols, h: dstRows } };
  }

  const srcAspect = srcW / srcH;
  const dstAspect = dstCols / dstRows;

  switch (mode) {
    case 'cover': {
      // 裁源：保持比例，填满目标
      let sw: number, sh: number;
      if (srcAspect > dstAspect) {
        // 源更宽 → 裁左右
        sh = srcH;
        sw = Math.round(srcH * dstAspect);
      } else {
        // 源更高 → 裁上下
        sw = srcW;
        sh = Math.round(srcW / dstAspect);
      }
      const sx = Math.round((srcW - sw) / 2);
      const sy = Math.round((srcH - sh) / 2);
      return { src: { x: sx, y: sy, w: sw, h: sh }, dst: { x: 0, y: 0, w: dstCols, h: dstRows } };
    }
    case 'contain': {
      // 用全源，目标区域居中缩小
      let dw: number, dh: number;
      if (srcAspect > dstAspect) {
        // 源更宽 → 高度留白
        dw = dstCols;
        dh = Math.max(1, Math.round(dstCols / srcAspect));
      } else {
        // 源更高 → 宽度留白
        dh = dstRows;
        dw = Math.max(1, Math.round(dstRows * srcAspect));
      }
      const dx = Math.round((dstCols - dw) / 2);
      const dy = Math.round((dstRows - dh) / 2);
      return { src: { x: 0, y: 0, w: srcW, h: srcH }, dst: { x: dx, y: dy, w: dw, h: dh } };
    }
    case 'stretch':
    default:
      return { src: { x: 0, y: 0, w: srcW, h: srcH }, dst: { x: 0, y: 0, w: dstCols, h: dstRows } };
  }
}

/* ==================== 预处理 ==================== */

/** 对单个像素应用亮度/对比度/饱和度调整（就地修改 r,g,b） */
function preprocessPixel(
  rgb: [number, number, number],
  brightness: number,
  contrastFactor: number,
  saturationFactor: number,
): void {
  let r = rgb[0], g = rgb[1], b = rgb[2];

  // 亮度：-100~+100 → -255~+255 偏移
  if (brightness !== 0) {
    const offset = brightness * 2.55;
    r += offset;
    g += offset;
    b += offset;
  }

  // 对比度：factor = (259*(contrast+255))/(255*(259-contrast))，简化为 0~2 区间
  if (contrastFactor !== 1) {
    r = (r - 128) * contrastFactor + 128;
    g = (g - 128) * contrastFactor + 128;
    b = (b - 128) * contrastFactor + 128;
  }

  // 饱和度：0=灰度，1=原始，2=双倍饱和
  if (saturationFactor !== 1) {
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    r = gray + (r - gray) * saturationFactor;
    g = gray + (g - gray) * saturationFactor;
    b = gray + (b - gray) * saturationFactor;
  }

  rgb[0] = Math.min(255, Math.max(0, Math.round(r)));
  rgb[1] = Math.min(255, Math.max(0, Math.round(g)));
  rgb[2] = Math.min(255, Math.max(0, Math.round(b)));
}

/** 由 -100~+100 的对比度值计算乘数因子 */
function contrastToFactor(c: number): number {
  if (c === 0) return 1;
  // 映射 -100→0, 0→1, +100→2
  return 1 + c / 100;
}

/** 由 -100~+100 的饱和度值计算乘数因子 */
function saturationToFactor(s: number): number {
  if (s === 0) return 1;
  return 1 + s / 100;
}

/* ==================== 去背景 ==================== */

/** 容差滑杆 0–100 → RGB 欧氏距离上限（30 → 48，宽松但仍不会把深色主体吞掉） */
function toleranceToDistance(tolerance: number): number {
  const t = Math.min(100, Math.max(0, tolerance));
  return t * 1.6;
}

/**
 * 从四边采样估计背景色：每条边均匀取 ~60 个点，逐通道取中位数。
 * 中位数比均值抗干扰（边缘若有一圈水印/文字不会带偏）。
 */
function detectEdgeColor(src: PixelateSource): [number, number, number] {
  const { data, width: w, height: h } = src;
  const samples: number[][] = [];
  const perEdge = 60;
  const stepX = Math.max(1, Math.floor(w / perEdge));
  const stepY = Math.max(1, Math.floor(h / perEdge));
  for (let x = 0; x < w; x += stepX) {
    samples.push([data[x * 4], data[x * 4 + 1], data[x * 4 + 2]]);                     // 上边
    const bIdx = ((h - 1) * w + x) * 4;
    samples.push([data[bIdx], data[bIdx + 1], data[bIdx + 2]]);                        // 下边
  }
  for (let y = 0; y < h; y += stepY) {
    const lIdx = (y * w) * 4;
    samples.push([data[lIdx], data[lIdx + 1], data[lIdx + 2]]);                        // 左边
    const rIdx = (y * w + (w - 1)) * 4;
    samples.push([data[rIdx], data[rIdx + 1], data[rIdx + 2]]);                        // 右边
  }
  const med = (arr: number[]): number => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  return [med(samples.map((s) => s[0])), med(samples.map((s) => s[1])), med(samples.map((s) => s[2]))];
}

/**
 * 边缘洪泛去背景：把「与图片边缘连通、且颜色接近背景色」的区域 alpha 清 0。
 * 连通性保证主体内部的相似色区域不受影响（如人物衣服与背景同色也不会被挖空）。
 * 就地修改 src.data；纯函数、typed array，Worker 安全。
 */
export function removeBackgroundByEdge(src: PixelateSource, tolerance: number): void {
  const { data, width: w, height: h } = src;
  if (w <= 0 || h <= 0) return;
  const maxDist2 = toleranceToDistance(tolerance) ** 2;
  const [kr, kg, kb] = detectEdgeColor(src);

  const total = w * h;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;

  const nearKey = (idx: number): boolean => {
    const i4 = idx * 4;
    const dr = data[i4] - kr;
    const dg = data[i4 + 1] - kg;
    const db = data[i4 + 2] - kb;
    return dr * dr + dg * dg + db * db <= maxDist2;
  };

  // 种子：四边上所有接近背景色的像素
  for (let x = 0; x < w; x++) {
    if (!visited[x] && nearKey(x)) { visited[x] = 1; stack[sp++] = x; }
    const b = (h - 1) * w + x;
    if (!visited[b] && nearKey(b)) { visited[b] = 1; stack[sp++] = b; }
  }
  for (let y = 0; y < h; y++) {
    const l = y * w;
    if (!visited[l] && nearKey(l)) { visited[l] = 1; stack[sp++] = l; }
    const r = l + w - 1;
    if (!visited[r] && nearKey(r)) { visited[r] = 1; stack[sp++] = r; }
  }

  // 迭代洪泛（stack 指针即栈顶；每弹出一个，压入未访问的 4 邻）
  let cleared = 0;
  while (sp > 0) {
    const idx = stack[--sp];
    data[idx * 4 + 3] = 0;
    cleared++;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0) { const n = idx - 1; if (!visited[n] && nearKey(n)) { visited[n] = 1; stack[sp++] = n; } }
    if (x < w - 1) { const n = idx + 1; if (!visited[n] && nearKey(n)) { visited[n] = 1; stack[sp++] = n; } }
    if (y > 0) { const n = idx - w; if (!visited[n] && nearKey(n)) { visited[n] = 1; stack[sp++] = n; } }
    if (y < h - 1) { const n = idx + w; if (!visited[n] && nearKey(n)) { visited[n] = 1; stack[sp++] = n; } }
  }

  // 全图都被判定为背景（纯色空图/容差开太大）时整体保留，避免给出一张空板
  if (cleared >= total) {
    for (let i = 0; i < total; i++) data[i * 4 + 3] = 255;
  }
}

/* ==================== 线性光平均（缺陷 #47） ==================== */

/** sRGB 字节 → 线性光查找表（构建一次，全图共享；区域平均前先转线性） */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 线性光 → sRGB 字节（0–255，四舍五入截取） */
function linearToSrgb255(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/* ==================== 高光保护（瞳孔反光等小面积近白高光） ==================== */

/** 高光判定：像素亮度下限（0–255，Rec.709 加权） */
export const HL_LUMA_MIN = 235;
/** 高光判定：RGB 通道最大差上限（排除彩色高光误判，只认中性白） */
export const HL_SPREAD_MAX = 30;
/** 格内近白像素占比达到该值 → 整格改用高光簇均值 */
export const HL_MIN_FRACTION = 0.06;

/** 近白高光判定：亮度 ≥ 235 且通道差 ≤ 30（纯白/纸白/瞳孔反光；排除彩色高光） */
export function isNearWhiteRGB(r: number, g: number, b: number): boolean {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  if (hi - lo > HL_SPREAD_MAX) return false;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b >= HL_LUMA_MIN;
}

/* ==================== 四角透视校正（逆向对位增强） ==================== */

export type PerspectiveCorners = Array<{ x: number; y: number }>;

/**
 * 解「单位方 → 四边形」的单应矩阵（DLT：4 对对应点解 8 元线性方程组，高斯消元）。
 * 返回 row-major 3×3（h0..h7，h8=1）：u/v ∈ [0,1] → 源图坐标。
 * 导出给 UI 的网格叠加层用——采样与画线必须共用同一个 H 才能严格对位。
 */
export function homographyFromUnitQuad(quad: PerspectiveCorners): number[] {
  // 8×8 增广矩阵；行按 4 个角 × (u 方程, v 方程) 排列
  const unitCorners = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ];
  const A: number[][] = [];
  const b: number[] = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = unitCorners[k];
    const u = quad[k].x;
    const v = quad[k].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // 高斯消元（部分主元）
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[piv][col])) piv = row;
    }
    if (A[piv][col] === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1]; // 奇异（四点共线等）→ 恒等，安全兜底
    if (piv !== col) {
      [A[piv], A[col]] = [A[col], A[piv]];
      [b[piv], b[col]] = [b[col], b[piv]];
    }
    const d = A[col][col];
    for (let j = col; j < n; j++) A[col][j] /= d;
    b[col] /= d;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row][col];
      if (f === 0) continue;
      for (let j = col; j < n; j++) A[row][j] -= f * A[col][j];
      b[row] -= f * b[col];
    }
  }
  return [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1];
}

/** 单应映射：u/v（0..1 或像素/归一化坐标）→ [x, y] */
export function applyHomography(h: number[], u: number, v: number): [number, number] {
  const d = h[6] * u + h[7] * v + 1;
  return [(h[0] * u + h[1] * v + h[2]) / d, (h[3] * u + h[4] * v + h[5]) / d];
}

/**
 * 按四角把 src 拉正成 outW×outH 的矩形图（双线性采样，出界为透明）。
 * corners 为「工作图」上的归一化坐标（允许超出 0..1——四边形延伸到图外的部分采样为透明）。
 * 逐输出像素经 H⁻¹…不需要：H 本身就是「单位方 → 四边形」，输出像素先归一化
 * 成 u/v 再正向映射回源坐标采样，天然就是逆变换方向。
 */
export function warpPerspective(
  src: PixelateSource,
  corners: PerspectiveCorners,
  outW: number,
  outH: number,
): PixelateSource {
  const out = new Uint8ClampedArray(outW * outH * 4);
  if (outW <= 0 || outH <= 0 || src.width <= 0 || src.height <= 0 || corners.length !== 4) {
    return { data: out, width: outW, height: outH };
  }
  const pixelQuad = corners.map((c) => ({ x: c.x * src.width, y: c.y * src.height }));
  const h = homographyFromUnitQuad(pixelQuad);
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW;
      const [sx, sy] = applyHomography(h, u, v);
      const o = (y * outW + x) * 4;
      if (sx < -1 || sy < -1 || sx > sw || sy > sh) continue; // 出界保持透明
      const x0 = Math.min(sw - 1, Math.max(0, Math.floor(sx)));
      const y0 = Math.min(sh - 1, Math.max(0, Math.floor(sy)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const fy = Math.min(1, Math.max(0, sy - y0));
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = src.data[i00 + ch] * (1 - fx) + src.data[i10 + ch] * fx;
        const bot = src.data[i01 + ch] * (1 - fx) + src.data[i11 + ch] * fx;
        out[o + ch] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** pixelateFromRgba 的透视前置：无有效四角时原样返回，否则拉正成 cols:rows 比例的矩形 */
function applyPerspectiveIfAny(
  src: PixelateSource,
  perspective: PixelateOpts['perspective'],
  cols: number,
  rows: number,
): PixelateSource {
  if (!perspective || !Array.isArray(perspective.corners) || perspective.corners.length !== 4) {
    return src;
  }
  // 输出尺寸保持 cols:rows 纵横比，最长边 ~1400px（拉正后的采样分辨率够用且不慢）
  const k = 1400 / Math.max(1, Math.max(cols, rows));
  const outW = Math.max(64, Math.round(cols * k));
  const outH = Math.max(64, Math.round(rows * k));
  return warpPerspective(src, perspective.corners, outW, outH);
}

/* ==================== pixelateFromRgba ==================== */

/**
 * 将 RGBA 源图像素化为 cols×rows 的格子矩阵。
 * 纯函数，不含 DOM API。
 *
 * @param onProgress 可选进度回调（0..1，按行块上报；注意不能放进 opts——
 *        opts 会经 postMessage 传入 Worker，函数不可结构化克隆）
 */
export function pixelateFromRgba(
  src0: PixelateSource,
  opts: PixelateOpts,
  onProgress?: (fraction: number) => void,
): PixelateResult {
  const { cols, rows, sampling, preprocess, transparentAsEmpty, samplingCap, highlightProtect } = opts;
  const totalCells = cols * rows;
  const cells = new Uint32Array(totalCells);

  if (src0.width <= 0 || src0.height <= 0 || cols <= 0 || rows <= 0) {
    return { cells, cols, rows, sampledPixels: 0 };
  }

  // 四角透视校正（逆向对位增强）：先拉正，后续采样全部作用在拉正图上
  const src = applyPerspectiveIfAny(src0, opts.perspective, cols, rows);

  // 成品拼豆逆向：逐豆网格采样取代整块平均
  if (opts.beadGrid) {
    return sampleBeadGrid(src, opts, onProgress);
  }

    // 去背景：先于一切采样，把背景连通区清成透明（后续按 transparentAsEmpty 落空格）
  if (opts.bgRemove) {
    removeBackgroundByEdge(src, opts.bgRemove.tolerance);
  }

  // 确定源采样区域和目标填充区域
  const fit = opts.fit ?? fitRect(src.width, src.height, cols, rows, 'stretch');
  const { src: srcRect, dst: dstRect } = fit;

  // 预处理因子
  const bright = preprocess.brightness;
  const contrastF = contrastToFactor(preprocess.contrast);
  const satF = saturationToFactor(preprocess.saturation);
  const needPreprocess = bright !== 0 || contrastF !== 1 || satF !== 1;

  // 计算总采样像素数，决定是否需要跳采样
  const srcArea = srcRect.w * srcRect.h;
  let step = 1;
  if (srcArea > samplingCap) {
    step = Math.max(1, Math.ceil(Math.sqrt(srcArea / samplingCap)));
    // 保守校正：确保 cols*rows*ceil(cellW/step)*ceil(cellH/step) ≤ samplingCap
    const avgCellW = srcRect.w / dstRect.w;
    const avgCellH = srcRect.h / dstRect.h;
    while (dstRect.w * dstRect.h * Math.ceil(avgCellW / step) * Math.ceil(avgCellH / step) > samplingCap) {
      step++;
    }
  }

  let sampledPixels = 0;

  // 进度上报节流点：每完成 ~4% 的行数回调一次（纯函数内不做时间查询，由调用方节流）
  const progressEvery = Math.max(1, Math.ceil(rows / 25));

  // 对目标区域中的每个格子，采样对应的源像素范围
  for (let row = 0; row < rows; row++) {
    if (onProgress && row % progressEvery === 0) onProgress(row / rows);
    for (let col = 0; col < cols; col++) {
      const cellIdx = row * cols + col;

      // 检查是否在目标填充区域内
      if (
        row < dstRect.y || row >= dstRect.y + dstRect.h ||
        col < dstRect.x || col >= dstRect.x + dstRect.w
      ) {
        cells[cellIdx] = 0; // contain 模式下的留白
        continue;
      }

      // 计算此格对应的源像素范围
      const localCol = col - dstRect.x;
      const localRow = row - dstRect.y;
      const px0 = srcRect.x + Math.floor((localCol * srcRect.w) / dstRect.w);
      const px1 = srcRect.x + Math.floor(((localCol + 1) * srcRect.w) / dstRect.w);
      const py0 = srcRect.y + Math.floor((localRow * srcRect.h) / dstRect.h);
      const py1 = srcRect.y + Math.floor(((localRow + 1) * srcRect.h) / dstRect.h);

      const cellW = Math.max(1, px1 - px0);
      const cellH = Math.max(1, py1 - py0);

      if (sampling === 'center') {
        // 中心取样
        const cx = Math.min(src.width - 1, px0 + (cellW >> 1));
        const cy = Math.min(src.height - 1, py0 + (cellH >> 1));
        const idx = (cy * src.width + cx) * 4;
        const a = src.data[idx + 3];
        if (transparentAsEmpty && a < 128) {
          cells[cellIdx] = 0;
        } else {
          const rgb: [number, number, number] = [src.data[idx], src.data[idx + 1], src.data[idx + 2]];
          if (needPreprocess) preprocessPixel(rgb, bright, contrastF, satF);
          cells[cellIdx] = ((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0;
        }
        sampledPixels++;
      } else {
        // 区域平均（按跳采样步长）——缺陷 #47：在**线性光**空间求均值。
        // sRGB 是 gamma 编码过的信号，直接平均物理光色会偏暗、压饱和（红白边缘混成粉），
        // 这是「发灰」的经典来源；先经 LUT 转线性再平均、最后转回 sRGB 才是物理正确的均值。
        // 预处理（亮度/对比度/饱和度均为 sRGB 线性变换）移到均值之后应用，数学上等价。
        let sumR = 0, sumG = 0, sumB = 0, count = 0;
        // 高光保护（瞳孔反光等小面积近白高光）：同步累计近白簇，均值化后按占比决策
        let hlCount = 0, hlR = 0, hlG = 0, hlB = 0;
        const hlOn = highlightProtect === true;
        for (let sy = py0; sy < py1; sy += step) {
          if (sy >= src.height) break;
          const rowBase = sy * src.width * 4;
          for (let sx = px0; sx < px1; sx += step) {
            if (sx >= src.width) break;
            const idx = rowBase + sx * 4;
            const a = src.data[idx + 3];
            if (transparentAsEmpty && a < 128) {
              sampledPixels++;
              continue;
            }
            const pr = src.data[idx];
            const pg = src.data[idx + 1];
            const pb = src.data[idx + 2];
            if (hlOn && isNearWhiteRGB(pr, pg, pb)) {
              hlCount++;
              hlR += SRGB_TO_LINEAR[pr];
              hlG += SRGB_TO_LINEAR[pg];
              hlB += SRGB_TO_LINEAR[pb];
            }
            sumR += SRGB_TO_LINEAR[pr];
            sumG += SRGB_TO_LINEAR[pg];
            sumB += SRGB_TO_LINEAR[pb];
            count++;
            sampledPixels++;
          }
        }
        if (count === 0) {
          // 全部透明或无有效像素
          cells[cellIdx] = 0;
        } else {
          // 高光保护：近白像素成簇（占比 ≥ HL_MIN_FRACTION）→ 用高光簇均值取代整体均值，
          // 小面积白色高光不再被大片暗部平均成糊色
          const useHL = hlCount > 0 && hlCount / count >= HL_MIN_FRACTION;
          const denom = useHL ? hlCount : count;
          const sr = useHL ? hlR : sumR;
          const sg = useHL ? hlG : sumG;
          const sb = useHL ? hlB : sumB;
          const avg: [number, number, number] = [
            linearToSrgb255(sr / denom),
            linearToSrgb255(sg / denom),
            linearToSrgb255(sb / denom),
          ];
          if (needPreprocess) preprocessPixel(avg, bright, contrastF, satF);
          cells[cellIdx] = ((avg[0] << 16) | (avg[1] << 8) | avg[2]) >>> 0;
        }
      }
    }
  }

  onProgress?.(1);
  return { cells, cols, rows, sampledPixels };
}

/* ==================== 成品拼豆逆向：逐豆网格采样 ==================== */

/**
 * 把一张「已完成的实物拼豆照片/图纸」按对齐网格逐豆取色。
 * 与 pixelateFromRgba 的整块区域平均不同：每个豆格只对**豆心圆盘**（半径 = 豆距×
 * radiusRatio，默认 0.32，避开豆间的黑色底缝）求均值，颜色更纯净、不混入缝隙。
 * 网格支持旋转角（拍歪了）与起点微调（对齐第一颗豆的中心）。
 */
function sampleBeadGrid(
  src: PixelateSource,
  opts: PixelateOpts,
  onProgress?: (fraction: number) => void,
): PixelateResult {
  const grid = opts.beadGrid!;
  const { cols, rows, preprocess, transparentAsEmpty } = opts;
  const cells = new Uint32Array(cols * rows);
  let sampledPixels = 0;
  if (src.width <= 0 || src.height <= 0 || cols <= 0 || rows <= 0) {
    return { cells, cols, rows, sampledPixels };
  }

  const bright = preprocess.brightness;
  const contrastF = contrastToFactor(preprocess.contrast);
  const satF = saturationToFactor(preprocess.saturation);
  const needPreprocess = bright !== 0 || contrastF !== 1 || satF !== 1;

  const theta = (grid.angleDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const pitchX = src.width / cols;
  const pitchY = src.height / rows;
  const rx = Math.max(1, pitchX * grid.radiusRatio);
  const ry = Math.max(1, pitchY * grid.radiusRatio);
  const step = Math.max(1, Math.floor(Math.min(rx, ry) / 3));
  const progressEvery = Math.max(1, Math.ceil(rows / 25));

  for (let r = 0; r < rows; r++) {
    if (onProgress && r % progressEvery === 0) onProgress(r / rows);
    for (let c = 0; c < cols; c++) {
      // 豆心（未旋转坐标，-0.5..0.5 归一化），再绕图心旋转
      const u = (c + 0.5) / cols - 0.5 + grid.offsetX;
      const v = (r + 0.5) / rows - 0.5 + grid.offsetY;
      const cx = src.width / 2 + (u * cosT - v * sinT) * src.width;
      const cy = src.height / 2 + (u * sinT + v * cosT) * src.height;

      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      const x0 = Math.max(0, Math.floor(cx - rx));
      const x1 = Math.min(src.width - 1, Math.ceil(cx + rx));
      const y0 = Math.max(0, Math.floor(cy - ry));
      const y1 = Math.min(src.height - 1, Math.ceil(cy + ry));
      for (let sy = y0; sy <= y1; sy += step) {
        for (let sx = x0; sx <= x1; sx += step) {
          const dx = (sx - cx) / rx;
          const dy = (sy - cy) / ry;
          if (dx * dx + dy * dy > 1) continue;
          const idx = (sy * src.width + sx) * 4;
          const a = src.data[idx + 3];
          if (transparentAsEmpty && a < 128) continue;
          sumR += SRGB_TO_LINEAR[src.data[idx]];
          sumG += SRGB_TO_LINEAR[src.data[idx + 1]];
          sumB += SRGB_TO_LINEAR[src.data[idx + 2]];
          count++;
        }
      }
      sampledPixels += count;
      const i = r * cols + c;
      if (count === 0) { cells[i] = 0; continue; }
      const rgb: [number, number, number] = [
        linearToSrgb255(sumR / count),
        linearToSrgb255(sumG / count),
        linearToSrgb255(sumB / count),
      ];
      if (needPreprocess) preprocessPixel(rgb, bright, contrastF, satF);
      cells[i] = ((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0;
    }
  }

  onProgress?.(1);
  return { cells, cols, rows, sampledPixels };
}
