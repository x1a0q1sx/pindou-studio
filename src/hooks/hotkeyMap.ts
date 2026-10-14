/**
 * src/hooks/hotkeyMap.ts —— 全局快捷键「组合键 → 动作 id」的**纯函数层**（快捷键全表）。
 *
 * 【为什么单独一个文件】
 *   `useHotkeys.ts` 里必然 import React / zustand store / bridge，无法在 node 里直接跑单测。
 *   本文件刻意做到 **零 React、零 DOM、零 store 依赖**（只有 type-only import，编译后被擦除），
 *   于是可以用 esbuild 打包成 .mjs 直接在 node 中断言每一个组合键的映射结果。
 *
 * 【铁律】本文件不得出现 `document` / `window` / `localStorage` / React 的任何运行时引用。
 *   需要 DOM 的探测（焦点是否在输入框、是否有 Modal 打开）由调用方算好后通过
 *   `HotkeyContext` 传进来。
 *
 * 【`1` 键裁决】
 *   快捷键全表曾同时把 `1` 定义为「切 1:1 物理尺寸」和「1–9 快速选色」，二者冲突。
 *   裁决（leader 已确认）：
 *     - 数字键 `1`–`9`（无修饰键） = **快速选色**（拼豆时高频，优先级更高）
 *     - **1:1 物理尺寸切换 = `Ctrl+1`**，Toolbar 上另给一个可见的「1:1」按钮作为无键盘入口
 *     - `0` = 缩放适配（保持不变），`Ctrl+0` 等价于 `0`
 */
import type { BoardConfig, Calibration, ToolId } from '@/core/types';

/* ==================== 动作 id ==================== */

export type HotkeyActionId =
  /* 历史 */
  | 'undo'
  | 'redo'
  /* 工具切换（ToolId 一一对应） */
  | 'tool:pen'
  | 'tool:eraser'
  | 'tool:flood'
  | 'tool:replaceColor'
  | 'tool:picker'
  | 'tool:pan'
  | 'tool:markPlaced'
  /* 快速选色：数字键 1–9 → 调色板索引 0–8 */
  | 'selectColor1'
  | 'selectColor2'
  | 'selectColor3'
  | 'selectColor4'
  | 'selectColor5'
  | 'selectColor6'
  | 'selectColor7'
  | 'selectColor8'
  | 'selectColor9'
  /* 视图 */
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'zoom1to1'
  | 'fullscreen'
  | 'togglePanels'
  | 'toggleGrid'
  | 'cycleTheme'
  /* 模式 */
  | 'toggleMode'
  /* 拼豆换色（语义上仅在拼豆模式有意义，执行层会用 mode 守卫） */
  | 'colorNext'
  | 'colorPrev'
  | 'colorDone'
  /* 分区 */
  | 'regionPrev'
  | 'regionNext'
  /* 文件 */
  | 'save'
  | 'open'
  | 'export'
  | 'importImage'
  | 'print'
  /* 退出类 */
  | 'escape';

/** 全部动作 id（供 UI 生成快捷键速查表 / 单测穷举） */
export const HOTKEY_ACTION_IDS: readonly HotkeyActionId[] = [
  'undo',
  'redo',
  'tool:pen',
  'tool:eraser',
  'tool:flood',
  'tool:replaceColor',
  'tool:picker',
  'tool:pan',
  'tool:markPlaced',
  'selectColor1',
  'selectColor2',
  'selectColor3',
  'selectColor4',
  'selectColor5',
  'selectColor6',
  'selectColor7',
  'selectColor8',
  'selectColor9',
  'zoomIn',
  'zoomOut',
  'zoomFit',
  'zoom1to1',
  'fullscreen',
  'togglePanels',
  'toggleGrid',
  'cycleTheme',
  'toggleMode',
  'colorNext',
  'colorPrev',
  'colorDone',
  'regionPrev',
  'regionNext',
  'save',
  'open',
  'export',
  'importImage',
  'print',
  'escape',
];

/* ==================== 入参形状 ==================== */

/** KeyboardEvent 的最小子集（结构化类型，node 里可以直接传普通对象） */
export interface HotkeyEventLike {
  key: string;
  /** 物理键位（`KeyB`/`Digit1`/`BracketLeft`…）；优先于 key，避免输入法/键盘布局干扰 */
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** 按住不放的自动重复；匹配阶段忽略，由执行层决定是否忽略 */
  repeat?: boolean;
}

/**
 * 匹配上下文。两个开关都为真时**除 `Escape` 外全部快捷键失效**——
 * 绝不能劫持用户在输入框里的打字，也不能盖掉 Modal 自己的键盘语义。
 */
