/**
 * theme/appearance.ts —— 主题/布局选择持久化（localStorage）。
 * 【契约】key: `pindou-studio:appearance` → {theme?, layout?}
 *  的 persistence.ts 做全项目自动保存时沿用同一命名空间。
 */
import type { LayoutId, ThemeId } from '@/core/types';

const KEY = 'pindou-studio:appearance';

export interface AppearanceState {
  theme?: ThemeId;
  layout?: LayoutId;
}

export function loadAppearance(): AppearanceState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AppearanceState) : {};
  } catch {
    return {};
  }
}

export function saveAppearance(patch: AppearanceState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadAppearance(), ...patch }));
  } catch {
    // 隐私模式等写失败：静默，主题仍是会话级生效
  }
}
