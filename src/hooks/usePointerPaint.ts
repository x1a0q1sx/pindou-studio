/**
 * src/hooks/usePointerPaint.ts —— 指针绘制编排。
 *
 * 【职责】把 `StageCanvas` 的 `onCellHit` / `onCellHover` / `onCellLeave` 三个回调，
 *   按 store 的 `tool` 分派成 7 种工具行为，并保证：
 *   1. 一次 `pointerdown → pointermove… → pointerup` 拖拽 = **一条**历史记录
 *      （`beginTransaction` / `addTransactionCells` / `commitTransaction` 三件套）；
 *   2. 拖拽过程用 `bresenhamLine`（由 `applyLine` 内部调用）插值补齐快速划过跳过的格子，绝不断线；
 *   3. 一帧内多次 pointermove **合批**成一次 `mutateBeads`，只 bump 一次 `beadsVersion`
 *      —— 否则 104×104=10816 格会被反复全量重绘；
 *   4. 一切写入只走 `mutateBeads` / `mutatePlaced`（store 铁律：typed array 内容变更 zustand 感知不到）；
 *   5. `markPlaced` 与 `Shift+点击` 写 `placedMask`，**不进撤销栈**（契约如此）。
 *
 * 【为什么不持有 React state】
 *   指针绘制是每帧数十次的高频事件。若用 useState 保存 hover/笔画状态，AppShell 整棵树会被反复重渲染。
 *   因此本 hook **只用 ref**，回调引用恒定；需要被 UI 观察的少量状态（悬停格、替换对话框开关）
 *   放在模块级的轻量外部 store 里，由 `usePaintUi()`（useSyncExternalStore）按需订阅。
 *
 * 【hover 高亮路径选择】
 *   复用既有链路：StageCanvas 自己维护 `hoverCell` state → 注入 `RendererState.hoverCell`
 *   → renderer L3 交互层画高亮环（strokeRect + highlightGlow）。本 hook **不重复实现**高亮，
 *   只把悬停格镜像到 `paintUiStore` 供 StatusBar 显示「光标所在格 (行, 列)」。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { colorAt, usePdbStore } from '@/store';
import { cellIndex } from '@/core/board';
import {
  applyBrushLine,
  applyLine,
  bresenhamLine,
  fillConnectedRegion,
  inBounds,
  markPlacedCells,
  replaceAllOfColor,
} from '@/core/editOps';
import type { Diff } from '@/core/editOps';
import {
  addTransactionCells,
  beginTransaction,
  commitTransaction,
  pushEdit,
} from '@/store/history';
import type { PdbState } from '@/store';
import type { ToolId } from '@/core/types';
import { getActiveRenderer } from '@/render/activeRenderer';

/* ==================== 活动渲染器 registry（缺口 7：脏矩形接线） ==================== */

/**
 * 注册表本体已抽到 `@/render/activeRenderer`（零依赖模块）：history.ts 的撤销/重做/
 * pushEdit 也要按格标脏，而本 hook import history —— 若 history 反向 import 本文件会成环。
 * 这里 re-export 维持既有对外契约（StageCanvas 等调用方 import 路径不变）。
 */
export { setActiveRenderer, getActiveRenderer } from '@/render/activeRenderer';

/* ==================== 轻量外部 store（hover / 替换对话框） ==================== */

export interface PaintUiSnapshot {
  /** 当前悬停格（绝对行列）；null = 指针不在板上 */
  hoverCell: { row: number; col: number } | null;
  /** 悬停格的 beads 值（调色板索引+1，0=空格） */
  hoverValue: number;
  /** 「同色替换」自定义对话框是否打开 */
  replaceOpen: boolean;
  /** 对话框预选的源色值（beads 编码，0=空格，-1=未预选） */
  replaceFrom: number;
}

const INITIAL_UI: PaintUiSnapshot = { hoverCell: null, hoverValue: 0, replaceOpen: false, replaceFrom: -1 };

let uiSnapshot: PaintUiSnapshot = INITIAL_UI;
const uiListeners = new Set<() => void>();

function uiEquals(a: PaintUiSnapshot, b: PaintUiSnapshot): boolean {
  return (
    a.hoverValue === b.hoverValue &&
    a.replaceOpen === b.replaceOpen &&
    a.replaceFrom === b.replaceFrom &&
    a.hoverCell?.row === b.hoverCell?.row &&
    a.hoverCell?.col === b.hoverCell?.col
  );
}