export interface HotkeyContext {
  /** 焦点在 input/textarea/select/contenteditable 内 */
  typing?: boolean;
  /** 有 Modal 处于打开状态 */
  modalOpen?: boolean;
}

/** 视图状态（与 store 的 ViewportState 结构一致，此处只用结构类型避免 import store） */
export interface ViewLike {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/* ==================== 键位归一化 ==================== */

/** code → 基础键名（只收录本项目用到的物理键位；未收录时回落到 key） */
const CODE_TO_BASE: Record<string, string> = {
  KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F', KeyG: 'G',
  KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L', KeyM: 'M', KeyN: 'N',
  KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R', KeyS: 'S', KeyT: 'T', KeyU: 'U',
  KeyV: 'V', KeyW: 'W', KeyX: 'X', KeyY: 'Y', KeyZ: 'Z',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
  Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
  Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  NumpadSubtract: '-',
  Equal: '=',
  NumpadAdd: '=',
  Space: 'Space',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
};

/** key → 基础键名（code 缺失或未被收录时的兜底；兼容旧浏览器与合成事件） */
const KEY_TO_BASE: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Esc: 'Escape',
  Escape: 'Escape',
  '+': '=',
  Add: '=',
  Subtract: '-',
  '-': '-',
  // Shift+'-' 在美式键盘上产生的 key 是 '_'（code 缺失时全靠 key 兜底），必须折回 '-'
  _: '-',
  '[': '[',
  ']': ']',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
};

/**
 * 取出「基础键名」（不含修饰键）。
 * 单字符 key 一律大写；`Ctrl+Shift+Z` 与 `Ctrl+Z` 因此共享基础键 `Z`，靠 shift 区分。
 */
export function baseKeyOf(e: HotkeyEventLike): string {
  const code = e.code;
  if (code && CODE_TO_BASE[code]) return CODE_TO_BASE[code]!;
  const key = e.key ?? '';
  if (KEY_TO_BASE[key]) return KEY_TO_BASE[key]!;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * 归一化组合键字符串，形如 `Ctrl+Shift+Z` / `Digit1→'1'` / `[`。
 * 修饰键顺序固定为 Ctrl → Alt → Shift；macOS 的 metaKey 统一折叠成 `Ctrl+`，
 * 这样一张表同时覆盖 Win/mac。
 */
export function normalizeKey(e: HotkeyEventLike): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(baseKeyOf(e));
  return parts.join('+');
}

/* ==================== 快捷键全表 ==================== */

/** 组合键 → 动作 id。键必须与 `normalizeKey` 的输出格式完全一致。 */
export const HOTKEY_TABLE: Readonly<Record<string, HotkeyActionId>> = Object.freeze({
  /* ---- 历史 ---- */
  'Ctrl+Z': 'undo',
  'Ctrl+Shift+Z': 'redo', // 与 Ctrl+Z 严格区分：多一个 Shift
  'Ctrl+Y': 'redo', // Windows 习惯的第二个重做键

  /* ---- 工具（B/E/G/R/I） ---- */
  B: 'tool:pen',
  E: 'tool:eraser',
  G: 'tool:flood',
  R: 'tool:replaceColor',
  I: 'tool:picker',
  // pan / markPlaced 刻意**不占字母键**：约定的是「Space+拖拽」平移与「Shift+点击」标记，
  // 它们属于指针修饰交互而非模式切换键，绑字母会与画笔高频操作抢键位。

  /* ---- 快速选色（裁决：无修饰数字键 = 选色） ---- */
  '1': 'selectColor1',
  '2': 'selectColor2',
  '3': 'selectColor3',
  '4': 'selectColor4',
  '5': 'selectColor5',
  '6': 'selectColor6',
  '7': 'selectColor7',
  '8': 'selectColor8',
  '9': 'selectColor9',

  /* ---- 视图缩放 ---- */
  'Ctrl+1': 'zoom1to1', // 裁决：1:1 物理尺寸让位给快速选色，改挂 Ctrl+1
  '0': 'zoomFit',
  'Ctrl+0': 'zoomFit',
  'Ctrl+=': 'zoomIn',
  'Ctrl+Shift+=': 'zoomIn', // 多数布局下 Ctrl+'+' 实际是 Ctrl+Shift+=
  'Ctrl+-': 'zoomOut',
  'Ctrl+Shift+-': 'zoomOut',

  /* ---- 全屏 / 模式 ---- */
  F: 'fullscreen',
  P: 'toggleMode', // 进出拼豆模式（1:1 + focus 布局 + glowDark + 全屏 + 防休眠）

  /* ---- 拼豆换色（只在拼豆模式生效；设计模式下按了不做事，见 useHotkeys 分支） ---- */
  N: 'colorNext', // 切到「剩余最多」的下一个色
  'Shift+N': 'colorPrev', // 反向（当前色即最多时切到次多者）
  Enter: 'colorDone', // 把当前色剩余全部标记为已拼（二次确认）

  /* ---- 分区切换 ---- */
  '[': 'regionPrev',
  ']': 'regionNext',

  /* ---- 文件（浏览器默认行为必须 preventDefault） ---- */
  'Ctrl+S': 'save',
  'Ctrl+O': 'open',
  'Ctrl+E': 'export',
  'Ctrl+Shift+I': 'importImage', // 额外给「导入图片」一个键盘入口（Toolbar 按钮同源）
  'Ctrl+P': 'print', // 劫持浏览器打印：本项目用 Ctrl+E 导出施工图

  /* ---- 外观 / 面板 ---- */
  T: 'cycleTheme',
  H: 'toggleGrid',
  M: 'togglePanels',

  /* ---- 退出类 ---- */
  Escape: 'escape',
});

