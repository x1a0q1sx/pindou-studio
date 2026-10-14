/**
 * io/exporters.ts —— 七种导出产物的统一编排层（纯逻辑 + 下载，零 React 依赖）。
 *
 * 产物（对应导出产物的 7 项）：
 *   PNG 栅格（调 render/exportRaster.ts）：
 *     1. sheet1to1    —— PNG 1:1 物理尺寸图纸（exportSheet1to1）
 *     2. regionSheets —— PNG 分块图纸（exportRegionSheets，label 顺序 A1,B1,A2,B2…）
 *     3. previewPng   —— PNG 预览图（exportPreviewPng）
 *   文本（本文件内实现）：
 *     4. colorListCsv  —— CSV 颜色清单：`色号,名称,HEX,用量,已放置,剩余`，按用量降序，**带 UTF-8 BOM**
 *     5. gridCsv       —— CSV 网格数据：首行列号，每行以行号开头，逐格输出色号（空格留白）
 *     6. placementTxt  —— TXT 分色施工图：按剩余量降序分组，每组列出 (行, 列) 坐标
 *     7. paletteJson   —— JSON 色板：当前（可能已被用户校正过的）BeadPalette，缩进 2 空格
 *
 * 【刻意不 import store/selectors.ts】用量统计在本文件内用局部辅助函数完成（遍历 beads/placedMask 即可），
 *   避免与并发任务产生编译竞态；也让本模块能被 esbuild 单独打包进 Node 做真实往返测试。
 *
 * 【性能】坐标数量可能上万，一律用数组 push + join，绝不做字符串 `+=` 累加。
 */
import type { BeadColor, BeadPalette, BoardConfig, Calibration, DisplayMetrics, ThemeId } from '@/core/types';
import { getBridge } from '@/io/bridge';
import { sanitizeFileName } from '@/io/project';
import {
  exportSheet1to1,
  exportRegionSheets,
  exportPreviewPng,
} from '@/render/exportRaster';
import type {
  ExportState as RasterExportState,
  ExportSuccess as RasterExportSuccess,
  ExportFailure as RasterExportFailure,
  RegionSheetsResult,
  Sheet1to1Options,
  RegionSheetsOptions,
  PreviewOptions,
} from '@/render/exportRaster';

/* ==================== 类型 ==================== */

/** 单个导出产物 */
export interface ExportResult {
  filename: string;
  mime: string;
  text: string;
}

/** 导出所需的最小状态切片（PdbState 的子集，结构化类型） */
export interface ExportSource {
  board: BoardConfig;
  /** 调色板索引 + 1，0 = 空格 */
  beads: Uint16Array;
  /** 1 = 已物理放置 */
  placedMask: Uint8Array;
  palette: BeadPalette;
  /** 用于文件名与文件头；缺省「拼豆项目」 */
  meta?: { name?: string; updatedAt?: string };
}

/** 单个颜色的用量统计 */
export interface ColorUsage {
  /** 调色板索引（0-based） */
  index: number;
  /** beads 中存储的值 = index + 1 */
  cellValue: number;
  color: BeadColor | null;
  code: string;
  /** 优先中文名，无则英文名 */
  name: string;
  hex: string;
  /** 图案中该色总格数 */
  total: number;
  /** 其中已物理放置的格数 */
  placed: number;
  /** 剩余待放 = total - placed（不会为负） */
  remaining: number;
}

/** 整板统计 */
export interface BoardUsage {
  cells: number;
  filled: number;
  empty: number;
  placed: number;
  remaining: number;
  usedColors: number;
}

/* ==================== 常量 ==================== */

/** UTF-8 BOM：Excel 打开中文 CSV 不乱码的唯一可靠办法 */
export const CSV_BOM = '\uFEFF';
export const COLOR_LIST_HEADER = '色号,名称,HEX,用量,已放置,剩余';
/** CSV 用 RFC4180 的 CRLF；TXT/JSON 用 LF */
const CRLF = '\r\n';
const LF = '\n';

/* ==================== 局部统计辅助（不依赖 selectors.ts） ==================== */

function colorName(c: BeadColor | null): string {
  if (!c) return '未知颜色';
  return c.nameZh && c.nameZh.length > 0 ? c.nameZh : c.name || c.code;
}

