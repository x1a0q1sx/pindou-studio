/**
 * src/core/region.ts —— 分区模式核心逻辑。
 *
 * 把 104×104 板按 splitsX × splitsY 切成若干区块，每块能在 1:1 下独立对齐。
 * 切换区块时保持板子物理位置不动、改变屏幕显示的内容区域。
 */
import type { BoardConfig, Calibration, DisplayMetrics, Region } from './types';
import { autoSuggestSplits, fitsOnScreen, pitchToDevicePx, sanitizeCalibration } from './geometry';

/**
 * 单轴块尺寸序列（用户反馈：第一块尽量占满，余量给末块）。
 *   ・有有效容量（0 < capacity < total 且前 count-1 块装得下）→ 前面每块 = capacity，末块 = 余量；
 *   ・否则回退均分（ceil 逐块、末块 clamp、退化块剔除）。
 */
export function blockSizes(total: number, count: number, capacity?: number): number[] {
  const n = Math.max(1, Math.floor(count) || 1);
  if (n === 1) return [total];
  const cap = capacity != null && Number.isFinite(capacity) ? Math.floor(capacity) : 0;
  if (cap > 0 && cap < total && cap * (n - 1) < total) {
    const sizes: number[] = [];
    for (let j = 0; j < n - 1; j++) sizes.push(cap);
    sizes.push(total - cap * (n - 1));
    return sizes;
  }
  const even = Math.ceil(total / n);
  const sizes: number[] = [];
  for (let j = 0; j < n; j++) {
    const size = Math.min(even, total - even * j);
    if (size > 0) sizes.push(size);
  }
  return sizes;
}

/**
 * 构建分区列表。
 * 区块按行优先排列：index = iy * splitsX + ix。
 */
export function buildRegions(
  boardCols: number,
  boardRows: number,
  splitsX: number,
  splitsY: number,
  blockCols?: number,
  blockRows?: number,
): Region[] {
  const regions: Region[] = [];
  const colSizes = blockSizes(boardCols, splitsX, blockCols);
  const rowSizes = blockSizes(boardRows, splitsY, blockRows);

  let row0 = 0;
  for (let iy = 0; iy < rowSizes.length; iy++) {
    let col0 = 0;
    for (let ix = 0; ix < colSizes.length; ix++) {
      const cols = colSizes[ix];
      const rows = rowSizes[iy];
      if (cols > 0 && rows > 0) {
        regions.push({
          id: `r-${ix}-${iy}`,
          label: regionLabel(ix, iy),
          ix,
          iy,
          col0,
          row0,
          cols,
          rows,
        });
      }
      col0 += cols;
    }
    row0 += rowSizes[iy];
  }
  return regions;
}

/**
 * 区块标签：A1 A2 B1 B2 ...（超过 26 列时用 AA1 之类）。
 */
export function regionLabel(ix: number, iy: number): string {
  let letter: string;
  if (ix < 26) {
    letter = String.fromCharCode(65 + ix);
  } else {
    const first = String.fromCharCode(65 + Math.floor(ix / 26) - 1);
    const second = String.fromCharCode(65 + (ix % 26));
    letter = first + second;
  }
  return `${letter}${iy + 1}`;
}

/**
 * 查找包含指定格子的区块。
 */
export function regionOf(regions: Region[], row: number, col: number): Region | null {
  for (const r of regions) {
    if (row >= r.row0 && row < r.row0 + r.rows && col >= r.col0 && col < r.col0 + r.cols) {
      return r;
    }
  }
  return null;
}

/**
 * 自动建议分区方案（封装 geometry.autoSuggestSplits）。
 */
export function suggestSplitsFor(
  board: BoardConfig,
  cal: Calibration | null,
  display: DisplayMetrics | null,
): { splitsX: number; splitsY: number; blockCols?: number; blockRows?: number } {
  if (!cal || !display) return { splitsX: 1, splitsY: 1 };
  const safeCal = sanitizeCalibration(cal);
  const fit = fitsOnScreen(board, safeCal, display);
  if (fit.fits) return { splitsX: 1, splitsY: 1 };
  const suggestion = autoSuggestSplits(board.cols, board.rows, fit.colsMax, fit.rowsMax);
  return {
    splitsX: suggestion.splitsX,
    splitsY: suggestion.splitsY,
    blockCols: suggestion.blockCols,
    blockRows: suggestion.blockRows,
  };
}

/**
 * 该区块在 1:1 下的设备像素矩形。
 * 返回 { x, y, width, height }（设备像素）。
 */
export function regionCanvasRect(
  region: Region,
  cal: Calibration,
): { x: number; y: number; width: number; height: number } {
  const safeCal = sanitizeCalibration(cal);
  const pitch = pitchToDevicePx(safeCal.pitchMm, safeCal);
  return {
    x: 0,
    y: 0,
    width: Math.round(region.cols * pitch.x),
    height: Math.round(region.rows * pitch.y),
  };
}

/**
 * 获取当前活跃区块的 offset 信息（供渲染器使用）。
 */
export function getActiveRegionOffset(
  boardCols: number,
  boardRows: number,
  splitsX: number,
  splitsY: number,
  activeIndex: number,
  blockCols?: number,
  blockRows?: number,
): { row0: number; col0: number; rows: number; cols: number } | null {
  if (splitsX <= 1 && splitsY <= 1) return null;
  const regions = buildRegions(boardCols, boardRows, splitsX, splitsY, blockCols, blockRows);
  const region = regions[activeIndex];
  if (!region) return null;
  return { row0: region.row0, col0: region.col0, rows: region.rows, cols: region.cols };
}
