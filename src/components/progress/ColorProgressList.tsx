/**
 * progress/ColorProgressList.tsx —— 逐色进度列表。
 *
 * 每行列出：色号 · 名称 · 色块 · 总量 · 已放置 · 剩余 · 进度环（stroke-dasharray 补间）· 百分比。
 * 数据流：placedMask + beads（typed array）经 store/selectors.ts 的颜色统计派生 →
 *   selectColorUsage（全板）/ selectColorUsageInRegion（当前区块）→ 本组件只读渲染。
 *   placedMask 由 usePointerPaint 的 markPlaced 工具 / Shift+点击 逐颗写入，bump beadsVersion →
 *   本列表随 beadsVersion 重算，剩余量实时递减。
 *
 * 交互：
 *   · 点击某行 → 设为当前色 + 筛选色（联动 FilterControls / L2 高亮）
 *   · 排序：剩余量（默认）/ 色号 / 总量 / 已放置
 *   · 统计范围：当前区块 / 全板
 *   · 「跳到下一个待拼颜色」：选本范围内 remaining>0 且 total 最大者
 *   · 「本色全部标记完成」：把当前色在本范围内的格子一次性标记为已放置
 *   · 【完成边沿】当前筛选色在当前范围 remaining 由 >0 变 0 的完成边沿：
 *     toast 报告完成并自动复用 jumpNextPending 切到下一色（scope/区块/筛选色变化重置基线，防误报）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePdbStore } from '@/store';
import {
  selectActiveRegion,
  selectColorUsage,
  selectColorUsageInRegion,
  sortColorUsage,
  selectCellsOfColorIndex,
} from '@/store/selectors';
import type { ColorUsage, UsageSortKey } from '@/store/selectors';
import { markPlacedCells } from '@/core/editOps';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import './progress.css';

type Scope = 'region' | 'board';

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/** 排序维度的中文标签 */
const SORT_LABELS: Record<UsageSortKey, string> = {
  remaining: '剩余',
  total: '总量',
  placed: '已放',
  code: '色号',
};