function colorCode(c: BeadColor | null, fallbackIndex: number): string {
  return c ? c.code || `#${fallbackIndex + 1}` : `#${fallbackIndex + 1}`;
}

function colorHex(c: BeadColor | null): string {
  return c ? c.hex : '#000000';
}

/**
 * 一次遍历同时算出「每色用量/已放置/剩余」与整板统计。
 * O(rows*cols)，104×104 = 10816 次循环，微秒级。
 * beads 中出现越界索引（> colors.length）时归到 `overflow` 项，绝不抛错。
 */
export function computeUsage(state: ExportSource): { list: ColorUsage[]; board: BoardUsage; overflow: number } {
  const { beads, placedMask, palette } = state;
  const colors = palette.colors;
  const n = beads.length;
  const totals = new Int32Array(colors.length + 1); // totals[index] = 该色格数
  const placedTotals = new Int32Array(colors.length + 1);
  let overflow = 0;
  let filled = 0;
  let placedAll = 0;

  for (let i = 0; i < n; i++) {
    const v = beads[i];
    if (v === 0) continue;
    filled++;
    const isPlaced = i < placedMask.length && placedMask[i] !== 0;
    if (isPlaced) placedAll++;
    const idx = v - 1;
    if (idx >= 0 && idx < colors.length) {
      totals[idx]++;
      if (isPlaced) placedTotals[idx]++;
    } else {
      overflow++;
    }
  }

  const list: ColorUsage[] = [];
  for (let idx = 0; idx < colors.length; idx++) {
    const c = colors[idx];
    const total = totals[idx];
    const placed = placedTotals[idx];
    list.push({
      index: idx,
      cellValue: idx + 1,
      color: c,
      code: colorCode(c, idx),
      name: colorName(c),
      hex: colorHex(c),
      total,
      placed,
      remaining: Math.max(0, total - placed),
    });
  }

  const cells = state.board.cols * state.board.rows;
  return {
    list,
    overflow,
    board: {
      cells,
      filled,
      empty: Math.max(0, cells - filled),
      placed: placedAll,
      remaining: Math.max(0, filled - placedAll),
      usedColors: list.filter((u) => u.total > 0).length,
    },
  };
}

/** 便捷：整板统计 */
export function computeBoardUsage(state: ExportSource): BoardUsage {
  return computeUsage(state).board;
}

/* ==================== 文件名与格式化工具 ==================== */

function baseName(state: ExportSource): string {
  return sanitizeFileName(state.meta?.name ?? '', '拼豆项目');
}

function pad2(v: number): string {
  return v < 10 ? `0${v}` : String(v);
}

/** yyyy-MM-dd HH:mm:ss */
export function formatDateTime(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/** yyyyMMdd（文件名用） */
export function formatDateCompact(date: Date = new Date()): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function mm(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

/**
 * 压成单行：TXT 施工图是按行解析的文本文档，色名/项目名里若混进 \r\n 会撕裂组标题格式。
 * CSV 不需要（引号包裹的字段内允许换行），故只用于 TXT。
 */
function oneLine(value: string): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * CSV 字段转义：含逗号 / 双引号 / 换行时用双引号包裹，内部 `"` → `""`。
 * 前置空格也会被 Excel 吞掉，故一并包裹。
 */
export function csvField(value: string | number): string {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ==================== 1. CSV 颜色清单 ==================== */

/**
 * 颜色清单 CSV。**必须以 UTF-8 BOM 开头**，否则 Excel 打开中文乱码。
 * 只列出图案中实际用到的颜色，按「用量」降序（用量相同按色号升序，保证稳定输出）。
 */
export function exportColorListCsv(state: ExportSource): ExportResult {
  const { list } = computeUsage(state);
  const used = list
    .filter((u) => u.total > 0)
    .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code));

  const lines: string[] = [COLOR_LIST_HEADER];
  for (const u of used) {
    lines.push(
      [csvField(u.code), csvField(u.name), csvField(u.hex), u.total, u.placed, u.remaining].join(','),
    );
  }

  return {
    filename: `${baseName(state)}-颜色清单.csv`,
    mime: 'text/csv;charset=utf-8',
    text: CSV_BOM + lines.join(CRLF) + CRLF,
  };
}

/* ==================== 2. CSV 网格数据 ==================== */

/**
 * 网格 CSV：第一行为列号（1-based），随后每行以行号开头，逐格输出**色号**，空格输出空字符串。
 * 同样带 UTF-8 BOM。行列号 1-based，与画布上的行列编号、施工图坐标完全一致。
 */
export function exportGridCsv(state: ExportSource): ExportResult {
  const { cols, rows } = state.board;
  const { beads, palette } = state;
  const codes: string[] = palette.colors.map((c, i) => csvField(colorCode(c, i)));

  const lines: string[] = [];
  // 表头：首格留空 + 列号
  const header: string[] = [''];
  for (let c = 1; c <= cols; c++) header.push(String(c));
  lines.push(header.join(','));

  const row: string[] = new Array(cols + 1);
  for (let r = 0; r < rows; r++) {
    row[0] = String(r + 1);
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      const v = i < beads.length ? beads[i] : 0;
      row[c + 1] = v === 0 ? '' : (codes[v - 1] ?? '');
    }
    lines.push(row.join(','));
  }

  return {
    filename: `${baseName(state)}-网格数据.csv`,
    mime: 'text/csv;charset=utf-8',
    text: CSV_BOM + lines.join(CRLF) + CRLF,
  };
}

