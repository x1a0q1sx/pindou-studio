/**
 * src/core/geometry.ts —— 物理换算核心（纯函数，零副作用）。
 *
 * 【精度要求 · 务必理解】
 * 1. 面板各向异性：本机横向 0.12891 mm/px、纵向 0.13125 mm/px，差 1.8%——必须分轴计算。
 * 2. devicePx 取整偏差：Electron 的 `screen.getAllDisplays()` 报的 bounds 是 DIP（设备无关像素），
 *    devicePx = Math.round(bounds × scaleFactor)。本机 DIP 1707×1067 × 1.5 = 2560.5×1600.5 →
 *    取整后 2561×1601，而面板真实帧缓冲为 2560×1600（差 0.04%）。此偏差来源已记录。
 *    → 本模块用 `refineDevicePx()` 显式修正：真实面板的宽/高几乎总是偶数（2560/1920/3840…），
 *      当 dpr 非整数且 devicePx 为奇数时，判定为「DIP×scale 向上取整」产物并回退 1px。
 *      修正后 mmPerDevicePx = 330/2560 = 0.12890625（横）、210/1600 = 0.13125（纵），与实测吻合。
 *    → 双保险：即便不修正，在 maxCellsAt1to1 等计算中，若 areaDevicePx 与 mmPerDevicePx 的来源
 *      一致（同一 devicePx），偏差也会在除法中精确抵消（physicalMm / pitchMm），不影响结果。
 *    但在逐格像素定位时（渲染器侧），必须用**独立取整** `round(origin + i*pitch)` 而非累加步长，
 *    以确保累计误差恒 < 0.5 设备像素。
 * 3. 用户标尺校准可覆盖自动值：CalibrationWizard 的四种方式最终都归一到 Calibration 写入 store，
 *    此处所有函数只接受 Calibration 参数——校准来源由调用方决定。
 *
 * 【换算推导】
 *   mmPerDevicePx = physicalMm / devicePx                       （每设备像素对应的物理毫米数）
 *   ppi = 25.4 / mmPerDevicePx                                   （每英寸像素数）
 *   pitchDevicePx = pitchMm / mmPerDevicePx                      （一格钉距对应多少设备像素）
 *   pitchCssPx = pitchDevicePx / dpr                              （一格钉距对应多少 CSS 像素）
 *   maxCells = floor(screenAreaDevicePx / pitchDevicePx)          （1:1 能放多少格）
 *             = floor(screenAreaDevicePx × mmPerDevicePx / pitchMm)
 *   boardPhysicalMm = cols × pitchMm + 2 × marginMm               （含边距的整板物理尺寸）
 */
import type { BoardConfig, Calibration, DisplayMetrics } from './types';

/* ================= 基础换算 ================= */

/**
 * 【最高精度来源】修正 Electron 报的 devicePx 取整偏差。
 *
 * 原理：Electron `display.bounds` 是 DIP，`devicePx = Math.round(DIP × scaleFactor)`。
 * 当 scaleFactor 非整数（如 1.5）时，DIP × scaleFactor 可能落在 .5 上被向上取整：
 *   本机 1707 × 1.5 = 2560.5 → 2561（真值 2560）；1067 × 1.5 = 1600.5 → 1601（真值 1600）
 * 而真实面板的宽/高在现实中几乎总是偶数（2560/1920/3840/1080/1600…），奇数帧缓冲不存在。
 * 故：dpr 非整数 && devicePx 为奇数 → 判定为取整产物，回退 1px 得到真值。
 *
 * 返回 adjusted 标记，便于 UI/日志透明地告知用户做了修正。
 */
export function refineDevicePx(display: DisplayMetrics): {
  width: number;
  height: number;
  adjusted: boolean;
} {
  const rawW = display.devicePx.width;
  const rawH = display.devicePx.height;
  const dpr = display.devicePixelRatio;
  // dpr 为整数（1/2/3）时 DIP×dpr 必为整数，不存在取整偏差
  const fractionalDpr = Math.abs(dpr - Math.round(dpr)) > 1e-6;
  const w = fractionalDpr && rawW % 2 === 1 ? rawW - 1 : rawW;
  const h = fractionalDpr && rawH % 2 === 1 ? rawH - 1 : rawH;
  return { width: w, height: h, adjusted: w !== rawW || h !== rawH };
}

/**
 * 从 DisplayMetrics 提取分轴 mm/设备像素（优先使用最高精度来源）。
 * 若 physicalMm 或 devicePx 无效则返回 null（虚拟屏/浏览器降级）。
 *
 * 本机实测：330/2560 = 0.128906（横）、210/1600 = 0.131250（纵），两轴差 1.8%。
 */
