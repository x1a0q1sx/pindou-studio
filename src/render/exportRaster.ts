/**
 * src/render/exportRaster.ts —— 图纸栅格（PNG）导出引擎（导出产物 1/2/3）。
 *
 * ══════════════════════ 给 `ExportDialog` 的对接契约 ══════════════════════
 * 【失败语义】三个导出函数**永不 reject、永不静默失败**，一律返回「判别联合」（discriminated union）：
 *   成功 → `{ ok: true,  kind, filename, mime:'image/png', blob?, dataUrl, width, height, dpi, bytes?, sizeMm?, label? }`
 *   失败 → `{ ok: false, kind, code, error, suggestDpi? }`，`error` 为**可直接展示的中文提示**；
 *   `code === 'too-large'` 时额外给出 `suggestDpi`（数字），供 ExportDialog 渲染「改用 XXX DPI 重试」按钮。
 *   消费方式：
 *     const r = await exportSheet1to1(usePdbStore.getState(), { dpi: 300 });
 *     if (!r.ok) { pushToast('danger', r.error); return; }
 *     saveFile(r.filename, r.dataUrl || r.blob);           // io/exporters.ts 二选一即可
 *   `exportRegionSheets` 成功时返回 `{ ok:true, kind:'region', sheets: ExportSuccess[], count, splitsX, splitsY, dpi }`，
 *   `sheets` 为**每区块一张 PNG** 的数组（按行优先顺序，`label` = A1/B1/A2/B2…）。
 *
 * 【blob / dataUrl】二者至少提供一个：
 *   - OffscreenCanvas 路径 → 必有 `blob`（convertToBlob）；`dataUrl` 由 FileReader 转出（环境无 FileReader 时为 ''）
 *   - HTMLCanvasElement 路径 → 必有 `dataUrl`（toDataURL）+ `blob`（toBlob，缺失时由 dataURL 反解）
 *   - 像素量 > 20,000,000（约 600DPI 整板）时**默认不再额外生成 dataURL**（base64 会再吃 1.33 倍内存），
 *     此时 `dataUrl === ''`、`blob` 仍可用；可用 `opts.includeDataUrl = true` 强制生成。
 *
 * 【隔离铁律】全部绘制发生在**本模块自建的独立离屏 canvas** 上（优先 OffscreenCanvas，
 *   降级 document.createElement('canvas')），**绝不引用/复用/干扰**屏幕上 `Renderer`/`LayerSystem`
 *   的任何实例、缓存或 transform；导出为**纯只读**操作：只读 state 快照，绝不调用任何 mutate action。
 *
 * 【精度铁律】打印图纸是**纸张物理精度**（非屏幕像素对齐），故格边界用浮点坐标：
 *   `px = mm / 25.4 * dpi`，每格边界 = `origin + i * cellPx` **独立乘法**（与渲染器同一条铁律，
 *   绝不累加步长），故 `cols * pitchMm` 的总宽累计误差恒为 0（已由 exportLayout 单测证实）。
 *
 * 【内存保护】入口先按 dpi 估算像素总量，超过 `MAX_EXPORT_PIXELS`（8000 万像素 ≈ 320MB RGBA）
 *   直接返回中文错误并建议降低 DPI，绝不让浏览器崩溃。分块图纸逐张创建/编码/释放，峰值内存 = 单张。
 *
 * 【视觉口径】`opts.style`：
 *   - `'print'`（1:1 与分块图纸默认）= **主题令牌 + 打印增强**：白纸底、线条对比度提升、
 *     深色主题底自动翻白（否则 glowDark 会印出满版黑）、大面积深色填充降级为浅灰。
 *     空格子仍取主题 `emptyCell`/`emptyCellStroke`（过深时按上述规则降级）。
 *   - `'theme'`（预览图固定使用）= 原样主题 Canvas 令牌，所见即所得。
 *
 * 【网格/编号开关】1:1 与分块图纸的 `showGrid/showMajorGrid/showNumbers` **默认恒为 true**
 *   （纸质施工图没有网格就失去意义），可由 opts 显式关闭；预览图不画网格。
 */
import type { BeadPalette, BoardConfig, Calibration, CanvasTokens, DisplayMetrics, ThemeId } from '@/core/types';
import { suggestSplitsFor } from '@/core/region';
import { getTheme } from '@/themes';
import {
  DEFAULT_PAPER_RATIO,
  beadHighlightColor,
  beadShadeColor,
  buildFilename,
  budgetFromPixels,
  computePreviewLayout,
  computeRegionLayout,
  computeSheetLayout,
  estimatePixelBudget,
  fitFontSize,
  mmToPx,
  normalizeDpi,
  numberTicks,
  pxToMm,
  resolveExportColors,
  shouldIncludeDataUrl,
} from './exportLayout';
import type {
  ExportColors,
  ExportStyle,
  PreviewLayout,
  Rect,
  RegionLayoutResult,
  RegionSheetLayout,
  SheetLayout,
} from './exportLayout';

/* ══════════════════════ 对外类型 ══════════════════════ */

/**
 * 导出所需的**只读状态快照**（结构化类型：`usePdbStore.getState()` 可直接传入，无需任何适配）。
 * 刻意不 import store，避免与并发任务产生模块耦合。
 */
export interface ExportState {
  board: BoardConfig;
  /** 调色板索引+1，0=空格（契约见 store/index.ts） */
  beads: Uint16Array;
  /** 1=已物理放置 */
  placedMask: Uint8Array;
  palette: BeadPalette;
  theme: ThemeId;
  region?: { splitsX: number; splitsY: number; activeIndex: number };
  calibration?: Calibration | null;
  display?: DisplayMetrics | null;
}

export type ExportKind = '1to1' | 'region' | 'preview';

export type ExportErrorCode =
  | 'too-large'          // 像素预算超限（中文提示含建议 DPI）
  | 'invalid-board'      // 板参数非法
  | 'canvas-unsupported' // 环境无离屏 canvas 能力
  | 'encode-failed'      // PNG 编码失败
  | 'unknown';

export interface ExportSuccess {
  ok: true;
  kind: ExportKind;
  /** 形如 `pindou_104x104_1to1_300dpi.png` / `pindou_region_A1_300dpi.png` / `pindou_preview.png` */
  filename: string;
  mime: 'image/png';
  /** PNG 二进制（OffscreenCanvas 路径必有；HTMLCanvas 路径由 toBlob 或 dataURL 反解得到） */
  blob?: Blob;
  /** base64 data URL；像素量过大或环境不支持时为 `''` */
  dataUrl: string;
  width: number;
  height: number;
  /** 1:1/分块 = 真实打印 DPI；预览图 = 96（屏幕像素口径，不代表物理精度） */
  dpi: number;
  /** PNG 字节数（拿到 blob 时提供） */
  bytes?: number;
  /** 图纸的**物理尺寸**（mm，含板留白、不含标注槽），供 UI 显示「294 × 294 mm」与打印核验 */
  sizeMm?: { width: number; height: number };
  /** 分块图纸专用：区块编号（A1/B1/…） */
  label?: string;
}

export interface ExportFailure {
  ok: false;
  kind: ExportKind;
  code: ExportErrorCode;
  /** 可直接展示给用户的中文错误信息 */
  error: string;
  filename?: string;
  /**
   * 仅 `code === 'too-large'` 时提供：建议改用的 DPI（已验证按此 DPI 重算可通过预算）。
   * ExportDialog 可直接渲染「改用 {suggestDpi} DPI 重试」按钮，无需解析中文文案。
   */
  suggestDpi?: number | null;
}

export type ExportResult = ExportSuccess | ExportFailure;

export interface RegionSheetsSuccess {
  ok: true;
  kind: 'region';
  /** 每区块一张 PNG，按行优先顺序（index = iy*splitsX + ix） */
  sheets: ExportSuccess[];
  count: number;
  splitsX: number;
  splitsY: number;
  dpi: number;
}

export type RegionSheetsResult = RegionSheetsSuccess | ExportFailure;

