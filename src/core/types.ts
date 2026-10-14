/**
 * src/core/types.ts —— 全项目类型契约（契约层）。
 * 【硬约束】后续所有任务必须引用这里的类型，字段名与类型一字不差，禁止改名或增删字段。
 */

/* ---------------- 基础枚举型 ---------------- */

export type ThemeId = 'macaron' | 'glowDark' | 'journal' | 'minimal';
export type LayoutId = 'classic' | 'floating' | 'split' | 'focus' | 'dual';
export type ToolId = 'pen' | 'eraser' | 'flood' | 'replaceColor' | 'picker' | 'pan' | 'markPlaced';
export type AppMode = 'design' | 'placement';
/**
 * 按色筛选档位。
 *   off   正常显示全部豆点
 *   only  只显示当前筛选色，其余极淡轮廓
 *   dim   当前筛选色高亮发光，其余压暗
 *   hide  当前筛选色以外完全隐藏（已拼格仍显示）
 *   panel 发光板：**只亮「当前色 ∩ 未拼」的格子**，其余全部纯黑 —— 拼豆模式专用，
 *         屏幕上呈现的即真实发光底板该亮的样子（已拼的格熄灭，可直观看到还剩哪些）。
 */
export type FilterMode = 'off' | 'only' | 'dim' | 'hide' | 'panel';
export type FitMode = 'cover' | 'contain' | 'stretch';

/**
 * 手机点亮图案（虚拟板链路）：手机 App 点色号后经 PIXDOU 节目下发的「该亮哪些格」。
 * 由对话框收齐 0x00 分片、解出内嵌 GIF 首帧后构建；panel（发光板）档优先渲染它——
 * 手机是遥控器，App 选的色即板子显示的内容。
 */
export interface VbLightPattern {
  /** 图案宽高（= 板分辨率，如 104×104）；坐标与设计格 1:1 对应（x=列, y=行），越界裁掉 */
  w: number;
  h: number;
  /** 行主序 0/1 掩码，长度 w*h */
  mask: Uint8Array;
  /** GIF 首帧原像素（行主序 RGBA，长度 w*h*4）：小窗按原色忠实重绘（App 会把色号画进图里） */
  rgba: Uint8ClampedArray;
  /** 点亮格数 */
  count: number;
}

/* ---------------- 显示器与校准 ---------------- */

export interface DisplayMetrics {
  id: string;
  label: string;
  isPrimary: boolean;
  isVirtual: boolean;
  boundsCss: { width: number; height: number };
  workAreaCss: { width: number; height: number };
  devicePx: { width: number; height: number };
  devicePixelRatio: number;
  physicalMm: { width: number; height: number } | null;   // 浏览器/虚拟屏为 null
  /** 物理尺寸与该屏匹配的可信度（WMI↔Chromium 无稳定桥接，按宽高比贪心配对；
   *  low = 宽高比差异明显，物理尺寸可能张冠李戴，UI 提示用户复核） */
  matchConfidence?: 'high' | 'medium' | 'low';
  ppi: { x: number; y: number } | null;
  mmPerDevicePx: { x: number; y: number } | null;
}

export interface Calibration {
  pitchMm: number;                        // 默认 2.6923
  mmPerDevicePxX: number;
  mmPerDevicePxY: number;
  originDevicePx: { x: number; y: number };    // 钉位(0,0)中心在屏幕的位置
  source: 'auto-wmi' | 'manual-ruler' | 'manual-ppi' | 'manual-span' | 'browser-fallback';
  displayKey: string;                     // `${id}|${w}x${h}|${dpr}`，按显示器记忆
  verifiedAt: string;
}

/* ---------------- 板与豆 ---------------- */

