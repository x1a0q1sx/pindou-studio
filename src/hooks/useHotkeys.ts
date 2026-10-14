/**
 * src/hooks/useHotkeys.ts —— 全局快捷键（快捷键全表）。
 *
 * 【分层】
 *   `hotkeyMap.ts`（纯函数，零 DOM/零 React）负责「组合键 → 动作 id」的匹配，可 node 单测；
 *   本文件负责 DOM 侧：焦点/Modal 探测、preventDefault、以及把动作 id 执行成真实的 store/bridge 调用。
 *
 * 【输入态豁免 · 最容易踩的坑】
 *   焦点在 input/textarea/select/contenteditable 内、或有 Modal 打开时，**除 Esc 外全部快捷键失效**，
 *   绝不能劫持用户打字。判定用 `isTypingTarget(document.activeElement)` + `.pdb-modal-overlay` DOM 探测。
 *
 * 【拼豆模式联动（P / Esc）】
 *   store 里**没有**「模式联动开关」字段（形状是  契约、不可增字段），故联动快照由本模块持有：
 *   进入 placement = 锁 1:1 + focus 布局 + glowDark 主题 + 全屏 + keepAwake(true)，并记住进入前的
 *   layout/theme/view；退出时**逐项反向恢复** + keepAwake(false)。
 *   ⚠️ 联动开关（是否自动全屏/自动换主题）在设置面板补齐；届时把本模块的常量提到 store 即可。
 *
 * 【StrictMode 双挂载】
 *   只挂一个 window keydown 监听，useEffect 返回严格的 removeEventListener；
 *   动作执行器全部是幂等的模块级函数，双挂载不会导致一次按键触发两次。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { MutableRefObject } from 'react';
import { usePdbStore } from '@/store';
import { peekRedoInfo, peekUndoInfo, redo as redoEdit, undo as undoEdit } from '@/store/history';
import { openProject, saveProjectAs } from '@/store/persistence';
// 懒加载瘦身：导出器（含 PNG 光栅化）体积可观，只在真正导出时才下载
import type { ExportKind } from '@/io/exporters';
import { getBridge } from '@/io/bridge';
import { applyThemeById, getTheme, nextThemeId } from '@/themes';
import { sanitizeCalibration } from '@/core/geometry';
import { regionLabel } from '@/core/region';
import { useFullscreen } from '@/hooks/useFullscreen';
import type { UseFullscreenReturn } from '@/hooks/useFullscreen';
import type { FilterMode, LayoutId, ThemeId } from '@/core/types';
import {
  actionColorIndex,
  actionToolId,
  buildCheatSheet,
  clampScale,
  computeFitView,
  computeOneToOneView,
  isTypingTarget,
  matchHotkey,
  nextRegionIndex,
  shouldPreventDefault,
  zoomViewAtAnchor,
} from '@/hooks/hotkeyMap';
import type { HotkeyActionId, HotkeyCheatEntry, HotkeyContext, ViewLike } from '@/hooks/hotkeyMap';
import { closeReplaceColorDialog, endActiveStroke, getPaintUi, getActiveRenderer } from '@/hooks/usePointerPaint';
import { getPlacementLinkage } from '@/store/placementPrefs';
import { stepColor } from '@/store/placementActions';
import { mountPlacementOverlay } from '@/components/progress/PlacementOverlay';

/* ==================== 常量（联动开关已移至 placementPrefs store，此处保留布局/主题 ID） ==================== */

/** 缩放步进（Ctrl+± / Toolbar 按钮共用） */
export const ZOOM_STEP = 1.2;
/** 拼豆模式目标布局与主题（prefs.autoLayout/autoTheme 控制是否启用） */
const PLACEMENT_LAYOUT: LayoutId = 'focus';
const PLACEMENT_THEME: ThemeId = 'glowDark';
/** 导出兜底种类（仓内暂无 ExportDialog，补齐后 Ctrl+E 会改成打开对话框） */
const FALLBACK_EXPORT_KIND: ExportKind = 'placementTxt';

/* ==================== 面板显隐（M 键）的轻量外部 store ==================== */

let panelsHidden = false;
const panelListeners = new Set<() => void>();