export interface Sheet1to1Options {
  /** 150 | 300 | 600（任意值会被夹到 [72,1200]），默认 300 */
  dpi?: number;
  /** 'print'（默认，主题色 + 打印增强）| 'theme'（原样主题色） */
  style?: ExportStyle;
  /**
   * 标注槽（每侧，画行列编号与说明），默认 **5mm**。
   * 104×104 + 双边 2mm 留白 = 284mm，加 2×5mm 标注槽 = **294mm**，正好落在 A4（297mm）内可 100% 打印。
   * 传 0 则图纸严格等于「板含留白」尺寸（284mm）。标注槽在板留白之外，**不影响排豆区物理精度**。
   */
  gutterMm?: number;
  /** 默认 true（纸质施工图必须有网格） */
  showGrid?: boolean;
  showMajorGrid?: boolean;
  showNumbers?: boolean;
  /** 已放置格加小勾，默认 false */
  showPlacedMarks?: boolean;
  /** 覆盖「像素量 > 2000 万时不生成 dataURL」的默认策略 */
  includeDataUrl?: boolean;
  /** 覆盖默认文件名 */
  filename?: string;
}

export interface RegionSheetsOptions {
  dpi?: number;
  style?: ExportStyle;
  /** 缺省时依次尝试 suggestSplitsFor → state.region → 兜底（大板 2×2） */
  splitsX?: number;
  splitsY?: number;
  /** 目标纸张宽高比（w/h），默认 A4 竖版 1/√2 ≈ 0.7071；内容不缩放，不足处留白居中 */
  paperRatio?: number;
  /** 编号带（每侧，含全局+局部两条编号），默认 9mm */
  gutterMm?: number;
  /** 页眉（区块编号 + 说明），默认 12mm */
  headerMm?: number;
  /** 页脚（打印提示），默认 8mm */
  footerMm?: number;
  showGrid?: boolean;
  showMajorGrid?: boolean;
  showNumbers?: boolean;
  showPlacedMarks?: boolean;
  /** 只导出指定 index 的区块（缺省 = 全部） */
  onlyIndex?: number;
  includeDataUrl?: boolean;
}

export interface PreviewOptions {
  /** 每格像素，默认 12（夹到 [4,64]） */
  cellPx?: number;
  /** 水印文字，默认 `'PinDou Studio'`；传 `null` 或 `''` 关闭 */
  watermark?: string | null;
  /** 已放置格（placedMask===1）加小勾，默认 false */
  showPlacedMarks?: boolean;
  /** 覆盖 state.theme（预览另一套主题时用） */
  theme?: ThemeId;
  /** 四边内边距，默认 cellPx*2 */
  paddingPx?: number;
  /** 板面圆角半径，默认 cellPx*1.5 */
  cornerPx?: number;
  includeDataUrl?: boolean;
  filename?: string;
}

/* ══════════════════════ 常量 ══════════════════════ */

const TAU = Math.PI * 2;
/** 预览图的 dpi 口径（屏幕像素图，非物理打印） */
const PREVIEW_DPI = 96;
const DEFAULT_SHEET_GUTTER_MM = 5;
/** 技术标注字体：Bahnschrift（Windows 自带的 DIN 风格 condensed 无衬线，工程制图气质），逐级降级 */
const FONT_TECH =
  '"Bahnschrift", "DIN Alternate", "DIN Condensed", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
/** 正文/编号字体：人文无衬线，数字清晰 */
const FONT_TEXT =
  '"Segoe UI", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif';

/* ══════════════════════ 离屏画布封装 ══════════════════════ */

interface EncodedPng {
  blob?: Blob;
  dataUrl: string;
  bytes?: number;
}

interface Surface {
  width: number;
  height: number;
  ctx: CanvasRenderingContext2D;
  encode(includeDataUrl: boolean): Promise<EncodedPng>;
  dispose(): void;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    if (typeof FileReader === 'undefined') {
      resolve('');
      return;
    }
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    } catch {
      resolve('');
    }
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    try {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    if (meta.endsWith(';base64')) {
      if (typeof atob !== 'function') return null;
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: 'image/png' });
    }
    return new Blob([decodeURIComponent(body)], { type: 'image/png' });
  } catch {
    return null;
  }
}

/**
 * 创建独立离屏画布：优先 OffscreenCanvas（可用 convertToBlob 时无需 DOM），
 * 降级 document.createElement('canvas')（toBlob / toDataURL）。两者都不可用时返回 null。
 */
function createSurface(width: number, height: number): Surface | null {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(w, h);
      const raw = oc.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (raw && typeof oc.convertToBlob === 'function') {
        return {
          width: w,
          height: h,
          ctx: raw as unknown as CanvasRenderingContext2D,
          encode: async (includeDataUrl) => {
            try {
              const blob = await oc.convertToBlob({ type: 'image/png' });
              const dataUrl = includeDataUrl ? await blobToDataUrl(blob) : '';
              return { blob, dataUrl, bytes: blob.size };
            } catch {
              return { blob: undefined, dataUrl: '', bytes: undefined };
            }
          },
          dispose: () => {
            oc.width = 0;
            oc.height = 0;
          },
        };
      }
    } catch {
      /* 尺寸过大或不支持 → 降级 HTMLCanvasElement */
    }
  }

  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    try {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (ctx) {
        return {
          width: w,
          height: h,
          ctx,
          encode: async (includeDataUrl) => {
            let dataUrl = '';
            if (includeDataUrl) {
              try {
                dataUrl = c.toDataURL('image/png');
              } catch {
                dataUrl = '';
              }
            }
            let blob = await canvasToBlob(c);
            if (!blob && dataUrl) blob = dataUrlToBlob(dataUrl);
            if (!blob && !dataUrl) {
              // 最后兜底：先生成 dataURL 再反解 blob
              try {
                dataUrl = c.toDataURL('image/png');
                blob = dataUrlToBlob(dataUrl);
              } catch {
                /* 环境完全不支持编码 */
              }
            }
            return { blob: blob ?? undefined, dataUrl, bytes: blob ? blob.size : undefined };
          },
          dispose: () => {
            c.width = 0;
            c.height = 0;
          },
        };
      }
    } catch {
      /* 环境不支持 */
    }
  }
  return null;
}

/* ══════════════════════ 绘制工具（纯 Canvas，无状态） ══════════════════════ */