export function mmPerDevicePx(display: DisplayMetrics): { x: number; y: number } | null {
  if (!display.physicalMm) return null;
  const { width: pw, height: ph } = display.physicalMm;
  const { width: dw, height: dh } = refineDevicePx(display);
  if (dw <= 0 || dh <= 0 || pw <= 0 || ph <= 0) return null;
  return { x: pw / dw, y: ph / dh };
}

/**
 * 分轴 PPI（每英寸像素数）= 25.4 / mmPerDevicePx。
 */
export function ppiOf(display: DisplayMetrics): { x: number; y: number } | null {
  const mm = mmPerDevicePx(display);
  if (!mm) return null;
  return { x: 25.4 / mm.x, y: 25.4 / mm.y };
}

/**
 * 钉距 → 设备像素（分轴！）。
 * pitchDevicePx.x = pitchMm / cal.mmPerDevicePxX
 * 本机实测：2.6923 / 0.12890625 ≈ 20.886 (横)，2.6923 / 0.13125 ≈ 20.513 (纵)
 */
export function pitchToDevicePx(pitchMm: number, cal: Calibration): { x: number; y: number } {
  return {
    x: pitchMm / cal.mmPerDevicePxX,
    y: pitchMm / cal.mmPerDevicePxY,
  };
}

/**
 * 钉距 → CSS 像素（分轴）。CSS px = 设备 px / dpr。
 */
export function pitchToCssPx(pitchMm: number, cal: Calibration, dpr: number): { x: number; y: number } {
  const dev = pitchToDevicePx(pitchMm, cal);
  return { x: dev.x / dpr, y: dev.y / dpr };
}

/* ================= 容量与适配 ================= */

/**
 * 1:1 模式最多能在给定设备像素面积内放多少格。
 * areaDevicePx 通常 = display.devicePx（全屏）或实际画布 backing store 尺寸。
 *
 * 推导：maxCols = floor(areaW / pitchDevX) = floor(areaW × mmPerDevPxX / pitchMm)
 * 当 area 与 mmPerDevicePx 来源一致时，devicePx 取整偏差精确抵消：
 *   floor(devicePx × (physicalMm / devicePx) / pitchMm) = floor(physicalMm / pitchMm)
 */
export function maxCellsAt1to1(
  cal: Calibration,
  areaDevicePx: { width: number; height: number },
): { cols: number; rows: number } {
  const pitch = pitchToDevicePx(cal.pitchMm, cal);
  return {
    cols: Math.max(1, Math.floor(areaDevicePx.width / pitch.x)),
    rows: Math.max(1, Math.floor(areaDevicePx.height / pitch.y)),
  };
}

/**
 * 整板物理尺寸（mm），含两侧 marginMm。
 * width = cols × pitchMm + 2 × marginMm
 */
export function boardPhysicalSizeMm(board: BoardConfig): { width: number; height: number } {
  return {
    width: board.cols * board.pitchMm + 2 * board.marginMm,
    height: board.rows * board.pitchMm + 2 * board.marginMm,
  };
}

/**
 * 排豆区（网格）物理尺寸（mm），**不含**板边留白：cols × pitchMm × rows × pitchMm。
 * 这是「104 钉 = 280mm」对位校准真正要比对的区域（豆心到豆心的网格跨度），
 * 与含边框的「整板外形」区分开——用户贴实物板子对位时以网格区为准。
 */
export function beadAreaSizeMm(board: BoardConfig): { width: number; height: number } {
  return {
    width: board.cols * board.pitchMm,
    height: board.rows * board.pitchMm,
  };
}

/**
 * 整板在屏幕上的尺寸（设备像素 + CSS 像素），含 margin。
 * 用于判断是否超出屏幕、以及 CSS 布局定位。
 *
 * @param dpr 可选。省略时自动读 `window.devicePixelRatio`（SSR/Node 下回退 1）。
 *            CSS px = 设备 px / dpr，因此 dpr 必须正确才能得到可用的 CSS 尺寸。
 */
export function boardScreenSizePx(
  board: BoardConfig,
  cal: Calibration,
  dpr?: number,
): { widthDevicePx: number; heightDevicePx: number; widthCssPx: number; heightCssPx: number } {
  const ratio = dpr ?? currentDpr();
  return boardScreenSizePxWithDpr(board, cal, ratio);
}

/** 读取当前设备像素比（Node/SSR 安全） */
export function currentDpr(): number {
  if (typeof window !== 'undefined' && window.devicePixelRatio > 0) return window.devicePixelRatio;
  return 1;
}

/**
 * 显式传 DPR 的版本：整板在屏幕上的尺寸（设备像素 + CSS 像素）。
 * 与 boardScreenSizePx 等价，供需要明确控制 dpr 的调用方（如 Canvas 渲染器）使用。
 */