function emitPanels(): void {
  for (const l of panelListeners) l();
}

function subscribePanels(l: () => void): () => void {
  panelListeners.add(l);
  return () => {
    panelListeners.delete(l);
  };
}

function getPanelsSnapshot(): boolean {
  return panelsHidden;
}

/** 面板是否被 `M` 隐藏（Toolbar 按钮的 pressed 态订阅它） */
export function usePanelsHidden(): boolean {
  return useSyncExternalStore(subscribePanels, getPanelsSnapshot, getPanelsSnapshot);
}

/**
 * 显隐四周面板。实现方式：给 `<html>` 打 `data-pdb-panels` 标记，
 * 由 `layout/tools.css` 统一收起 `.pdb-toolbar/.pdb-left-rail/.pdb-right-panel/.pdb-statusbar`。
 * 这样**不需要改动任何布局组件的内部结构**，4 套布局一起生效。
 */
export function setPanelsHidden(hidden: boolean): void {
  if (panelsHidden === hidden) return;
  panelsHidden = hidden;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.pdbPanels = hidden ? 'hidden' : 'visible';
  }
  emitPanels();
}

export function arePanelsHidden(): boolean {
  return panelsHidden;
}

export function togglePanels(): void {
  setPanelsHidden(!panelsHidden);
  usePdbStore.getState().pushToast('info', panelsHidden ? '已隐藏面板（M 恢复）' : '已显示面板', 1600);
}

/* ==================== 拼豆模式联动快照 ==================== */

interface PlacementSnapshot {
  layout: LayoutId;
  theme: ThemeId;
  view: ViewLike;
  /** 双板并排布局的右画布视图 */
  viewB: ViewLike;
  /** 进入拼豆前刻度尺是否开启（拼豆下自动隐藏避免遮挡最左列，退出恢复） */
  rulerOn: boolean;
  /** 进入拼豆前的按色筛选状态（进入时自动切「发光板」，退出逐项还原） */
  filterColorIndex: number;
  filterMode: FilterMode;
  /** 进入拼豆前的当前色（发光板会改 activeColorIndex，退出还原） */
  activeColorIndex: number;
}

let placementSnapshot: PlacementSnapshot | null = null;

/** 当前是否处于由本模块发起的拼豆模式会话（Toolbar 的模式切换按钮据此同步） */
export function isPlacementSessionActive(): boolean {
  return placementSnapshot !== null;
}

/**
 * 拼豆模式进入时自动启用的显示档 —— 「发光板」。
 * 语义：屏幕上只亮「当前色 ∩ 未拼」的格子，已拼熄灭、其他色纯黑，
 * 与真实发光底板的观感一致（见 core/types.ts 的 FilterMode.panel 注释）。
 */
const PLACEMENT_FILTER_MODE: FilterMode = 'panel';

export interface AppActionEnv {
  /** 由 `useHotkeys` 注入（内部来自 `useFullscreen()`）；缺省时回落到 `getBridge()` */
  fullscreen?: UseFullscreenReturn;
  /** 画布元素 ref：缩放适配 / 锚点缩放 / 1:1 需要它的 CSS 尺寸 */
  stageRef?: MutableRefObject<HTMLCanvasElement | null>;
}

/** useHotkeys 挂载时写入，Toolbar 等 UI 直接调 `runAppAction(id)` 即可复用同一套实现 */
let activeEnv: AppActionEnv = {};

function enterFullscreen(env: AppActionEnv): void {
  // 缺陷 #41：优先用用户在校准页**选定的显示器**（store.display），而不是主显示器——
  // 拼豆板对齐的是选定屏，进入全屏不该把窗口拽回主屏。无选定时才回退主屏。
  const selectedDisplayId = usePdbStore.getState().display?.id;
  if (env.fullscreen) {
    void env.fullscreen.enter(selectedDisplayId);
    return;
  }
  void getBridge().enterFullscreen(selectedDisplayId);
}

function exitFullscreen(env: AppActionEnv): void {
  if (env.fullscreen) {
    void env.fullscreen.exit();
    return;
  }
  void getBridge().exitFullscreen();
}

