/**
 * 主题 1/4 · 奶油马卡龙 macaron —— 默认主题。
 * 柔和粉彩、大圆角(20px/pill)、暖白底、弹性动效、软阴影。日常设计创作，最「可爱」。
 * 配色取值（bg #FFF8F2 / primary 樱花粉 #FF9BB3 / accent 薄荷 #A8E6CF …）。
 */
import type { ThemeDefinition } from '@/core/types';

export const macaronTheme: ThemeDefinition = {
  id: 'macaron',
  name: '奶油马卡龙',
  nameEn: 'Macaron',
  emoji: '🍬',
  description: '柔和粉彩 · 暖白底 · 弹性动效，日常设计创作首选',

  /* UI 令牌（21 个，键名契约见 types.ts / tokens.css） */
  tokens: {
    '--bg': '#FFF8F2',
    '--bg-alt': '#FDF0E6',
    '--surface': '#FFFFFF',
    '--surface-2': '#FFF3EC',
    '--surface-hover': '#FFEFE6',
    '--border': '#F6DFE5',
    '--border-strong': '#EBC9D4',
    '--text': '#6B4F52',
    '--text-soft': '#93737A',
    '--text-mute': '#BCA3A8',
    '--primary': '#FF9BB3',
    '--primary-soft': '#FFD9E2',
    '--primary-contrast': '#5C2432',
    '--accent': '#A8E6CF',
    '--accent-soft': '#DCF5E9',
    '--success': '#6FCF97',
    '--warning': '#FFB74D',
    '--danger': '#EB5757',
    '--focus-ring': 'rgba(255, 155, 179, 0.40)',
    '--overlay': 'rgba(107, 79, 82, 0.28)',
    '--shadow-color': 'rgba(232, 168, 186, 0.22)',
    /* 主题私有令牌（非契约）：马卡龙辅助色 + 纸纹位 */
    '--peach': '#FFD3B6',
    '--lavender': '#C7CEEA',
    '--lemon': '#FFF1A8',
    '--paper-texture': 'none',
  },

  /* Canvas 令牌 —— Canvas 读不到 CSS 变量， 渲染器必须从主题对象直接取 */
  canvas: {
    canvasBg: '#FFF6EE',
    canvasBgGlow: '#FFFDF9',
    gridLine: 'rgba(107, 79, 82, 0.10)',
    gridLineMajor: 'rgba(107, 79, 82, 0.22)',
    emptyCell: 'rgba(255, 255, 255, 0.72)',
    emptyCellStroke: 'rgba(235, 201, 212, 0.90)',
    beadStroke: 'rgba(107, 79, 82, 0.18)',
    numberText: '#BCA3A8',
    selectionStroke: '#FF9BB3',
    highlightGlow: false,
    rulerBg: '#FFF0E4',
    rulerText: '#93737A',
  },

  radius: { sm: '10px', md: '14px', lg: '20px', pill: '999px' },
  motion: {
    fast: '120ms',
    base: '220ms',
    slow: '420ms',
    ease: 'cubic-bezier(.34, 1.56, .64, 1)',   // 弹性回弹，马卡龙的signature
  },
  shadows: {
    sm: '0 1px 2px rgba(232, 168, 186, 0.18)',
    md: '0 6px 18px rgba(232, 168, 186, 0.20)',
    lg: '0 18px 44px rgba(232, 168, 186, 0.28)',
  },

  previewSwatches: ['#FF9BB3', '#A8E6CF', '#FFD3B6', '#C7CEEA', '#FFF1A8'],
};
