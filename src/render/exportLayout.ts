/**
 * src/render/exportLayout.ts —— 导出图纸的**纯计算层**（导出产物 1/2/3 的几何与配色计算）。
 *
 * 【铁律】本文件**零 DOM / 零 Canvas / 零 store 依赖**，只 import `core/types`（类型）、
 * `core/region`（分区约定，已定稿）。因此可以被 esbuild 打包后在 node 里直接跑单测：
 *   npx esbuild src/render/exportLayout.ts --bundle --format=esm --platform=node \
 *     --tsconfig=tsconfig.json --outfile=.tmp-verify-export/layout.mjs
 *
 * 【与屏幕渲染器的关系】渲染器（render/renderer.ts）为「屏幕物理对齐」服务，逐格独立取整；
 * 打印图纸为「纸张物理精度」服务，格边界用**浮点**坐标（打印机本身是连续坐标系），
 * 但同样坚持「每格边界 = origin + i*cellPx 独立计算」而非累加步长，故累计误差恒为 0。
 *
 * 【mm→px 换算】px = mm / 25.4 * dpi。整板有效排豆区 = cols * pitchMm（104 × 2.6923 = 279.9992mm）。
 *   300DPI：有效区 3307.0772px，含双边 2mm 留白 3354.3213px。
 *   （名义值 280mm/284mm 对应 3307.0866/3354.3307，差 0.0094px ≈ 0.8µm，源于 pitchMm=2.6923 是舍入值。）
 */
import type { CanvasTokens } from '@/core/types';
import { buildRegions, regionLabel } from '@/core/region';

/* ==================== 常量 ==================== */

export const MM_PER_INCH = 25.4;

/** 默认导出分辨率 */
export const DEFAULT_DPI = 300;
/** UI 提供的三档 */
export const SUPPORTED_DPI: readonly number[] = [150, 300, 600];
export const MIN_DPI = 72;
export const MAX_DPI = 1200;

/**
 * 单次导出的像素总量上限（宽×高）。
 * 600DPI 整板 104×104 ≈ 6709² ≈ 4501 万像素 ≈ 180MB RGBA —— 通过；
 * 超过 8000 万像素时浏览器极易直接崩溃，故在此拦截并给出中文提示。
 */
export const MAX_EXPORT_PIXELS = 80_000_000;

/** 超过此像素量默认不再额外生成 dataURL（base64 会再吃 1.33 倍内存） */
export const DATA_URL_PIXEL_LIMIT = 20_000_000;

/** A4 宽高比（竖版 w/h = 1/√2 ≈ 0.7071） */
export const DEFAULT_PAPER_RATIO = 1 / Math.SQRT2;

/* ==================== 基础换算 ==================== */

/** 毫米 → 像素（`px = mm / 25.4 * dpi`） */
export function mmToPx(mm: number, dpi: number): number {
  return (mm / MM_PER_INCH) * dpi;
}

/** 像素 → 毫米 */
export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * MM_PER_INCH;
}

/** DPI 归一：非法值回退 300，并夹到 [72, 1200] */
export function normalizeDpi(dpi?: number | null): number {
  if (typeof dpi !== 'number' || !Number.isFinite(dpi)) return DEFAULT_DPI;
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(dpi)));
}

/** 从 SUPPORTED_DPI 中挑不超过 target 的最大档；都不满足时返回 target 本身 */
export function pickSupportedDpi(target: number): number {
  let best = 0;
  for (const d of SUPPORTED_DPI) if (d <= target && d > best) best = d;
  return best > 0 ? best : Math.max(1, Math.floor(target));
}

/** 正整数归一（列数/行数/分区数） */
export function sanitizeCount(v: number | undefined | null, fallback: number, max = 4096): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(1, Math.round(v)));
}

/** 毫米量归一（钉距/留白/标注槽） */
export function sanitizeMm(v: number | undefined | null, fallback: number, min = 0, max = 200): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** 比例归一（beadFillRatio 0.05–1.0） */
export function sanitizeRatio(v: number | undefined | null, fallback: number, min = 0.05, max = 1): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/**
 * 像素量归一 + 夹紧（cellPx / paddingPx / bandPx 等）。
 * 【铁律】缺省（undefined）必须回退到 fallback，绝不可把 undefined 交给 Math.max ——
 * `Math.max(1, undefined)` 会静默产出 NaN 并污染整条布局链。
 */
