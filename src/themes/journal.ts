/**
 * 主题 3/4 · 日系手账贴纸 journal。
 * 米色纸纹（SVG feTurbulence data-URI 生成，零外部图片）、手绘描边、贴纸标签、柔和动效。
 * 纸纹用法：tokens['--paper-texture'] 已由 base.css 叠加到 body 背景。
 */
import type { ThemeDefinition } from '@/core/types';
import { paperTextureDataUri } from './_paper';

export const journalTheme: ThemeDefinition = {
  id: 'journal',
  name: '日系手账贴纸',
  nameEn: 'Journal',
  emoji: '📔',
  description: '米色纸纹 · 手绘描边 · 贴纸氛围，记录创作过程',

  tokens: {
    '--bg': '#FBF6E9',
    '--bg-alt': '#F5EDDA',
    '--surface': '#FFFDF6',
    '--surface-2': '#F8F1DF',
    '--surface-hover': '#F3EAD3',
    '--border': '#E4D9BE',
    '--border-strong': '#D2C29C',
    '--text': '#5C5142',
    '--text-soft': '#857864',
    '--text-mute': '#A99C85',
    '--primary': '#E8A87C',
    '--primary-soft': '#F8E3D2',
    '--primary-contrast': '#4C3320',
    '--accent': '#85B09A',
    '--accent-soft': '#E1EDE5',
    '--success': '#7FA98C',
    '--warning': '#DFA15C',
    '--danger': '#C96A5B',
    '--focus-ring': 'rgba(232, 168, 124, 0.40)',
    '--overlay': 'rgba(92, 81, 66, 0.30)',
    '--shadow-color': 'rgba(160, 140, 100, 0.22)',
    '--peach': '#F2C6A0',
    '--lavender': '#B8AECF',
    '--lemon': '#EED98C',
    /* 纸纹：feTurbulence 生成的 data-URI，base.css 把它叠在 body 底色上 */
    '--paper-texture': paperTextureDataUri({ baseFrequency: 0.82, octaves: 4, inkColor: '#8a7a58', inkOpacity: 0.05 }),
  },

  canvas: {
    canvasBg: '#FDF8EC',
    canvasBgGlow: '#FFFCF2',
    gridLine: 'rgba(92, 81, 66, 0.12)',
    gridLineMajor: 'rgba(92, 81, 66, 0.26)',
    emptyCell: 'rgba(255, 253, 246, 0.80)',
    emptyCellStroke: 'rgba(210, 194, 156, 0.90)',
    beadStroke: 'rgba(92, 81, 66, 0.22)',
    numberText: '#A99C85',
    selectionStroke: '#E8A87C',
    highlightGlow: false,
    rulerBg: '#F5EDDA',
    rulerText: '#857864',
  },

  radius: { sm: '8px', md: '12px', lg: '16px', pill: '999px' },
  motion: {
    fast: '130ms',
    base: '240ms',
    slow: '460ms',
    ease: 'cubic-bezier(.30, .90, .35, 1.02)',  // 手账翻页般的柔缓
  },
  shadows: {
    sm: '0 1px 2px rgba(160, 140, 100, 0.16)',
    md: '0 5px 14px rgba(160, 140, 100, 0.20)',
    lg: '0 14px 36px rgba(160, 140, 100, 0.26)',
  },

  previewSwatches: ['#E8A87C', '#85B09A', '#B8AECF', '#EED98C', '#C96A5B'],
};