/** 动作 → 中文说明（Toolbar/LeftRail 的 Tooltip 与速查表共用） */
export const HOTKEY_LABELS: Readonly<Record<HotkeyActionId, string>> = Object.freeze({
  undo: '撤销',
  redo: '重做',
  'tool:pen': '画笔',
  'tool:eraser': '橡皮',
  'tool:flood': '连通填充',
  'tool:replaceColor': '同色替换',
  'tool:picker': '取色',
  'tool:pan': '平移',
  'tool:markPlaced': '标记已放',
  selectColor1: '选第 1 色',
  selectColor2: '选第 2 色',
  selectColor3: '选第 3 色',
  selectColor4: '选第 4 色',
  selectColor5: '选第 5 色',
  selectColor6: '选第 6 色',
  selectColor7: '选第 7 色',
  selectColor8: '选第 8 色',
  selectColor9: '选第 9 色',
  zoomIn: '放大',
  zoomOut: '缩小',
  zoomFit: '缩放适配',
  zoom1to1: '1:1 物理尺寸',
  fullscreen: '全屏',
  togglePanels: '显隐面板',
  toggleGrid: '显隐网格',
  cycleTheme: '循环切主题',
  toggleMode: '进出拼豆模式',
  colorNext: '下一色（剩余最多）',
  colorPrev: '上一色',
  colorDone: '本色拼完（标记剩余为已拼）',
  regionPrev: '上一区块',
  regionNext: '下一区块',
  save: '保存项目',
  open: '打开项目',
  export: '导出',
  importImage: '导入图片',
  print: '打印（已让位给导出）',
  escape: '退出 / 关闭 / 取消',
});

/** 动作 → 展示用键位文本（`Ctrl+Shift+Z` 这种，给 Tooltip 用） */
export const HOTKEY_COMBOS: Readonly<Partial<Record<HotkeyActionId, string>>> = Object.freeze({
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z / Ctrl+Y',
  'tool:pen': 'B',
  'tool:eraser': 'E',
  'tool:flood': 'G',
  'tool:replaceColor': 'R',
  'tool:picker': 'I',
  'tool:pan': 'Space+拖拽 / 中键',
  'tool:markPlaced': 'Shift+点击',
  zoomIn: 'Ctrl+=',
  zoomOut: 'Ctrl+-',
  zoomFit: '0',
  zoom1to1: 'Ctrl+1',
  fullscreen: 'F',
  togglePanels: 'M',
  toggleGrid: 'H',
  cycleTheme: 'T',
  toggleMode: 'P',
  colorNext: 'N',
  colorPrev: 'Shift+N',
  colorDone: 'Enter',
  regionPrev: '[',
  regionNext: ']',
  save: 'Ctrl+S',
  open: 'Ctrl+O',
  export: 'Ctrl+E',
  importImage: 'Ctrl+Shift+I',
  print: 'Ctrl+P',
  escape: 'Esc',
});

/** ToolId → 工具快捷键提示文本（LeftRail/Toolbar 的 Tooltip 用） */
export const TOOL_HOTKEYS: Readonly<Record<ToolId, string>> = Object.freeze({
  pen: 'B',
  eraser: 'E',
  flood: 'G',
  replaceColor: 'R',
  picker: 'I',
  pan: 'Space+拖拽',
  markPlaced: 'Shift+点击',
});

/** ToolId → 对应动作 id */
export function toolActionId(tool: ToolId): HotkeyActionId {
  return `tool:${tool}` as HotkeyActionId;
}