/* ==================== 3. TXT 分色施工图 ==================== */

/**
 * 分色施工图：按颜色分组（按**剩余量**降序），每组一行标题 + 逐行列出坐标。
 *
 * 组标题格式（契约，UI/文档均按此展示）：
 *   `【S13 黑 #000000】共 320 颗 · 已放置 0 · 剩余 320`
 *
 * 坐标为 `(行, 列)`，1-based；同一板行的坐标聚在一行输出（真正「逐行」，拼豆时顺着行找最快）。
 * 上万坐标用数组 join，不做字符串 += 累加。
 */
export function exportPlacementTxt(state: ExportSource): ExportResult {
  const { cols, rows, pitchMm } = state.board;
  const { beads, palette } = state;
  const usage = computeUsage(state);
  const now = new Date();

  // 只输出图案里真的用到的颜色；按剩余量降序（剩余相同按用量降序、再按色号）
  const groups = usage.list
    .filter((u) => u.total > 0)
    .sort((a, b) => b.remaining - a.remaining || b.total - a.total || a.code.localeCompare(b.code));

  // 一次遍历把每个颜色的坐标按板行分桶：buckets[cellValue][row] = 列号数组（1-based）
  const buckets: (number[] | undefined)[][] = [];
  for (let v = 0; v <= palette.colors.length; v++) buckets.push([]);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      const v = i < beads.length ? beads[i] : 0;
      if (v === 0 || v > palette.colors.length) continue;
      const rowsBucket = buckets[v];
      let rowBucket = rowsBucket[r];
      if (!rowBucket) {
        rowBucket = [];
        rowsBucket[r] = rowBucket;
      }
      rowBucket.push(c + 1);
    }
  }

  const out: string[] = [];
  out.push('PinDou Studio · 分色施工图');
  out.push('========================================');
  out.push(`项目名称：${oneLine(state.meta?.name ?? '拼豆项目') || '拼豆项目'}`);
  out.push(
    `板规格：${cols} 列 × ${rows} 行 · 钉距 ${pitchMm} mm · 有效排豆区 ${mm(cols * pitchMm)} × ${mm(
      rows * pitchMm,
    )} mm`,
  );
  out.push(`生成时间：${formatDateTime(now)}`);
  out.push(
    `颜色统计：${usage.board.usedColors} 色 · 共 ${usage.board.filled} 颗 · 已放置 ${usage.board.placed} 颗 · 剩余 ${usage.board.remaining} 颗`,
  );
  out.push('坐标格式：(行, 列)，行与列均从 1 开始计数，与画布上的行列编号一致。');
  out.push('使用说明：按「剩余量」由多到少排列，建议逐色完成；每行按板行聚合，顺着行放豆最快。');
  out.push('');

  for (const g of groups) {
    out.push(
      `【${oneLine(g.code)} ${oneLine(g.name)} ${oneLine(g.hex)}】共 ${g.total} 颗 · 已放置 ${g.placed} · 剩余 ${g.remaining}`,
    );
    const rowsBucket = buckets[g.cellValue];
    for (let r = 0; r < rows; r++) {
      const colList = rowsBucket[r];
      if (!colList || colList.length === 0) continue;
      const coords: string[] = new Array(colList.length);
      for (let k = 0; k < colList.length; k++) coords[k] = `(${r + 1},${colList[k]})`;
      out.push(`  第 ${pad2(r + 1)} 行 · ${colList.length} 颗：${coords.join(' ')}`);
    }
    out.push('');
  }

  if (groups.length === 0) {
    out.push('（当前图案还没有任何豆颗，先在画布上绘制或导入图片后再导出施工图）');
    out.push('');
  }

  return {
    filename: `${baseName(state)}-分色施工图.txt`,
    mime: 'text/plain;charset=utf-8',
    text: out.join(LF),
  };
}

