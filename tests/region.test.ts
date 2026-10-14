/**
 * tests/region.test.ts —— 分块（容量优先）回归用例（Vitest）。
 * 用户反馈：自动分块不是均分两半，而是第一块尽量占满一屏，剩余给末块。
 */
import { describe, expect, it } from 'vitest';
import { blockSizes, buildRegions, getActiveRegionOffset } from '@/core/region';

describe('blockSizes（容量优先）', () => {
  it('104 行 / 容量 78 / 2 块 → [78, 26]（不是 [52, 52]）', () => {
    expect(blockSizes(104, 2, 78)).toEqual([78, 26]);
  });

  it('104 行 / 容量 40 / 3 块 → [40, 40, 24]', () => {
    expect(blockSizes(104, 3, 40)).toEqual([40, 40, 24]);
  });

  it('无容量 → 回退均分', () => {
    expect(blockSizes(104, 2, undefined)).toEqual([52, 52]);
  });

  it('容量 ≥ 总数（过度切分）→ 回退均分', () => {
    expect(blockSizes(104, 2, 120)).toEqual([52, 52]);
  });

  it('单块 → [total]', () => {
    expect(blockSizes(104, 1, 78)).toEqual([104]);
  });
});

describe('buildRegions（容量优先布局）', () => {
  it('104×104 / 每屏 104×78 / 1×2 → 首块 104×78、末块 104×26', () => {
    const regions = buildRegions(104, 104, 1, 2, 104, 78);
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ col0: 0, row0: 0, cols: 104, rows: 78, label: 'A1' });
    expect(regions[1]).toMatchObject({ col0: 0, row0: 78, cols: 104, rows: 26, label: 'A2' });
  });

  it('块并集恰好覆盖整板（无重叠无遗漏）', () => {
    const regions = buildRegions(104, 104, 1, 2, 104, 78);
    const total = regions.reduce((s, r) => s + r.rows * r.cols, 0);
    expect(total).toBe(104 * 104);
  });

  it('getActiveRegionOffset 透传容量', () => {
    const off = getActiveRegionOffset(104, 104, 1, 2, 0, 104, 78);
    expect(off).toEqual({ col0: 0, row0: 0, cols: 104, rows: 78 });
    const off2 = getActiveRegionOffset(104, 104, 1, 2, 1, 104, 78);
    expect(off2).toEqual({ col0: 0, row0: 78, cols: 104, rows: 26 });
  });
});