export interface BoardConfig {
  cols: number;                           // 默认 104
  rows: number;                           // 默认 104
  pitchMm: number;                        // 默认 2.6923
  beadFillRatio: number;                  // 豆点直径/格距，默认 0.90
  marginMm: number;                       // 板边留白，默认 2.0
  cellShape: 'circle' | 'square' | 'ring';    // 默认 circle
  showGrid: boolean;
  showMajorGrid: boolean;
  majorEvery: number;                     // 默认 10
  showNumbers: boolean;
  numberEvery: number;                    // 默认 10
  showRuler: boolean;
  /** 空格显示为棋盘格（马赛克）：去背景/留空区域一眼可辨（缺省 true） */
  emptyCheckerboard?: boolean;
  /** 在每颗豆子上叠加显示色号（格子够大时绘制，文字颜色按豆色自动取黑/白，缺省 false） */
  showColorCodes?: boolean;
  /** 暗色豆救援描边：豆色与画布底色对比不足时补一圈反向高对比边线
   *  ——glowDark 纯黑底上的黑/深色豆不再「看不见」。缺省 true。 */
  darkBeadEdge?: boolean;
}

export interface BeadColor {
  id: string;
  code: string;
  name: string;
  nameZh?: string;
  hex: string;
  rgb: [number, number, number];
  lab: [number, number, number];
  series?: string;
  builtin: boolean;
}

export interface BeadPalette {
  id: string;
  brand: string;
  name: string;
  beadSizeMm: number;
  colors: BeadColor[];
  editable: boolean;
  source?: string;
}

/* ---------------- 分区 / 历史 / 项目文件 ---------------- */

export interface Region {
  id: string;
  label: string;
  ix: number;
  iy: number;
  col0: number;
  row0: number;
  cols: number;
  rows: number;
}

export interface EditEntry {
  label: string;
  ts: number;
  cells?: { i: number; prev: number; next: number }[];
  snapshot?: Uint16Array;
  /** 扩板类编辑：该编辑执行**前**的板尺寸。携带此字段时 snapshot/placedMask
   *  按「整板替换」语义恢复（undo 回到 board 尺寸 + 旧板内容；redo 前进到新尺寸）。 */
  board?: { cols: number; rows: number };
}

export interface ProjectFile {
  format: 'pindou-studio/project';
  version: 1;
  meta: { name: string; createdAt: string; updatedAt: string; appVersion: string };
  board: BoardConfig;
  palette: { baseId: string; customized: boolean; colors: Omit<BeadColor, 'lab'>[] };
  beads: string;        // base64(Uint16Array LE)，0=空，n=colors[n-1]
  placedMask: string;   // base64(Uint8Array)，1=已物理放置
  calibration?: Calibration;
  sourceImage?: { name: string; dataUrl: string };  // ≤2MB 才内嵌
}

/* ---------------- 主题 ---------------- */

/**
 * Canvas 令牌【契约】—— Canvas 读不到 CSS 变量，必须由主题对象直接传给渲染器。
 * 键名逐字固定：新增主题必须全部提供。highlightGlow 为 boolean，其余为 CSS 颜色字符串。
 */
export interface CanvasTokens {
  canvasBg: string;
  canvasBgGlow: string;
  gridLine: string;
  gridLineMajor: string;
  emptyCell: string;
  emptyCellStroke: string;
  beadStroke: string;
  numberText: string;
  selectionStroke: string;
  highlightGlow: boolean;
  rulerBg: string;
  rulerText: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  nameEn: string;
  emoji: string;
  description: string;
  tokens: Record<string, string>;              // UI 令牌（--bg --bg-alt…--shadow-color，共 21 个）
  canvas: CanvasTokens;
  radius: Record<string, string>;              // sm/md/lg/pill
  motion: Record<string, string>;              // fast/base/slow/ease
  shadows: Record<string, string>;             // sm/md/lg
  previewSwatches: string[];
}

/* ---------------- UI 辅助 ---------------- */

export type ToastKind = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** 毫秒，默认 2600；<=0 表示不自动消失 */
  duration?: number;
}