function emitUi(patch: Partial<PaintUiSnapshot>): void {
  const next: PaintUiSnapshot = { ...uiSnapshot, ...patch };
  if (uiEquals(next, uiSnapshot)) return;
  uiSnapshot = next;
  for (const l of uiListeners) l();
}

function subscribeUi(listener: () => void): () => void {
  uiListeners.add(listener);
  return () => {
    uiListeners.delete(listener);
  };
}

function getUiSnapshot(): PaintUiSnapshot {
  return uiSnapshot;
}

/** 订阅绘制相关 UI 状态（StatusBar / ReplaceColorDialog 使用） */
export function usePaintUi(): PaintUiSnapshot {
  return useSyncExternalStore(subscribeUi, getUiSnapshot, getUiSnapshot);
}

/** 非 React 环境读取当前快照 */
export function getPaintUi(): PaintUiSnapshot {
  return uiSnapshot;
}

/** 打开「同色替换」自定义对话框；`from` 为预选源色值（beads 编码），省略则用当前悬停格 */
export function openReplaceColorDialog(from?: number): void {
  const src = from ?? (uiSnapshot.hoverCell ? uiSnapshot.hoverValue : -1);
  emitUi({ replaceOpen: true, replaceFrom: src >= 0 ? src : -1 });
}

export function closeReplaceColorDialog(): void {
  emitUi({ replaceOpen: false });
}

/* ==================== 笔画状态机 ==================== */

/** 笔画类别：paint 写 beads（进撤销栈）；place 写 placedMask（不进撤销栈） */
type StrokeMode = 'paint' | 'place';