/**
 * 进出拼豆模式（`P` / Toolbar 的「设计|拼豆」分段控件共用同一实现）。
 * 进入：mode='placement' + scale 锁 1 + focus 布局 + glowDark 主题 + 全屏 + keepAwake(true)
 * 退出：**逐项反向恢复**进入前的 layout/theme/view + 退出全屏 + keepAwake(false)
 */
export function setPlacementMode(on: boolean, env: AppActionEnv = activeEnv): void {
  const s = usePdbStore.getState();
  const prefs = getPlacementLinkage();

  if (on) {
    if (s.mode === 'placement') return;
    placementSnapshot = {
      layout: s.layout, theme: s.theme, view: { ...s.view }, viewB: { ...s.viewB },
      rulerOn: s.board.showRuler,
      filterColorIndex: s.filterColorIndex, filterMode: s.filterMode,
      activeColorIndex: s.activeColorIndex,
    };
    s.setMode('placement');
    // placement 模式下渲染器强制 scale=1，这里同步 store 以便退出设计模式时数值连续
    s.setView({ scale: 1, offsetX: 0, offsetY: 0 });
    s.setViewB({ scale: 1, offsetX: 0, offsetY: 0 }); // 双板并排布局的右画布同样锁 1:1
    // 自动启「发光板」：只亮当前色未拼格，一进模式就是可照着拼的底板。
    // 筛选色取当前色；当前色无效（色板为空）则退化为不动，用户可在顶部条重新选色。
    if (s.activeColorIndex >= 0 && s.activeColorIndex < s.palette.colors.length) {
      s.setFilter(s.activeColorIndex, PLACEMENT_FILTER_MODE);
    }
    if (prefs.autoLayout) s.setLayout(PLACEMENT_LAYOUT);
    if (prefs.autoTheme && s.theme !== PLACEMENT_THEME) {
      s.setTheme(PLACEMENT_THEME);
      applyThemeById(PLACEMENT_THEME);
    }
    if (prefs.autoFullscreen) enterFullscreen(env);
    if (prefs.keepAwake) void getBridge().keepAwake(true);
    // 极简拼豆标记：配合 progress.css 的 html[data-pdb-placement='on'] 规则，
    // 隐藏布局自身的全部工具界面，只留板子 + 可拖动浮动按钮。dimPanels 关闭时保留面板。
    if (prefs.dimPanels && typeof document !== 'undefined') {
      document.documentElement.dataset.pdbPlacement = 'on';
    }
    // 分块兜底 & 大屏自动合块（用户反馈 #54）：按 store.display（与全屏同一目标屏）的
    // 1:1 容量重估——装得下自动合并单块，装不下按最小方案分块（首块尽量占满、余量归
    // 末块），手动分块只增不减；格子永远 1:1 不缩小。
    s.reconcileRegionWithDisplay();
    // 刻度尺避让（用户反馈：拼豆下刻度尺遮挡最左列）：进入时自动隐藏，退出时按快照恢复
    if (s.board.showRuler) {
      s.setBoardConfig({ showRuler: false });
      s.pushToast('info', '刻度尺已自动隐藏（避免遮挡最左列）；拼豆面板里可重新打开', 4200);
    }
    s.pushToast('success', '已进入拼豆模式：1:1 物理尺寸，只显示板子。点浮动按钮打开操作面板（Esc 退出）', 4200);
    return;
  }

  if (s.mode !== 'placement') return;
  const snap = placementSnapshot;
  placementSnapshot = null;
  s.setMode('design');
  // 清除面板压暗标记
  if (typeof document !== 'undefined') {
    delete document.documentElement.dataset.pdbPlacement;
  }
  // 恢复进入前隐藏的刻度尺
  if (snap && snap.rulerOn && !s.board.showRuler) {
    s.setBoardConfig({ showRuler: true });
  }
  if (snap) {
    // 显示状态逐项还原：发光板 / 筛选色 / 当前色（避免退出后画布仍停在拼豆视角）
    s.setActiveColorIndex(snap.activeColorIndex);
    if (snap.filterMode === 'off') s.setFilterMode('off');
    else s.setFilter(snap.filterColorIndex, snap.filterMode);
    if (prefs.autoLayout) s.setLayout(snap.layout);
    if (prefs.autoTheme && s.theme !== snap.theme) {
      s.setTheme(snap.theme);
      applyThemeById(snap.theme);
    }
    s.setView({ scale: snap.view.scale, offsetX: snap.view.offsetX, offsetY: snap.view.offsetY });
    s.setViewB({ scale: snap.viewB.scale, offsetX: snap.viewB.offsetX, offsetY: snap.viewB.offsetY });
  } else {
    applyThemeById(s.theme);
  }
  if (prefs.autoFullscreen) exitFullscreen(env);
  if (prefs.keepAwake) void getBridge().keepAwake(false);
  s.pushToast('info', '已退出拼豆模式，恢复到进入前的布局与主题', 2600);
}