export function clampNumber(v: number | undefined | null, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/* ==================== 通用几何类型 ==================== */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ==================== 像素预算（内存保护） ==================== */

export interface PixelBudget {
  /** 整数画布尺寸（= ceil(浮点理论尺寸)） */
  widthPx: number;
  heightPx: number;
  /** 浮点理论尺寸（mm 精确换算，未取整） */
  widthPxExact: number;
  heightPxExact: number;
  totalPixels: number;
  limitPixels: number;
  /** RGBA 未压缩字节数 */
  approxBytes: number;
  approxMb: number;
  ok: boolean;
  /** 超限时的中文错误提示（ok=true 时为 null） */
  error: string | null;
  /** 超限时建议改用的 DPI（ok=true 时为 null） */
  suggestDpi: number | null;
}

export interface PixelBudgetParams {
  cols: number;
  rows: number;
  pitchMm: number;
  marginMm: number;
  dpi: number;
  /** 标注槽（每侧），默认 0 —— 预算函数的默认口径与「板含留白」一致 */
  gutterMm?: number;
  /** 覆盖默认上限（测试/降级用） */
  limit?: number;
  /** 错误提示里的产物名称，例如「1:1 图纸」「分块图纸」 */
  label?: string;
}

/**
 * 由「浮点理论像素尺寸」直接构造预算结果（超限不抛异常，返回中文提示）。
 * estimatePixelBudget 与分块图纸预算共用此口径。
 */
export function budgetFromPixels(
  widthPxExact: number,
  heightPxExact: number,
  dpi: number,
  label = '',
  limit = MAX_EXPORT_PIXELS,
): PixelBudget {
  const widthPx = Math.max(1, Math.ceil(widthPxExact));
  const heightPx = Math.max(1, Math.ceil(heightPxExact));
  const totalPixels = widthPx * heightPx;
  const approxBytes = totalPixels * 4;
  const base: PixelBudget = {
    widthPx,
    heightPx,
    widthPxExact,
    heightPxExact,
    totalPixels,
    limitPixels: limit,
    approxBytes,
    approxMb: approxBytes / (1024 * 1024),
    ok: totalPixels <= limit,
    error: null,
    suggestDpi: null,
  };
  if (base.ok) return base;

  const d = normalizeDpi(dpi);
  const scale = Math.sqrt(limit / totalPixels);
  const suggestDpi = pickSupportedDpi(d * scale * 0.98);
  return {
    ...base,
    error:
      `${label}尺寸过大：约 ${widthPx}×${heightPx} 像素（${Math.round(totalPixels / 10000)} 万像素，` +
      `未压缩 RGBA 约 ${Math.round(approxBytes / (1024 * 1024))}MB），超出单次导出上限 ` +
      `${Math.round(limit / 10000)} 万像素，继续导出极可能让浏览器崩溃。` +
      `请把 DPI 从 ${d} 降到 ${suggestDpi}（或更低），或减少行列数，或改用「分块图纸」逐块导出。`,
    suggestDpi,
  };
}

/**
 * 估算一次导出的像素总量与内存占用，超限时返回中文提示（**不抛异常**）。
 * 宽度口径 = cols*pitchMm + 2*marginMm + 2*gutterMm。
 */
export function estimatePixelBudget(p: PixelBudgetParams): PixelBudget {
  const dpi = normalizeDpi(p.dpi);
  const cols = sanitizeCount(p.cols, 104);
  const rows = sanitizeCount(p.rows, 104);
  const pitchMm = sanitizeMm(p.pitchMm, 2.6923, 1, 10);
  const marginMm = sanitizeMm(p.marginMm, 2, 0, 50);
  const gutterMm = sanitizeMm(p.gutterMm ?? 0, 0, 0, 100);
  const limit = p.limit && p.limit > 0 ? p.limit : MAX_EXPORT_PIXELS;

  return budgetFromPixels(
    mmToPx(cols * pitchMm + 2 * marginMm + 2 * gutterMm, dpi),
    mmToPx(rows * pitchMm + 2 * marginMm + 2 * gutterMm, dpi),
    dpi,
    p.label ?? '',
    limit,
  );
}

/** dataURL 是否值得生成（像素量过大时只给 blob，省 1.33 倍内存） */
export function shouldIncludeDataUrl(totalPixels: number, explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return totalPixels <= DATA_URL_PIXEL_LIMIT;
}

/* ==================== 1:1 物理尺寸图纸布局 ==================== */

export interface SheetLayoutParams {
  cols: number;
  rows: number;
  pitchMm: number;
  marginMm: number;
  dpi: number;
  /**
   * 标注槽（画行列编号与说明文字的空白带，每侧），默认 0。
   * 5mm 时整板 284mm → 294mm，正好落在 A4（297mm）内，可单张 100% 打印。
   * **标注槽在板留白之外，不影响排豆区的物理尺寸。**
   */
  gutterMm?: number;
  beadFillRatio?: number;
}

export interface SheetLayout {
  cols: number;
  rows: number;
  dpi: number;
  pitchMm: number;
  marginMm: number;
  gutterMm: number;
  beadFillRatio: number;
  /** 每格边长（像素，浮点）= pitchMm / 25.4 * dpi */
  cellPx: number;
  /** 豆点半径 = 0.5 * cellPx * beadFillRatio */
  beadRadiusPx: number;
  marginPx: number;
  gutterPx: number;
  /** 有效排豆区尺寸（浮点精确，= cols*cellPx） */
  areaWidthPx: number;
  areaHeightPx: number;
  /** 板含双边留白的尺寸（浮点，= areaWidthPx + 2*marginPx） */
  contentWidthPx: number;
  contentHeightPx: number;
  /** 整数画布尺寸（= ceil(content + 2*gutter)） */
  widthPx: number;
  heightPx: number;
  totalPixels: number;
  /** (0,0) 格左上角的绝对画布坐标 = gutterPx + marginPx */
  originX: number;
  originY: number;
  /** 板含留白外框左上角 = gutterPx */
  boardX: number;
  boardY: number;
  /** 板含留白外框（= 实物板边缘，L 形对齐标记依此绘制） */
  boardRect: Rect;
  /** 格左/上边界（相对排豆区，= i*cellPx，**独立乘法、无累加漂移**） */
  cellLeft(col: number): number;
  cellTop(row: number): number;
  /** 格左/上边界的绝对画布坐标 */
  cellLeftAbs(col: number): number;
  cellTopAbs(row: number): number;
  /** 格矩形（绝对画布坐标，浮点；w === h === cellPx） */
  cellRect(col: number, row: number): Rect;
  /** 格中心（绝对画布坐标） */
  cellCenter(col: number, row: number): { x: number; y: number };
  isInside(col: number, row: number): boolean;
}

/**
 * 1:1 物理尺寸图纸布局。
 * 位置参数口径即验收口径：`computeSheetLayout(104, 104, 2.6923, 2.0, 300)`。
 */
export function computeSheetLayout(
  cols: number,
  rows: number,
  pitchMm: number,
  marginMm: number,
  dpi: number,
  extra?: { gutterMm?: number; beadFillRatio?: number },
): SheetLayout {
  const c = sanitizeCount(cols, 104);
  const r = sanitizeCount(rows, 104);
  const pitch = sanitizeMm(pitchMm, 2.6923, 1, 10);
  const margin = sanitizeMm(marginMm, 2, 0, 50);
  const d = normalizeDpi(dpi);
  const gutter = sanitizeMm(extra?.gutterMm ?? 0, 0, 0, 100);
  const fill = sanitizeRatio(extra?.beadFillRatio ?? 0.9, 0.9);

  const cellPx = mmToPx(pitch, d);
  const marginPx = mmToPx(margin, d);
  const gutterPx = mmToPx(gutter, d);
  const areaWidthPx = c * cellPx;
  const areaHeightPx = r * cellPx;
  const contentWidthPx = areaWidthPx + 2 * marginPx;
  const contentHeightPx = areaHeightPx + 2 * marginPx;
  const widthPx = Math.max(1, Math.ceil(contentWidthPx + 2 * gutterPx));
  const heightPx = Math.max(1, Math.ceil(contentHeightPx + 2 * gutterPx));
  const boardX = gutterPx;
  const boardY = gutterPx;
  const originX = gutterPx + marginPx;
  const originY = gutterPx + marginPx;

  const layout: SheetLayout = {
    cols: c,
    rows: r,
    dpi: d,
    pitchMm: pitch,
    marginMm: margin,
    gutterMm: gutter,
    beadFillRatio: fill,
    cellPx,
    beadRadiusPx: 0.5 * cellPx * fill,
    marginPx,
    gutterPx,
    areaWidthPx,
    areaHeightPx,
    contentWidthPx,
    contentHeightPx,
    widthPx,
    heightPx,
    totalPixels: widthPx * heightPx,
    originX,
    originY,
    boardX,
    boardY,
    boardRect: { x: boardX, y: boardY, w: contentWidthPx, h: contentHeightPx },
    cellLeft: (col) => col * cellPx,
    cellTop: (row) => row * cellPx,
    cellLeftAbs: (col) => originX + col * cellPx,
    cellTopAbs: (row) => originY + row * cellPx,
    cellRect: (col, row) => ({
      x: originX + col * cellPx,
      y: originY + row * cellPx,
      w: cellPx,
      h: cellPx,
    }),
    cellCenter: (col, row) => ({
      x: originX + (col + 0.5) * cellPx,
      y: originY + (row + 0.5) * cellPx,
    }),
    isInside: (col, row) => col >= 0 && col < c && row >= 0 && row < r,
  };
  return layout;
}

/* ==================== 分块图纸布局 ==================== */

export interface RegionSheetLayoutParams {
  cols: number;
  rows: number;
  pitchMm: number;
  marginMm: number;
  dpi: number;
  splitsX: number;
  splitsY: number;
  /** 目标纸张宽高比（w/h），默认 A4 竖版 1/√2；内容按 1:1 物理尺寸居中，不足处留白 */
  paperRatio?: number;
  /** 编号带（每侧，含「全局」与「局部」两条编号），默认 9mm */
  gutterMm?: number;
  /** 页眉（区块编号 + 说明），默认 12mm */
  headerMm?: number;
  /** 页脚（打印提示），默认 8mm */
  footerMm?: number;
  beadFillRatio?: number;
}

export interface RegionSheetLayout {
  /** 行优先序号 = iy * splitsX + ix（与 core/region.buildRegions 一致） */
  index: number;
  /** 区块编号（core/region.regionLabel：字母=列序 ix，数字=行序 iy+1） */
  label: string;
  ix: number;
  iy: number;
  /** 全局起始列/行 */
  col0: number;
  row0: number;
  /** 本区块列数/行数（退化块可能小于 regionCols） */
  cols: number;
  rows: number;
  dpi: number;
  cellPx: number;
  beadRadiusPx: number;
  marginPx: number;
  gutterPx: number;
  headerPx: number;
  footerPx: number;
  areaWidthPx: number;
  areaHeightPx: number;
  /** 含页眉/编号带/留白/页脚的内容盒尺寸（浮点，未补白） */
  contentWidthPx: number;
  contentHeightPx: number;
  /** 补齐到 paperRatio 后的整数画布尺寸 */
  widthPx: number;
  heightPx: number;
  totalPixels: number;
  /** 内容盒在画布中的居中偏移（补白） */
  padX: number;
  padY: number;
  /** 本区块 (0,0) 格（= 全局 (col0,row0)）左上角的绝对画布坐标 */
  originX: number;
  originY: number;
  /** 实物板边缘外框（L 形对齐标记依此绘制） */
  boardRect: Rect;
  alignRect: Rect;
  /** 局部格矩形（localCol/localRow 相对本区块） */
  cellRect(localCol: number, localRow: number): Rect;
  /** 全局格矩形；不在本区块内时返回 null */
  globalCellRect(col: number, row: number): Rect | null;
  cellLeft(localCol: number): number;
  cellTop(localRow: number): number;
  cellCenter(localCol: number, localRow: number): { x: number; y: number };
  /** 编号带内两条基线：全局编号（外）与局部编号（内） */
  colNumberY: { global: number; local: number };
  rowNumberX: { global: number; local: number };
}

export interface RegionLayoutResult {
  splitsX: number;
  splitsY: number;
  dpi: number;
  paperRatio: number;
  sheets: RegionSheetLayout[];
  /** 最大单张像素量 */
  maxSheetPixels: number;
  /** 以最大单张为口径的内存预算 */
  budget: PixelBudget;
}

/**
 * 分块图纸布局：每个区块一张纸，内容保持 **1:1 物理尺寸不缩放**，
 * 长宽比不足 paperRatio 的部分用留白补齐并居中（缩放会破坏「垫在板下」的对齐精度）。
 */
export function computeRegionLayout(p: RegionSheetLayoutParams): RegionLayoutResult {
  const cols = sanitizeCount(p.cols, 104);
  const rows = sanitizeCount(p.rows, 104);
  const pitchMm = sanitizeMm(p.pitchMm, 2.6923, 1, 10);
  const marginMm = sanitizeMm(p.marginMm, 2, 0, 50);
  const dpi = normalizeDpi(p.dpi);
  const splitsX = sanitizeCount(p.splitsX, 1, 64);
  const splitsY = sanitizeCount(p.splitsY, 1, 64);
  const paperRatio =
    typeof p.paperRatio === 'number' && Number.isFinite(p.paperRatio) && p.paperRatio > 0.05 && p.paperRatio <= 20
      ? p.paperRatio
      : DEFAULT_PAPER_RATIO;
  const gutterMm = sanitizeMm(p.gutterMm ?? 9, 9, 0, 60);
  const headerMm = sanitizeMm(p.headerMm ?? 12, 12, 0, 80);
  const footerMm = sanitizeMm(p.footerMm ?? 8, 8, 0, 80);
  const fill = sanitizeRatio(p.beadFillRatio ?? 0.9, 0.9);

  const cellPx = mmToPx(pitchMm, dpi);
  const marginPx = mmToPx(marginMm, dpi);
  const gutterPx = mmToPx(gutterMm, dpi);
  const headerPx = mmToPx(headerMm, dpi);
  const footerPx = mmToPx(footerMm, dpi);

  const regions = buildRegions(cols, rows, splitsX, splitsY);
  const sheets: RegionSheetLayout[] = regions.map((region, index) => {
    const areaWidthPx = region.cols * cellPx;
    const areaHeightPx = region.rows * cellPx;
    // 内容盒：左/右 = 编号带 + 板留白；上 = 页眉 + 编号带 + 板留白；下 = 板留白 + 编号带 + 页脚
    const contentWidthPx = 2 * (gutterPx + marginPx) + areaWidthPx;
    const contentHeightPx = headerPx + 2 * (gutterPx + marginPx) + areaHeightPx + footerPx;

    // 按纸张比例补白（只增不减，绝不缩放内容）
    let sheetW = contentWidthPx;
    let sheetH = contentHeightPx;
    if (contentWidthPx / contentHeightPx > paperRatio) {
      sheetH = contentWidthPx / paperRatio;
    } else {
      sheetW = contentHeightPx * paperRatio;
    }
    const widthPx = Math.max(1, Math.ceil(sheetW));
    const heightPx = Math.max(1, Math.ceil(sheetH));
    const padX = (widthPx - contentWidthPx) / 2;
    const padY = (heightPx - contentHeightPx) / 2;

    const boardX = padX + gutterPx;
    const boardY = padY + headerPx + gutterPx;
    const originX = boardX + marginPx;
    const originY = boardY + marginPx;
    const boardRect: Rect = {
      x: boardX,
      y: boardY,
      w: areaWidthPx + 2 * marginPx,
      h: areaHeightPx + 2 * marginPx,
    };

    const sheet: RegionSheetLayout = {
      index,
      label: region.label || regionLabel(region.ix, region.iy),
      ix: region.ix,
      iy: region.iy,
      col0: region.col0,
      row0: region.row0,
      cols: region.cols,
      rows: region.rows,
      dpi,
      cellPx,
      beadRadiusPx: 0.5 * cellPx * fill,
      marginPx,
      gutterPx,
      headerPx,
      footerPx,
      areaWidthPx,
      areaHeightPx,
      contentWidthPx,
      contentHeightPx,
      widthPx,
      heightPx,
      totalPixels: widthPx * heightPx,
      padX,
      padY,
      originX,
      originY,
      boardRect,
      alignRect: boardRect,
      cellRect: (localCol, localRow) => ({
        x: originX + localCol * cellPx,
        y: originY + localRow * cellPx,
        w: cellPx,
        h: cellPx,
      }),
      globalCellRect: (col, row) => {
        const lc = col - region.col0;
        const lr = row - region.row0;
        if (lc < 0 || lr < 0 || lc >= region.cols || lr >= region.rows) return null;
        return { x: originX + lc * cellPx, y: originY + lr * cellPx, w: cellPx, h: cellPx };
      },
      cellLeft: (localCol) => localCol * cellPx,
      cellTop: (localRow) => localRow * cellPx,
      cellCenter: (localCol, localRow) => ({
        x: originX + (localCol + 0.5) * cellPx,
        y: originY + (localRow + 0.5) * cellPx,
      }),
      // 编号带两条基线：外带 = 全局编号，内带 = 局部编号
      colNumberY: {
        global: boardY - marginPx - gutterPx * 0.5,
        local: boardY - marginPx - gutterPx * 0.16,
      },
      rowNumberX: {
        global: boardX - marginPx - gutterPx * 0.5,
        local: boardX - marginPx - gutterPx * 0.16,
      },
    };
    return sheet;
  });

  const maxSheetPixels = sheets.reduce((m, s) => Math.max(m, s.totalPixels), 0);
  const biggest = sheets.reduce<RegionSheetLayout | null>(
    (m, s) => (m === null || s.totalPixels > m.totalPixels ? s : m),
    null,
  );

  return {
    splitsX,
    splitsY,
    dpi,
    paperRatio,
    sheets,
    maxSheetPixels,
    // 以「最大单张」的真实画布尺寸为口径做内存保护
    budget: biggest
      ? budgetFromPixels(biggest.widthPx, biggest.heightPx, dpi, '分块图纸单张')
      : budgetFromPixels(1, 1, dpi, '分块图纸单张'),
  };
}

/* ==================== 预览图布局 ==================== */

export interface PreviewLayoutParams {
  cols: number;
  rows: number;
  /** 每格像素，默认 12 */
  cellPx?: number;
  /** 四边内边距，默认 cellPx * 2 */
  paddingPx?: number;
  /** 底部水印条高度，默认 cellPx * 2.2（watermark 关闭时传 0） */
  bandPx?: number;
  beadFillRatio?: number;
}

export interface PreviewLayout {
  cols: number;
  rows: number;
  cellPx: number;
  paddingPx: number;
  bandPx: number;
  beadFillRatio: number;
  beadRadiusPx: number;
  areaWidthPx: number;
  areaHeightPx: number;
  widthPx: number;
  heightPx: number;
  totalPixels: number;
  originX: number;
  originY: number;
  /** 板外框（含圆角）矩形 */
  boardRect: Rect;
  /** 水印条矩形 */
  bandRect: Rect;
  cellRect(col: number, row: number): Rect;
  cellCenter(col: number, row: number): { x: number; y: number };
  isInside(col: number, row: number): boolean;
}

/** 分享用预览图布局（非物理尺寸，按 cellPx 等距网格） */
export function computePreviewLayout(p: PreviewLayoutParams): PreviewLayout {
  const cols = sanitizeCount(p.cols, 104);
  const rows = sanitizeCount(p.rows, 104);
  const cellPx = clampNumber(p.cellPx, 12, 1, 256);
  const paddingPx = clampNumber(p.paddingPx, cellPx * 2, 0, 8192);
  const bandPx = clampNumber(p.bandPx, 0, 0, 8192);
  const fill = sanitizeRatio(p.beadFillRatio ?? 0.92, 0.92);

  const areaWidthPx = cols * cellPx;
  const areaHeightPx = rows * cellPx;
  const widthPx = Math.max(1, Math.ceil(2 * paddingPx + areaWidthPx));
  const heightPx = Math.max(1, Math.ceil(2 * paddingPx + areaHeightPx + bandPx));
  const originX = paddingPx;
  const originY = paddingPx;

  return {
    cols,
    rows,
    cellPx,
    paddingPx,
    bandPx,
    beadFillRatio: fill,
    beadRadiusPx: 0.5 * cellPx * fill,
    areaWidthPx,
    areaHeightPx,
    widthPx,
    heightPx,
    totalPixels: widthPx * heightPx,
    originX,
    originY,
    boardRect: { x: originX, y: originY, w: areaWidthPx, h: areaHeightPx },
    bandRect: { x: 0, y: originY + areaHeightPx, w: widthPx, h: bandPx },
    cellRect: (col, row) => ({
      x: originX + col * cellPx,
      y: originY + row * cellPx,
      w: cellPx,
      h: cellPx,
    }),
    cellCenter: (col, row) => ({
      x: originX + (col + 0.5) * cellPx,
      y: originY + (row + 0.5) * cellPx,
    }),
    isInside: (col, row) => col >= 0 && col < cols && row >= 0 && row < rows,
  };
}

/* ==================== 编号 / 文字排版计算 ==================== */

/** 需要标注编号的格序号（0-based，每 every 格一个，含第 0 格） */
export function numberTicks(count: number, every: number): number[] {
  const ticks: number[] = [];
  const step = Math.max(1, Math.round(Number.isFinite(every) ? every : 1));
  for (let i = 0; i < count; i += step) ticks.push(i);
  return ticks;
}

/** 需要加粗的主网格线序号（0..count，含两端） */
export function majorTicks(count: number, every: number): number[] {
  const ticks: number[] = [];
  const step = Math.max(1, Math.round(Number.isFinite(every) ? every : 1));
  for (let i = 0; i <= count; i += step) ticks.push(i);
  return ticks;
}

/** 按可用高度求字号（像素），并夹到 [minFont, maxFont] */
export function fitFontSize(availablePx: number, factor = 0.62, minFont = 6, maxFont = 200): number {
  const size = availablePx * factor;
  return Math.min(maxFont, Math.max(minFont, size));
}

/* ==================== 配色解析（纯函数，供打印增强用） ==================== */

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED_COLORS: Record<string, string> = {
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'rgba(0,0,0,0)',
};

/** 解析 `#RGB` / `#RRGGBB` / `#RRGGBBAA` / `rgb()` / `rgba()`；失败返回 null */
export function parseCssColor(input: string): RgbaColor | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0) return null;
  const named = NAMED_COLORS[raw.toLowerCase()];
  const s = named ?? raw;

  if (s.charAt(0) === '#') {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
      const g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
      const b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
      const a = hex.length === 4 ? parseInt(hex.charAt(3) + hex.charAt(3), 16) / 255 : 1;
      if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
      return { r, g, b, a: Number.isFinite(a) ? a : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
      return { r, g, b, a: Number.isFinite(a) ? a : 1 };
    }
    return null;
  }

  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const parts = (m[1] as string).split(/[,\s/]+/).filter((x) => x.length > 0);
    if (parts.length < 3) return null;
    const num = (v: string): number => {
      if (v.endsWith('%')) return (parseFloat(v) / 100) * 255;
      return parseFloat(v);
    };
    const r = num(parts[0] as string);
    const g = num(parts[1] as string);
    const b = num(parts[2] as string);
    const a = parts.length >= 4 ? num(parts[3] as string) : 1;
    if (![r, g, b, a].every((v) => Number.isFinite(v))) return null;
    return {
      r: Math.min(255, Math.max(0, r)),
      g: Math.min(255, Math.max(0, g)),
      b: Math.min(255, Math.max(0, b)),
      a: Math.min(1, Math.max(0, a)),
    };
  }
  return null;
}

