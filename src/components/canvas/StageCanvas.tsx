/**
 * src/components/canvas/StageCanvas.tsx —— 画布主组件（接管  的 CanvasStage 占位）。
 *
 * 职责：
 * - canvas 元素与 ResizeObserver 尺寸自适应
 * - 实例化 Renderer、订阅 store（beadsVersion/board/calibration/theme/view/region/filter/mode）
 * - 指针事件转 screenToCell 并暴露回调接口
 * - Ctrl+滚轮缩放（**以鼠标位置为锚点**）、Space+拖拽 / 中键 / pan 工具平移
 * - 叠加 OriginHandle + AlignGuide（已实现）
 *
 *  接线完成：onCellHit / onCellHover / onCellLeave 由 `usePointerPaint` 消费。
 *
 * 【修复 $1 · Renderer 反复重建】
 *   原先 `getState` 依赖 `[hoverCell]`，而渲染器初始化 effect 依赖 `[stageRef, getState]`
 *   ⇒ **指针每移动一格就 dispose + new Renderer**（重新分配 4 张离屏画布），拖拽绘制时是灾难。
 *   现在 `getState` 通过 `hoverCellRef` 读悬停格、依赖数组为空，Renderer 全程只建一次。
 *
 * 【修复 $1 · 悬停只失效 L3】
 *   悬停格变化原先触发 `invalidateAll()`（10816 格全量重绘）。高亮环只画在 L3 交互层，
 *   故改为 `invalidate(3)`；且悬停格只存 ref、不走 React state（每跨一格 setState 会
 *   让组件持续 re-render），变化时直接失效 L3 + 排一帧 rAF，指针高频移动零 React 开销。
 *
 * 【修复 $1 · Ctrl+滚轮 preventDefault 失效】
 *   React 18 把 root 上的 `wheel` 注册为 passive 监听，JSX 的 `onWheel` 里调 `preventDefault()`
 *   不生效（还会打印告警），页面会跟着滚动。改为在 canvas 元素上挂原生 `{ passive: false }` 监听。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { usePdbStore } from '@/store';
import { getTheme } from '@/themes';
import { sanitizeCalibration } from '@/core/geometry';
import { getActiveRegionOffset } from '@/core/region';
import { Renderer } from '@/render/renderer';
import type { RendererState } from '@/render/renderer';
import { SCALE_MAX, SCALE_MIN, isTypingTarget, zoomViewAtAnchor } from '@/hooks/hotkeyMap';
import { setActiveRenderer, getActiveRenderer } from '@/hooks/usePointerPaint';
import { OriginHandle } from './OriginHandle';
import { AlignGuide } from './AlignGuide';
import { RulerOverlay } from './RulerOverlay';
import './canvas.css';

/** 拼豆模式：位移超过该值（px）判定为拖拽平移，否则视为单击标记 */
const PLACEMENT_PAN_THRESHOLD = 5;
export interface StageCanvasProps {
  stageRef?: MutableRefObject<HTMLCanvasElement | null>;
  className?: string;
  /** 格子命中回调（：usePointerPaint 消费；kind 区分左键/右键/Shift+点击） */
  onCellHit?: (row: number, col: number, kind: 'primary' | 'secondary' | 'shift') => void;
  /** 格子悬停回调（：既是高亮反馈，也是拖拽笔画的续点来源） */
  onCellHover?: (row: number, col: number) => void;
  /**  新增（可选、向后兼容）：指针移出板面时清空悬停格 */
  onCellLeave?: () => void;
  /**
   * Renderer 实例就绪/销毁回调。
   * 创建渲染器时以实例调用，dispose 时以 null 调用，供外部拿到实例做脏矩形接线。
   * 不传时行为完全不变。
   */
  onRendererReady?: (renderer: Renderer | null) => void;
  /**
   * 外部持有的 Renderer ref。
   * 实例就绪时写入，dispose 时置 null。不传时行为完全不变。
   */
  rendererRef?: MutableRefObject<Renderer | null>;
  /** 视图来源（双板并排）：view = 左/主画布，viewB = 右画布。缺省 view。 */
  viewKey?: 'view' | 'viewB';
  /** 数据来源（双图同屏）：A = 主图案，B = 第二图案（boardB/beadsB/regionB）。缺省 A。 */
  dataKey?: 'A' | 'B';
}

