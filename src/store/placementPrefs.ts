/**
 * src/store/placementPrefs.ts —— 拼豆模式联动 + 发光底板增强 偏好（专用轻量 slice）。
 *
 * 【为什么独立于 store/index.ts】
 *   根 store 的形状是  契约、字段不可增删；本模块用**独立的 zustand store** 承载  新增的
 *   可配置项，既不污染契约、也不需要改动 store/index.ts 或 store/persistence.ts（后者是  领地）。
 *
 * 【持久化】沿用 theme/layout/calibration 的 localStorage 命名空间约定（见 theme/appearance.ts），
 *   key = `pindou-studio:placement-prefs`；读写失败（隐私模式/配额满）静默降级为会话级生效。
 *
 * 【两类偏好】
 *   1. 联动开关：进入拼豆模式时是否自动全屏 / 自动切 focus 布局 / 自动切 glowDark 主题 / 防休眠 / 压暗面板。
 *      —— useHotkeys.setPlacementMode 读这些开关取代原先写死的模块级常量。
 *   2. 发光增强：亮度 / 饱和度 / 外发光强度 / 空格纯黑。
 *      —— render/renderer.ts 在绘制时同步读取（getGlowPrefs），补偿透明板色偏。
 */
import { create } from 'zustand';

/* ------------------------------------------------------------------ 类型 */

/** 拼豆模式联动开关（进入 placement 时逐项生效，退出时逐项还原） */
export interface PlacementLinkage {
  /** 进入拼豆模式自动进入全屏（浏览器下需用户手势，快捷键/按钮点击本身即手势） */
  autoFullscreen: boolean;
  /** 自动切换到 focus 专注布局；关闭则保留当前布局 */
  autoLayout: boolean;
  /** 自动切换到 glowDark 发光主题；关闭则保留当前主题 */
  autoTheme: boolean;
  /** 防休眠（Electron powerSaveBlocker / 浏览器 Wake Lock），退出拼豆模式自动释放 */
  keepAwake: boolean;
  /** 拼豆模式下面板压暗，只让画布发光（<html> data 标记 + progress.css 实现） */
  dimPanels: boolean;
}

/** 发光底板增强（补偿透明板色偏；数值型默认 1.0 = 不做任何处理） */
export interface GlowEnhance {
  /** 亮度增强倍率（0.6–1.8，默认 1.0）——作用于豆点层合成 */
  brightness: number;
  /** 饱和度增强倍率（0.6–2.2，默认 1.0）——作用于豆点层合成 */
  saturation: number;
  /** 当前色外发光强度倍率（0–2.5，默认 1.0）——作用于 L2 shadowBlur */
  glowBoost: number;
  /** 空格子渲染纯黑 #000000（LCD 不漏光）；仅在 highlightGlow 主题（glowDark）下生效 */
  pureBlackEmpty: boolean;
}

export type PlacementPrefs = PlacementLinkage & GlowEnhance;

export interface PlacementPrefsStore extends PlacementPrefs {
  /** 合并式更新并持久化（任意子集） */
  update: (patch: Partial<PlacementPrefs>) => void;
  /** 恢复发光增强默认值（亮度/饱和度/发光回 1.0、空格纯黑开） */
  resetGlow: () => void;
  /** 恢复联动开关默认值（全部开） */
  resetLinkage: () => void;
}

/* ------------------------------------------------------------------ 默认值 */

export const DEFAULT_PLACEMENT_PREFS: PlacementPrefs = {
  autoFullscreen: true,
  autoLayout: true,
  autoTheme: true,
  keepAwake: true,
  dimPanels: true,
  brightness: 1,
  saturation: 1,
  glowBoost: 1,
  pureBlackEmpty: true,
};

/** 发光增强的默认值子集（resetGlow 用） */
const DEFAULT_GLOW: GlowEnhance = {
  brightness: DEFAULT_PLACEMENT_PREFS.brightness,
  saturation: DEFAULT_PLACEMENT_PREFS.saturation,
  glowBoost: DEFAULT_PLACEMENT_PREFS.glowBoost,
  pureBlackEmpty: DEFAULT_PLACEMENT_PREFS.pureBlackEmpty,
};

/** 联动开关的默认值子集（resetLinkage 用） */
const DEFAULT_LINKAGE: PlacementLinkage = {
  autoFullscreen: DEFAULT_PLACEMENT_PREFS.autoFullscreen,
  autoLayout: DEFAULT_PLACEMENT_PREFS.autoLayout,
  autoTheme: DEFAULT_PLACEMENT_PREFS.autoTheme,
  keepAwake: DEFAULT_PLACEMENT_PREFS.keepAwake,
  dimPanels: DEFAULT_PLACEMENT_PREFS.dimPanels,
};

