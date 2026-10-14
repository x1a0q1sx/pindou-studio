/**
 * palettes/types.ts —— 色板数据文件的轻量输入类型。
 * 数据文件只写 hex（人类可读、便于校对），rgb/lab 由 index.ts 加载时用
 * color/convert.ts 统一计算填充（hydratePalette），保证全链路数值一致。
 */
import type { BeadColor } from '../core/types';

/** 色板数据文件里的单色定义：BeadColor 去掉派生字段 rgb/lab */
export type BeadColorInput = Omit<BeadColor, 'rgb' | 'lab'>;