/** 动作 id → ToolId（非工具动作返回 null） */
export function actionToolId(action: HotkeyActionId): ToolId | null {
  if (!action.startsWith('tool:')) return null;
  return action.slice(5) as ToolId;
}

/** 快速选色动作 → 调色板索引（0–8）；非选色动作返回 null */
export function actionColorIndex(action: HotkeyActionId): number | null {
  if (!action.startsWith('selectColor')) return null;
  const n = Number(action.slice('selectColor'.length));
  if (!Number.isInteger(n) || n < 1 || n > 9) return null;
  return n - 1;
}

/* ==================== 匹配 ==================== */

/**
 * 组合键 → 动作 id。**纯函数**，可直接 node 单测。
 *
 * 规则：
 * 1. `ctx.typing` 或 `ctx.modalOpen` 为真时，除 `Escape` 外一律返回 `null`（输入态豁免）。
 * 2. 带 Ctrl/Meta 的组合优先匹配；不带修饰键的字母/数字键只匹配单键条目。
 * 3. `Alt+*` 一律不绑定（留给浏览器/系统），返回 `null`。
 * 4. 未绑定的键返回 `null`。
 */
export function matchHotkey(e: HotkeyEventLike, ctx: HotkeyContext = {}): HotkeyActionId | null {
  const base = baseKeyOf(e);
  if (!base) return null;

  const blocked = ctx.typing === true || ctx.modalOpen === true;
  if (blocked) {
    // 输入态 / Modal 态：只放行 Esc，其余全部失效
    if (base === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) return 'escape';
    return null;
  }

  // Alt 组合保留给系统，绝不劫持
  if (e.altKey) return null;

  const combo = normalizeKey(e);
  const hit = HOTKEY_TABLE[combo];
  if (hit) return hit;

  // 兜底：`Ctrl+Shift+=` 在部分布局下 code 缺失、key 为 '+'（或 Shift+'-' 时 key 为 '_'），
  // normalize 后会带上多余的 Shift；上表已同时收录两种写法，这里再补一层「Shift+标点」的退化匹配。
  if (e.shiftKey && (base === '=' || base === '-')) {
    const relaxed = `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${base}`;
    const hit2 = HOTKEY_TABLE[relaxed];
    if (hit2) return hit2;
  }

  return null;
}

/**
 * 该事件是否需要 `preventDefault()`。
 * 命中动作 → 一律拦截（含浏览器自身的 Ctrl+S/O/E/P 与 Ctrl±缩放）；
 * 未命中但是 Space（非输入态）→ 也拦截，防止页面滚动 / 焦点按钮被空格重复激活。
 */
export function shouldPreventDefault(e: HotkeyEventLike, ctx: HotkeyContext = {}): boolean {
  if (matchHotkey(e, ctx) !== null) return true;
  const blocked = ctx.typing === true || ctx.modalOpen === true;
  if (blocked) return false;
  return baseKeyOf(e) === 'Space';
}

/* ==================== 输入态探测（纯结构化，不碰 DOM） ==================== */

/** `document.activeElement` 的最小结构子集 */
export interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string | null;
}

/** 会接收文本输入、因而必须豁免快捷键的标签名 */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** 这些 input 类型不接收文本，快捷键可以照常工作（如 checkbox/range/button） */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color',
]);

