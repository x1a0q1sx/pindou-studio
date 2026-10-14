/**
 * tests/history.test.ts —— 包边的撤销/重做往返 + store 约定回归（Vitest）。
 * Node 环境直跑 zustand store（无 DOM 依赖；localStorage 缺失时自定义色板写入被安全跳过）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { usePdbStore } from '@/store';
import { redo, undo } from '@/store/history';

function drawPattern(): void {
  const s = usePdbStore.getState();
  s.setBoardConfig({ cols: 8, rows: 8 });
  s.mutateBeads((beads) => {
    for (let r = 2; r <= 3; r++) {
      for (let c = 2; c <= 3; c++) beads[r * 8 + c] = 2; // 色板索引 1（与包边色 0 区分）
    }
  });
}

describe('applyBorderRing（包边）+ undo/redo', () => {
  beforeEach(() => {
    // 历史栈是模块级单例：每个用例前清空，避免用例间串味
    usePdbStore.getState().clearHistory();
    drawPattern();
    usePdbStore.getState().clearHistory(); // 画图案不进历史（本用例只验证包边）
  });

  it('板内包边：外圈 12 颗、图案不动、可撤销可重做', () => {
    const s = usePdbStore.getState();
    const r = s.applyBorderRing(0);
    expect(r).not.toBeNull();
    expect(r!.expanded).toBe(false);
    expect(r!.cells).toBe(12); // 4×4 外圈周长

    const beadAt = (row: number, col: number) => usePdbStore.getState().beads[row * 8 + col];
    expect(beadAt(1, 1)).toBe(1); // 包边色（索引 0）
    expect(beadAt(2, 2)).toBe(2); // 图案保持（索引 1），未被包边覆盖

    // 撤销 → 包边消失、图案仍在
    expect(undo()).toBe(true);
    const s2 = usePdbStore.getState();
    expect(s2.beads[1 * 8 + 1]).toBe(0);
    expect(s2.beads[2 * 8 + 2]).toBe(2);

    // 重做 → 包边回来
    expect(redo()).toBe(true);
    const s3 = usePdbStore.getState();
    expect(s3.beads[1 * 8 + 1]).toBe(1);
    expect(s3.beads[4 * 8 + 4]).toBe(1);
  });

  it('轮廓包边：单豆 8 颗；凹角描边而非外接矩形', () => {
    const g = () => usePdbStore.getState();
    g().setBoardConfig({ cols: 10, rows: 10 });
    // 单颗豆：8 邻域膨胀 = 3×3 外圈 8 颗
    g().mutateBeads((b) => { b[2 * 10 + 2] = 2; });
    g().clearHistory();
    expect(g().applyBorderRing(0)?.cells).toBe(8);
    expect(g().beads[1 * 10 + 1]).toBe(1);
    expect(g().beads[2 * 10 + 2]).toBe(2); // 豆本身不被覆盖

    // L 形（凹角）：凹角 (3,3) 被描边、对角外侧 (4,4) 不描 → 不是外接方框
    g().setBoardConfig({ cols: 10, rows: 10 });
    g().mutateBeads((b) => {
      b.fill(0);
      b[2 * 10 + 2] = 2;
      b[3 * 10 + 2] = 2;
      b[2 * 10 + 3] = 2;
    });
    g().clearHistory();
    g().applyBorderRing(0);
    const s4 = g();
    expect(s4.beads[3 * 10 + 3]).toBe(1); // 凹角描边
    expect(s4.beads[4 * 10 + 4]).toBe(0); // 外接矩形的角不描
  });

  it('空板包边返回 null 并给提示', () => {
    const s = usePdbStore.getState();
    // 换不同尺寸强制重建空数组（同尺寸的 setBoardConfig 不会清空内容）
    s.setBoardConfig({ cols: 10, rows: 10 });
    s.clearHistory();
    expect(s.applyBorderRing(0)).toBeNull();
  });
});

describe('store 契约', () => {
  it('replaceBeads 直接替换数组并 bump 版本', () => {
    const s = usePdbStore.getState();
    s.setBoardConfig({ cols: 4, rows: 4 });
    const v0 = usePdbStore.getState().beadsVersion;
    const beads = new Uint16Array(16);
    beads[0] = 2;
    s.replaceBeads(beads);
    expect(usePdbStore.getState().beadsVersion).toBe(v0 + 1);
    expect(usePdbStore.getState().beads[0]).toBe(2);
  });

  it('setBrushSize 钳制 1–9', () => {
    const s = usePdbStore.getState();
    s.setBrushSize(0);
    expect(usePdbStore.getState().brushSize).toBe(1);
    s.setBrushSize(99);
    expect(usePdbStore.getState().brushSize).toBe(9);
  });
});