/* ==================== 视图动作 ==================== */

interface CanvasBox {
  cssW: number;
  cssH: number;
  dpr: number;
}

function canvasBox(env: AppActionEnv): CanvasBox {
  const canvas = env.stageRef?.current;
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { cssW: rect.width, cssH: rect.height, dpr };
  }
  // 兜底：拿不到画布时用窗口尺寸（缩放适配仍然可用，只是不含面板占位误差）
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  return { cssW: w, cssH: h, dpr };
}

/**
 * 缩放目标解析（补全）：dual 布局两块画布各自持有视图，
 * 「Ctrl+±/0/1」必须作用于**鼠标悬停的那个窗格**——activeRenderer registry
 * 由 StageCanvas 在 pointerenter 时接管，这里读它拿到 viewKey 与画布尺寸；
 * 单画布布局（registry 为空或拿不到尺寸）回退主画布 + view。
 */
function resolveZoomTarget(env: AppActionEnv): { viewKey: 'view' | 'viewB'; box: CanvasBox } {
  const r = getActiveRenderer();
  if (r) {
    const rect = r.canvasEl.getBoundingClientRect();
    const box: CanvasBox = rect.width > 0 && rect.height > 0
      ? { cssW: rect.width, cssH: rect.height, dpr: r.effectiveDpr }
      : canvasBox(env);
    return { viewKey: r.viewKey, box };
  }
  return { viewKey: 'view', box: canvasBox(env) };
}

/** 按 viewKey 选出「视图 + 写入口」（dual 布局右画布写 viewB） */
function viewSelectors(s: ReturnType<typeof usePdbStore.getState>, viewKey: 'view' | 'viewB') {
  return viewKey === 'viewB'
    ? { view: s.viewB, setViewSel: s.setViewB }
    : { view: s.view, setViewSel: s.setView };
}

/** 以画布中心为锚点缩放（`Ctrl+±`；Ctrl+滚轮的锚点是鼠标位置，由 StageCanvas 处理） */
function zoomBy(factor: number, env: AppActionEnv): void {
  const s = usePdbStore.getState();
  if (s.mode === 'placement') {
    s.pushToast('info', '拼豆模式锁定 1:1 物理尺寸，不能缩放（Esc 退出后可缩放）', 2600);
    return;
  }
  const { viewKey, box } = resolveZoomTarget(env);
  const { view, setViewSel } = viewSelectors(s, viewKey);
  const next = clampScale(view.scale * factor);
  if (next === view.scale) return;
  const cal = sanitizeCalibration(s.calibration);
  const nextView = zoomViewAtAnchor(view, cal, box.dpr, box.cssW / 2, box.cssH / 2, next);
  setViewSel(nextView);
}

/** 缩放适配（`0`）：整板刚好填满视口并居中 */
function zoomFit(env: AppActionEnv): void {
  const s = usePdbStore.getState();
  if (s.mode === 'placement') {
    s.pushToast('info', '拼豆模式已是 1:1 物理尺寸，无需适配', 2200);
    return;
  }
  const { viewKey, box } = resolveZoomTarget(env);
  const { setViewSel } = viewSelectors(s, viewKey);
  const cal = sanitizeCalibration(s.calibration);
  const view = computeFitView(s.board, cal, box.dpr, box.cssW, box.cssH);
  setViewSel(view);
  s.pushToast('success', `已缩放适配：${Math.round(view.scale * 100)}%（整板居中）`, 2000);
}