/** 逐格绘制所需的几何与数据（1:1 图纸 / 分块图纸共用） */
interface CellPainter {
  beads: Uint16Array;
  placedMask: Uint8Array;
  palette: BeadPalette;
  /** 全板列数（索引换算 i = row*boardCols + col） */
  boardCols: number;
  /** 遍历范围（全局坐标） */
  col0: number;
  row0: number;
  cols: number;
  rows: number;
  cellPx: number;
  beadRadiusPx: number;
  /** 全局 (col,row) → 画布矩形 */
  rectAt(col: number, row: number): Rect;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function setText(
  ctx: CanvasRenderingContext2D,
  fontPx: number,
  color: string,
  align: CanvasTextAlign = 'center',
  baseline: CanvasTextBaseline = 'middle',
  stack: string = FONT_TEXT,
  weight = '',
): void {
  const size = Math.max(1, fontPx);
  ctx.font = `${weight ? `${weight} ` : ''}${size.toFixed(2)}px ${stack}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
}

/** 手动字距（canvas letterSpacing 兼容性不稳，逐字符绘制更可靠） */
function drawTrackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: CanvasTextAlign = 'left',
): number {
  const chars = Array.from(text);
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  let cursor = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i] as string, cursor, y);
    cursor += (widths[i] as number) + tracking;
  }
  ctx.textAlign = prevAlign;
  return total;
}

/** 四角 L 形对齐标记（供用户把透明板角对准纸上括标） */
function drawAlignMarks(ctx: CanvasRenderingContext2D, rect: Rect, color: string, armLen: number, lineWidth: number): void {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  const arm = Math.max(4, Math.min(armLen, Math.min(rect.w, rect.h) * 0.25));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'square';
  ctx.beginPath();
  ctx.moveTo(x0, y0 + arm); ctx.lineTo(x0, y0); ctx.lineTo(x0 + arm, y0);
  ctx.moveTo(x1 - arm, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + arm);
  ctx.moveTo(x0, y1 - arm); ctx.lineTo(x0, y1); ctx.lineTo(x0 + arm, y1);
  ctx.moveTo(x1 - arm, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - arm);
  ctx.stroke();
  ctx.restore();
}

interface GridOptions {
  originX: number;
  originY: number;
  cols: number;
  rows: number;
  cellPx: number;
  /** 主线判定的全局基准（分块图纸用 col0/row0，保证相邻区块主线连续） */
  baseCol: number;
  baseRow: number;
  colors: ExportColors;
  majorEvery: number;
  minorWidth: number;
  majorWidth: number;
}

/** 细网格线 + 每 majorEvery 格主线加粗 */
function drawGrid(ctx: CanvasRenderingContext2D, o: GridOptions): void {
  const x0 = o.originX;
  const y0 = o.originY;
  const x1 = o.originX + o.cols * o.cellPx;
  const y1 = o.originY + o.rows * o.cellPx;
  const isMajorCol = (c: number): boolean => o.majorEvery > 0 && (o.baseCol + c) % o.majorEvery === 0;
  const isMajorRow = (r: number): boolean => o.majorEvery > 0 && (o.baseRow + r) % o.majorEvery === 0;

  ctx.save();
  // 细线
  ctx.strokeStyle = o.colors.gridLine;
  ctx.lineWidth = o.minorWidth;
  ctx.beginPath();
  for (let c = 0; c <= o.cols; c++) {
    if (isMajorCol(c)) continue;
    const x = x0 + c * o.cellPx;
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
  }
  for (let r = 0; r <= o.rows; r++) {
    if (isMajorRow(r)) continue;
    const y = y0 + r * o.cellPx;
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();

  // 主线
  ctx.strokeStyle = o.colors.gridLineMajor;
  ctx.lineWidth = o.majorWidth;
  ctx.beginPath();
  for (let c = 0; c <= o.cols; c++) {
    if (!isMajorCol(c)) continue;
    const x = x0 + c * o.cellPx;
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
  }
  for (let r = 0; r <= o.rows; r++) {
    if (!isMajorRow(r)) continue;
    const y = y0 + r * o.cellPx;
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** 空格子：主题 emptyCell 填充 + emptyCellStroke 描边（批量单次 path，10816 格也只 2 次绘制调用） */
function drawEmptyCells(
  ctx: CanvasRenderingContext2D,
  p: CellPainter,
  colors: ExportColors,
  insetRatio: number,
  lineWidth: number,
): void {
  if (p.cellPx < 1.5) return;
  const inset = p.cellPx * insetRatio;
  const size = p.cellPx - 2 * inset;
  if (size <= 0.4) return;
  ctx.save();
  ctx.beginPath();
  for (let r = p.row0; r < p.row0 + p.rows; r++) {
    for (let c = p.col0; c < p.col0 + p.cols; c++) {
      if (p.beads[r * p.boardCols + c] !== 0) continue;
      const rect = p.rectAt(c, r);
      ctx.rect(rect.x + inset, rect.y + inset, size, size);
    }
  }
  ctx.fillStyle = colors.emptyCell;
  ctx.fill();
  if (lineWidth > 0) {
    ctx.strokeStyle = colors.emptyCellStroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
  ctx.restore();
}

function traceBeadPath(
  ctx: CanvasRenderingContext2D,
  list: number[],
  radius: number,
  shape: 'circle' | 'square' | 'ring',
): void {
  ctx.beginPath();
  for (let k = 0; k < list.length; k += 2) {
    const cx = list[k] as number;
    const cy = list[k + 1] as number;
    if (shape === 'square') {
      ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
    } else {
      ctx.moveTo(cx + radius, cy);
      ctx.arc(cx, cy, radius, 0, TAU);
    }
  }
}

interface BeadDrawOptions {
  shape: 'circle' | 'square' | 'ring';
  /** 豆点描边宽度（px），<=0 表示不描边 */
  lineWidth: number;
  /** ring 内圈填充色（= 板底色） */
  hollowFill: string;
  /** ring 内圈半径占比（渲染器口径 0.45） */
  hollowRatio?: number;
}

/** 豆点：按色分桶批量绘制（与渲染器 L1 同一手法，避免 10816 次 fillStyle 切换） */
function drawBeads(ctx: CanvasRenderingContext2D, p: CellPainter, colors: ExportColors, o: BeadDrawOptions): void {
  const radius = p.beadRadiusPx;
  if (radius < 0.2) return;
  const buckets = new Map<number, number[]>();
  for (let r = p.row0; r < p.row0 + p.rows; r++) {
    for (let c = p.col0; c < p.col0 + p.cols; c++) {
      const v = p.beads[r * p.boardCols + c];
      if (v === 0) continue;
      if (v - 1 >= p.palette.colors.length) continue;
      const rect = p.rectAt(c, r);
      let list = buckets.get(v);
      if (!list) {
        list = [];
        buckets.set(v, list);
      }
      list.push(rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
  }
  if (buckets.size === 0) return;

  const hollowRatio = o.hollowRatio ?? 0.45;
  ctx.save();
  for (const [v, list] of buckets) {
    const color = p.palette.colors[v - 1];
    if (!color) continue;
    // 1) 本色填充
    traceBeadPath(ctx, list, radius, o.shape);
    ctx.fillStyle = color.hex;
    ctx.fill();
    // 2) ring 内圈挖空
    if (o.shape === 'ring' && radius * hollowRatio >= 0.3) {
      traceBeadPath(ctx, list, radius * hollowRatio, 'circle');
      ctx.fillStyle = o.hollowFill;
      ctx.fill();
    }
    // 3) 描边（格子太小时省略，避免糊成一团）
    if (o.lineWidth > 0 && p.cellPx >= 3) {
      traceBeadPath(ctx, list, radius, o.shape);
      ctx.strokeStyle = colors.beadStroke;
      ctx.lineWidth = o.lineWidth;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** 已放置格小勾（placedMask === 1） */
function drawPlacedMarks(ctx: CanvasRenderingContext2D, p: CellPainter, color: string, lineWidth: number): void {
  const radius = p.beadRadiusPx;
  if (radius < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let any = false;
  for (let r = p.row0; r < p.row0 + p.rows; r++) {
    for (let c = p.col0; c < p.col0 + p.cols; c++) {
      const i = r * p.boardCols + c;
      if (p.beads[i] === 0 || p.placedMask[i] !== 1) continue;
      const rect = p.rectAt(c, r);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const sz = radius * 0.62;
      ctx.moveTo(cx - sz * 0.55, cy + sz * 0.02);
      ctx.lineTo(cx - sz * 0.12, cy + sz * 0.42);
      ctx.lineTo(cx + sz * 0.6, cy - sz * 0.38);
      any = true;
    }
  }
  if (any) ctx.stroke();
  ctx.restore();
}

/** 制图框（工程图纸气质：细外框 + 四角十字定位标） */
function drawDraftingBorder(ctx: CanvasRenderingContext2D, w: number, h: number, inset: number, color: string, lineWidth: number): void {
  if (inset <= 0 || w - 2 * inset < 8 || h - 2 * inset < 8) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(inset, inset, w - 2 * inset, h - 2 * inset);
  const tick = Math.min(12, inset * 0.9);
  ctx.beginPath();
  const corners: [number, number][] = [
    [inset, inset],
    [w - inset, inset],
    [inset, h - inset],
    [w - inset, h - inset],
  ];
  for (const [cx, cy] of corners) {
    const sx = cx < w / 2 ? 1 : -1;
    const sy = cy < h / 2 ? 1 : -1;
    ctx.moveTo(cx + sx * tick, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy * tick);
  }
  ctx.stroke();
  ctx.restore();
}

/* ══════════════════════ 1. 1:1 物理尺寸图纸 ══════════════════════ */

/**
 * 导出 **1:1 物理尺寸图纸 PNG**（导出产物 1）。
 * 打印后（选「实际大小 / 100%」，勿选「适应页面」）可直接垫在透明拼豆板下逐格放豆。
 *
 * @param state 只读状态快照（`usePdbStore.getState()` 可直接传入）
 * @param opts  见 {@link Sheet1to1Options}
 */
export async function exportSheet1to1(state: ExportState, opts: Sheet1to1Options = {}): Promise<ExportResult> {
  const kind: ExportKind = '1to1';
  const filename = opts.filename ?? '';
  try {
    const board = state?.board;
    if (!board || !(board.cols >= 1) || !(board.rows >= 1) || !(board.pitchMm > 0)) {
      return fail(kind, 'invalid-board', '板参数无效（行列数必须 ≥ 1、钉距必须 > 0），无法导出 1:1 图纸。', filename);
    }
    if (!state.beads || state.beads.length < board.cols * board.rows) {
      return fail(kind, 'invalid-board', '豆位数据与板尺寸不一致，请重新设置板参数后再导出。', filename);
    }

    const dpi = normalizeDpi(opts.dpi);
    const gutterMm = Math.max(0, Math.min(60, opts.gutterMm ?? DEFAULT_SHEET_GUTTER_MM));

    // 内存保护：按真正要分配的画布尺寸（含标注槽）估算
    const budget = estimatePixelBudget({
      cols: board.cols,
      rows: board.rows,
      pitchMm: board.pitchMm,
      marginMm: board.marginMm,
      dpi,
      gutterMm,
      label: '1:1 图纸',
    });
    if (!budget.ok) {
      return fail(kind, 'too-large', budget.error ?? '图纸过大，请降低 DPI。', filename, budget.suggestDpi);
    }

    const layout = computeSheetLayout(board.cols, board.rows, board.pitchMm, board.marginMm, dpi, {
      gutterMm,
      beadFillRatio: board.beadFillRatio,
    });
    const name = filename || buildFilename(['pindou', `${layout.cols}x${layout.rows}`, '1to1', `${dpi}dpi`]);

    const surface = createSurface(layout.widthPx, layout.heightPx);
    if (!surface) {
      return fail(kind, 'canvas-unsupported', '当前环境不支持离屏画布（OffscreenCanvas 与 canvas 元素均不可用），无法导出 PNG。', name);
    }
    try {
      const tokens = getTheme(state.theme).canvas;
      const colors = resolveExportColors(opts.style ?? 'print', tokens);
      paintSheet1to1(surface.ctx, layout, state, colors, tokens, opts);
      const enc = await surface.encode(shouldIncludeDataUrl(layout.totalPixels, opts.includeDataUrl));
      if (!enc.blob && !enc.dataUrl) {
        return fail(kind, 'encode-failed', 'PNG 编码失败（浏览器未返回图像数据），请降低 DPI 后重试。', name);
      }
      return {
        ok: true,
        kind,
        filename: name,
        mime: 'image/png',
        blob: enc.blob,
        dataUrl: enc.dataUrl,
        width: layout.widthPx,
        height: layout.heightPx,
        dpi,
        bytes: enc.bytes,
        sizeMm: {
          width: pxToMm(layout.contentWidthPx, dpi),
          height: pxToMm(layout.contentHeightPx, dpi),
        },
      };
    } finally {
      surface.dispose();
    }
  } catch (e) {
    return fail(kind, 'unknown', toChineseError(e, '1:1 图纸'), filename);
  }
}

function paintSheet1to1(
  ctx: CanvasRenderingContext2D,
  layout: SheetLayout,
  state: ExportState,
  colors: ExportColors,
  tokens: CanvasTokens,
  opts: Sheet1to1Options,
): void {
  const board = state.board;
  const dpi = layout.dpi;
  const showGrid = opts.showGrid ?? true;
  const showMajorGrid = opts.showMajorGrid ?? true;
  const showNumbers = opts.showNumbers ?? true;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, layout.widthPx, layout.heightPx);

  // 1) 纸张底色 + 板区底色
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, layout.widthPx, layout.heightPx);
  ctx.fillStyle = colors.boardBg;
  ctx.fillRect(layout.boardRect.x, layout.boardRect.y, layout.boardRect.w, layout.boardRect.h);

  const painter: CellPainter = {
    beads: state.beads,
    placedMask: state.placedMask,
    palette: state.palette,
    boardCols: layout.cols,
    col0: 0,
    row0: 0,
    cols: layout.cols,
    rows: layout.rows,
    cellPx: layout.cellPx,
    beadRadiusPx: layout.beadRadiusPx,
    rectAt: (col, row) => layout.cellRect(col, row),
  };

  // 2) 空格子（主题 emptyCell / emptyCellStroke）
  drawEmptyCells(ctx, painter, colors, 0.06, Math.max(0.35, mmToPx(0.05, dpi)));

  // 3) 网格：细线 + 每 majorEvery 格主线加粗
  if (showGrid) {
    drawGrid(ctx, {
      originX: layout.originX,
      originY: layout.originY,
      cols: layout.cols,
      rows: layout.rows,
      cellPx: layout.cellPx,
      baseCol: 0,
      baseRow: 0,
      colors,
      majorEvery: showMajorGrid ? Math.max(1, Math.round(board.majorEvery || 10)) : 0,
      minorWidth: Math.max(0.4, mmToPx(0.08, dpi)),
      majorWidth: Math.max(1, mmToPx(0.28, dpi)),
    });
  }

  // 4) 豆点（cellShape: circle / square / ring，直径 = pitch * beadFillRatio）
  drawBeads(ctx, painter, colors, {
    shape: board.cellShape,
    lineWidth: Math.max(0.4, mmToPx(0.09, dpi)),
    hollowFill: colors.boardBg,
  });
  if (opts.showPlacedMarks) {
    drawPlacedMarks(ctx, painter, colors.accent, Math.max(1, mmToPx(0.3, dpi)));
  }

  // 5) 板外框（实物板边缘）
  ctx.save();
  ctx.strokeStyle = colors.frame;
  ctx.lineWidth = Math.max(1, mmToPx(0.35, dpi));
  ctx.strokeRect(layout.boardRect.x, layout.boardRect.y, layout.boardRect.w, layout.boardRect.h);
  ctx.restore();

  // 6) 行列编号 + 标注槽说明（制图框内）
  if (layout.gutterPx >= 8) {
    drawDraftingBorder(
      ctx,
      layout.widthPx,
      layout.heightPx,
      layout.gutterPx * 0.14,
      colors.caption,
      Math.max(0.5, mmToPx(0.12, dpi)),
    );
    if (showNumbers) drawSheetNumbers(ctx, layout, board, colors);
    drawSheetCaption(ctx, layout, state, colors, tokens);
  }
}

/** 1:1 图纸：标注槽内的行列编号（每 numberEvery 格，含首末） */
function drawSheetNumbers(
  ctx: CanvasRenderingContext2D,
  layout: SheetLayout,
  board: BoardConfig,
  colors: ExportColors,
): void {
  const every = Math.max(1, Math.round(board.numberEvery || 10));
  const fontPx = fitFontSize(layout.gutterPx * 0.86, 0.62, 5, layout.cellPx * every * 0.8);
  ctx.save();
  setText(ctx, fontPx, colors.numberText, 'center', 'middle', FONT_TECH, '600');
  const colTicks = numberTicks(layout.cols, every);
  if (colTicks[colTicks.length - 1] !== layout.cols - 1) colTicks.push(layout.cols - 1);
  const topY = layout.boardY - layout.marginPx - layout.gutterPx * 0.5;
  for (const c of colTicks) {
    const cx = layout.cellLeftAbs(c) + layout.cellPx / 2;
    ctx.fillText(String(c + 1), cx, topY);
  }
  const rowTicks = numberTicks(layout.rows, every);
  if (rowTicks[rowTicks.length - 1] !== layout.rows - 1) rowTicks.push(layout.rows - 1);
  const leftX = layout.boardX - layout.marginPx - layout.gutterPx * 0.5;
  for (const r of rowTicks) {
    const cy = layout.cellTopAbs(r) + layout.cellPx / 2;
    ctx.fillText(String(r + 1), leftX, cy);
  }
  ctx.restore();
}

/** 1:1 图纸：底部标注槽的技术说明（工程图纸标题栏气质） */
function drawSheetCaption(
  ctx: CanvasRenderingContext2D,
  layout: SheetLayout,
  state: ExportState,
  colors: ExportColors,
  _tokens: CanvasTokens,
): void {
  const board = state.board;
  const y = layout.heightPx - layout.gutterPx * 0.5;
  const fontPx = fitFontSize(layout.gutterPx * 0.72, 0.5, 4, layout.cellPx * 1.6);
  const caption =
    `${layout.cols}×${layout.rows} 钉 · 钉距 ${board.pitchMm}mm · 排豆区 ${(layout.cols * board.pitchMm).toFixed(2)}×` +
    `${(layout.rows * board.pitchMm).toFixed(2)}mm · ${layout.dpi}DPI · 1:1 原尺寸 · ` +
    `打印请选「实际大小 / 100%」，切勿选「适应页面」`;
  ctx.save();
  setText(ctx, fontPx, colors.caption, 'center', 'middle', FONT_TECH);
  ctx.fillText(caption, layout.widthPx / 2, y);
  // 左上角小标：品牌 + 色板名
  const tag = `PinDou Studio · ${state.palette?.brand ?? ''} ${state.palette?.name ?? ''}`.replace(/\s+/g, ' ').trim();
  setText(ctx, fontPx * 0.92, colors.watermark, 'left', 'middle', FONT_TECH, '600');
  ctx.fillText(tag, layout.gutterPx * 0.3, layout.gutterPx * 0.5);
  ctx.restore();
}

/* ══════════════════════ 2. 分块图纸 ══════════════════════ */

/**
 * 导出 **分块图纸 PNG 数组**（导出产物 2）：笔记本屏幕放不下整板时的纸质兜底。
 * 每区块一张纸，内容保持 **1:1 物理尺寸不缩放**，含：醒目区块编号、四角 L 形对齐标记、
 * **局部 + 全局两套行列编号**、该区豆点与网格；长宽比补齐到 A4（不足处留白居中）。
 */
export async function exportRegionSheets(
  state: ExportState,
  opts: RegionSheetsOptions = {},
): Promise<RegionSheetsResult> {
  const kind: ExportKind = 'region';
  try {
    const board = state?.board;
    if (!board || !(board.cols >= 1) || !(board.rows >= 1) || !(board.pitchMm > 0)) {
      return fail(kind, 'invalid-board', '板参数无效（行列数必须 ≥ 1、钉距必须 > 0），无法导出分块图纸。');
    }
    if (!state.beads || state.beads.length < board.cols * board.rows) {
      return fail(kind, 'invalid-board', '豆位数据与板尺寸不一致，请重新设置板参数后再导出。');
    }

    const dpi = normalizeDpi(opts.dpi);
    const splits = resolveSplits(state, opts);
    const result = computeRegionLayout({
      cols: board.cols,
      rows: board.rows,
      pitchMm: board.pitchMm,
      marginMm: board.marginMm,
      dpi,
      splitsX: splits.splitsX,
      splitsY: splits.splitsY,
      paperRatio: opts.paperRatio ?? DEFAULT_PAPER_RATIO,
      gutterMm: opts.gutterMm,
      headerMm: opts.headerMm,
      footerMm: opts.footerMm,
      beadFillRatio: board.beadFillRatio,
    });

    // 内存保护（以最大单张为口径）
    if (!result.budget.ok) {
      return fail(kind, 'too-large', result.budget.error ?? '分块图纸过大，请降低 DPI。', undefined, result.budget.suggestDpi);
    }

    const targets =
      typeof opts.onlyIndex === 'number' && opts.onlyIndex >= 0
        ? result.sheets.filter((s) => s.index === opts.onlyIndex)
        : result.sheets;
    if (targets.length === 0) {
      return fail(
        kind,
        'invalid-board',
        `分区 ${result.splitsX}×${result.splitsY} 未产出任何区块（板 ${board.cols}×${board.rows} 太小），请减少分块数。`,
      );
    }

    const tokens = getTheme(state.theme).canvas;
    const colors = resolveExportColors(opts.style ?? 'print', tokens);
    const sheets: ExportSuccess[] = [];

    // 逐张创建 → 绘制 → 编码 → 释放，峰值内存 = 单张
    for (const sheet of targets) {
      const name = buildFilename(['pindou', 'region', sheet.label, `${dpi}dpi`]);
      const surface = createSurface(sheet.widthPx, sheet.heightPx);
      if (!surface) {
        return fail(
          kind,
          'canvas-unsupported',
          `区块 ${sheet.label} 导出失败：当前环境不支持离屏画布（${sheet.widthPx}×${sheet.heightPx}）。`,
          name,
        );
      }
      try {
        paintRegionSheet(surface.ctx, sheet, result, state, colors, opts);
        const enc = await surface.encode(shouldIncludeDataUrl(sheet.totalPixels, opts.includeDataUrl));
        if (!enc.blob && !enc.dataUrl) {
          return fail(kind, 'encode-failed', `区块 ${sheet.label} 的 PNG 编码失败，请降低 DPI 后重试。`, name);
        }
        sheets.push({
          ok: true,
          kind,
          filename: name,
          mime: 'image/png',
          blob: enc.blob,
          dataUrl: enc.dataUrl,
          width: sheet.widthPx,
          height: sheet.heightPx,
          dpi,
          bytes: enc.bytes,
          label: sheet.label,
          sizeMm: { width: pxToMm(sheet.widthPx, dpi), height: pxToMm(sheet.heightPx, dpi) },
        });
      } finally {
        surface.dispose();
      }
    }

    return {
      ok: true,
      kind,
      sheets,
      count: sheets.length,
      splitsX: result.splitsX,
      splitsY: result.splitsY,
      dpi,
    };
  } catch (e) {
    return fail(kind, 'unknown', toChineseError(e, '分块图纸'));
  }
}

/** 分区数解析：opts → suggestSplitsFor（需 display+calibration）→ state.region → 大板兜底 2×2 */
function resolveSplits(state: ExportState, opts: RegionSheetsOptions): { splitsX: number; splitsY: number } {
  if (typeof opts.splitsX === 'number' && opts.splitsX >= 1 && typeof opts.splitsY === 'number' && opts.splitsY >= 1) {
    return { splitsX: Math.round(opts.splitsX), splitsY: Math.round(opts.splitsY) };
  }
  const suggested = suggestSplitsFor(state.board, state.calibration ?? null, state.display ?? null);
  if (suggested.splitsX > 1 || suggested.splitsY > 1) return suggested;
  const region = state.region;
  if (region && (region.splitsX > 1 || region.splitsY > 1)) {
    return { splitsX: Math.max(1, Math.round(region.splitsX)), splitsY: Math.max(1, Math.round(region.splitsY)) };
  }
  // 无显示器/校准信息时的兜底：板边超过 200mm（A4 短边）就切 2×2，保证每块能 100% 打印在 A4 上
  const board = state.board;
  const longestMm = Math.max(board.cols, board.rows) * board.pitchMm + 2 * board.marginMm;
  return longestMm > 200 ? { splitsX: 2, splitsY: 2 } : { splitsX: 1, splitsY: 1 };
}

function paintRegionSheet(
  ctx: CanvasRenderingContext2D,
  sheet: RegionSheetLayout,
  result: RegionLayoutResult,
  state: ExportState,
  colors: ExportColors,
  opts: RegionSheetsOptions,
): void {
  const board = state.board;
  const dpi = sheet.dpi;
  const showGrid = opts.showGrid ?? true;
  const showMajorGrid = opts.showMajorGrid ?? true;
  const showNumbers = opts.showNumbers ?? true;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, sheet.widthPx, sheet.heightPx);

  // 1) 纸张 + 板区底色
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, sheet.widthPx, sheet.heightPx);
  ctx.fillStyle = colors.boardBg;
  ctx.fillRect(sheet.boardRect.x, sheet.boardRect.y, sheet.boardRect.w, sheet.boardRect.h);

  const painter: CellPainter = {
    beads: state.beads,
    placedMask: state.placedMask,
    palette: state.palette,
    boardCols: board.cols,
    col0: sheet.col0,
    row0: sheet.row0,
    cols: sheet.cols,
    rows: sheet.rows,
    cellPx: sheet.cellPx,
    beadRadiusPx: sheet.beadRadiusPx,
    rectAt: (col, row) =>
      sheet.globalCellRect(col, row) ?? {
        x: sheet.originX + (col - sheet.col0) * sheet.cellPx,
        y: sheet.originY + (row - sheet.row0) * sheet.cellPx,
        w: sheet.cellPx,
        h: sheet.cellPx,
      },
  };

  // 2) 空格子
  drawEmptyCells(ctx, painter, colors, 0.06, Math.max(0.35, mmToPx(0.05, dpi)));

  // 3) 网格（主线按**全局**序号判定，保证相邻区块拼接后主线连续）
  if (showGrid) {
    drawGrid(ctx, {
      originX: sheet.originX,
      originY: sheet.originY,
      cols: sheet.cols,
      rows: sheet.rows,
      cellPx: sheet.cellPx,
      baseCol: sheet.col0,
      baseRow: sheet.row0,
      colors,
      majorEvery: showMajorGrid ? Math.max(1, Math.round(board.majorEvery || 10)) : 0,
      minorWidth: Math.max(0.4, mmToPx(0.08, dpi)),
      majorWidth: Math.max(1, mmToPx(0.28, dpi)),
    });
  }

  // 4) 豆点 + 已放置勾
  drawBeads(ctx, painter, colors, {
    shape: board.cellShape,
    lineWidth: Math.max(0.4, mmToPx(0.09, dpi)),
    hollowFill: colors.boardBg,
  });
  if (opts.showPlacedMarks) {
    drawPlacedMarks(ctx, painter, colors.accent, Math.max(1, mmToPx(0.3, dpi)));
  }

  // 5) 板外框
  ctx.save();
  ctx.strokeStyle = colors.frame;
  ctx.lineWidth = Math.max(1, mmToPx(0.35, dpi));
  ctx.strokeRect(sheet.boardRect.x, sheet.boardRect.y, sheet.boardRect.w, sheet.boardRect.h);
  ctx.restore();

  // 6) 四角 L 形对齐标记
  drawAlignMarks(
    ctx,
    sheet.alignRect,
    colors.accent,
    Math.min(mmToPx(9, dpi), Math.min(sheet.areaWidthPx, sheet.areaHeightPx) * 0.14),
    Math.max(1.6, mmToPx(0.45, dpi)),
  );

  // 7) 两套行列编号（全局 + 局部）
  if (showNumbers && sheet.gutterPx >= 10) drawRegionNumbers(ctx, sheet, board, colors);

  // 8) 页眉（醒目区块编号 + 全局范围）与页脚（打印提示）
  drawRegionHeader(ctx, sheet, result, state, colors);
  drawRegionFooter(ctx, sheet, colors, dpi);

  // 9) 补白区的淡色大编号（多张纸叠放时便于识别）
  if (sheet.padY > mmToPx(9, dpi) || sheet.padX > mmToPx(9, dpi)) {
    drawSheetGhostLabel(ctx, sheet, colors);
  }
}

/** 分块图纸：全局编号（外带）+ 局部编号（内带），两套都必须有 */
function drawRegionNumbers(
  ctx: CanvasRenderingContext2D,
  sheet: RegionSheetLayout,
  board: BoardConfig,
  colors: ExportColors,
): void {
  const every = Math.max(1, Math.round(board.numberEvery || 10));
  const fontPx = fitFontSize(sheet.gutterPx * 0.42, 0.78, 4, sheet.cellPx * every * 0.7);
  const colTicks = regionTicks(sheet.col0, sheet.cols, every);
  const rowTicks = regionTicks(sheet.row0, sheet.rows, every);

  ctx.save();
  // 列编号：上侧编号带（外=全局，内=局部）
  setText(ctx, fontPx, colors.numberText, 'center', 'middle', FONT_TECH, '600');
  for (const g of colTicks) {
    const cx = sheet.originX + (g - sheet.col0 + 0.5) * sheet.cellPx;
    ctx.fillText(String(g + 1), cx, sheet.colNumberY.global);
    setText(ctx, fontPx * 0.92, colors.caption, 'center', 'middle', FONT_TECH);
    ctx.fillText(String(g - sheet.col0 + 1), cx, sheet.colNumberY.local);
    setText(ctx, fontPx, colors.numberText, 'center', 'middle', FONT_TECH, '600');
  }
  // 行编号：左侧编号带
  for (const g of rowTicks) {
    const cy = sheet.originY + (g - sheet.row0 + 0.5) * sheet.cellPx;
    ctx.fillText(String(g + 1), sheet.rowNumberX.global, cy);
    setText(ctx, fontPx * 0.92, colors.caption, 'center', 'middle', FONT_TECH);
    ctx.fillText(String(g - sheet.row0 + 1), sheet.rowNumberX.local, cy);
    setText(ctx, fontPx, colors.numberText, 'center', 'middle', FONT_TECH, '600');
  }
  // 带的口径小注（外=全局 / 内=局部），避免用户拼错位置
  const notePx = fitFontSize(sheet.gutterPx * 0.3, 0.7, 3, fontPx * 0.8);
  setText(ctx, notePx, colors.watermark, 'left', 'middle', FONT_TECH);
  ctx.fillText('外:全局', sheet.padX + mmToPx(1, sheet.dpi), sheet.colNumberY.global);
  ctx.fillText('内:局部', sheet.padX + mmToPx(1, sheet.dpi), sheet.colNumberY.local);
  ctx.restore();
}

/** 需要标注的全局序号：每 every 格 + 区块首末格（首末必标，方便对齐拼接） */
function regionTicks(start: number, count: number, every: number): number[] {
  const step = Math.max(1, Math.round(every));
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const g = start + k;
    if (k === 0 || k === count - 1 || g % step === 0) {
      if (out[out.length - 1] !== g) out.push(g);
    }
  }
  return out;
}

function drawRegionHeader(
  ctx: CanvasRenderingContext2D,
  sheet: RegionSheetLayout,
  result: RegionLayoutResult,
  state: ExportState,
  colors: ExportColors,
): void {
  const dpi = sheet.dpi;
  if (sheet.headerPx < 8) return;
  const left = sheet.padX + mmToPx(1.5, dpi);
  const cy = sheet.padY + sheet.headerPx * 0.52;

  ctx.save();
  // 醒目区块编号（A1/B1/…）
  const labelPx = fitFontSize(sheet.headerPx * 0.86, 0.72, 8, mmToPx(9, dpi));
  setText(ctx, labelPx, colors.accent, 'left', 'middle', FONT_TECH, '700');
  ctx.fillText(sheet.label, left, cy);
  const labelWidth = ctx.measureText(sheet.label).width;

  // 编号右侧的技术说明（两行）
  const infoPx = fitFontSize(sheet.headerPx * 0.3, 0.72, 5, mmToPx(3, dpi));
  const infoX = left + labelWidth + mmToPx(3, dpi);
  const board = state.board;
  const line1 =
    `第 ${sheet.index + 1}/${result.sheets.length} 块 · 分区 ${result.splitsX}×${result.splitsY} · ` +
    `全局列 ${sheet.col0 + 1}–${sheet.col0 + sheet.cols} · 全局行 ${sheet.row0 + 1}–${sheet.row0 + sheet.rows}`;
  const line2 =
    `${sheet.cols}×${sheet.rows} 钉 · 钉距 ${board.pitchMm}mm · 本区 ${(sheet.cols * board.pitchMm).toFixed(1)}×` +
    `${(sheet.rows * board.pitchMm).toFixed(1)}mm · ${dpi}DPI · 1:1 原尺寸`;
  setText(ctx, infoPx, colors.caption, 'left', 'middle', FONT_TECH);
  ctx.fillText(line1, infoX, cy - infoPx * 0.72);
  setText(ctx, infoPx * 0.92, colors.watermark, 'left', 'middle', FONT_TECH);
  ctx.fillText(line2, infoX, cy + infoPx * 0.78);

  // 右上角品牌 + 页眉分隔线
  setText(ctx, infoPx * 0.92, colors.watermark, 'right', 'middle', FONT_TECH, '600');
  drawTrackedText(ctx, 'PINDOU STUDIO', sheet.padX + sheet.contentWidthPx - mmToPx(1.5, dpi), cy - infoPx * 0.72, infoPx * 0.22, 'right');
  ctx.strokeStyle = colors.frame;
  ctx.lineWidth = Math.max(0.6, mmToPx(0.18, dpi));
  ctx.beginPath();
  const ruleY = sheet.padY + sheet.headerPx - mmToPx(0.8, dpi);
  ctx.moveTo(left, ruleY);
  ctx.lineTo(sheet.padX + sheet.contentWidthPx - mmToPx(1.5, dpi), ruleY);
  ctx.stroke();
  ctx.restore();
}

function drawRegionFooter(
  ctx: CanvasRenderingContext2D,
  sheet: RegionSheetLayout,
  colors: ExportColors,
  dpi: number,
): void {
  if (sheet.footerPx < 6) return;
  const cy = sheet.heightPx - sheet.padY - sheet.footerPx * 0.5;
  const fontPx = fitFontSize(sheet.footerPx * 0.42, 0.7, 4, mmToPx(2.6, dpi));
  ctx.save();
  setText(ctx, fontPx, colors.caption, 'center', 'middle', FONT_TECH);
  ctx.fillText(
    '打印请选「实际大小 / 100%」，切勿选「适应页面」或「缩放」 · 用四角 L 形标记对准透明板边角 · 编号外带为全局、内带为局部',
    sheet.widthPx / 2,
    cy,
  );
  ctx.restore();
}

/** 补白区的淡色大编号（装饰 + 实用：叠放多张纸时一眼认出区块） */
function drawSheetGhostLabel(
  ctx: CanvasRenderingContext2D,
  sheet: RegionSheetLayout,
  colors: ExportColors,
): void {
  const size = Math.min(sheet.padY * 1.5, sheet.widthPx * 0.28);
  if (size < 24) return;
  ctx.save();
  ctx.globalAlpha = 0.09;
  setText(ctx, size, colors.accent, 'left', 'middle', FONT_TECH, '700');
  ctx.fillText(sheet.label, sheet.padX + mmToPx(2, sheet.dpi), sheet.heightPx - sheet.padY * 0.5);
  ctx.globalAlpha = 1;
  setText(ctx, size * 0.2, colors.watermark, 'left', 'middle', FONT_TECH);
  ctx.fillText(
    `区块 ${sheet.label} · 第 ${sheet.index + 1} 张 · ${sheet.cols}×${sheet.rows} 钉`,
    sheet.padX + mmToPx(2, sheet.dpi) + size * 0.78,
    sheet.heightPx - sheet.padY * 0.5,
  );
  ctx.restore();
}

/* ══════════════════════ 3. 分享用预览图 ══════════════════════ */

/**
 * 导出 **分享用预览图 PNG**（导出产物 3）：主题背景 + 圆角豆点（带高光/暗部/描边）+
 * 板边外框 + 可选水印 + 可选已放置小勾。**非物理尺寸**（按 cellPx 等距网格），dpi 字段固定 96。
 */
export async function exportPreviewPng(state: ExportState, opts: PreviewOptions = {}): Promise<ExportResult> {
  const kind: ExportKind = 'preview';
  const filename = opts.filename ?? '';
  try {
    const board = state?.board;
    if (!board || !(board.cols >= 1) || !(board.rows >= 1)) {
      return fail(kind, 'invalid-board', '板参数无效（行列数必须 ≥ 1），无法导出预览图。', filename);
    }
    const cellPx = Math.max(4, Math.min(64, Math.round(opts.cellPx ?? 12)));
    const watermark =
      opts.watermark === undefined ? 'PinDou Studio' : opts.watermark === null ? '' : String(opts.watermark).trim();
    const paddingPx = Math.max(0, opts.paddingPx ?? cellPx * 2);
    const bandPx = watermark.length > 0 ? cellPx * 2.4 : 0;

    const layout = computePreviewLayout({
      cols: board.cols,
      rows: board.rows,
      cellPx,
      paddingPx,
      bandPx,
      beadFillRatio: 0.92,
    });

    const budget = budgetFromPixels(layout.widthPx, layout.heightPx, PREVIEW_DPI, '预览图');
    if (!budget.ok) {
      return fail(kind, 'too-large', budget.error ?? '预览图过大，请减小每格像素。', filename, budget.suggestDpi);
    }

    const name = filename || buildFilename(['pindou', 'preview']);
    const surface = createSurface(layout.widthPx, layout.heightPx);
    if (!surface) {
      return fail(kind, 'canvas-unsupported', '当前环境不支持离屏画布，无法导出预览图。', name);
    }
    try {
      const tokens = getTheme(opts.theme ?? state.theme).canvas;
      const colors = resolveExportColors('theme', tokens);
      paintPreview(surface.ctx, layout, state, colors, tokens, {
        watermark,
        showPlacedMarks: opts.showPlacedMarks ?? false,
        cornerPx: opts.cornerPx ?? cellPx * 1.5,
      });
      const enc = await surface.encode(shouldIncludeDataUrl(layout.totalPixels, opts.includeDataUrl));
      if (!enc.blob && !enc.dataUrl) {
        return fail(kind, 'encode-failed', '预览图 PNG 编码失败，请减小每格像素后重试。', name);
      }
      return {
        ok: true,
        kind,
        filename: name,
        mime: 'image/png',
        blob: enc.blob,
        dataUrl: enc.dataUrl,
        width: layout.widthPx,
        height: layout.heightPx,
        dpi: PREVIEW_DPI,
        bytes: enc.bytes,
      };
    } finally {
      surface.dispose();
    }
  } catch (e) {
    return fail(kind, 'unknown', toChineseError(e, '预览图'), filename);
  }
}

function paintPreview(
  ctx: CanvasRenderingContext2D,
  layout: PreviewLayout,
  state: ExportState,
  colors: ExportColors,
  tokens: CanvasTokens,
  opts: { watermark: string; showPlacedMarks: boolean; cornerPx: number },
): void {
  const board = state.board;
  const cell = layout.cellPx;
  const w = layout.widthPx;
  const h = layout.heightPx;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // 1) 主题背景：对角渐变 + 柔光斑，营造氛围而非平铺单色
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, tokens.canvasBgGlow || colors.boardBg);
  grad.addColorStop(0.55, colors.boardBg);
  grad.addColorStop(1, tokens.canvasBg);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.18, h * 0.12, 0, w * 0.18, h * 0.12, Math.max(w, h) * 0.72);
  glow.addColorStop(0, withAlpha(colors.accent, 0.14));
  glow.addColorStop(1, withAlpha(colors.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // 2) 底板：圆角 + 柔和投影（「一块真实的拼豆板」）
  const platePad = cell * 0.55;
  const plate: Rect = {
    x: layout.originX - platePad,
    y: layout.originY - platePad,
    w: layout.areaWidthPx + platePad * 2,
    h: layout.areaHeightPx + platePad * 2,
  };
  ctx.save();
  ctx.shadowColor = withAlpha('#000000', 0.18);
  ctx.shadowBlur = cell * 1.6;
  ctx.shadowOffsetY = cell * 0.45;
  roundRectPath(ctx, plate.x, plate.y, plate.w, plate.h, opts.cornerPx);
  ctx.fillStyle = withAlpha(colors.boardBg, 0.96);
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, plate.x, plate.y, plate.w, plate.h, opts.cornerPx);
  ctx.strokeStyle = withAlpha(tokens.gridLineMajor, 0.9);
  ctx.lineWidth = Math.max(1, cell * 0.1);
  ctx.stroke();
  ctx.restore();

  const painter: CellPainter = {
    beads: state.beads,
    placedMask: state.placedMask,
    palette: state.palette,
    boardCols: board.cols,
    col0: 0,
    row0: 0,
    cols: layout.cols,
    rows: layout.rows,
    cellPx: cell,
    beadRadiusPx: layout.beadRadiusPx,
    rectAt: (col, row) => layout.cellRect(col, row),
  };

  // 3) 空格：小圆孔（钉板质感），比图纸的方格更「可爱」
  drawPreviewHoles(ctx, painter, colors);

  // 4) 豆点：圆角 + 高光 + 暗部 + 描边
  drawPreviewBeads(ctx, painter, colors, board.cellShape);

  // 5) 已放置小勾
  if (opts.showPlacedMarks) {
    drawPlacedMarks(ctx, painter, colors.accent, Math.max(1, cell * 0.14));
  }

  // 6) 水印条：左侧作品信息，右侧品牌字距排版 + 三颗装饰豆
  if (opts.watermark.length > 0 && layout.bandPx > 0) {
    drawPreviewWatermark(ctx, layout, state, colors, opts.watermark);
  }
}

function drawPreviewHoles(ctx: CanvasRenderingContext2D, p: CellPainter, colors: ExportColors): void {
  const r = p.cellPx * 0.2;
  if (r < 0.5) return;
  ctx.save();
  ctx.beginPath();
  for (let row = p.row0; row < p.row0 + p.rows; row++) {
    for (let col = p.col0; col < p.col0 + p.cols; col++) {
      if (p.beads[row * p.boardCols + col] !== 0) continue;
      const rect = p.rectAt(col, row);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, TAU);
    }
  }
  ctx.fillStyle = withAlpha(colors.emptyCellStroke, 0.55);
  ctx.fill();
  ctx.restore();
}

function drawPreviewBeads(
  ctx: CanvasRenderingContext2D,
  p: CellPainter,
  colors: ExportColors,
  shape: 'circle' | 'square' | 'ring',
): void {
  const radius = p.beadRadiusPx;
  if (radius < 0.4) return;
  const buckets = new Map<number, number[]>();
  for (let row = p.row0; row < p.row0 + p.rows; row++) {
    for (let col = p.col0; col < p.col0 + p.cols; col++) {
      const v = p.beads[row * p.boardCols + col];
      if (v === 0 || v - 1 >= p.palette.colors.length) continue;
      const rect = p.rectAt(col, row);
      let list = buckets.get(v);
      if (!list) {
        list = [];
        buckets.set(v, list);
      }
      list.push(rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
  }

  ctx.save();
  for (const [v, list] of buckets) {
    const color = p.palette.colors[v - 1];
    if (!color) continue;
    // 底色（预览统一走圆润造型：square/ring 也保留圆角观感，ring 额外挖心）
    ctx.save();
    ctx.shadowColor = withAlpha('#000000', 0.16);
    ctx.shadowBlur = radius * 0.5;
    ctx.shadowOffsetY = radius * 0.18;
    traceBeadPath(ctx, list, radius, shape === 'square' ? 'square' : 'circle');
    ctx.fillStyle = color.hex;
    ctx.fill();
    ctx.restore();

    if (shape === 'ring' && radius * 0.45 >= 0.4) {
      traceBeadPath(ctx, list, radius * 0.45, 'circle');
      ctx.fillStyle = colors.boardBg;
      ctx.fill();
    }

    // 暗部月牙 + 高光点 + 描边（逐豆，量级 = 已填色格数）
    for (let k = 0; k < list.length; k += 2) {
      const cx = list[k] as number;
      const cy = list[k + 1] as number;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.9, Math.PI * 0.12, Math.PI * 0.88);
      ctx.strokeStyle = beadShadeColor(color.hex);
      ctx.lineWidth = Math.max(0.5, radius * 0.18);
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx - radius * 0.33, cy - radius * 0.36, radius * 0.34, 0, TAU);
      ctx.fillStyle = beadHighlightColor(color.hex);
      ctx.fill();

      ctx.beginPath();
      if (shape === 'square') {
        ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
      } else {
        ctx.arc(cx, cy, radius, 0, TAU);
      }
      ctx.strokeStyle = withAlpha(colors.beadStroke, 0.85);
      ctx.lineWidth = Math.max(0.5, radius * 0.1);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawPreviewWatermark(
  ctx: CanvasRenderingContext2D,
  layout: PreviewLayout,
  state: ExportState,
  colors: ExportColors,
  text: string,
): void {
  const band = layout.bandRect;
  const cy = band.y + band.h * 0.52;
  const cell = layout.cellPx;
  const pad = layout.paddingPx * 0.5;

  ctx.save();
  // 细分隔线
  ctx.strokeStyle = withAlpha(colors.frame, 0.55);
  ctx.lineWidth = Math.max(1, cell * 0.06);
  ctx.beginPath();
  ctx.moveTo(pad, band.y + band.h * 0.1);
  ctx.lineTo(layout.widthPx - pad, band.y + band.h * 0.1);
  ctx.stroke();

  // 左：作品信息
  const infoPx = Math.max(8, cell * 0.95);
  setText(ctx, infoPx, colors.caption, 'left', 'middle', FONT_TECH);
  const placed = countPlaced(state);
  const info =
    `${state.board.cols} × ${state.board.rows} 钉 · ${state.palette?.brand ?? ''} ${state.palette?.name ?? ''}`
      .replace(/\s+/g, ' ')
      .trim() + (placed > 0 ? ` · 已放置 ${placed} 颗` : '');
  const infoWidth = ctx.measureText(info).width;
  ctx.fillText(info, pad, cy);

  // 右：三颗装饰豆（取色板前三色）+ 字距排版品牌名
  const brandPx = Math.max(9, cell * 1.05);
  setText(ctx, brandPx, colors.watermark, 'right', 'middle', FONT_TECH, '600');
  const brandWidth = drawTrackedText(ctx, text.toUpperCase(), layout.widthPx - pad, cy, brandPx * 0.26, 'right');
  const dotR = brandPx * 0.22;
  const dotsX = layout.widthPx - pad - brandWidth - dotR * 4.4;
  // 空间不足（窄图/长文案）时省掉装饰豆，绝不与左侧信息重叠
  if (dotsX - dotR * 5 > pad + infoWidth) {
    const colors3 = (state.palette?.colors ?? []).slice(0, 3).map((c) => c.hex);
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(dotsX + i * dotR * 2.5, cy, dotR, 0, TAU);
      ctx.fillStyle = colors3[i] ?? colors.accent;
      ctx.fill();
      ctx.lineWidth = Math.max(0.5, dotR * 0.22);
      ctx.strokeStyle = colors.beadStroke;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function countPlaced(state: ExportState): number {
  const mask = state.placedMask;
  if (!mask) return 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) n++;
  return n;
}

/** 给 CSS 颜色串附加/覆盖 alpha（解析失败时原样返回） */
function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const m = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (m) {
    const parts = (m[1] as string).split(/[,\s/]+/).filter((x) => x.length > 0);
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})`;
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1] as string, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const hex3 = /^#([0-9a-f]{3})$/i.exec(color.trim());
  if (hex3) {
    const s = hex3[1] as string;
    const r = parseInt(s.charAt(0) + s.charAt(0), 16);
    const g = parseInt(s.charAt(1) + s.charAt(1), 16);
    const b = parseInt(s.charAt(2) + s.charAt(2), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return color;
}

/* ══════════════════════ 失败构造 ══════════════════════ */

function fail(
  kind: ExportKind,
  code: ExportErrorCode,
  error: string,
  filename?: string,
  suggestDpi?: number | null,
): ExportFailure {
  return {
    ok: false,
    kind,
    code,
    error,
    ...(filename ? { filename } : {}),
    ...(typeof suggestDpi === 'number' && suggestDpi > 0 ? { suggestDpi } : {}),
  };
}

function toChineseError(e: unknown, label: string): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return `${label}导出失败：${raw || '未知错误'}。建议降低 DPI 或减少行列数后重试。`;
}