export function boardScreenSizePxWithDpr(
  board: BoardConfig,
  cal: Calibration,
  dpr: number,
): { widthDevicePx: number; heightDevicePx: number; widthCssPx: number; heightCssPx: number } {
  const pitch = pitchToDevicePx(board.pitchMm, cal);
  const marginDevX = board.marginMm / cal.mmPerDevicePxX;
  const marginDevY = board.marginMm / cal.mmPerDevicePxY;
  const wDev = board.cols * pitch.x + 2 * marginDevX;
  const hDev = board.rows * pitch.y + 2 * marginDevY;
  return {
    widthDevicePx: wDev,
    heightDevicePx: hDev,
    widthCssPx: wDev / dpr,
    heightCssPx: hDev / dpr,
  };
}

/**
 * 判断整板能否在给定显示器上 1:1 完整显示。
 * 返回：是否适配、最大可容格数、哪个方向溢出。
 *
 * 注：面积使用 refineDevicePx() 修正后的帧缓冲尺寸，与 mmPerDevicePx 保持同源，
 * 避免「分子用修正值、分母用原始值」引入新的不一致。
 */
export function fitsOnScreen(
  board: BoardConfig,
  cal: Calibration,
  display: DisplayMetrics,
): { fits: boolean; colsMax: number; rowsMax: number; overflowX: boolean; overflowY: boolean } {
  const refined = refineDevicePx(display);
  const max = maxCellsAt1to1(cal, { width: refined.width, height: refined.height });
  const overflowX = board.cols > max.cols;
  const overflowY = board.rows > max.rows;
  return {
    fits: !overflowX && !overflowY,
    colsMax: max.cols,
    rowsMax: max.rows,
    overflowX,
    overflowY,
  };
}

/* ================= 分区建议 ================= */

/**
 * 自动建议分区方案（纯函数，core/region.ts 会基于此做完整分区逻辑）。
 * 目标：找到最小的 splitsX × splitsY 使得每个分区都能 1:1 放入屏幕。
 * 两轴**独立**取最小值——屏幕宽度放得下就绝不横切（A1/B1 合二为一）。
 *
 * 本机示例：boardCols=104, boardRows=104, maxCols1to1=122, maxRows1to1=78
 *   → 横向 104 ≤ 122 放得下 → splitsX=1（不再强制切 2）
 *   → 纵向 104 > 78 → ceil(104/78)=2 → splitsY=2
 *   → 建议 1×2 = 两块 104×52 上下排（旧版强制对称会给出 2×2 = 52×52 四块）
 */
export function autoSuggestSplits(
  boardCols: number,
  boardRows: number,
  maxCols1to1: number,
  maxRows1to1: number,
): { splitsX: number; splitsY: number; regionCols: number; regionRows: number; blockCols: number; blockRows: number } {
  // 每个方向各自取「放得下所需的最少刀数」，互不牵连
  const splitsX = Math.max(1, Math.ceil(boardCols / Math.max(1, maxCols1to1)));
  const splitsY = Math.max(1, Math.ceil(boardRows / Math.max(1, maxRows1to1)));

  // 容量优先分块（用户反馈：不是均分两半，而是第一块尽量占满一屏，余量给末块）：
  // blockCols/blockRows = 满块容量（= 屏幕能容纳的格数），末块 = 总数 - 满块 × (块数-1)。
  // regionCols/regionRows 保留为「首块尺寸」= 满块容量，供 Toast 文案使用。
  const blockCols = Math.max(1, Math.min(boardCols, maxCols1to1));
  const blockRows = Math.max(1, Math.min(boardRows, maxRows1to1));

  return {
    splitsX,
    splitsY,
    regionCols: blockCols,
    regionRows: blockRows,
    blockCols,
    blockRows,
  };
}

/* ================= 辅助 ================= */

/**
 * 显示器唯一标识 key：`${id}|${w}x${h}|${dpr}`。
 * 用于按显示器记忆校准参数（换屏自动切换对应档）。
 */
export function displayKey(display: DisplayMetrics): string {
  return `${display.id}|${display.devicePx.width}x${display.devicePx.height}|${display.devicePixelRatio}`;
}

/* ================= 校准边界校验 ================= */

/** 默认校准值（本机实测） */
export const DEFAULT_CALIBRATION: Calibration = {
  pitchMm: 2.6923,
  mmPerDevicePxX: 330 / 2560,   // ≈ 0.128906
  mmPerDevicePxY: 210 / 1600,   // = 0.13125
  originDevicePx: { x: 0, y: 0 },
  source: 'auto-wmi',
  displayKey: 'default',
  verifiedAt: new Date().toISOString(),
};