/** 1:1 物理尺寸（`Ctrl+1` + Toolbar 的「1:1」按钮） */
function zoomOneToOne(): void {
  const s = usePdbStore.getState();
  if (s.mode === 'placement') {
    s.pushToast('info', '拼豆模式本身就是 1:1 物理尺寸', 2000);
    return;
  }
  const { viewKey } = resolveZoomTarget({});
  viewSelectors(s, viewKey).setViewSel(computeOneToOneView());
  const cal = sanitizeCalibration(s.calibration);
  s.pushToast(
    'success',
    `已切到 1:1 物理尺寸（${s.board.pitchMm}mm 格距 · ${(cal.pitchMm / cal.mmPerDevicePxX).toFixed(2)} 设备像素/格）`,
    2600,
  );
}

/* ==================== 文件 / 导出动作 ==================== */

async function doExport(): Promise<void> {
  const s = usePdbStore.getState();
  // 先给 ExportDialog 一次机会：若有人监听了该事件就把 handled 置真
  const detail: { handled: boolean } = { handled: false };
  window.dispatchEvent(new CustomEvent('pdb:open-export', { detail }));
  if (detail.handled) return;

  // 兜底：直接导出分色施工图（exporters 已定稿可用）
  try {
    const { exportAndDownload } = await import('@/io/exporters');
    const r = await exportAndDownload(
      { board: s.board, beads: s.beads, placedMask: s.placedMask, palette: s.palette },
      FALLBACK_EXPORT_KIND,
    );
    if (r.ok) {
      s.pushToast('success', `已导出 ${r.filename}${r.path ? `：${r.path}` : ''}`, 3200);
    } else if (!r.cancelled && r.error && r.error !== '已取消保存') {
      s.pushToast('danger', `导出失败：${r.error}`, 5000);
    }
  } catch (err) {
    s.pushToast('danger', `导出失败：${err instanceof Error ? err.message : String(err)}`, 5000);
  }
}

/* ==================== 动作执行器 ==================== */

/**
 * 执行一个快捷键动作。**快捷键与 Toolbar/LeftRail 按钮共用这一个入口**，
 * 保证「点按钮」和「按键」的行为、Toast 文案、联动逻辑完全一致。
 */
