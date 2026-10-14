/**
 * themes/index.ts —— 主题系统统一出口。
 * 使用：`import { getTheme, applyThemeById } from '@/themes'`。
 * 依赖方向（无环）：registry(数据) ← applyTheme(应用机制) ← index(出口)。
 */
export { THEMES, THEME_ORDER, DEFAULT_THEME, getTheme, nextThemeId } from './registry';
export { applyTheme, applyThemeById, readThemeCssVar } from './applyTheme';
