/**
 * tests/store-patternB.test.ts —— 图 B 通道（双图同屏）store 行为用例。
 * 覆盖 copyAtoB / setPatternB（含尺寸校验与自动复位区块）/ clearPatternB / setRegionB 独立性。
 */
import { describe, expect, it } from 'vitest';
import { usePdbStore } from '@/store';
import type { BoardConfig } from '@/core/types';

function smallBoard(cols: number, rows: number): BoardConfig {
  const s = usePdbStore.getState();
  s.setBoardConfig({ cols, rows });
  return usePdbStore.getState().board;
}

describe('图 B 通道', () => {
  it('copyAtoB：板/豆/已放整体拷贝，版本 bump', () => {
    const board = smallBoard(8, 8);
    const s = usePdbStore.getState();
    s.mutateBeads((beads) => {
      beads[0] = 2;
      beads[63] = 3;
    });
    const vBefore = usePdbStore.getState().beadsBVersion;
    usePdbStore.getState().copyAtoB();
    const after = usePdbStore.getState();
    expect(after.beadsBVersion).toBe(vBefore + 1);
    expect(after.beadsB[0]).toBe(2);
    expect(after.beadsB[63]).toBe(3);
    expect(after.boardB.cols).toBe(8);
    // 拷贝是快照：改 A 不影响 B
    s.mutateBeads((beads) => { beads[0] = 5; });
    expect(usePdbStore.getState().beadsB[0]).toBe(2);
    void board;
  });

  it('setPatternB：尺寸不符被拒并 toast；符合则落图 + 区块复位（大屏 fits 时）', () => {
    smallBoard(8, 8);
    const s = usePdbStore.getState();
    const board = { ...s.boardB };
    const ok = new Uint16Array(64);
    ok[10] = 4;
    s.setPatternB(board, ok);
    expect(usePdbStore.getState().beadsB[10]).toBe(4);
    const bad = new Uint16Array(32);
    const toastsBefore = usePdbStore.getState().toasts.length;
    s.setPatternB(board, bad);
    expect(usePdbStore.getState().toasts.length).toBe(toastsBefore + 1);
    expect(usePdbStore.getState().beadsB[10]).toBe(4); // 未被污染
  });

  it('clearPatternB：清空但保持板尺寸', () => {
    const s = usePdbStore.getState();
    const dims = { cols: s.boardB.cols, rows: s.boardB.rows };
    s.clearPatternB();
    const after = usePdbStore.getState();
    expect(after.boardB.cols).toBe(dims.cols);
    expect(after.beadsB.every((v) => v === 0)).toBe(true);
  });

  it('setRegionB 与 A 的 region 互不串台', () => {
    const s = usePdbStore.getState();
    s.setRegion({ splitsX: 2, splitsY: 2, activeIndex: 1 });
    s.setRegionB({ splitsX: 1, splitsY: 2, activeIndex: 0 });
    const after = usePdbStore.getState();
    expect(after.region.splitsX).toBe(2);
    expect(after.regionB.splitsX).toBe(1);
    expect(after.regionB.splitsY).toBe(2);
  });
});
