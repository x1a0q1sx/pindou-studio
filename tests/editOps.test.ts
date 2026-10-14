/**
 * tests/editOps.test.ts —— 笔刷/绘制原语的回归用例（Vitest）。
 */
import { describe, expect, it } from 'vitest';
import { applyBrushLine, applyDiff, applyLine, cellCoords, fillConnectedRegion } from '@/core/editOps';

describe('applyBrushLine（可调大小笔刷）', () => {
  it('水平直线 + 笔刷 3 = 7×3 的并集（路径去重）', () => {
    const beads = new Uint16Array(20 * 20);
    const diff = applyBrushLine(
      beads, 20, 20,
      { col: 2, row: 2 }, { col: 6, row: 2 },
      5, 3,
    );
    expect(diff.length).toBe(21); // 5 格路径 + 两侧各扩 1 列 = 7 列 × 3 行
    // 中心行全覆盖
    for (let c = 1; c <= 7; c++) expect(beads[2 * 20 + c]).toBe(5);
    // 上下各一行
    for (let c = 1; c <= 7; c++) {
      expect(beads[1 * 20 + c]).toBe(5);
      expect(beads[3 * 20 + c]).toBe(5);
    }
    // 圈外不受影响
    expect(beads[0]).toBe(0);
    expect(beads[4 * 20 + 1]).toBe(0);
  });

  it('对角线笔刷 3 的并集 = |i-j|≤1 的带状区（无重复计数）', () => {
    const beads = new Uint16Array(20 * 20);
    const diff = applyBrushLine(
      beads, 20, 20,
      { col: 2, row: 2 }, { col: 6, row: 6 },
      9, 3,
    );
    // 轴对齐 3×3 方块沿对角线的并集（不是细带）：逐行 3+4+5+5+5+4+3 = 29
    expect(diff.length).toBe(29);
  });

  it('笔刷 1 等价于普通画线；size 钳制上限 8（half=8 → 17×17）', () => {
    const a = new Uint16Array(30 * 30);
    applyBrushLine(a, 30, 30, { col: 5, row: 5 }, { col: 9, row: 5 }, 3, 1);
    expect(a[5 * 30 + 5]).toBe(3);
    expect(a[4 * 30 + 5]).toBe(0); // size=1 不外扩
    const b = new Uint16Array(30 * 30);
    const diff = applyBrushLine(b, 30, 30, { col: 15, row: 15 }, { col: 15, row: 15 }, 3, 99);
    // half = floor((99-1)/2)=49 → 钳到 8；(15,15) ±8 全在 30×30 板内 → 17×17
    expect(diff.length).toBe(17 * 17);
  });

  it('diff 可精确撤销', () => {
    const beads = new Uint16Array(20 * 20);
    const diff = applyBrushLine(beads, 20, 20, { col: 2, row: 2 }, { col: 6, row: 2 }, 5, 3);
    applyDiff(beads, diff, 'undo');
    expect(diff.every((d) => beads[d.i] === d.prev)).toBe(true);
    applyDiff(beads, diff, 'redo');
    expect(beads[2 * 20 + 4]).toBe(5);
  });
});

describe('fillConnectedRegion（油漆桶）', () => {
  it('封闭区域不外泄、同色值填充零操作', () => {
    const beads = new Uint16Array(6 * 6);
    // 一圈墙
    for (let c = 1; c <= 4; c++) {
      beads[1 * 6 + c] = 1;
      beads[4 * 6 + c] = 1;
    }
    for (let r = 1; r <= 4; r++) {
      beads[r * 6 + 1] = 1;
      beads[r * 6 + 4] = 1;
    }
    const diff = fillConnectedRegion(beads, 6, 6, 2, 2, 7);
    expect(diff.length).toBe(4); // 内部 2×2
    expect(beads[2 * 6 + 2]).toBe(7);
    expect(beads[1 * 6 + 1]).toBe(1); // 墙不被穿透
    expect(beads[0]).toBe(0);
  });
});

describe('cellCoords / applyLine 基础', () => {
  it('cellCoords 与索引互换', () => {
    expect(cellCoords(7, 5)).toEqual({ col: 2, row: 1 });
  });
  it('applyLine 返回稀疏 diff 且只含端点间路径', () => {
    const beads = new Uint16Array(12);
    const diff = applyLine(beads, 6, 2, { col: 0, row: 0 }, { col: 3, row: 0 }, 4);
    expect(diff.length).toBe(4);
    expect(beads[3]).toBe(4);
    expect(beads[4]).toBe(0);
  });
});
