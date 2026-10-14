/**
 * src/core/board.ts —— 板索引换算纯函数。
 *
 * 【索引约定（契约）】i = row × cols + col；row = (i / cols) | 0；col = i % cols。
 * 全部为纯函数，无副作用，便于测试。
 */
import type { BoardConfig } from './types';

/**
 * 行列 → 一维索引。
 * @param row 行号（0-based）
 * @param col 列号（0-based）
 * @param cols 板总列数
 */
export function cellIndex(row: number, col: number, cols: number): number {
  return row * cols + col;
}

/**
 * 一维索引 → 行号。
 * 等价于 Math.floor(i / cols)，用位运算加速（cols 为正整数时安全）。
 */
export function rowOf(i: number, cols: number): number {
  return (i / cols) | 0;
}

/**
 * 一维索引 → 列号。
 */
export function colOf(i: number, cols: number): number {
  return i % cols;
}

/**
 * 夹紧格坐标到板范围内。
 * 返回 {row, col, index}；若输入越界则夹到边界。
 */
export function clampCell(
  row: number,
  col: number,
  board: Pick<BoardConfig, 'cols' | 'rows'>,
): { row: number; col: number; index: number } {
  const r = Math.max(0, Math.min(board.rows - 1, Math.round(row)));
  const c = Math.max(0, Math.min(board.cols - 1, Math.round(col)));
  return { row: r, col: c, index: cellIndex(r, c, board.cols) };
}

/**
 * 板总格数。
 */
export function boardCellCount(board: Pick<BoardConfig, 'cols' | 'rows'>): number {
  return board.cols * board.rows;
}

/**
 * 判断一维索引是否在板范围内。
 */
export function isInsideBoard(i: number, board: Pick<BoardConfig, 'cols' | 'rows'>): boolean {
  return i >= 0 && i < board.cols * board.rows;
}

/**
 * 判断行列坐标是否在板范围内。
 */
export function isInsideBoardRC(
  row: number,
  col: number,
  board: Pick<BoardConfig, 'cols' | 'rows'>,
): boolean {
  return row >= 0 && row < board.rows && col >= 0 && col < board.cols;
}