/**
 * 边界校验 + 非法值回退默认。
 * - pitchMm 限 1.0–10.0（拼豆钉距不可能小于 1mm 或大于 10mm）
 * - mmPerDevicePx 限 0.01–1.0（对应 PPI 25.4–2540，覆盖所有真实显示器）
 */
export function sanitizeCalibration(cal: Calibration | null | undefined): Calibration {
  if (!cal) return { ...DEFAULT_CALIBRATION, verifiedAt: new Date().toISOString() };

  const pitchMm = clamp(cal.pitchMm, 1.0, 10.0, DEFAULT_CALIBRATION.pitchMm);
  const mmX = clamp(cal.mmPerDevicePxX, 0.01, 1.0, DEFAULT_CALIBRATION.mmPerDevicePxX);
  const mmY = clamp(cal.mmPerDevicePxY, 0.01, 1.0, DEFAULT_CALIBRATION.mmPerDevicePxY);
  const ox = Number.isFinite(cal.originDevicePx?.x) ? cal.originDevicePx.x : 0;
  const oy = Number.isFinite(cal.originDevicePx?.y) ? cal.originDevicePx.y : 0;

  return {
    pitchMm,
    mmPerDevicePxX: mmX,
    mmPerDevicePxY: mmY,
    originDevicePx: { x: ox, y: oy },
    source: cal.source ?? 'auto-wmi',
    displayKey: cal.displayKey ?? 'default',
    verifiedAt: cal.verifiedAt ?? new Date().toISOString(),
  };
}

/**
 * 按「屏幕上图纸的实测尺寸」逐轴反算校准。
 * 背景：EDID/预设报的物理尺寸 X/Y 可能各偏各的（如 28cm 板屏上量得 27.8×27.6），
 * 同比例的整板对位微调修不了各向异性误差，这里按比率精确解：
 *   该轴渲染出的设备像素数 P = expectedMm / assumedMmPerPx 不变，
 *   屏上实测 measuredMm → 真 mmPerPx = assumedMmPerPx × (measuredMm / expectedMm)。
 * 传 0/NaN 的轴跳过不校正；比率限 0.5–2 防误输毁档；两轴都无效返回 null。
 */
export function boardAlignCalibration(
  cal: Calibration,
  expectedWmm: number,
  measuredWmm: number,
  expectedHmm: number,
  measuredHmm: number,
): { cal: Calibration; factorX: number | null; factorY: number | null } | null {
  const factor = (expected: number, measured: number): number | null => {
    if (!(measured > 0) || !(expected > 0)) return null;
    const f = measured / expected;
    return f >= 0.5 && f <= 2 ? f : null;
  };
  const fx = factor(expectedWmm, measuredWmm);
  const fy = factor(expectedHmm, measuredHmm);
  if (fx === null && fy === null) return null;
  return {
    cal: sanitizeCalibration({
      ...cal,
      mmPerDevicePxX: cal.mmPerDevicePxX * (fx ?? 1),
      mmPerDevicePxY: cal.mmPerDevicePxY * (fy ?? 1),
      source: 'manual-span',
      verifiedAt: new Date().toISOString(),
    }),
    factorX: fx,
    factorY: fy,
  };
}

/** 内部工具：clamp 并在非法时回退 */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

/* ================= 从 DisplayMetrics 生成初始 Calibration ================= */

/**
 * 根据显示器信息自动生成初始校准（WMI 自动检测路径）。
 * 若 physicalMm 为 null（浏览器/虚拟屏），返回 browser-fallback 校准（需手动标尺校准）。
 */
export function calibrationFromDisplay(display: DisplayMetrics): Calibration {
  const key = displayKey(display);
  const now = new Date().toISOString();

  if (display.physicalMm && display.devicePx.width > 0 && display.devicePx.height > 0) {
    // Electron + WMI 有效物理尺寸 → 高精度自动校准（走 mmPerDevicePx 以享受 refineDevicePx 修正）
    const mm = mmPerDevicePx(display);
    if (mm) {
      return {
        pitchMm: DEFAULT_CALIBRATION.pitchMm,
        mmPerDevicePxX: mm.x,
        mmPerDevicePxY: mm.y,
        originDevicePx: { x: 0, y: 0 },
        source: 'auto-wmi',
        displayKey: key,
        verifiedAt: now,
      };
    }
  }

  // 浏览器降级：无法自动获取物理尺寸，用默认值占位，等用户手动校准
  return {
    pitchMm: DEFAULT_CALIBRATION.pitchMm,
    mmPerDevicePxX: DEFAULT_CALIBRATION.mmPerDevicePxX,
    mmPerDevicePxY: DEFAULT_CALIBRATION.mmPerDevicePxY,
    originDevicePx: { x: 0, y: 0 },
    source: 'browser-fallback',
    displayKey: key,
    verifiedAt: now,
  };
}
