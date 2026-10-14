/**
 * themes/applyTheme.ts —— 主题应用机制。
 * 应用方式（契约）：设置 `document.documentElement.dataset.theme` + 把 tokens 写入 :root style。
 * tokens.css 中另有 [data-theme=...] 静态兜底；两者值一致，JS 写入优先级更高（inline style）。
 */
import type { ThemeDefinition, ThemeId } from '@/core/types';
import { DEFAULT_THEME, THEMES } from './registry';

/**
 * 应用主题：
 * 1. `data-theme` → 供 CSS 选择器（含 journal 纸纹、glowDark 滚动条等主题专属样式）与调试识别；
 * 2. tokens/radius/motion/shadows → 写入 :root inline CSS 变量；
 * 3. color-scheme → 原生控件（滚动条、input[type=color]）跟随明暗。
 */
export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.id === 'glowDark' ? 'dark' : 'light';

  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(key, value);
  }
  for (const [key, value] of Object.entries(theme.radius)) {
    root.style.setProperty(`--radius-${key}`, value);
  }
  for (const [key, value] of Object.entries(theme.motion)) {
    root.style.setProperty(`--motion-${key}`, value);
  }
  for (const [key, value] of Object.entries(theme.shadows)) {
    root.style.setProperty(`--shadow-${key}`, value);
  }
}

/** 按 id 应用（store.setTheme 后调用） */
export function applyThemeById(id: ThemeId): void {
  applyTheme(THEMES[id] ?? THEMES[DEFAULT_THEME]!);
}

/**
 * 【验收点】从 :root 计算样式读回主题 CSS 变量，验证主题切换已生效。
 * Canvas 令牌不走这里（Canvas 读不到 CSS 变量），必须从 getTheme(id).canvas 对象直取。
 */
export function readThemeCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
