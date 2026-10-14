/**
 * 主题 4/4 · 极简清透专注 minimal。
 * 去装饰、6px 小圆角、无阴影、纯净蓝；适合只要底图不要干扰、打印/截图输出干净图纸。
 * 注：方案提到 minimal 支持明暗双态，ThemeId 契约固定为 4 个，故  实现明态；
 * TODO: 若需要暗态极简，配合系统 prefers-color-scheme 在 tokens.css 做 [data-theme=minimal] 内的媒体查询覆盖，不新增 ThemeId。
 */
import type { ThemeDefinition } from '@/core/types';

export const minimalTheme: ThemeDefinition = {
  id: 'minimal',
  name: '极简清透专注',
  nameEn: 'Minimal',
  emoji: '⚪',
  description: '去装饰 · 纯净底图 · 无阴影，专注与干净输出',

  tokens: {
    '--bg': '#FFFFFF',
    '--bg-alt': '#FAFAFA',
    '--surface': '#FFFFFF',
    '--surface-2': '#F5F5F5',
    '--surface-hover': '#F0F0F0',
    '--border': '#E5E5E5',
    '--border-strong': '#CCCCCC',
    '--text': '#1A1A1A',
    '--text-soft': '#555555',
    '--text-mute': '#8C8C8C',
    '--primary': '#2F6FED',
    '--primary-soft': '#E4EDFD',
    '--primary-contrast': '#FFFFFF',
    '--accent': '#12B886',
    '--accent-soft': '#E0F5EE',
    '--success': '#2B8A3E',
    '--warning': '#E8A33D',
    '--danger': '#D64545',
    '--focus-ring': 'rgba(47, 111, 237, 0.30)',
    '--overlay': 'rgba(26, 26, 26, 0.24)',
    '--shadow-color': 'rgba(0, 0, 0, 0.10)',
    '--peach': '#F0A878',
    '--lavender': '#9B8EC4',
    '--lemon': '#E8C84A',
    '--paper-texture': 'none',
  },

  canvas: {
    canvasBg: '#FFFFFF',
    canvasBgGlow: '#FFFFFF',
    gridLine: 'rgba(0, 0, 0, 0.09)',
    gridLineMajor: 'rgba(0, 0, 0, 0.24)',
    emptyCell: '#FFFFFF',
    emptyCellStroke: 'rgba(0, 0, 0, 0.16)',
    beadStroke: 'rgba(0, 0, 0, 0.12)',
    numberText: '#8C8C8C',
    selectionStroke: '#2F6FED',
    highlightGlow: false,
    rulerBg: '#F5F5F5',
    rulerText: '#555555',
  },

  radius: { sm: '3px', md: '4px', lg: '6px', pill: '999px' },
  motion: {
    fast: '80ms',
    base: '140ms',
    slow: '260ms',
    ease: 'cubic-bezier(.4, 0, .2, 1)',   // 标准曲线，零回弹零个性
  },
  shadows: {
    sm: 'none',
    md: '0 1px 2px rgba(0, 0, 0, 0.08)',
    lg: '0 4px 12px rgba(0, 0, 0, 0.10)',
  },

  previewSwatches: ['#2F6FED', '#12B886', '#E8A33D', '#D64545', '#555555'],
};