export function runAppAction(action: HotkeyActionId, env: AppActionEnv = activeEnv): void {
  const s = usePdbStore.getState();

  switch (action) {
    /* ---- 历史 ---- */
    case 'undo': {
      endActiveStroke(); // 拖拽中途按 Ctrl+Z：先把笔画收尾成一条历史，再撤销它
      const info = peekUndoInfo();
      if (!undoEdit()) {
        s.pushToast('info', '没有可撤销的操作', 1600);
        return;
      }
      s.pushToast('success', `已撤销「${info ? info.label : '操作'}」`, 1600);
      return;
    }
    case 'redo': {
      endActiveStroke();
      const info = peekRedoInfo();
      if (!redoEdit()) {
        s.pushToast('info', '没有可重做的操作', 1600);
        return;
      }
      s.pushToast('success', `已重做「${info ? info.label : '操作'}」`, 1600);
      return;
    }

    /* ---- 工具 ---- */
    case 'tool:pen':
    case 'tool:eraser':
    case 'tool:flood':
    case 'tool:replaceColor':
    case 'tool:picker':
    case 'tool:pan':
    case 'tool:markPlaced': {
      const tool = actionToolId(action);
      if (!tool) return;
      s.setTool(tool);
      return;
    }

    /* ---- 快速选色 ---- */
    case 'selectColor1':
    case 'selectColor2':
    case 'selectColor3':
    case 'selectColor4':
    case 'selectColor5':
    case 'selectColor6':
    case 'selectColor7':
    case 'selectColor8':
    case 'selectColor9': {
      const idx = actionColorIndex(action);
      if (idx === null) return;
      const c = s.palette.colors[idx];
      if (!c) {
        s.pushToast('warning', `当前色板只有 ${s.palette.colors.length} 色，没有第 ${idx + 1} 色`, 2400);
        return;
      }
      s.setActiveColorIndex(idx);
      s.pushToast('info', `当前色：${c.code} ${c.nameZh ?? c.name}`, 1400);
      return;
    }

    /* ---- 视图 ---- */
    case 'zoomIn':
      zoomBy(ZOOM_STEP, env);
      return;
    case 'zoomOut':
      zoomBy(1 / ZOOM_STEP, env);
      return;
    case 'zoomFit':
      zoomFit(env);
      return;
    case 'zoom1to1':
      zoomOneToOne();
      return;
    case 'fullscreen': {
      // 全屏优先去用户选定的显示器（缺陷 #41）
      const selectedDisplayId = usePdbStore.getState().display?.id;
      if (env.fullscreen) void env.fullscreen.toggle(selectedDisplayId);
      else if (typeof document !== 'undefined' && document.fullscreenElement) void getBridge().exitFullscreen();
      else void getBridge().enterFullscreen(selectedDisplayId);
      return;
    }
    case 'togglePanels':
      togglePanels();
      return;
    case 'toggleGrid': {
      // 「网格」是 showGrid（细线）+ showMajorGrid（粗线）的总开关；行列号与标尺不受影响
      const next = !s.board.showGrid;
      s.setBoardConfig({ showGrid: next, showMajorGrid: next });
      s.pushToast('info', next ? '已显示网格（H 切换）' : '已隐藏网格（H 切换）', 1600);
      return;
    }
    case 'cycleTheme': {
      const next = nextThemeId(s.theme);
      s.setTheme(next);
      applyThemeById(next);
      s.pushToast('info', `主题：${getTheme(next).name}（T 循环切换）`, 1800);
      return;
    }

    /* ---- 模式 ---- */
    case 'toggleMode':
      setPlacementMode(s.mode !== 'placement', env);
      return;

    /* ---- 拼豆换色（只在拼豆模式有意义；设计模式下按了给提示，不静默失败） ---- */
    case 'colorNext':
    case 'colorPrev': {
      if (s.mode !== 'placement') {
        s.pushToast('info', '切色快捷键只在拼豆模式生效（按 P 进入拼豆模式）', 2400);
        return;
      }
      stepColor(action === 'colorNext' ? 'next' : 'prev');
      return;
    }
    case 'colorDone': {
      if (s.mode !== 'placement') {
        s.pushToast('info', '「本色拼完」只在拼豆模式生效（按 P 进入拼豆模式）', 2400);
        return;
      }
      // 键盘路径与顶部条共用同一确认对话框：派发事件让 PlacementTopBar 弹确认窗，
      // 避免在热键层直接写数据（确认交互必须可见、可取消）。
      window.dispatchEvent(new CustomEvent('pdb:placement-confirm-done'));
      return;
    }

    /* ---- 分区 ---- */
    case 'regionPrev':
    case 'regionNext': {
      const count = Math.max(1, s.region.splitsX * s.region.splitsY);
      if (count <= 1) {
        s.pushToast('info', '当前未分区（1×1），可在右侧「板参数」里设置分区', 2600);
        return;
      }
      const delta = action === 'regionNext' ? 1 : -1;
      const nextIdx = nextRegionIndex(s.region.activeIndex, count, delta);
      s.setRegion({ activeIndex: nextIdx });
      const ix = nextIdx % s.region.splitsX;
      const iy = Math.floor(nextIdx / s.region.splitsX);
      // #25：统一走 core/region.ts 的 regionLabel（字母=列 ix + 数字=行 iy+1），
      // 与画布括标 / AppShell 区块 chip 同一口径，删除手写拼接
      s.pushToast('info', `区块 ${regionLabel(ix, iy)}（${nextIdx + 1}/${count}）`, 1400);
      return;
    }

    /* ---- 文件 ---- */
    case 'save':
      // persistence 内部自带成功/失败/取消的中文 Toast，这里不重复提示
      void saveProjectAs();
      return;
    case 'open':
      void openProject();
      return;
    case 'export':
      void doExport();
      return;
    case 'importImage':
      window.dispatchEvent(new CustomEvent('pdb:open-import'));
      return;
    case 'print':
      s.pushToast('info', '本项目不走浏览器打印：请用 Ctrl+E 导出分色施工图后按需打印', 4200);
      return;

    /* ---- 退出类 ---- */
    case 'escape':
      handleEscape(env);
      return;

    default:
      return;
  }
}