export function StageCanvas({
  stageRef,
  className = '',
  onCellHit,
  onCellHover,
  onCellLeave,
  onRendererReady,
  rendererRef: externalRendererRef,
  viewKey = 'view',
  dataKey = 'A',
}: StageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const rafRef = useRef<number>(0);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  /**
   * 悬停格只存 ref、不走 React state：指针移动是每秒数百次的高频事件，
   * 逐格 setState 会让本组件（及两个 effect）持续 re-render。高亮环画在 L3 交互层，
   * updateHover 直接失效 L3 + 排一帧 rAF 即可；渲染器经 getState() 读本 ref。
   * StatusBar 需要的悬停信息由 usePointerPaint 的 paintUiStore（useSyncExternalStore）另行镜像。
   */
  const hoverCellRef = useRef<{ row: number; col: number } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const panStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  /**
   * 拼豆模式压点：pointerdown 记录起点但不落格；位移超阈值升级为平移，
   * 否则 pointerup 时按「单击标记已放置」处理。row/col 为 -1 表示压点时不在板上。
   */
  const placementPress = useRef<{ x: number; y: number; row: number; col: number; panning: boolean } | null>(null);
  /**
   * #24 pan 手势兜底：window 级一次性清理监听（endPan 函数本体）。
   * setPointerCapture 失败（走 catch）后，指针在画布外释放时 canvas 的 onPointerUp
   * 收不到，panStart 残留导致指针重进画布持续漂移；窗口失焦同理。
   */
  const endPanRef = useRef<(() => void) | null>(null);
  /**
   * ：保持 onRendererReady 的最新引用，避免把它放进渲染器初始化 effect 的依赖数组
   *   （否则父组件传内联回调会导致 Renderer 每次渲染都重建 —— 正是  修复1 要杜绝的灾难）。
   *   初值即挂载时的回调，后续变化由下方 sync effect 刷新。
   */
  const onRendererReadyRef = useRef(onRendererReady);

  // Store subscriptions（view/setView 按 viewKey 选择：dual 布局左右画布各用各的视图；
  // board/beads/placed/region/beadsVersion 按 dataKey 选择：右画布可走图 B 通道）
  const board = usePdbStore((s) => (dataKey === 'B' ? s.boardB : s.board));
  const beadsVersion = usePdbStore((s) => (dataKey === 'B' ? s.beadsBVersion : s.beadsVersion));
  const themeId = usePdbStore((s) => s.theme);
  // palette 也订阅：改色（updateColor/addColor）不改 beads、不 bump 版本，
  // 不订阅的话画布上的豆子颜色会停留在旧色值（视觉陈旧 bug）
  const palette = usePdbStore((s) => s.palette);
  const calibration = usePdbStore((s) => s.calibration);
  const view = usePdbStore((s) => (viewKey === 'viewB' ? s.viewB : s.view));
  const mode = usePdbStore((s) => s.mode);
  const region = usePdbStore((s) => (dataKey === 'B' ? s.regionB : s.region));
  const filterColorIndex = usePdbStore((s) => s.filterColorIndex);
  const filterMode = usePdbStore((s) => s.filterMode);
  const vbLight = usePdbStore((s) => s.vbLight);
  const setView = usePdbStore((s) => (viewKey === 'viewB' ? s.setViewB : s.setView));
  const tool = usePdbStore((s) => s.tool);
  const brushSize = usePdbStore((s) => s.brushSize);

  // Build renderer state getter（依赖 viewKey/dataKey：切通道时重建；其余现取 store，悬停格走 ref）
  const getState = useCallback((): RendererState => {
    const s = usePdbStore.getState();
    const isB = dataKey === 'B';
    const boardX = isB ? s.boardB : s.board;
    const regionX = isB ? s.regionB : s.region;
    const cal = sanitizeCalibration(s.calibration);
    const tokens = getTheme(s.theme).canvas;
    // 区块对位/裁剪只属于拼豆模式：设计模式永远渲染整板（绝对坐标），
    // 否则缩小后超出活动区块边界（"中线"以外）的内容不显示（用户反馈 bug）。
    // B 画布例外：regionB 就是它的分页开关，设计/拼豆模式都生效。
    const regionOffset = (isB || s.mode === 'placement')
      ? getActiveRegionOffset(
          boardX.cols, boardX.rows,
          regionX.splitsX, regionX.splitsY,
          regionX.activeIndex,
          regionX.blockCols,
          regionX.blockRows,
        )
      : null;
    return {
      board: boardX,
      beads: isB ? s.beadsB : s.beads,
      placedMask: isB ? s.placedB : s.placedMask,
      beadsVersion: isB ? s.beadsBVersion : s.beadsVersion,
      palette: s.palette,
      calibration: cal,
      view: viewKey === 'viewB' ? s.viewB : s.view,
      mode: s.mode,
      filterColorIndex: s.filterColorIndex,
      filterMode: s.filterMode,
      vbLight: s.vbLight,
      region: regionX,
      canvasTokens: tokens,
      hoverCell: hoverCellRef.current,
      tool: s.tool,
      brushSize: s.brushSize,
      regionOffset,
    };
  }, [viewKey, dataKey]);

  const scheduleRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      rendererRef.current?.render();
    });
  }, []);

  // 保持 onRendererReadyRef 与最新回调同步（不进初始化 effect 的依赖，Renderer 全程只建一次）
  useEffect(() => {
    onRendererReadyRef.current = onRendererReady;
  }, [onRendererReady]);

  // Initialize renderer
  useEffect(() => {
    const canvas = stageRef?.current;
    if (!canvas) return;
    const renderer = new Renderer(canvas, getState, viewKey);
    rendererRef.current = renderer;

    // ：对外暴露 Renderer（三条通道并存，均为可选、向后兼容；不传时行为完全不变）
    //   1) 模块级 registry setActiveRenderer：usePointerPaint 免改 AppShell 即可拿到实例，
    //      拖拽笔画每帧对实际改动的格调 markCellsDirty，替代 beadsVersion→invalidateAll 全量重绘；
    //   2) 可选 prop rendererRef：外部显式持有实例；
    //   3) 可选 prop onRendererReady：就绪/销毁回调。
    setActiveRenderer(renderer);
    if (externalRendererRef) externalRendererRef.current = renderer;
    onRendererReadyRef.current?.(renderer);

    const parent = canvas.parentElement;
    if (parent) {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w > 0 && h > 0) {
        renderer.setViewport(w, h, window.devicePixelRatio || 1);
        setContainerSize({ w, h });
      }
    }

    renderer.render();

    return () => {
      renderer.dispose();
      rendererRef.current = null;
      // 三条暴露通道同步收尾（strict mode 双挂载时，第二次挂载会重新写入活实例）。
      // dual 布局两个画布共享 registry：卸载时仅在 registry 仍指向本实例时清空，
      // 避免卸载左画布把右画布的活动渲染器一并清掉。
      if (getActiveRenderer() === renderer) setActiveRenderer(null);
      if (externalRendererRef) externalRendererRef.current = null;
      onRendererReadyRef.current?.(null);
    };
  }, [stageRef, getState, viewKey]);

  // ResizeObserver
  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (w > 0 && h > 0) {
        setContainerSize({ w, h });
        rendererRef.current?.setViewport(w, h, window.devicePixelRatio || 1);
        scheduleRender();
      }
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [scheduleRender]);

  // Re-render on 结构/视图变化（板参/主题/校准/视图/模式/分区/色板）→ 全量重绘
  // （悬停格不在此列——走 updateHover 的 L3 局部失效；beadsVersion 拆到下一个 effect 走脏矩形局部路径）
  useEffect(() => {
    rendererRef.current?.invalidateAll();
    scheduleRender();
  }, [board, themeId, calibration, view, mode, region, palette, scheduleRender]);

  // 筛选态 / 手机点亮图案 → 只失效 L2 筛选层（layers.ts 分层契约：L0 网格、L1 豆点、
  // L3 交互都不读筛选状态）。切色是拼豆模式最高频的操作，此前混在全量 effect 里每次
  // invalidateAll 连 L1 上万颗豆点一起重画 —— 这是「切色卡顿」的主因。
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.invalidate(2);
    scheduleRender();
  }, [filterColorIndex, filterMode, vbLight, scheduleRender]);

  // 工具 / 笔刷 → 只失效 L3 交互层（光标预览、笔刷范围环）
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.invalidate(3);
    scheduleRender();
  }, [tool, brushSize, scheduleRender]);

  // beadsVersion 变化：拖拽绘制已按格标脏且版本快照匹配时走局部重绘（跳过 invalidateAll），否则全量。
  // consumeCellDirtyPending() 返回 { pending, version }：pending 为 true ⇔ 本帧已有来源
  // （拖拽笔画 flushStroke / history 的 pushEdit·undo·redo / 填充替换）调 markCellsDirty 标好脏瓦片；
  // version 是置位时的 beadsVersion 快照（#24 竞态守卫）。
  // 仅当「按格标脏 && 快照 === 本 effect 收到的 beadsVersion」才走局部路径；否则（未标脏的
  // 一次性大改：整板落地、色板重映射、快照型撤销；或置位后同帧插入另一来源的 beads 变更）
  // 一律回落 invalidateAll() 全量重绘，避免按格标脏只覆盖部分格子、其余格漏绘。
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    const ticket = r.consumeCellDirtyPending();
    if (!(ticket.pending && ticket.version === beadsVersion)) r.invalidateAll();
    scheduleRender();
  }, [beadsVersion, scheduleRender]);

  // Keyboard: Space for pan（输入态 / Modal 态豁免，绝不劫持打字）
  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat) return;
      if (isTypingTarget(document.activeElement as HTMLElement | null)) return;
      if (document.querySelector('.pdb-modal-overlay')) return;
      e.preventDefault(); // 阻止页面滚动与焦点按钮被空格激活
      setSpaceDown(true);
    };
    const onUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    const onBlur = (): void => setSpaceDown(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  /**
   * #24 pan 手势兜底（参照 usePointerPaint attach/detachEndListeners 的笔画收尾模式）：
   * 进入 pan 手势时挂一次性 window 级 pointerup/pointercancel/blur —— 捕获失败或指针在
   * 画布外/窗口失焦时收尾 panStart + endGesture，杜绝 panStart 残留导致指针重进画布持续漂移。
   * 正常收尾（canvas onPointerUp）与异常收尾（window endPan）都会摘除监听；卸载时兜底摘除。
   */
  const detachPanGuards = useCallback((): void => {
    const fn = endPanRef.current;
    if (!fn) return;
    window.removeEventListener('pointerup', fn);
    window.removeEventListener('pointercancel', fn);
    window.removeEventListener('blur', fn);
    endPanRef.current = null;
  }, []);

  const attachPanGuards = useCallback((): void => {
    if (endPanRef.current) return; // 已挂
    const endPan = (): void => {
      detachPanGuards();
      if (panStart.current) {
        panStart.current = null;
        rendererRef.current?.endGesture();
      }
    };
    endPanRef.current = endPan;
    window.addEventListener('pointerup', endPan);
    window.addEventListener('pointercancel', endPan);
    window.addEventListener('blur', endPan);
  }, [detachPanGuards]);

  // 卸载兜底摘除（覆盖手势进行中组件卸载的场景）
  useEffect(() => detachPanGuards, [detachPanGuards]);

  /**
   * 悬停格更新（只写 ref；行列未变时零开销）。变化时只失效 L3 交互层（高亮环）并排帧渲染，
   * 绝不触发 React 重渲染、绝不重绘 L0–L2。
   */
  const updateHover = useCallback((cell: { row: number; col: number } | null) => {
    const prev = hoverCellRef.current;
    const same =
      (prev === null && cell === null) ||
      (prev !== null && cell !== null && prev.row === cell.row && prev.col === cell.col);
    if (same) return;
    hoverCellRef.current = cell;
    rendererRef.current?.invalidate(3);
    scheduleRender();
  }, [scheduleRender]);

  // Pointer events
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = stageRef?.current;
    if (!canvas) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const s = usePdbStore.getState();

    // 拼豆模式：左键**拖拽 = 平移图纸**（渲染器锁 1:1，格距不变），
    // **单击（位移 < 5px）= 标记/取消已放置**。压下时先不落格，move 超阈值才转平移——
    // 这样逐颗点格计数与拖动对位互不打架。右键/Shift 保持原有标记语义。
    if (s.mode === 'placement' && e.button === 0) {
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败不视为错误 */
      }
      const cell = renderer.screenToCell(e.clientX, e.clientY);
      placementPress.current = { x: e.clientX, y: e.clientY, row: cell?.row ?? -1, col: cell?.col ?? -1, panning: false };
      return;
    }

    // 中键 / Space+左键 / pan 工具 = 平移手势（手势期 blit，结束后清晰重绘）
    const viewNow = viewKey === 'viewB' ? s.viewB : s.view;
    const wantsPan = e.button === 1 || (e.button === 0 && (spaceDown || s.tool === 'pan'));
    if (wantsPan) {
      e.preventDefault();
      // 缺陷#6：非真实 pointerId（合成事件/已失效指针）捕获会抛 NotFoundError 中断手势；
      // try/catch 静默降级 —— 捕获失败时 move/up 仍会正常派发，平移不受影响
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败不视为错误 */
      }
      panStart.current = { x: e.clientX, y: e.clientY, ox: viewNow.offsetX, oy: viewNow.offsetY };
      // #24：捕获失败/画布外释放/窗口失焦的兜底收尾（正常路径由 onPointerUp 摘除）
      attachPanGuards();
      renderer.beginGesture();
      return;
    }

    // 左键 = 主操作，右键 = 次操作（默认擦除），Shift+左键 = 标记/取消已放置
    if (e.button !== 0 && e.button !== 2) return;
    const cell = renderer.screenToCell(e.clientX, e.clientY);
    if (!cell) return;
    // 拖拽绘制时指针会移出画布：捕获后 move/up 仍派发到本元素，笔画不会中断
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 个别浏览器对右键捕获抛错，忽略即可（window 上的 pointerup 仍会收尾笔画） */
    }
    if (!onCellHit) return;
    const kind: 'primary' | 'secondary' | 'shift' =
      e.button === 2 ? 'secondary' : e.shiftKey ? 'shift' : 'primary';
    onCellHit(cell.row, cell.col, kind);
  }, [stageRef, spaceDown, onCellHit]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    // 拼豆模式压点：位移超阈值 → 升级为平移手势（格距锁 1:1，只改 offset 不改 scale）
    const press = placementPress.current;
    if (press && !press.panning) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= PLACEMENT_PAN_THRESHOLD) {
        press.panning = true;
        const s = usePdbStore.getState();
        const viewNow = viewKey === 'viewB' ? s.viewB : s.view;
        panStart.current = { x: e.clientX, y: e.clientY, ox: viewNow.offsetX, oy: viewNow.offsetY };
        attachPanGuards();
        renderer.beginGesture();
      }
    }

    // Panning
    if (panStart.current) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      const current = usePdbStore.getState();
      if (current.mode === 'placement') {
        // 拼豆模式只改 offset，并在每次拖动帧强制 scale=1，绝不改变格距。
        setView({ scale: 1, offsetX: panStart.current.ox + dx, offsetY: panStart.current.oy + dy });
      } else {
        setView({ offsetX: panStart.current.ox + dx, offsetY: panStart.current.oy + dy });
      }
      return;
    }

    // 拼豆模式压点未升级为平移（还没松开）：不触发绘制/悬停，等 pointerup 判定单击
    if (placementPress.current) return;

    // Hover（同时是拖拽笔画的续点：usePointerPaint 在 onCellHover 里做 Bresenham 插值）
    const cell = renderer.screenToCell(e.clientX, e.clientY);
    updateHover(cell);
    if (cell) {
      if (onCellHover) onCellHover(cell.row, cell.col);
    } else if (onCellLeave) {
      onCellLeave();
    }
  }, [setView, onCellHover, onCellLeave, updateHover, attachPanGuards]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = stageRef?.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    // #24：正常收尾先摘 window 兜底监听（避免 window endPan 重复触发 endGesture）
    detachPanGuards();
    if (panStart.current) {
      panStart.current = null;
      rendererRef.current?.endGesture();
    }
    // 拼豆模式：未发生平移的单击 = 标记/取消已放置（kind='shift' 走 markPlaced，不挑工具）
    const press = placementPress.current;
    placementPress.current = null;
    if (press && !press.panning && press.row >= 0 && press.col >= 0 && onCellHit) {
      onCellHit(press.row, press.col, 'shift');
    }
  }, [stageRef, detachPanGuards, onCellHit]);

  const onPointerLeave = useCallback(() => {
    updateHover(null);
    if (onCellLeave) onCellLeave();
  }, [updateHover, onCellLeave]);

  /** 指针进入本画布 → 接管「活动渲染器」：键盘缩放（Ctrl+±/0/1）跟随悬停窗格（dual 布局） */
  const onPointerEnter = useCallback(() => {
    const r = rendererRef.current;
    if (r) setActiveRenderer(r);
  }, []);

  // Ctrl+Wheel = zoom（设计模式限定；以**鼠标位置**为锚点，不是画布中心）
  // 用原生非 passive 监听：React 的 onWheel 在 root 上是 passive 的，preventDefault 无效
  useEffect(() => {
    const canvas = stageRef?.current;
    if (!canvas) return;
    const handler = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      // #24：命中 Ctrl/meta 即拦截——preventDefault 必须先于模式判断，否则 placement 模式
      // 提前 return 会把事件放行给浏览器/Ctrl+滚轮页面缩放。placement 下仅不改 view。
      e.preventDefault();
      const renderer = rendererRef.current;
      if (!renderer) return;
      const s = usePdbStore.getState();
      if (s.mode === 'placement') return; // 拼豆模式锁 1:1（拦截已完成，不再放行页面缩放）

      const rect = canvas.getBoundingClientRect();
      // #24：锚点推导必须用渲染器实际 DPR（clamp 封顶 2）；dpr>2 的设备上用原始
      // window.devicePixelRatio 会与渲染域不一致，缩放锚点漂移
      const dpr = renderer.effectiveDpr;
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      // 双板并排：滚轮缩放作用于本画布的视图
      const view = viewKey === 'viewB' ? s.viewB : s.view;
      const setViewSel = viewKey === 'viewB' ? s.setViewB : s.setView;
      const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, view.scale * factor));
      if (next === view.scale) return;

      const cal = sanitizeCalibration(s.calibration);
      renderer.beginGesture();
      setViewSel(zoomViewAtAnchor(view, cal, dpr, e.clientX - rect.left, e.clientY - rect.top, next));
      // endGesture 内部有 120ms 防抖 → 连续滚动只做一次清晰重绘
      window.setTimeout(() => renderer.endGesture(), 50);
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [stageRef, viewKey]);

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const cursor = spaceDown || tool === 'pan' ? 'grab' : 'crosshair';

  return (
    <div ref={containerRef} className={`pdb-stage-wrap ${className}`}>
      <canvas
        ref={stageRef}
        className="pdb-stage-canvas"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="拼豆板画布"
      />
      {/* 标尺叠加层 */}
      {containerSize.w > 0 && board.showRuler && (
        <RulerOverlay width={containerSize.w} height={containerSize.h} viewKey={viewKey} dataKey={dataKey} />
      )}
      {/*  叠加层：原点手柄 + 对齐括标 */}
      {containerSize.w > 0 && (
        <>
          <AlignGuide width={containerSize.w} height={containerSize.h} showBoardOutline={mode === 'placement'} />
          {mode === 'placement' && (
            <OriginHandle containerWidth={containerSize.w} containerHeight={containerSize.h} dpr={dpr} />
          )}
        </>
      )}
    </div>
  );
}
