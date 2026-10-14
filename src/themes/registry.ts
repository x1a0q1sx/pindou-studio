/**
 * themes/registry.ts —— 主题注册表本体（数据）。
 * 【扩展契约】新增一套主题 = 新建一个 ThemeDefinition 文件 + 在 THEMES/THEME_ORDER 各加一行，其余零改动。
 * 所有主题必须提供同名的 21 个 UI 令牌 + 12 个 Canvas 令牌（键名见 core/types.ts）。
 */
import type { ThemeDefinition, ThemeId } from '@/core/types';
import { macaronTheme } from './macaron';
import { glowDarkTheme } from './glowDark';
import { journalTheme } from './journal';
import { minimalTheme } from './minimal';

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  macaron: macaronTheme,
  glowDark: glowDarkTheme,
  journal: journalTheme,
  minimal: minimalTheme,
};

export const THEME_ORDER: ThemeId[] = ['macaron', 'glowDark', 'journal', 'minimal'];

export const DEFAULT_THEME: ThemeId = 'macaron';

export function getTheme(id: ThemeId): ThemeDefinition {
  return THEMES[id] ?? THEMES[DEFAULT_THEME]!;
}

/** 快捷键 T 循环切换用（useHotkeys 调用） */
export function nextThemeId(id: ThemeId): ThemeId {
  const i = THEME_ORDER.indexOf(id);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length]!;
}