/**
 * Esc 的优先级（「退出」语义的展开）：
 *   1. Modal 打开 → 交给 Modal 自己关（本函数直接返回，避免误退出拼豆模式）
 *   2. 有拖拽到一半的笔画 → 收尾成一条可撤销的历史
 *   3. 拼豆模式 → 退出并反向恢复
 *   4. 面板被隐藏 → 恢复面板
 *   5. 当前工具不是画笔 → 回到画笔（取消当前工具）
 */
function handleEscape(env: AppActionEnv): void {
  if (typeof document !== 'undefined' && document.querySelector('.pdb-modal-overlay')) return;
  const s = usePdbStore.getState();
  if (getPaintUi().replaceOpen) {
    closeReplaceColorDialog();
    return;
  }
  if (endActiveStroke()) return;
  if (s.mode === 'placement') {
    setPlacementMode(false, env);
    return;
  }
  if (panelsHidden) {
    setPanelsHidden(false);
    s.pushToast('info', '已恢复面板显示', 1600);
    return;
  }
  if (s.tool !== 'pen') {
    s.setTool('pen');
    s.pushToast('info', '已取消当前工具，回到画笔', 1600);
  }
}

/* ==================== Hook ==================== */

export interface UseHotkeysOptions {
  /** 画布元素 ref（缩放适配 / 锚点缩放需要它的 CSS 尺寸）；由 AppShell 传入 */
  stageRef?: MutableRefObject<HTMLCanvasElement | null>;
  /** 置 false 可整体停用（例如未来做「快捷键自定义」编辑态） */
  enabled?: boolean;
}

export interface UseHotkeysReturn {
  /** 手动执行某个动作（UI 按钮可直接调，行为与按键完全一致） */
  run: (action: HotkeyActionId) => void;
  /** 分组速查表（做「快捷键」说明弹窗时用） */
  cheatsheet: Record<string, HotkeyCheatEntry[]>;
}

/** 判定当前是否处于「不该劫持键盘」的上下文（纯 DOM 探测，结果喂给 hotkeyMap 的纯函数） */
function readContext(): HotkeyContext {
  if (typeof document === 'undefined') return { typing: false, modalOpen: false };
  return {
    typing: isTypingTarget(document.activeElement as HTMLElement | null),
    modalOpen: document.querySelector('.pdb-modal-overlay') !== null,
  };
}

/** 这些动作在按住不放（auto-repeat）时必须忽略，否则会疯狂来回切换 */
const REPEAT_UNSAFE = new Set<HotkeyActionId>([
  'toggleMode',
  'fullscreen',
  'togglePanels',
  'toggleGrid',
  'cycleTheme',
  'zoomFit',
  'zoom1to1',
  'escape',
  'save',
  'open',
  'export',
  'importImage',
  'print',
]);

/**
 * 在 `AppShell` 挂载一次即可（全局快捷键）。
 * 内部只注册一个 window keydown 监听，卸载时严格摘除；StrictMode 双挂载不会导致重复触发。
 */
export function useHotkeys(options: UseHotkeysOptions = {}): UseHotkeysReturn {
  const fullscreen = useFullscreen();
  const { stageRef, enabled = true } = options;

  // 把 env 暴露给模块级执行器，让 Toolbar/LeftRail 的按钮与快捷键走同一套实现
  useEffect(() => {
    activeEnv = { fullscreen, stageRef };
    // 挂载拼豆模式 overlay（独立 React root，仅 placement 模式下可见）
    mountPlacementOverlay();
    return () => {
      activeEnv = {};
    };
  }, [fullscreen, stageRef]);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      const ctx = readContext();
      const action = matchHotkey(e, ctx);

      // 未命中任何动作时，Space 仍要拦截：防止页面滚动 / 焦点按钮被空格重复激活
      if (shouldPreventDefault(e, ctx)) e.preventDefault();
      if (!action) return;
      if (e.repeat && REPEAT_UNSAFE.has(action)) return;

      runAppAction(action, { fullscreen, stageRef });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, fullscreen, stageRef]);

  const run = useCallback((action: HotkeyActionId): void => {
    runAppAction(action, activeEnv);
  }, []);

  return { run, cheatsheet: buildCheatSheet() };
}
