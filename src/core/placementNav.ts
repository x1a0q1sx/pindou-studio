/**
 * src/core/placementNav.ts —— 拼豆模式「选色/切色/标完」的纯函数层（零 React / 零 store / 零 DOM）。
 *
 * 【为什么单独一个文件】
 *   与 `hooks/hotkeyMap.ts` 同款理由：拼豆模式的换色逻辑既要被顶部控制条（React 组件）
 *   调用，也要被全局热键（N / Shift+N / Enter）调用，还要能被单测覆盖。
 *   把「挑哪个色」的规则抽成纯函数后，UI 与热键共享同一实现，测试无需 DOM。
 *
 * 【铁律】本文件不得 import React / zustand / DOM。只接收**已经算好的用量数据**。
 */

/** 用量条目的最小形状（与 store/selectors.ts 的 ColorUsage 结构兼容，不复刻全字段） */
export interface NavColorUsage {
  /** 调色板索引（非 +1 编码） */
  index: number;
  /** 图案中该色总格数 */
  total: number;
  /** 已物理放置格数 */
  placed: number;
  /** 未拼格数 = total - placed */
  remaining: number;
}

/**
 * 挑「下一个要拼的颜色」：剩余颗数最多者优先；并列时取调色板索引小者（结果确定可复现）。
 *
 * 为什么按剩余量而不是色号顺序：拼豆的物理成本主要在「换一次色」——
 * 先把大头拼完，能把换色次数压到最低（这也是设计上选定的规则）。
 *
 * @param usages   当前统计范围内的逐色用量（可含 remaining===0 的项，内部会跳过）
 * @param current  当前色索引（用于「只剩它自己没拼完」时不返回自身造成空转）
 * @param opts.allowSelf  true = 允许返回 current（默认 false：优先换到别的色）
 * @returns 目标色索引；范围内已全部拼完（无可选项）返回 null
 */
export function pickNextColor(
  usages: readonly NavColorUsage[],
  current = -1,
  opts: { allowSelf?: boolean } = {},
): number | null {
  const allowSelf = opts.allowSelf === true;
  let best: NavColorUsage | null = null;
  for (const u of usages) {
    if (u.remaining <= 0) continue;
    if (!allowSelf && u.index === current) {
      // 记下来当作兜底：若除它之外再无待拼色，allowSelf=false 时也应给出结果（否则空转）
      if (best === null) best = u;
      continue;
    }
    if (best === null || betterThan(u, best, current, allowSelf)) best = u;
  }
  if (best === null) return null;
  // 若最终选中的是 current 且不允许自身 —— 说明只有它没拼完，此时仍返回它（避免「下一色」无响应）
  return best.index;
}

/** 排序判据：remaining 降序 → total 降序 → index 升序；current 在不允许自身时排到最后 */
function betterThan(a: NavColorUsage, b: NavColorUsage, current: number, allowSelf: boolean): boolean {
  if (!allowSelf) {
    const aSelf = a.index === current;
    const bSelf = b.index === current;
    if (aSelf !== bSelf) return bSelf; // 非自身者优先
  }
  if (a.remaining !== b.remaining) return a.remaining > b.remaining;
  if (a.total !== b.total) return a.total > b.total;
  return a.index < b.index;
}

/**
 * 挑「上一个要拼的颜色」：与 `pickNextColor` 同规则但方向相反——
 * 仍以「剩余最多」为主序（拼豆场景下这才是有效目标），
 * 只是当当前色**本身就是剩余最多**时，返回次多者，避免 Shift+N 原地不动。
 */
export function pickPrevColor(usages: readonly NavColorUsage[], current = -1): number | null {
  const pending = usages.filter((u) => u.remaining > 0);
  if (pending.length === 0) return null;
  if (pending.length === 1) return pending[0]!.index;
  const sorted = sortForPlacement(pending, current);
  // 当前色是第一名（即「剩余最多」）→ 取第二名；否则取第一名
  const first = sorted[0]!;
  return (first.index === current ? sorted[1]! : first).index;
}

/**
 * 拼豆顺序排序（「接下来拼什么」的展示序）：剩余多在前；
 * 并列时 total 降序 → 非当前色优先 → index 升序（结果确定可复现）。
 * 顶部色卡队列与 pickPrevColor 共用这一份顺序，保证「看到的第一个」就是热键 N 会切去的色。
 */
export function sortForPlacement(usages: readonly NavColorUsage[], current: number): NavColorUsage[] {
  return usages.slice().sort((a, b) => {
    if (a.remaining !== b.remaining) return b.remaining - a.remaining;
    if (a.total !== b.total) return b.total - a.total;
    // 并列时「非当前色」优先，避免切色原地不动
    const aSelf = a.index === current ? 1 : 0;
    const bSelf = b.index === current ? 1 : 0;
    if (aSelf !== bSelf) return aSelf - bSelf;
    return a.index - b.index;
  });
}

/** 行进方向（顶部控制条的两个按钮共用同一份语义） */
export type NavDirection = 'next' | 'prev';

/** 按方向挑色（UI 与热键的统一入口） */
export function pickColorByDirection(
  usages: readonly NavColorUsage[],
  direction: NavDirection,
  current = -1,
): number | null {
  return direction === 'next' ? pickNextColor(usages, current) : pickPrevColor(usages, current);
}

/**
 * 「接下来要拼的色」队列（顶部色卡直接点击用）：按 sortForPlacement 顺序取
 * 排除当前色、剩余 >0 的前 count 个索引。空数组 = 当前色之外没有待拼色了。
 */
export function pickUpcoming(
  usages: readonly NavColorUsage[],
  current: number,
  count: number,
): number[] {
  const out: number[] = [];
  for (const u of sortForPlacement(usages, current)) {
    if (out.length >= count) break;
    if (u.remaining <= 0 || u.index === current) continue;
    out.push(u.index);
  }
  return out;
}

/**
 * 「本色拼完」的确认文案（二次确认弹窗用）。
 * 拆出来是为了让 UI 与测试共享同一措辞，避免两处写法漂移。
 */
export function buildColorDonePrompt(code: string, remaining: number, scopeLabel?: string): {
  title: string;
  body: string;
  confirm: string;
} {
  const where = scopeLabel ? `（范围：${scopeLabel}）` : '';
  return {
    title: `把 ${code} 标记为已拼完？`,
    body: `将把 ${code} 的 ${remaining} 颗全部标记为已放置${where}。若其中有还没真正放上去的豆子，可退出后用编辑操作修正（已拼标记不进撤销栈）。`,
    confirm: `标记 ${remaining} 颗为已拼`,
  };
}

/** 找当前色在用量表中的条目（找不到/范围内无此色 → null） */
export function findUsage(
  usages: readonly NavColorUsage[],
  colorIndex: number,
): NavColorUsage | null {
  if (colorIndex < 0) return null;
  for (const u of usages) if (u.index === colorIndex) return u;
  return null;
}
