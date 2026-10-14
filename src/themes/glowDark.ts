/**
 * 主题 2/4 · 暗夜发光底板 glowDark —— 拼豆模式主力主题。
 * 纯黑画布（LCD 不漏光、杂散光最少）、压暗面板、高饱和发光豆点、圆角 12px、动效迅捷。
 * 【契约】canvasBg 必须为纯黑 #000000、highlightGlow 必须为 true（发光底板专项）。
 */
import type { ThemeDefinition } from '@/core/types';

export const glowDarkTheme: ThemeDefinition = {
  id: 'glowDark',
  name: '暗夜发光底板',
  nameEn: 'Glow Dark',
  emoji: '🌌',
  description: '纯黑画布 · 发光豆点 · 压暗面板，逐颗拼豆专用',

  tokens: {
    '--bg': '#05060A',
    '--bg-alt': '#080A10',
    '--surface': '#0E1118',
    '--surface-2': '#141926',
    '--surface-hover': '#1A2030',
    '--border': '#1E2530',
    '--border-strong': '#2C3542',
    '--text': '#E6EDF7',
    '--text-soft': '#A7B2C4',
    '--text-mute': '#6C7789',
    '--primary': '#4CC9FF',
    '--primary-soft': '#123A4D',
    '--primary-contrast': '#04121B',
    '--accent': '#FF6FD8',
    '--accent-soft': '#43123A',
    '--success': '#3DDC97',
    '--warning': '#FFB454',
    '--danger': '#FF6B6B',
    '--focus-ring': 'rgba(76, 201, 255, 0.45)',
    '--overlay': 'rgba(2, 3, 6, 0.66)',
    '--shadow-color': 'rgba(0, 0, 0, 0.55)',
    '--peach': '#FF9E6F',
    '--lavender': '#9AA5FF',
    '--lemon': '#FFE066',
    '--paper-texture': 'none',
  },

  canvas: {
    canvasBg: '#000000',            // 纯黑：透明板下 LCD 不漏光
    canvasBgGlow: '#02040A',
    gridLine: 'rgba(255, 255, 255, 0.10)',
    gridLineMajor: 'rgba(255, 255, 255, 0.22)',
    emptyCell: 'rgba(255, 255, 255, 0.03)',
    emptyCellStroke: 'rgba(255, 255, 255, 0.14)',
    beadStroke: 'rgba(0, 0, 0, 0.40)',
    numberText: '#6C7789',
    selectionStroke: '#4CC9FF',
    highlightGlow: true,            // 当前颜色格子 shadowBlur 外发光
    rulerBg: '#0A0D14',
    rulerText: '#A7B2C4',
  },

  radius: { sm: '6px', md: '9px', lg: '12px', pill: '999px' },
  motion: {
    fast: '90ms',
    base: '160ms',
    slow: '300ms',
    ease: 'cubic-bezier(.32, .72, .24, 1)',   // 迅捷无回弹，暗色下更利落
  },
  shadows: {
    sm: '0 1px 3px rgba(0, 0, 0, 0.50)',
    md: '0 8px 24px rgba(0, 0, 0, 0.60)',
    lg: '0 20px 60px rgba(0, 0, 0, 0.75)',
  },

  previewSwatches: ['#4CC9FF', '#FF6FD8', '#3DDC97', '#FFE066', '#9AA5FF'],
};