export function ColorProgressList() {
  const [sortKey, setSortKey] = useState<UsageSortKey>('remaining');
  const [scope, setScope] = useState<Scope>('region');

  // 订阅会影响统计结果的信号；实际计算走 selectors（内部按 beadsVersion 记忆化）
  const beadsVersion = usePdbStore((s) => s.beadsVersion);
  const palette = usePdbStore((s) => s.palette);
  const paletteId = usePdbStore((s) => s.paletteId);
  const colorsLen = usePdbStore((s) => s.palette.colors.length);
  const boardCols = usePdbStore((s) => s.board.cols);
  const boardRows = usePdbStore((s) => s.board.rows);
  const splitsX = usePdbStore((s) => s.region.splitsX);
  const splitsY = usePdbStore((s) => s.region.splitsY);
  const activeIndex = usePdbStore((s) => s.region.activeIndex);
  const filterColorIndex = usePdbStore((s) => s.filterColorIndex);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  const setFilter = usePdbStore((s) => s.setFilter);
  const setActiveColorIndex = usePdbStore((s) => s.setActiveColorIndex);
  const filterMode = usePdbStore((s) => s.filterMode);
  const pushToast = usePdbStore((s) => s.pushToast);

  /** 当前统计范围内的逐色用量（未排序） */
  const usage = useMemo<ColorUsage[]>(() => {
    void beadsVersion;
    void paletteId;
    void colorsLen;
    void boardCols;
    void boardRows;
    void splitsX;
    void splitsY;
    void activeIndex;
    const state = usePdbStore.getState();
    if (scope === 'board') return selectColorUsage(state);
    const region = selectActiveRegion(state);
    return selectColorUsageInRegion(state, region);
  }, [scope, beadsVersion, palette, paletteId, colorsLen, boardCols, boardRows, splitsX, splitsY, activeIndex]);

  const sorted = useMemo(() => sortColorUsage(usage, sortKey), [usage, sortKey]);

  /** 本范围汇总（顶部读数） */
  const summary = useMemo(() => {
    let total = 0;
    let placed = 0;
    for (const u of usage) {
      total += u.total;
      placed += u.placed;
    }
    const remaining = Math.max(0, total - placed);
    const ratio = total > 0 ? placed / total : 0;
    return { total, placed, remaining, ratio };
  }, [usage]);

  /** 选中某色：设为当前色 + 筛选色（off 档自动切 only） */
  const focusColor = (index: number): void => {
    setActiveColorIndex(index);
    setFilter(index, filterMode === 'off' ? 'only' : filterMode);
  };

  /** 跳到下一个待拼颜色：remaining>0 且 total 最大（并列取索引小者） */
  const jumpNextPending = (): void => {
    let best: ColorUsage | null = null;
    for (const u of usage) {
      if (u.remaining <= 0) continue;
      if (best === null || u.total > best.total || (u.total === best.total && u.index < best.index)) best = u;
    }
    if (!best) {
      pushToast('success', scope === 'region' ? '本区块已全部拼完' : '整板已全部拼完', 2400);
      return;
    }
    focusColor(best.index);
    pushToast('info', `下一待拼色：${best.color.code} ${best.color.nameZh ?? best.color.name}（剩余 ${best.remaining} 颗）`, 2600);
  };

  /** 本色全部标记完成：把当前色在本范围内的格子标记为已放置 */
  const markCurrentColorDone = (): void => {
    const state = usePdbStore.getState();
    const colorIndex = filterColorIndex >= 0 ? filterColorIndex : activeColorIndex;
    const color = state.palette.colors[colorIndex];
    if (!color) {
      pushToast('warning', '当前没有选定的颜色', 2200);
      return;
    }
    const cols = state.board.cols;
    const rows = state.board.rows;
    const allCells = selectCellsOfColorIndex(state, colorIndex);
    let indices = allCells;
    if (scope === 'region') {
      const region = selectActiveRegion(state);
      const c0 = region.col0;
      const r0 = region.row0;
      const c1 = region.col0 + region.cols;
      const r1 = region.row0 + region.rows;
      indices = allCells.filter((i) => {
        const col = i % cols;
        const row = (i / cols) | 0;
        return col >= c0 && col < c1 && row >= r0 && row < r1;
      });
    }
    if (indices.length === 0) {
      pushToast('info', `本范围内没有 ${color.code} 的格子`, 2200);
      return;
    }
    let changed = 0;
    state.mutatePlaced((placed) => {
      changed = markPlacedCells(placed, cols, rows, indices, true);
    });
    pushToast(
      changed > 0 ? 'success' : 'info',
      changed > 0
        ? `已把 ${color.code} ${color.nameZh ?? color.name} 的 ${changed} 颗标记为已放置`
        : `${color.code} 在本范围内已全部标记完成`,
      2800,
    );
  };

  const curColorIndex = filterColorIndex >= 0 ? filterColorIndex : activeColorIndex;

  /* ---- 该色完成自动提示 + 切下一色 ----
   * ui/Toast 组件无动作按钮契约，故「附『跳到下一色』动作」实现为：完成边沿触发时
   * 自动复用 jumpNextPending()（与点击「跳到下一待拼色」按钮行为完全一致）。
   * 边沿判定用 ref 基线（上一轮同条件下的 remaining），防重复触发：
   *   · scope / 区块 / 筛选色任一变化 → 重置基线，不跨边界报完成；
   *   · remaining 保持 0 的后续重算（prev===0 不满足 >0）不会再次触发。
   */
  const jumpRef = useRef(jumpNextPending);
  const completionEdgeRef = useRef<{
    scope: Scope;
    regionIndex: number;
    colorIndex: number;
    remaining: number | null; // null = 该色在当前范围内没有格子（不算完成）
  }>({ scope, regionIndex: activeIndex, colorIndex: curColorIndex, remaining: null });

  useEffect(() => {
    jumpRef.current = jumpNextPending;
  });

  useEffect(() => {
    const cur = curColorIndex >= 0 ? (usage.find((u) => u.index === curColorIndex) ?? null) : null;
    const now = cur ? cur.remaining : null;
    const base = completionEdgeRef.current;
    if (base.scope !== scope || base.regionIndex !== activeIndex || base.colorIndex !== curColorIndex) {
      completionEdgeRef.current = { scope, regionIndex: activeIndex, colorIndex: curColorIndex, remaining: now };
      return;
    }
    completionEdgeRef.current = { ...base, remaining: now };
    if (cur && base.remaining !== null && base.remaining > 0 && now === 0) {
      pushToast(
        'success',
        `「${cur.color.code} ${cur.color.nameZh ?? cur.color.name}」已全部拼完，为你跳到下一待拼色`,
        3200,
      );
      jumpRef.current();
    }
  }, [usage, scope, activeIndex, curColorIndex, pushToast]);

  return (
    <section className="pdb-cpl" aria-label="逐色进度">
      <header className="pdb-cpl__head">
        <span className="pdb-label">
          <PdbIcon name="chart" size={13} />
          逐色进度
        </span>
        <div className="pdb-cpl__scopes" role="group" aria-label="统计范围">
          <button
            type="button"
            className="pdb-cpl__scope"
            data-active={scope === 'region'}
            onClick={() => setScope('region')}
          >
            本区
          </button>
          <button
            type="button"
            className="pdb-cpl__scope"
            data-active={scope === 'board'}
            onClick={() => setScope('board')}
          >
            全板
          </button>
        </div>
      </header>

      {/* 汇总读数 */}
      <div className="pdb-cpl__summary">
        <svg className="pdb-progress-ring pdb-cpl__ring" width="34" height="34" viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r={RING_R} fill="none" stroke="var(--surface-2)" strokeWidth="3" />
          <circle
            cx="12" cy="12" r={RING_R} fill="none"
            stroke="var(--primary)" strokeWidth="3" strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - summary.ratio)}
            transform="rotate(-90 12 12)"
          />
        </svg>
        <div className="pdb-cpl__summary-text">
          <strong>{Math.round(summary.ratio * 100)}%</strong>
          <span>
            已放 {summary.placed} / 共 {summary.total} 颗 · 剩余 {summary.remaining}
          </span>
        </div>
      </div>

      {/* 工具行 */}
      <div className="pdb-cpl__toolbar">
        <div className="pdb-cpl__sorts" role="group" aria-label="排序方式">
          {(Object.keys(SORT_LABELS) as UsageSortKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className="pdb-cpl__sort"
              data-active={sortKey === k}
              onClick={() => setSortKey(k)}
              title={`按${SORT_LABELS[k]}排序`}
            >
              {SORT_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      <div className="pdb-cpl__actions">
        <Button size="sm" variant="outline" onClick={jumpNextPending}>
          <PdbIcon name="chevronRight" size={13} />
          跳到下一待拼色
        </Button>
        <Button size="sm" variant="soft" onClick={markCurrentColorDone}>
          <PdbIcon name="checkCircle" size={13} />
          本色全部标记完成
        </Button>
      </div>

      {/* 逐色列表 */}
      {sorted.length === 0 ? (
        <p className="pdb-hint pdb-cpl__empty">
          {scope === 'region' ? '本区块暂无已填色的格子' : '整板暂无已填色的格子'}
        </p>
      ) : (
        <ul className="pdb-cpl__list">
          {sorted.map((u) => {
            const isCur = u.index === curColorIndex;
            const done = u.remaining <= 0;
            return (
              <li key={u.color.id}>
                <button
                  type="button"
                  className={`pdb-cpl__row pdb-pressable ${isCur ? 'is-active' : ''} ${done ? 'is-done' : ''}`}
                  onClick={() => focusColor(u.index)}
                  aria-label={`${u.color.code} ${u.color.nameZh ?? u.color.name}，剩余 ${u.remaining} 颗`}
                  title={`点击筛选并高亮 ${u.color.code}`}
                >
                  <span className="pdb-cpl__swatch" style={{ background: u.color.hex }} aria-hidden />
                  <span className="pdb-cpl__meta">
                    <span className="pdb-cpl__code">{u.color.code}</span>
                    <span className="pdb-cpl__name">{u.color.nameZh ?? u.color.name}</span>
                  </span>
                  <span className="pdb-cpl__nums">
                    <span className="pdb-cpl__remain" data-done={done || undefined}>
                      {done ? '完成' : `余 ${u.remaining}`}
                    </span>
                    <span className="pdb-cpl__sub">{u.placed}/{u.total}</span>
                  </span>
                  <svg className="pdb-progress-ring pdb-cpl__ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden>
                    <circle cx="12" cy="12" r={RING_R} fill="none" stroke="var(--surface-2)" strokeWidth="3" />
                    <circle
                      cx="12" cy="12" r={RING_R} fill="none"
                      stroke={done ? 'var(--success)' : u.color.hex}
                      strokeWidth="3" strokeLinecap="round"
                      strokeDasharray={RING_C}
                      strokeDashoffset={RING_C * (1 - u.ratio)}
                      transform="rotate(-90 12 12)"
                    />
                  </svg>
                  <span className="pdb-cpl__pct">{Math.round(u.ratio * 100)}%</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