/* ==================== 4. JSON 色板 ==================== */

/**
 * 导出当前调色板为 BeadPalette 形状的 JSON（含用户校正后的 HEX/名称/自定义色），缩进 2 空格，
 * 可被 PaletteManager 直接导入复用。
 */
export function exportPaletteJson(state: ExportSource): ExportResult {
  const palette: BeadPalette = {
    id: state.palette.id,
    brand: state.palette.brand,
    name: state.palette.name,
    beadSizeMm: state.palette.beadSizeMm,
    colors: state.palette.colors.map((c) => ({ ...c })),
    editable: state.palette.editable,
  };
  if (state.palette.source) palette.source = state.palette.source;

  return {
    filename: `${baseName(state)}-色板.json`,
    mime: 'application/json;charset=utf-8',
    text: JSON.stringify(palette, null, 2) + LF,
  };
}

/* ==================== 组合与落地 ==================== */

export type ExportKind = 'colorListCsv' | 'gridCsv' | 'placementTxt' | 'paletteJson';

export const EXPORT_KINDS: readonly ExportKind[] = ['colorListCsv', 'gridCsv', 'placementTxt', 'paletteJson'];

const BUILDERS: Record<ExportKind, (state: ExportSource) => ExportResult> = {
  colorListCsv: exportColorListCsv,
  gridCsv: exportGridCsv,
  placementTxt: exportPlacementTxt,
  paletteJson: exportPaletteJson,
};

/** ExportDialog 勾选组合时用：按 kinds 顺序生成多个产物 */
export function buildExports(state: ExportSource, kinds: readonly ExportKind[] = EXPORT_KINDS): ExportResult[] {
  return kinds.map((k) => BUILDERS[k](state)).filter(Boolean);
}

/**
 * 把导出产物落地成文件。
 * - Electron：走 bridge.saveFile(filename, { text }) → 原生保存对话框（payload 形状见 src/pdb.d.ts 的 PdbSavePayload）
 * - 浏览器：直接 `<a download>` + Blob（**不**走 bridge.saveFile，因为浏览器分支的 showSaveFilePicker
 *   会把扩展名改成 .bin，破坏 .csv/.txt 的可打开性）
 *
 * 用户取消返回 null；失败抛出的异常由调用方（persistence/UI）转成中文 toast。
 */
export async function downloadExport(result: ExportResult): Promise<{ path: string } | null> {
  const bridge = getBridge();
  if (bridge.env === 'electron') {
    return bridge.saveFile(result.filename, { text: result.text });
  }
  return browserDownload(result);
}