interface Segment {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

interface ActiveStroke {
  mode: StrokeMode;
  /** 触发这笔的工具（历史 meta 与 coalesce 判定用） */
  tool: ToolId;
  /** paint 模式下写入的 beads 值（调色板索引+1，0=擦除） */
  value: number;
  /** place 模式下的目标状态 */
  placeOn: boolean;
  /** 笔刷边长：画笔/橡皮盖章的方形边长，1 = 单格 */
  brushSize: number;
  label: string;
  lastCol: number;
  lastRow: number;
  /** 尚未落盘的线段（每帧合批一次） */
  segments: Segment[];
  /** 实际发生变更的格子数（toast 汇总用） */
  changed: number;
  rafId: number;
  txOpen: boolean;
}

let strokeRef: ActiveStroke | null = null;
let endListenersAttached = false;

/**
 * 笔画收尾（pointerup / pointercancel / window blur / Esc / 组件卸载 共用）。
 * 挂在 **window** 而不是 canvas 上：指针拖出画布甚至拖出窗口时依然能收到 up 事件，
 * 否则事务永远不收尾，下一次落笔会被 beginTransaction 强制 commit 成两条历史。
 */
function handleStrokeEnd(): void {
  const st = strokeRef;
  if (!st) return;
  strokeRef = null;
  detachEndListeners();
  flushStroke(st);
  if (st.txOpen) {
    // commitTransaction 内部对「零变更」有保护：空事务不会污染撤销栈
    commitTransaction();
  }
}

function attachEndListeners(): void {
  if (endListenersAttached) return;
  endListenersAttached = true;
  window.addEventListener('pointerup', handleStrokeEnd);
  window.addEventListener('pointercancel', handleStrokeEnd);
  window.addEventListener('blur', handleStrokeEnd);
}

function detachEndListeners(): void {
  if (!endListenersAttached) return;
  endListenersAttached = false;
  window.removeEventListener('pointerup', handleStrokeEnd);
  window.removeEventListener('pointercancel', handleStrokeEnd);
  window.removeEventListener('blur', handleStrokeEnd);
}

/** 把待处理线段一次性落盘（一帧最多调用一次） */
function flushStroke(st: ActiveStroke): void {
  if (st.rafId) {
    cancelAnimationFrame(st.rafId);
    st.rafId = 0;
  }
  const segs = st.segments;
  if (segs.length === 0) return;
  st.segments = [];

  const s = usePdbStore.getState();
  const cols = s.board.cols;
  const rows = s.board.rows;

  if (st.mode === 'paint') {
    const diff: Diff = [];
    const brush = st.brushSize;
    // 一帧内所有线段整包提交：mutateBeads 只在结束时 bump 一次 beadsVersion
    s.mutateBeads((beads) => {
      for (let k = 0; k < segs.length; k++) {
        const g = segs[k]!;
        // 笔刷大小：>1 时每格盖章 N×N 方形（画笔/橡皮），=1 走单格原语
        const d = brush > 1
          ? applyBrushLine(beads, cols, rows, { col: g.c0, row: g.r0 }, { col: g.c1, row: g.r1 }, st.value, brush)
          : applyLine(beads, cols, rows, { col: g.c0, row: g.r0 }, { col: g.c1, row: g.r1 }, st.value);
        if (d.length > 0) {
          for (let n = 0; n < d.length; n++) diff.push(d[n]!);
        }
      }
    });
    if (diff.length > 0) {
      st.changed += diff.length;
      addTransactionCells(diff);
      // 缺口 7 核心接线：只把本帧实际改动的格子按格标脏（拖拽笔画通常每帧仅少数格），
      // markCellsDirty 内部置 cellDirtyPending → StageCanvas 的 beadsVersion effect 跳过 invalidateAll，
      // 走 drawL1Partial/drawL2Partial 脏瓦片局部重绘。beadsVersion 仍照常 bump，供筛选层/进度/
      // minimap 等消费方订阅（语义不变）。
      const renderer = getActiveRenderer();
      if (renderer) {
        const dirtyIdx: number[] = new Array(diff.length);
        for (let k = 0; k < diff.length; k++) dirtyIdx[k] = diff[k]!.i;
        renderer.markCellsDirty(dirtyIdx, cols);
      }
    }
    return;
  }

  // place 模式：写 placedMask，不进撤销栈
  const indices: number[] = [];
  for (let k = 0; k < segs.length; k++) {
    const g = segs[k]!;
    const path = bresenhamLine(g.c0, g.r0, g.c1, g.r1);
    for (let p = 0; p < path.length; p++) {
      const c = path[p]!;
          if (inBounds(c.col, c.row, cols, rows)) indices.push(cellIndex(c.row, c.col, cols));
    }
  }
  if (indices.length === 0) return;
  s.mutatePlaced((placed) => {
    st.changed += markPlacedCells(placed, cols, rows, indices, st.placeOn);
  });
  // placedMask 的「已放置」勾标画在 L1，故同样走按格局部重绘（不进撤销栈的语义不变）。
  const renderer = getActiveRenderer();
  if (renderer) renderer.markCellsDirty(indices, cols);
}

function scheduleFlush(st: ActiveStroke): void {
  if (st.rafId) return;
  st.rafId = requestAnimationFrame(() => {
    st.rafId = 0;
    if (strokeRef === st) flushStroke(st);
  });
}

function colorLabel(s: PdbState, cellValue: number): string {
  const c = colorAt(s, cellValue);
  if (!c) return '空格';
  return `${c.code} ${c.nameZh ?? c.name}`;
}

/**
 * 结束当前笔画（等价于 pointerup）；@returns 是否确有笔画被结束。
 * `useHotkeys` 的 Esc 分支会先调它：把画到一半的笔画正常收尾成一条可撤销的历史，
 * 而不是丢弃（`cancelTransaction` 不回滚 beads，会造成「画上了但撤销不掉」的数据不一致）。
 */
export function endActiveStroke(): boolean {
  const had = strokeRef !== null;
  handleStrokeEnd();
  return had;
}

/** 当前是否有活动笔画（供 Esc 处理与光标样式判断） */
export function isStrokeActive(): boolean {
  return strokeRef !== null;
}

/* ==================== 单发工具（无拖拽） ==================== */

/** 连通填充：扫描线 4 连通。目标色 == 原色时 editOps 返回空 diff → 绝不入撤销栈。 */
function doFlood(s: PdbState, col: number, row: number): void {
  const cols = s.board.cols;
  const rows = s.board.rows;
  const value = s.activeColorIndex + 1;
  let diff: Diff = [];
  s.mutateBeads((beads) => {
    diff = fillConnectedRegion(beads, cols, rows, col, row, value);
  });
  if (diff.length === 0) return; // 同色/越界：静默，且不产生历史记录
  const ts = Date.now();
  pushEdit({ label: '连通填充', ts, cells: diff }, { tool: 'flood', value, ts });
  s.pushToast('success', `已填充 ${diff.length} 格 · ${colorLabel(s, value)}`, 2200);
}

/**
 * 全图同色替换（点击即执行）：from = 点击格当前色，to = 当前色。
 * 想自选 from/to 请走 `openReplaceColorDialog()`（LeftRail 的「自定义…」按钮或 ReplaceColorDialog）。
 */
function doReplaceFromCell(s: PdbState, col: number, row: number): void {
  const cols = s.board.cols;
  const fromValue = s.beads[cellIndex(row, col, cols)] ?? 0;
  const toValue = s.activeColorIndex + 1;
  if (fromValue === toValue) {
    s.pushToast('info', `点击格已经是 ${colorLabel(s, toValue)}，无需替换`, 2000);
    return;
  }
  applyReplaceColorValues(s, fromValue, toValue);
}

/** 真正执行替换（点击式与对话框共用）。from/to 均为 beads 编码（0=空格）。 */
function applyReplaceColorValues(s: PdbState, fromValue: number, toValue: number): number {
  if (fromValue === toValue) return 0;
  const cols = s.board.cols;
  const rows = s.board.rows;
  let diff: Diff = [];
  s.mutateBeads((beads) => {
    diff = replaceAllOfColor(beads, cols, rows, fromValue, toValue);
  });
  if (diff.length === 0) {
    s.pushToast('info', `图案里没有 ${colorLabel(s, fromValue)} 的格子`, 2200);
    return 0;
  }
  const ts = Date.now();
  pushEdit({ label: '同色替换', ts, cells: diff }, { tool: 'replaceColor', value: toValue, ts });
  s.pushToast('success', `已把 ${colorLabel(s, fromValue)} 全图替换为 ${colorLabel(s, toValue)}（${diff.length} 格）`, 3200);
  return diff.length;
}

/**
 * 供 `ReplaceColorDialog` 调用的公开入口：全图把 fromValue 替换成 toValue（一条历史记录）。
 * @returns 实际替换的格子数
 */
export function applyReplaceColor(fromValue: number, toValue: number): number {
  return applyReplaceColorValues(usePdbStore.getState(), fromValue, toValue);
}

/** 吸管：读取点击格颜色 → setActiveColorIndex；空格给中文 Toast。 */
function doPick(s: PdbState, col: number, row: number): void {
  const cols = s.board.cols;
  const value = s.beads[cellIndex(row, col, cols)] ?? 0;
  if (value === 0) {
    s.pushToast('info', '这一格是空的，没有可取的颜色', 2000);
    return;
  }
  const index = value - 1;
  const c = s.palette.colors[index];
  if (!c) {
    s.pushToast('warning', `这一格的色号（索引 ${index}）已不在当前色板中，请先切换回对应色板`, 4200);
    return;
  }
  s.setActiveColorIndex(index);
  s.pushToast('success', `已取色 ${c.code} ${c.nameZh ?? c.name}`, 1800);
}

/* ==================== 拖拽型笔画 ==================== */

function startPaintStroke(s: PdbState, col: number, row: number, tool: ToolId, value: number, label: string): void {
  if (!inBounds(col, row, s.board.cols, s.board.rows)) return;
  endActiveStroke(); // 极端情况（漏掉 pointerup）下先收尾上一笔
  beginTransaction(label, tool, value);
  const st: ActiveStroke = {
    mode: 'paint',
    tool,
    value,
    placeOn: false,
    // 笔刷大小：仅画笔/橡皮生效
    brushSize: (tool === 'pen' || tool === 'eraser') ? s.brushSize : 1,
    label,
    lastCol: col,
    lastRow: row,
    // 起点作为一条零长度线段：applyLine 内部的 bresenhamLine 会退化成单格
    segments: [{ c0: col, r0: row, c1: col, r1: row }],
    changed: 0,
    rafId: 0,
    txOpen: true,
  };
  strokeRef = st;
  scheduleFlush(st);
  attachEndListeners();
}

/** 标记/取消标记已放置：toggle 语义由**首格当前状态**决定，整笔保持一致 */
function startPlaceStroke(s: PdbState, col: number, row: number, tool: ToolId): void {
  if (!inBounds(col, row, s.board.cols, s.board.rows)) return;
  endActiveStroke();
  const i = cellIndex(row, col, s.board.cols);
  const placeOn = (s.placedMask[i] ?? 0) !== 1;
  const st: ActiveStroke = {
    mode: 'place',
    tool,
    value: 0,
    placeOn,
    brushSize: 1, // place 模式不使用笔刷
    label: placeOn ? '标记已放置' : '取消已放置',
    lastCol: col,
    lastRow: row,
    segments: [{ c0: col, r0: row, c1: col, r1: row }],
    changed: 0,
    rafId: 0,
    txOpen: false, // 契约：placedMask 不进撤销栈
  };
  strokeRef = st;
  scheduleFlush(st);
  attachEndListeners();
}

/* ==================== Hook ==================== */

export interface UsePointerPaintReturn {
  /** 传给 `<StageCanvas onCellHit={...} />` */
  onCellHit: (row: number, col: number, kind: 'primary' | 'secondary' | 'shift') => void;
  /** 传给 `<StageCanvas onCellHover={...} />` */
  onCellHover: (row: number, col: number) => void;
  /** 传给 `<StageCanvas onCellLeave={...} />`：指针离开画布时清空悬停格 */
  onCellLeave: () => void;
}

/**
 * 指针绘制编排。在 `AppShell` 挂载一次，把返回的三个回调透传给 `StageCanvas`。
 * 返回的回调引用**恒定**（内部只用 ref / 模块级状态），不会导致 StageCanvas 反复重建 Renderer。
 */
export function usePointerPaint(): UsePointerPaintReturn {
  const onCellHit = useCallback((row: number, col: number, kind: 'primary' | 'secondary' | 'shift'): void => {
    const s = usePdbStore.getState();

    // Shift+点击：**任意工具下**都等价于「标记/取消标记已放置」——拼豆模式逐颗计数的核心交互
    if (kind === 'shift') {
      startPlaceStroke(s, col, row, 'markPlaced');
      return;
    }
    // 右键：默认执行擦除
    if (kind === 'secondary') {
      startPaintStroke(s, col, row, 'eraser', 0, '橡皮');
      return;
    }

    switch (s.tool) {
      case 'pen':
        startPaintStroke(s, col, row, 'pen', s.activeColorIndex + 1, '画笔');
        return;
      case 'eraser':
        startPaintStroke(s, col, row, 'eraser', 0, '橡皮');
        return;
      case 'markPlaced':
        startPlaceStroke(s, col, row, 'markPlaced');
        return;
      case 'flood':
        doFlood(s, col, row);
        return;
      case 'replaceColor':
        doReplaceFromCell(s, col, row);
        return;
      case 'picker':
        doPick(s, col, row);
        return;
      case 'pan':
        // 平移手势由 StageCanvas 自己处理（beginGesture/endGesture + setView），不会走到这里
        return;
      default:
        return;
    }
  }, []);

  const onCellHover = useCallback((row: number, col: number): void => {
    const s = usePdbStore.getState();
    const cols = s.board.cols;
    const value = inBounds(col, row, cols, s.board.rows) ? (s.beads[cellIndex(row, col, cols)] ?? 0) : 0;
    emitUi({ hoverCell: { row, col }, hoverValue: value });

    const st = strokeRef;
    if (!st) return;
    if (st.lastRow === row && st.lastCol === col) return;
    // 拖拽续点： Bresenham 插值由 flushStroke → applyLine 内部完成，快速划过也不会断线
    st.segments.push({ c0: st.lastCol, r0: st.lastRow, c1: col, r1: row });
    st.lastCol = col;
    st.lastRow = row;
    scheduleFlush(st);
  }, []);

  const onCellLeave = useCallback((): void => {
    emitUi({ hoverCell: null, hoverValue: 0 });
  }, []);

  /* 卸载兜底：把未收尾的笔画落盘并提交（StrictMode 双挂载时第二次挂载不会重复挂监听，
     因为 window 监听是在笔画开始时才按需 attach、收尾时立刻 detach 的） */
  useEffect(() => {
    return () => {
      handleStrokeEnd();
    };
  }, []);

  /* 「同色替换」自定义对话框的打开入口（沿用既有 `pdb:open-import` 的 CustomEvent 解耦模式） */
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ from?: number }>).detail;
      openReplaceColorDialog(detail?.from);
    };
    window.addEventListener('pdb:open-replace-color', handler);
    return () => window.removeEventListener('pdb:open-replace-color', handler);
  }, []);

  return { onCellHit, onCellHover, onCellLeave };
}