/** 焦点是否落在会接收文本输入的元素上 */
export function isTypingTarget(el: TypingTargetLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (!TYPING_TAGS.has(tag)) return false;
  if (tag === 'INPUT') {
    const type = (el.type ?? 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  // TEXTAREA / SELECT：一律视为输入态
  return true;
}

/* ==================== 分区 / 缩放 纯计算 ==================== */

/** 设计视图缩放区间（0.1×–8× 足够覆盖 104×104 板的预览与检查） */
export const SCALE_MIN = 0.1;
export const SCALE_MAX = 8;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}

/**
 * 区块索引步进：越界**循环**（不是钳制）。
 * 理由：拼豆时是 A1→A2→B1→B2→回到 A1 的环形流水线，循环比钳制少一次「退回去」的操作；
 * 与 AppShell 的 FocusLayout `stepRegion` 既有实现保持一致。
 */
export function nextRegionIndex(current: number, count: number, delta: number): number {
  const n = Math.max(1, Math.floor(count));
  const c = Math.floor(current);
  return ((c + delta) % n + n) % n;
}

/** 与 `@/core/geometry.pitchToDevicePx` 等价的两行换算（此处内联以保持本文件零依赖） */
function pitchDevicePx(pitchMm: number, cal: Calibration): { x: number; y: number } {
  return { x: pitchMm / cal.mmPerDevicePxX, y: pitchMm / cal.mmPerDevicePxY };
}

/**
 * 以**锚点不动**的方式缩放（Ctrl+滚轮的核心：锚点是鼠标位置，不是画布中心）。
 *
 * 推导：设 k = nextScale / view.scale，设备像素域原点
 *   originDev = cal.originDevicePx + offset*dpr，格子坐标 colF = (devX-originDev)/(pitch*k)。
 *   令锚点 devX 处的 colF 前后相等 ⇒ originDev' = devX + k*(originDev - devX)
 *   ⇒ offset' = offset*k + (anchorCss - cal.originDevicePx/dpr) * (1-k)
 *
 * @param anchorCss 锚点相对 **canvas 元素左上角** 的 CSS 像素坐标
 */
export function zoomViewAtAnchor(
  view: ViewLike,
  cal: Calibration,
  dpr: number,
  anchorCssX: number,
  anchorCssY: number,
  nextScale: number,
): ViewLike {
  const ratio = dpr > 0 ? dpr : 1;
  const scale = clampScale(nextScale);
  const s0 = view.scale > 0 ? view.scale : 1;
  const k = scale / s0;
  const originCssX = cal.originDevicePx.x / ratio;
  const originCssY = cal.originDevicePx.y / ratio;
  return {
    scale,
    offsetX: view.offsetX * k + (anchorCssX - originCssX) * (1 - k),
    offsetY: view.offsetY * k + (anchorCssY - originCssY) * (1 - k),
  };
}

/**
 * 缩放适配（`0` 键）：整板等比缩放到刚好填满视口，并把板中心对齐视口中心。
 * @param viewportCss 画布容器的 CSS 像素尺寸
 */
export function computeFitView(
  board: Pick<BoardConfig, 'cols' | 'rows' | 'pitchMm'>,
  cal: Calibration,
  dpr: number,
  viewportCssW: number,
  viewportCssH: number,
): ViewLike {
  const ratio = dpr > 0 ? dpr : 1;
  const pitch = pitchDevicePx(board.pitchMm, cal);
  const boardDevW = Math.max(1, board.cols * pitch.x);
  const boardDevH = Math.max(1, board.rows * pitch.y);
  const vpDevW = Math.max(1, viewportCssW * ratio);
  const vpDevH = Math.max(1, viewportCssH * ratio);
  const scale = clampScale(Math.min(vpDevW / boardDevW, vpDevH / boardDevH));
  return {
    scale,
    offsetX: (vpDevW / 2 - (boardDevW * scale) / 2 - cal.originDevicePx.x) / ratio,
    offsetY: (vpDevH / 2 - (boardDevH * scale) / 2 - cal.originDevicePx.y) / ratio,
  };
}

/** 1:1 物理尺寸（`Ctrl+1`）：scale 锁 1，板原点回到校准原点（offset 归零） */
export function computeOneToOneView(): ViewLike {
  return { scale: 1, offsetX: 0, offsetY: 0 };
}

/* ==================== 速查表（UI 展示用） ==================== */

export interface HotkeyCheatEntry {
  combo: string;
  action: HotkeyActionId;
  label: string;
}

/** 按分组给出速查表，供「快捷键」弹窗或报告使用 */
export function buildCheatSheet(): Record<string, HotkeyCheatEntry[]> {
  const groups: Record<string, HotkeyActionId[]> = {
    历史: ['undo', 'redo'],
    工具: ['tool:pen', 'tool:eraser', 'tool:flood', 'tool:replaceColor', 'tool:picker', 'tool:pan', 'tool:markPlaced'],
    选色: ['selectColor1', 'selectColor9'],
    视图: ['zoomIn', 'zoomOut', 'zoomFit', 'zoom1to1', 'fullscreen', 'togglePanels', 'toggleGrid', 'cycleTheme'],
    模式与分区: ['toggleMode', 'regionPrev', 'regionNext'],
    /* 拼豆换色：进拼豆模式后高频使用，单独成组避免淹没在「模式与分区」里 */
    拼豆换色: ['colorNext', 'colorPrev', 'colorDone'],
    文件: ['save', 'open', 'export', 'importImage', 'print'],
    其他: ['escape'],
  };
  const out: Record<string, HotkeyCheatEntry[]> = {};
  for (const [name, actions] of Object.entries(groups)) {
    out[name] = actions.map((a) => ({
      combo: HOTKEY_COMBOS[a] ?? '—',
      action: a,
      label: HOTKEY_LABELS[a],
    }));
  }
  return out;
}
