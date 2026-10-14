/**
 * layout/dualSplit.ts —— dual 布局分割比例的持久化（localStorage）。
 *
 * 分割线可拖拽（体验优化 #2）：左右窗格宽度比例存本地，重启/切换布局回来都保持。
 * 故意不进 zustand 契约：纯外观偏好，组件本地 state + localStorage 足够。
 */

const DUAL_SPLIT_KEY = 'pindou-studio:dual-split:v1';

export const DUAL_SPLIT_MIN = 0.15;
export const DUAL_SPLIT_MAX = 0.85;

export function clampDualSplit(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(DUAL_SPLIT_MAX, Math.max(DUAL_SPLIT_MIN, v));
}

/** 读取分割比例（左窗格占比 0.15–0.85）；无存档/损坏时回退 0.5 */
export function loadDualSplit(): number {
  try {
    const raw = localStorage.getItem(DUAL_SPLIT_KEY);
    if (!raw) return 0.5;
    return clampDualSplit(Number(raw));
  } catch {
    return 0.5;
  }
}

export function saveDualSplit(v: number): void {
  try {
    localStorage.setItem(DUAL_SPLIT_KEY, String(clampDualSplit(v)));
  } catch {
    /* 存不上就只在本次会话生效 */
  }
}