/* ------------------------------------------------------------------ localStorage */

const KEY = 'pindou-studio:placement-prefs';

/** 数值夹取工具（防脏数据/手改 localStorage 造成渲染异常） */
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function loadPrefs(): PlacementPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (!raw) return { ...DEFAULT_PLACEMENT_PREFS };
    const p = JSON.parse(raw) as Partial<PlacementPrefs>;
    return {
      autoFullscreen: p.autoFullscreen ?? DEFAULT_PLACEMENT_PREFS.autoFullscreen,
      autoLayout: p.autoLayout ?? DEFAULT_PLACEMENT_PREFS.autoLayout,
      autoTheme: p.autoTheme ?? DEFAULT_PLACEMENT_PREFS.autoTheme,
      keepAwake: p.keepAwake ?? DEFAULT_PLACEMENT_PREFS.keepAwake,
      dimPanels: p.dimPanels ?? DEFAULT_PLACEMENT_PREFS.dimPanels,
      brightness: clampNum(p.brightness, 0.6, 1.8, DEFAULT_PLACEMENT_PREFS.brightness),
      saturation: clampNum(p.saturation, 0.6, 2.2, DEFAULT_PLACEMENT_PREFS.saturation),
      glowBoost: clampNum(p.glowBoost, 0, 2.5, DEFAULT_PLACEMENT_PREFS.glowBoost),
      pureBlackEmpty: p.pureBlackEmpty ?? DEFAULT_PLACEMENT_PREFS.pureBlackEmpty,
    };
  } catch {
    return { ...DEFAULT_PLACEMENT_PREFS };
  }
}

function persistPrefs(prefs: PlacementPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 隐私模式/配额满：静默，偏好仍是会话级生效
  }
}

/** 从完整 store 状态里剥出可持久化的偏好字段（不含 action） */
function pickPrefs(s: PlacementPrefsStore): PlacementPrefs {
  return {
    autoFullscreen: s.autoFullscreen,
    autoLayout: s.autoLayout,
    autoTheme: s.autoTheme,
    keepAwake: s.keepAwake,
    dimPanels: s.dimPanels,
    brightness: s.brightness,
    saturation: s.saturation,
    glowBoost: s.glowBoost,
    pureBlackEmpty: s.pureBlackEmpty,
  };
}

/* ------------------------------------------------------------------ store */

export const usePlacementPrefs = create<PlacementPrefsStore>()((set, get) => ({
  ...loadPrefs(),

  update: (patch) => {
    const next: PlacementPrefsStore = { ...get(), ...patch };
    // 数值项夹取，杜绝越界
    if (patch.brightness !== undefined) next.brightness = clampNum(patch.brightness, 0.6, 1.8, 1);
    if (patch.saturation !== undefined) next.saturation = clampNum(patch.saturation, 0.6, 2.2, 1);
    if (patch.glowBoost !== undefined) next.glowBoost = clampNum(patch.glowBoost, 0, 2.5, 1);
    set(next);
    persistPrefs(pickPrefs(next));
  },

  resetGlow: () => {
    const next: PlacementPrefsStore = { ...get(), ...DEFAULT_GLOW };
    set(next);
    persistPrefs(pickPrefs(next));
  },

  resetLinkage: () => {
    const next: PlacementPrefsStore = { ...get(), ...DEFAULT_LINKAGE };
    set(next);
    persistPrefs(pickPrefs(next));
  },
}));

/* ------------------------------------------------------------------ 非响应式读取（供渲染器/联动逻辑） */

/**
 * 渲染器专用：同步读取发光增强参数（无 React 订阅）。
 * render/renderer.ts 在每次绘制时调用，数值变化由外部触发重绘（bump beadsVersion）后生效。
 */
export function getGlowPrefs(): GlowEnhance {
  const s = usePlacementPrefs.getState();
  return {
    brightness: s.brightness,
    saturation: s.saturation,
    glowBoost: s.glowBoost,
    pureBlackEmpty: s.pureBlackEmpty,
  };
}

/** 联动逻辑专用：同步读取联动开关（useHotkeys.setPlacementMode 用） */
export function getPlacementLinkage(): PlacementLinkage {
  const s = usePlacementPrefs.getState();
  return {
    autoFullscreen: s.autoFullscreen,
    autoLayout: s.autoLayout,
    autoTheme: s.autoTheme,
    keepAwake: s.keepAwake,
    dimPanels: s.dimPanels,
  };
}
