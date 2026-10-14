/**
 * tests/store-reconcile.test.ts —— 屏幕容量重估分块（大屏合回 / 小屏分块 /
 * 手动分页只增不减）的 store 行为用例（Vitest）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { usePdbStore } from '@/store';
import type { Calibration, DisplayMetrics } from '@/core/types';

/** 大显示器：2560×1440 / 597×336mm（27″ 16:9）——104×104 板 1:1 完全放得下（221×124 格容量） */
const BIG: DisplayMetrics = {
  id: 'big',
  label: '27 寸外接',
  isPrimary: true,
  isVirtual: false,
  boundsCss: { width: 1280, height: 720 },
  workAreaCss: { width: 1280, height: 720 },
  devicePx: { width: 2560, height: 1440 },
  devicePixelRatio: 2,
  physicalMm: { width: 597, height: 336 },
  ppi: null,
  mmPerDevicePx: null,
};

/** 笔记本内屏：2560×1600 / 309×173mm（13.3″）——容量 114×64，纵向要切两块 */
const SMALL: DisplayMetrics = {
  id: 'small',
  label: '笔记本内屏',
  isPrimary: false,
  isVirtual: false,
  boundsCss: { width: 1280, height: 800 },
  workAreaCss: { width: 1280, height: 800 },
  devicePx: { width: 2560, height: 1600 },
  devicePixelRatio: 2,
  physicalMm: { width: 309, height: 173 },
  ppi: null,
  mmPerDevicePx: null,
};

function calFor(d: DisplayMetrics): Calibration {
  return {
    pitchMm: 2.6923,
    mmPerDevicePxX: d.physicalMm!.width / d.devicePx.width,
    mmPerDevicePxY: d.physicalMm!.height / d.devicePx.height,
    originDevicePx: { x: 0, y: 0 },
    source: 'auto-wmi',
    displayKey: `${d.id}|${d.devicePx.width}x${d.devicePx.height}|${d.devicePixelRatio}`,
    verifiedAt: new Date().toISOString(),
  };
}

function setup(display: DisplayMetrics): void {
  const s = usePdbStore.getState();
  s.setBoardConfig({ cols: 104, rows: 104, pitchMm: 2.6923, marginMm: 2 });
  s.setDisplay(display);
  s.setCalibration(calFor(display));
}

describe('reconcileRegionWithDisplay', () => {
  beforeEach(() => {
    setup(BIG);
    usePdbStore.getState().setRegion({ splitsX: 1, splitsY: 1, blockCols: undefined, blockRows: undefined, activeIndex: 0, autoSized: undefined });
  });

  it('大屏装得下：自动分块 1×2 合回单块（用户反馈：切大显示器还是两块）', () => {
    const s = usePdbStore.getState();
    s.setRegion({ splitsX: 1, splitsY: 2, blockCols: 104, blockRows: 64, activeIndex: 1, autoSized: true });
    usePdbStore.getState().reconcileRegionWithDisplay();
    const r = usePdbStore.getState().region;
    expect(r.splitsX).toBe(1);
    expect(r.splitsY).toBe(1);
    expect(r.blockCols).toBeUndefined();
    expect(r.activeIndex).toBe(0);
  });

  it('手动分页（autoSized:false）：装得下也不合并', () => {
    const s = usePdbStore.getState();
    s.setRegion({ splitsX: 1, splitsY: 2, blockCols: undefined, blockRows: undefined, activeIndex: 0, autoSized: false });
    usePdbStore.getState().reconcileRegionWithDisplay();
    expect(usePdbStore.getState().region.splitsY).toBe(2);
  });

  it('小屏放不下：自动 1×1 扩成 1×2，容量优先（首块 104×64 占满）', () => {
    setup(SMALL);
    const s = usePdbStore.getState();
    s.setRegion({ splitsX: 1, splitsY: 1, blockCols: undefined, blockRows: undefined, activeIndex: 0, autoSized: true });
    s.reconcileRegionWithDisplay();
    const r = usePdbStore.getState().region;
    expect([r.splitsX, r.splitsY]).toEqual([1, 2]);
    expect(r.blockCols).toBe(104);
    expect(r.blockRows).toBe(64);
  });

  it('小屏放不下：手动 1×1 也被迫扩（格子绝不缩小），且保持手动标记', () => {
    setup(SMALL);
    const s = usePdbStore.getState();
    s.setRegion({ splitsX: 1, splitsY: 1, blockCols: undefined, blockRows: undefined, activeIndex: 0, autoSized: false });
    s.reconcileRegionWithDisplay();
    const r = usePdbStore.getState().region;
    expect(r.splitsY).toBe(2);
    expect(r.autoSized).toBe(false);
  });

  it('幂等：容量不变的重复调用不再改写、不再弹新提示', () => {
    setup(SMALL);
    const s = usePdbStore.getState();
    s.reconcileRegionWithDisplay();
    const before = usePdbStore.getState();
    const toastsBefore = before.toasts.length;
    const regionBefore = { ...before.region };
    before.reconcileRegionWithDisplay();
    const after = usePdbStore.getState();
    expect(after.region).toEqual(regionBefore);
    expect(after.toasts.length).toBe(toastsBefore);
  });

  it('切小屏：自动方案从合块收缩跟随新屏（双向调整）', () => {
    const s = usePdbStore.getState();
    // 当前屏（BIG）下已是单块自动
    s.setRegion({ splitsX: 1, splitsY: 1, blockCols: undefined, blockRows: undefined, activeIndex: 0, autoSized: true });
    setup(SMALL);
    usePdbStore.getState().reconcileRegionWithDisplay();
    expect(usePdbStore.getState().region.splitsY).toBe(2);
  });
});
