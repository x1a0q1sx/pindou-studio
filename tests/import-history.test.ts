/**
 * tests/import-history.test.ts —— 整板导入落地（applyImportedBeads）与色板操作的历史一致性：
 * 导入必须可撤销（undo 回到导入前的尺寸+内容+已放标记）、数据不符必须拒绝落地、
 * removeColor / setPaletteId 的索引重映射必须清空撤销栈（旧编码语义已失效）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { usePdbStore } from '@/store';
import { pushEdit, redo, undo } from '@/store/history';
import { BUILTIN_PALETTE_IDS } from '@/palettes';

function beadAt(row: number, col: number, cols?: number): number {
  const s = usePdbStore.getState();
  return s.beads[row * (cols ?? s.board.cols) + col];
}

describe('applyImportedBeads（可撤销的整板导入落地）', () => {
  beforeEach(() => {
    usePdbStore.getState().clearHistory();
    usePdbStore.getState().setBoardConfig({ cols: 8, rows: 8 });
    usePdbStore.getState().clearHistory();
  });

  it('落地后 undo 回到导入前（尺寸+内容+已放标记），redo 再回到导入后', () => {
    const s = usePdbStore.getState();
    // 导入前：6×6 板，有内容有已放标记
    s.setBoardConfig({ cols: 6, rows: 6 });
    s.mutateBeads((beads, placed) => {
      beads[0] = 2;
      beads[7] = 3;
      placed[0] = 1;
    });
    s.clearHistory();

    // 导入 4×5 新图案
    const imported = new Uint16Array(4 * 5);
    imported[3] = 5;
    const ok = s.applyImportedBeads(imported, { cols: 4, rows: 5 }, '导入图案');
    expect(ok).toBe(true);

    const after = usePdbStore.getState();
    expect(after.board.cols).toBe(4);
    expect(after.board.rows).toBe(5);
    expect(after.beads).toBe(imported);
    expect(after.placedMask.every((v) => v === 0)).toBe(true);

    // undo：完整回到 6×6 + 原内容 + 原已放标记
    expect(undo()).toBe(true);
    const before = usePdbStore.getState();
    expect(before.board.cols).toBe(6);
    expect(before.board.rows).toBe(6);
    expect(before.beads[0]).toBe(2);
    expect(before.beads[7]).toBe(3);
    expect(before.placedMask[0]).toBe(1);

    // redo：前进到导入后
    expect(redo()).toBe(true);
    const again = usePdbStore.getState();
    expect(again.board.cols).toBe(4);
    expect(again.beads[3]).toBe(5);
  });

  it('同尺寸导入也走历史（undo 恢复旧内容）', () => {
    const s = usePdbStore.getState();
    s.mutateBeads((beads) => {
      beads[5] = 4;
    });
    s.clearHistory();

    const imported = new Uint16Array(64);
    imported[10] = 6;
    expect(s.applyImportedBeads(imported, { cols: 8, rows: 8 })).toBe(true);
    expect(usePdbStore.getState().beads[5]).toBe(0);
    expect(usePdbStore.getState().beads[10]).toBe(6);

    expect(undo()).toBe(true);
    expect(usePdbStore.getState().beads[5]).toBe(4);
    expect(usePdbStore.getState().beads[10]).toBe(0);
  });

  it('数据长度与板尺寸不符时拒绝落地', () => {
    const s = usePdbStore.getState();
    const v0 = usePdbStore.getState().beadsVersion;
    const bad = new Uint16Array(10); // ≠ 8×8
    expect(s.applyImportedBeads(bad, { cols: 8, rows: 8 })).toBe(false);
    expect(usePdbStore.getState().beadsVersion).toBe(v0); // 未动任何状态
    expect(undo()).toBe(false); // 也不产生历史
  });
});

describe('replaceColorGlobal（全局换色可撤销）', () => {
  beforeEach(() => {
    usePdbStore.getState().clearHistory();
    usePdbStore.getState().setBoardConfig({ cols: 8, rows: 8 });
    usePdbStore.getState().clearHistory();
  });

  it('换色后 undo 恢复原色', () => {
    const s = usePdbStore.getState();
    s.mutateBeads((beads) => {
      beads[0] = 2; // 色板索引 1
      beads[9] = 2;
      beads[1] = 3; // 色板索引 2，不受影响
    });
    s.clearHistory();

    s.replaceColorGlobal(1, 4); // 索引1 → 索引4（编码 2→5）
    expect(beadAt(0, 0)).toBe(5); // beads[0]
    expect(beadAt(0, 1)).toBe(3); // beads[1]（色板索引 2，不在替换范围）

    expect(undo()).toBe(true);
    expect(beadAt(0, 0)).toBe(2);
    expect(beadAt(0, 1)).toBe(3);

    expect(redo()).toBe(true);
    expect(beadAt(0, 0)).toBe(5);
  });

  it('无命中格子时不产生历史', () => {
    const s = usePdbStore.getState();
    s.clearHistory();
    s.replaceColorGlobal(1, 4);
    expect(undo()).toBe(false);
  });
});

describe('色板索引重映射后撤销栈清空', () => {
  beforeEach(() => {
    usePdbStore.getState().clearHistory();
    usePdbStore.getState().setBoardConfig({ cols: 8, rows: 8 });
    usePdbStore.getState().clearHistory();
  });

  /** 造一条可撤销记录 */
  function seedHistory(): void {
    const s = usePdbStore.getState();
    let diff: Array<{ i: number; prev: number; next: number }> = [];
    s.mutateBeads((beads) => {
      diff = [{ i: 3, prev: 0, next: 2 }];
      beads[3] = 2;
    });
    pushEdit({ label: '画笔', ts: Date.now(), cells: diff });
  }

  it('removeColor 后撤销栈清空（旧编码语义失效）', () => {
    seedHistory();
    expect(undo()).toBe(true);
    // 重建记录再删色
    seedHistory();
    const s = usePdbStore.getState();
    s.removeColor(0, null); // 删除色板索引 0 → 后续色索引整体 -1
    expect(undo()).toBe(false); // 栈已清
  });

  it('setPaletteId 后撤销栈清空', () => {
    seedHistory();
    const s = usePdbStore.getState();
    const target = BUILTIN_PALETTE_IDS.find((id) => id !== s.paletteId);
    expect(target).toBeTruthy();
    s.setPaletteId(target!);
    expect(undo()).toBe(false);
  });
});