/** sRGB 相对亮度（WCAG 口径，0–1） */
export function relativeLuminance(c: RgbaColor): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** 颜色字符串的亮度；解析失败返回 fallbackLuma */
export function luminanceOf(color: string, fallbackLuma = 0.5): number {
  const c = parseCssColor(color);
  return c ? relativeLuminance(c) : fallbackLuma;
}

export function isDarkColor(color: string, threshold = 0.35): boolean {
  return luminanceOf(color, 0) < threshold;
}

export function rgbaString(c: RgbaColor): string {
  const r = Math.round(c.r);
  const g = Math.round(c.g);
  const b = Math.round(c.b);
  const a = Math.round(c.a * 1000) / 1000;
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * 打印用「墨水色」：
 * - 原色太浅（亮度 > 0.55，如 glowDark 主题的白色网格线）→ 换成深色 fallback，否则印在白纸上看不见；
 * - 原色够深但太透明 → 提升不透明度到 minAlpha，保证激光/喷墨都能出灰阶。
 */
export function printInk(color: string, fallbackHex: string, minAlpha: number): string {
  const c = parseCssColor(color);
  const fb = parseCssColor(fallbackHex) ?? { r: 40, g: 40, b: 40, a: 1 };
  if (!c) return rgbaString({ ...fb, a: minAlpha });
  if (relativeLuminance({ ...c, a: 1 }) > 0.55) return rgbaString({ ...fb, a: minAlpha });
  return rgbaString({ r: c.r, g: c.g, b: c.b, a: Math.max(c.a, minAlpha) });
}

/**
 * 打印用「填充色」：大面积填充若过深（如 glowDark 的纯黑空格）会把整页墨耗光，
 * 替换为极浅灰；其余保持主题原值。
 */
export function printFill(color: string, fallback: string): string {
  const c = parseCssColor(color);
  if (!c) return fallback;
  if (c.a <= 0.02) return fallback;
  if (relativeLuminance(c) < 0.18) return fallback;
  return rgbaString(c);
}

export type ExportStyle = 'theme' | 'print';

/** 导出用配色（12 项，全部为可直接赋给 ctx.fillStyle/strokeStyle 的 CSS 颜色串） */
export interface ExportColors {
  /** 画布最外层（纸张）底色 */
  paper: string;
  /** 板区底色 */
  boardBg: string;
  gridLine: string;
  gridLineMajor: string;
  emptyCell: string;
  emptyCellStroke: string;
  beadStroke: string;
  numberText: string;
  /** 强调色：区块编号 / L 形对齐标记 / 已放置勾 */
  accent: string;
  /** 板外框 */
  frame: string;
  /** 页眉页脚说明文字 */
  caption: string;
  watermark: string;
}

/**
 * 由主题 Canvas 令牌解析导出配色。
 * - `theme`：所见即所得，与屏幕渲染完全一致（预览图用）。
 * - `print`：**主题令牌 + 打印增强**（白纸底、线条对比度提升、深色底自动翻白、
 *   大面积深色填充降级为浅灰），既保留主题气质又能真打印出来。
 */
export function resolveExportColors(style: ExportStyle, tokens: CanvasTokens): ExportColors {
  if (style === 'theme') {
    return {
      paper: tokens.canvasBg,
      boardBg: tokens.canvasBg,
      gridLine: tokens.gridLine,
      gridLineMajor: tokens.gridLineMajor,
      emptyCell: tokens.emptyCell,
      emptyCellStroke: tokens.emptyCellStroke,
      beadStroke: tokens.beadStroke,
      numberText: tokens.numberText,
      accent: tokens.selectionStroke,
      frame: tokens.gridLineMajor,
      caption: tokens.numberText,
      watermark: tokens.numberText,
    };
  }
  const darkBoard = isDarkColor(tokens.canvasBg, 0.35);
  return {
    paper: '#FFFFFF',
    boardBg: darkBoard ? '#FFFFFF' : tokens.canvasBg,
    gridLine: printInk(tokens.gridLine, '#5A5A5A', 0.42),
    gridLineMajor: printInk(tokens.gridLineMajor, '#101010', 0.85),
    emptyCell: printFill(tokens.emptyCell, 'rgba(120, 120, 120, 0.07)'),
    emptyCellStroke: printInk(tokens.emptyCellStroke, '#9A9A9A', 0.6),
    beadStroke: printInk(tokens.beadStroke, '#2B2B2B', 0.5),
    numberText: printInk(tokens.numberText, '#1F1F1F', 0.95),
    accent: printInk(tokens.selectionStroke, '#C0392B', 0.95),
    frame: printInk(tokens.gridLineMajor, '#101010', 0.9),
    caption: 'rgba(70, 70, 70, 0.88)',
    watermark: 'rgba(95, 95, 95, 0.55)',
  };
}

/** 豆点高亮色（预览图用）：按底色亮度决定用白高光还是暗高光 */
export function beadHighlightColor(hex: string): string {
  return isDarkColor(hex, 0.45) ? 'rgba(255, 255, 255, 0.30)' : 'rgba(255, 255, 255, 0.45)';
}

/** 豆点暗部色（预览图用） */
export function beadShadeColor(hex: string): string {
  return isDarkColor(hex, 0.45) ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.14)';
}

/* ==================== 文件名 ==================== */

/** 生成合法且稳定的导出文件名（不含扩展名之外的路径字符） */
export function buildFilename(parts: (string | number)[]): string {
  const base = parts
    .map((p) => String(p))
    .join('_')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${base || 'pindou'}.png`;
}
