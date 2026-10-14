/**
 * src/store/placementActions.ts —— 拼豆模式的「换色 / 标完」动作（store 写入层）。
 *
 * 【为什么单独成模块】
 *   这三个动作被三处调用：顶部控制条（PlacementTopBar）、全局热键（useHotkeys）、
 *   以及逐色列表里的「下一待拼色」。放在这里可以避免「组件 → useHotkeys」的循环依赖
 *   （useHotkeys 已经 import 了 PlacementOverlay，反向再 import 会成环）。
 *
 * 【职责边界】
 *   本模块只做「读 store → 算目标色 → 写 store + toast」；
 *   纯算法在 core/placementNav.ts（可单测），屏幕提示措辞也在那边生成。
 */
import { usePdbStore } from '@/store';
import {
  buildColorDonePrompt,
  findUsage,
  pickColorByDirection,
  type NavColorUsage,
  type NavDirection,
} from '@/core/placementNav';
import { selectActiveRegion, selectColorUsage, selectColorUsageInRegion } from '@/store/selectors';
import { markPlacedCells } from '@/core/editOps';

/** 统计范围：当前区块 / 全板（与 ColorProgressList 的 scope 语义一致） */
export type PlacementScope = 'region' | 'board';

/** 取指定范围内的逐色用量（供顶部条与换色动作共用） */
export function usageInScope(scope: PlacementScope): NavColorUsage[] {
  const s = usePdbStore.getState();
  const list = scope === 'board'
    ? selectColorUsage(s)
    : selectColorUsageInRegion(s, selectActiveRegion(s));
  // ColorUsage 结构是 NavColorUsage 的超集，直接传递即可
  return list;
}

/** 当前生效色：有筛选色用筛选色，否则用当前色 */
export function effectiveColorIndex(): number {
  const s = usePdbStore.getState();
  return s.filterColorIndex >= 0 ? s.filterColorIndex : s.activeColorIndex;
}

/**
 * 切到「下一色 / 上一色」（按剩余量最多优先，规则见 core/placementNav.ts）。
 * 切色后自动把筛选色设为目标色并保持「发光板」档 —— 顶栏点一下就能直接照着拼。
 * @returns 是否真的换了色（false = 全部拼完，只有 toast）
 */
export function stepColor(direction: NavDirection, scope: PlacementScope = 'region'): boolean {
  const s = usePdbStore.getState();
  const usages = usageInScope(scope);
  const cur = effectiveColorIndex();
  const next = pickColorByDirection(usages, direction, cur);
  if (next === null) {
    s.pushToast('success', scope === 'region' ? '本区块已全部拼完' : '整板已全部拼完', 2400);
    return false;
  }
  const u = findUsage(usages, next);
  s.setActiveColorIndex(next);
  s.setFilter(next, 'panel');
  const label = s.palette.colors[next];
  const code = label ? label.code : `#${next}`;
  s.pushToast(
    'info',
    direction === 'next'
      ? `下一色：${code}（剩余 ${u ? u.remaining : 0} 颗）`
      : `上一色：${code}（剩余 ${u ? u.remaining : 0} 颗）`,
    2200,
  );
  return true;
}

/**
 * 直接切到指定色（顶部色卡 / 色卡队列点击用）：与 stepColor 同款落点——
 * 设当前色 + 筛选色并保持「发光板」档。范围里没有这个色（或已拼完）时返回 false 不动。
 */
export function focusPlacementColor(index: number, scope: PlacementScope = 'region'): boolean {
  const s = usePdbStore.getState();
  const u = findUsage(usageInScope(scope), index);
  if (!u || u.remaining <= 0) return false;
  s.setActiveColorIndex(index);
  s.setFilter(index, 'panel');
  const c = s.palette.colors[index];
  s.pushToast('info', `切到 ${c ? c.code : `#${index}`}（剩余 ${u.remaining} 颗）`, 2200);
  return true;
}

/**
 * 把当前色的剩余格全部标记为已拼（顶部条按钮 / Enter 键共用）。
 * **带二次确认**——调用方负责弹窗；本函数只处理「确认后」的写入。
 * @returns 实际标记的格数（0 = 范围内没有该色的格子）
 */
export function markCurrentColorDone(scope: PlacementScope = 'region'): number {
  const s = usePdbStore.getState();
  const colorIndex = effectiveColorIndex();
  const color = s.palette.colors[colorIndex];
  if (!color) {
    s.pushToast('warning', '当前没有选定的颜色', 2400);
    return 0;
  }
  const usages = usageInScope(scope);
  const u = findUsage(usages, colorIndex);
  if (!u || u.remaining === 0) {
    s.pushToast('info', `${color.code} 在${scope === 'region' ? '本区块' : '整板'}已全部拼完`, 2400);
    return 0;
  }
  const { board, beads, placedMask, mutatePlaced } = s;
  const { cols, rows } = board;
  const target = colorIndex + 1;
  // 收集范围内该色且未拼的格子（范围 = 当前区块矩形）
  const indices: number[] = [];
  if (scope === 'board') {
    for (let i = 0; i < beads.length; i++) {
      if (beads[i] === target && placedMask[i] !== 1) indices.push(i);
    }
  } else {
    const r = selectActiveRegion(s);
    for (let row = r.row0; row < r.row0 + r.rows; row++) {
      for (let col = r.col0; col < r.col0 + r.cols; col++) {
        const i = row * cols + col;
        if (beads[i] === target && placedMask[i] !== 1) indices.push(i);
      }
    }
  }
  if (indices.length === 0) {
    s.pushToast('info', `${color.code} 在${scope === 'region' ? '本区块' : '整板'}没有待拼的格子`, 2400);
    return 0;
  }
  let changed = 0;
  mutatePlaced((placed) => {
    changed = markPlacedCells(placed, cols, rows, indices, true);
  });
  s.pushToast('success', `已把 ${color.code} 的 ${changed} 颗标记为已拼`, 2600);
  return changed;
}

/** 供顶部条的二次确认弹窗取文案（读当前范围的真实剩余数） */
export function currentColorDonePrompt(scope: PlacementScope = 'region') {
  const s = usePdbStore.getState();
  const colorIndex = effectiveColorIndex();
  const color = s.palette.colors[colorIndex];
  const u = findUsage(usageInScope(scope), colorIndex);
  const code = color ? color.code : '当前色';
  const remaining = u ? u.remaining : 0;
  const regionLabelText = scope === 'region' ? regionScopeLabel() : undefined;
  return { ...buildColorDonePrompt(code, remaining, regionLabelText), remaining, colorIndex };
}

/** 当前区块的中文标签（如「区块 A2」）；单块时返回 undefined */
function regionScopeLabel(): string | undefined {
  const s = usePdbStore.getState();
  if (s.region.splitsX <= 1 && s.region.splitsY <= 1) return undefined;
  const r = selectActiveRegion(s);
  return `区块 ${r.label}`;
}