function browserDownload(result: ExportResult): Promise<{ path: string } | null> {
  return new Promise((resolve) => {
    try {
      if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        resolve(null);
        return;
      }
      const blob = new Blob([result.text], { type: result.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      resolve({ path: '' }); // 浏览器无真实路径
    } catch {
      resolve(null);
    }
  });
}

/** 便捷：生成 + 落地一步到位，返回中文提示所需的信息 */
    export async function exportAndDownload(
      state: ExportSource,
      kind: ExportKind,
    ): Promise<{
      ok: boolean;
      filename: string;
      path: string | null;
      error?: string;
      cancelled?: boolean;
    }> {
      const result = BUILDERS[kind](state);
      try {
        const saved = await downloadExport(result);
        if (saved === null) {
          return {
            ok: false,
            filename: result.filename,
            path: null,
            error: '已取消导出',
            cancelled: true,
          };
        }
        return { ok: true, filename: result.filename, path: saved.path || null };
      } catch (err) {
    return {
      ok: false,
      filename: result.filename,
      path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ==================== PNG 栅格导出集成（产物 1/2/3） ==================== */

/** PNG 栅格导出种类 */
export type PngExportKind = 'sheet1to1' | 'regionSheets' | 'previewPng';

/** 全部 7 种导出产物 */
export type AllExportKind = ExportKind | PngExportKind;

export const ALL_EXPORT_KINDS: readonly AllExportKind[] = [
  'sheet1to1', 'regionSheets', 'previewPng',
  'colorListCsv', 'gridCsv', 'placementTxt', 'paletteJson',
];

export const PNG_EXPORT_KINDS: readonly PngExportKind[] = ['sheet1to1', 'regionSheets', 'previewPng'];

/** 每种产物的中文显示名 */
export const EXPORT_LABELS: Record<AllExportKind, string> = {
  sheet1to1: 'PNG 1:1 物理尺寸图纸',
  regionSheets: 'PNG 分块图纸',
  previewPng: 'PNG 预览图',
  colorListCsv: 'CSV 颜色清单',
  gridCsv: 'CSV 网格数据',
  placementTxt: 'TXT 分色施工图',
  paletteJson: 'JSON 色板',
};

/** PNG 导出所需的完整状态（ExportState 的超集，可直接传 usePdbStore.getState()） */
export interface PngExportSource extends ExportSource {
  theme: ThemeId;
  region?: { splitsX: number; splitsY: number; activeIndex: number };
  calibration?: Calibration | null;
  display?: DisplayMetrics | null;
}

/** ExportDialog 传递给批量导出的选项 */
export interface PngExportOptions {
  dpi?: number;
  splitsX?: number;
  splitsY?: number;
  watermark?: string | null;
  previewTheme?: ThemeId;
  showPlacedMarks?: boolean;
  /**
   * 分块图纸逐张保存回调（仅该产物多文件时触发）：saved = 已成功保存张数，total = 总张数。
   * batchExport 借此把逐张进度上报给 UI（真实进度条而非整体跳变）。
   */
  onSheetSaved?: (saved: number, total: number) => void;
  /** 批量导出进度（文件级计数，含分块图纸逐张）；仅在 batchExport 中回调 */
  onBatchProgress?: (e: BatchExportProgress) => void;
}

/** 批量导出进度事件：done/total 为**文件级**计数（分块图纸逐张计入，其余每种产物 1 个文件） */
export interface BatchExportProgress {
  done: number;
  total: number;
  /** 当前产物的中文名（或「分块图纸 2/4」这类子进度） */
  label: string;
}

/** 单个产物的导出结果（成功/失败判别联合） */
    export type ExportOutcome =
      | { ok: true; kind: AllExportKind; filename: string; path: string | null }
      | {
          ok: false;
          kind: AllExportKind;
          filename?: string;
          error: string;
          code?: string;
          suggestDpi?: number | null;
          cancelled?: boolean;
        };

/** 批量导出结果 */
    export interface BatchExportResult {
      outcomes: ExportOutcome[];
      successCount: number;
      failCount: number;
      cancelledCount: number;
    }

/* ---- PNG 下载辅助 ---- */

/** 从 dataUrl 提取 base64 部分（去掉 data:...;base64, 前缀） */
function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

/** 将 Blob 转为 base64 字符串（不含 data: 前缀） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(dataUrlToBase64(result));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadPng(filename: string, dataUrl: string, blob?: Blob): Promise<{ path: string } | null> {
  const bridge = getBridge();
  if (bridge.env === 'electron') {
    // Electron：PdbSavePayload 只接受 { base64 } 或 { text }，PNG 走 base64
    let base64 = '';
    if (dataUrl) {
      base64 = dataUrlToBase64(dataUrl);
    } else if (blob) {
      base64 = await blobToBase64(blob);
    }
    if (!base64) return null;
    return bridge.saveFile(filename, { base64 });
  }
  // 浏览器：<a download> + blob/dataUrl
  return new Promise((resolve) => {
    try {
      const a = document.createElement('a');
      if (blob) {
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 8000);
      } else if (dataUrl) {
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        resolve(null);
        return;
      }
      resolve({ path: '' });
    } catch {
      resolve(null);
    }
  });
}

/* ---- 单个 PNG 产物导出 ---- */

/** 导出 PNG 1:1 物理尺寸图纸 */
export async function exportPngSheet1to1(
  state: PngExportSource,
  opts?: PngExportOptions,
): Promise<ExportOutcome> {
  const rasterOpts: Sheet1to1Options = { dpi: opts?.dpi ?? 300, showPlacedMarks: opts?.showPlacedMarks };
      const r = await exportSheet1to1(state as RasterExportState, rasterOpts);
      if (!r.ok) return mapRasterFailure(r, 'sheet1to1');
      return downloadRasterSuccess(r, 'sheet1to1');
}

/** 导出 PNG 分块图纸（多张） */
export async function exportPngRegionSheets(
  state: PngExportSource,
  opts?: PngExportOptions,
): Promise<ExportOutcome[]> {
  const rasterOpts: RegionSheetsOptions = {
    dpi: opts?.dpi ?? 300,
    splitsX: opts?.splitsX,
    splitsY: opts?.splitsY,
    showPlacedMarks: opts?.showPlacedMarks,
  };
  const r: RegionSheetsResult = await exportRegionSheets(state as RasterExportState, rasterOpts);
  if (!r.ok) {
    return [mapRasterFailure(r, 'regionSheets')];
  }
  // 成功：逐张下载（每张落地即回报进度，供批量导出驱动真实进度条）
  const outcomes: ExportOutcome[] = [];
  for (const sheet of r.sheets) {
    const saved = await downloadPng(sheet.filename, sheet.dataUrl, sheet.blob);
    if (saved === null) {
      outcomes.push({
        ok: false,
        kind: 'regionSheets',
        filename: sheet.filename,
        error: '已取消导出',
        cancelled: true,
      });
      break;
    }
    outcomes.push({
      ok: true,
      kind: 'regionSheets',
      filename: sheet.filename,
      path: saved?.path || null,
    });
    opts?.onSheetSaved?.(outcomes.filter((o) => o.ok).length, r.sheets.length);
  }
  return outcomes;
}

/** 导出 PNG 预览图 */
export async function exportPngPreview(
  state: PngExportSource,
  opts?: PngExportOptions,
): Promise<ExportOutcome> {
  const previewOpts: PreviewOptions = {
    watermark: opts?.watermark !== undefined ? opts.watermark : 'PinDou Studio',
    theme: opts?.previewTheme,
    showPlacedMarks: opts?.showPlacedMarks,
      };
      const r = await exportPreviewPng(state as RasterExportState, previewOpts);
      if (!r.ok) return mapRasterFailure(r, 'previewPng');
      return downloadRasterSuccess(r, 'previewPng');
    }

    /* ---- 结果映射 ---- */

    function mapRasterFailure(r: RasterExportFailure, kind: AllExportKind): ExportOutcome {
  return {
    ok: false,
    kind,
    filename: r.filename,
    error: r.error,
    code: r.code,
    suggestDpi: r.suggestDpi ?? null,
  };
}

/** 成功时执行下载并填充 path */
async function downloadRasterSuccess(r: RasterExportSuccess, kind: AllExportKind): Promise<ExportOutcome> {
  const saved = await downloadPng(r.filename, r.dataUrl, r.blob);
  if (saved === null) {
    return {
      ok: false,
      kind,
      filename: r.filename,
      error: '已取消导出',
      cancelled: true,
    };
  }
  return { ok: true, kind, filename: r.filename, path: saved?.path || null };
}

/* ---- 批量导出（ExportDialog 核心入口） ---- */

/**
 * 批量导出多种产物。
 * PNG 产物需要完整 store state（PngExportSource），文本产物只需 ExportSource 子集。
 * 返回每种产物的成功/失败结果，ExportDialog 据此渲染 Toast 与重试按钮。
 *
 * 进度：opts.onBatchProgress 按**文件级**计数回报（分块图纸逐张计入；其余每种 1 个文件）。
 * 每个产物开绘前回报一次（label = 正在导出的产物名），落地后再回报一次 —— 大 DPI 单张
 * 绘制虽会阻塞主线程，但「正在导出 XXX」文案先行的反馈也远好于进度 0→100 跳变。
 * 分块图纸的实际张数与估算不符时自动校正总数，进度保持单调。
 */
export async function batchExport(
  state: PngExportSource,
  kinds: readonly AllExportKind[],
  opts?: PngExportOptions,
): Promise<BatchExportResult> {
  const outcomes: ExportOutcome[] = [];
  const onProgress = opts?.onBatchProgress;

  // 总数估算：分块图纸按「手动分块积 → 当前分区积 → 1」，实际张数已知时校正
  let estRegionSheets =
    opts?.splitsX && opts?.splitsY
      ? Math.max(1, Math.round(opts.splitsX)) * Math.max(1, Math.round(opts.splitsY))
      : Math.max(1, (state.region?.splitsX ?? 1) * (state.region?.splitsY ?? 1));
  let total = 0;
  for (const k of kinds) total += k === 'regionSheets' ? estRegionSheets : 1;
  let done = 0;
  const report = (label: string): void => {
    onProgress?.({ done: Math.min(done, total), total, label });
  };

  for (const kind of kinds) {
    switch (kind) {
      case 'sheet1to1': {
        report(EXPORT_LABELS.sheet1to1);
        const r = await exportSheet1to1(state as RasterExportState, {
          dpi: opts?.dpi ?? 300,
          showPlacedMarks: opts?.showPlacedMarks,
        });
        if (!r.ok) { outcomes.push(mapRasterFailure(r, kind)); }
        else { outcomes.push(await downloadRasterSuccess(r, kind)); }
        done += 1;
        report(EXPORT_LABELS.sheet1to1);
        break;
      }
      case 'regionSheets': {
        report(EXPORT_LABELS.regionSheets);
        const regionOutcomes = await exportPngRegionSheets(state, {
          ...opts,
          onSheetSaved: (saved, sheetTotal) => {
            // 实际张数与估算不符（如走了自动建议）：先校正 total 再上报，保持 done ≤ total
            if (sheetTotal !== estRegionSheets) {
              total += sheetTotal - estRegionSheets;
              estRegionSheets = sheetTotal;
            }
            onProgress?.({ done: Math.min(done + saved, total), total, label: `${EXPORT_LABELS.regionSheets} ${saved}/${sheetTotal}` });
          },
        });
        outcomes.push(...regionOutcomes);
        const actual = Math.max(1, regionOutcomes.length);
        if (actual !== estRegionSheets) {
          total += actual - estRegionSheets;
          estRegionSheets = actual;
        }
        done += actual;
        report(EXPORT_LABELS.regionSheets);
        break;
      }
      case 'previewPng': {
        report(EXPORT_LABELS.previewPng);
        const r = await exportPreviewPng(state as RasterExportState, {
          watermark: opts?.watermark !== undefined ? opts.watermark : 'PinDou Studio',
          theme: opts?.previewTheme,
          showPlacedMarks: opts?.showPlacedMarks,
        });
        if (!r.ok) { outcomes.push(mapRasterFailure(r, kind)); }
        else { outcomes.push(await downloadRasterSuccess(r, kind)); }
        done += 1;
        report(EXPORT_LABELS.previewPng);
        break;
      }
      default: {
        // 文本导出
        report(EXPORT_LABELS[kind]);
        const textResult = await exportAndDownload(state, kind as ExportKind);
        if (textResult.ok) {
          outcomes.push({ ok: true, kind, filename: textResult.filename, path: textResult.path });
        } else {
          outcomes.push({
            ok: false,
            kind,
            filename: textResult.filename,
            error: textResult.error ?? '导出失败',
            cancelled: textResult.cancelled === true,
          });
        }
        done += 1;
        report(EXPORT_LABELS[kind]);
        break;
      }
    }
  }

  return {
    outcomes,
    successCount: outcomes.filter((o) => o.ok).length,
    failCount: outcomes.filter((o) => !o.ok).length,
    cancelledCount: outcomes.filter((o) => !o.ok && o.cancelled === true).length,
  };
}
