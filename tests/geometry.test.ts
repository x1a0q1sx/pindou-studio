/**
 * tests/geometry.test.ts —— 分区建议 / 屏幕适配的回归用例（Vitest）。
 */
import { describe, expect, it } from 'vitest';
import { autoSuggestSplits, boardAlignCalibration, maxCellsAt1to1, sanitizeCalibration, beadAreaSizeMm, boardPhysicalSizeMm } from '@/core/geometry';
import { DEFAULT_CALIBRATION } from '@/core/geometry';
import type { BoardConfig } from '@/core/types';

describe('beadAreaSizeMm / boardPhysicalSizeMm（拼豆模式 1:1 对位依据）', () => {
  // 104 钉 × 2.6923mm = 280mm 排豆区；含 2mm 板边 → 284mm 整板
  const board = { cols: 104, rows: 104, pitchMm: 2.6923, marginMm: 2 } as BoardConfig;
  it('排豆区 = cols × pitch（不含边距），104×2.6923 ≈ 280mm', () => {
    const a = beadAreaSizeMm(board);
    expect(a.width).toBeCloseTo(280, 0);
    expect(a.height).toBeCloseTo(280, 0);
  });
  it('整板外形 = 排豆区 + 2×margin', () => {
    const b = boardPhysicalSizeMm(board);
    expect(b.width).toBeCloseTo(284, 0);
  });
  it('非方板：宽高分离（如 104×52 半板）', () => {
    const half = { cols: 104, rows: 52, pitchMm: 2.6923, marginMm: 2 } as BoardConfig;
    const a = beadAreaSizeMm(half);
    expect(a.width).toBeCloseTo(280, 0);
    expect(a.height).toBeCloseTo(140, 0);
  });
});

describe('autoSuggestSplits（每轴独立最小值）', () => {
  it('一轴放得下时该轴不切（104 宽 / 52 高容量 → 纵切）', () => {
    const r = autoSuggestSplits(104, 104, 104, 52);
    expect(r.splitsX).toBe(1);
    expect(r.splitsY).toBe(2);
    expect(r.regionCols).toBe(104);
    expect(r.regionRows).toBe(52);
  });

  it('双轴都放不下时双轴切分（容量优先）', () => {
    const r = autoSuggestSplits(104, 104, 50, 50);
    expect(r.splitsX).toBe(3);
    expect(r.splitsY).toBe(3);
    expect(r.blockCols).toBe(50);
    expect(r.blockRows).toBe(50);
  });

  it('容量优先：104×104 / 每屏 104×78 → 首块 104×78（不是均分 52）', () => {
    const r = autoSuggestSplits(104, 104, 104, 78);
    expect(r.splitsX).toBe(1);
    expect(r.splitsY).toBe(2);
    expect(r.blockRows).toBe(78);
    expect(r.regionRows).toBe(78);
  });

  it('整板放得下时返回 1×1', () => {
    const r = autoSuggestSplits(52, 52, 104, 104);
    expect(r.splitsX).toBe(1);
    expect(r.splitsY).toBe(1);
  });

  it('恰好卡线（104 格 / 容量 104）不切', () => {
    const r = autoSuggestSplits(104, 104, 104, 104);
    expect(r.splitsX).toBe(1);
    expect(r.splitsY).toBe(1);
  });
});

describe('maxCellsAt1to1（物理容量换算）', () => {
  it('1920×1080 设备像素、0.26mm/px 下容量 ≈ 1920×0.26/2.6923', () => {
    const cal = sanitizeCalibration({
      ...DEFAULT_CALIBRATION,
      mmPerDevicePxX: 0.26,
      mmPerDevicePxY: 0.26,
      pitchMm: 2.6923,
    });
    const max = maxCellsAt1to1(cal, { width: 1920, height: 1080 });
    expect(max.cols).toBe(Math.floor(1920 / (2.6923 / 0.26)));
    expect(max.rows).toBe(Math.floor(1080 / (2.6923 / 0.26)));
  });
});

describe('boardAlignCalibration（屏上实测逐轴反算）', () => {
  const base = sanitizeCalibration({
    ...DEFAULT_CALIBRATION,
    mmPerDevicePxX: 0.200,
    mmPerDevicePxY: 0.200,
  });

  it('两轴分别反算：实测 27.8×27.6cm 对理论 28.0 → X ×0.993、Y ×0.9857', () => {
    const res = boardAlignCalibration(base, 280.05, 278, 280.05, 276)!;
    expect(res.factorX).toBeCloseTo(278 / 280.05, 6);
    expect(res.factorY).toBeCloseTo(276 / 280.05, 6);
    expect(res.cal.mmPerDevicePxX).toBeCloseTo(0.2 * (278 / 280.05), 8);
    expect(res.cal.mmPerDevicePxY).toBeCloseTo(0.2 * (276 / 280.05), 8);
    expect(res.cal.source).toBe('manual-span');
  });

  it('只量一轴：另一轴比率记 null、值不动', () => {
    const res = boardAlignCalibration(base, 280, 0, 280, 277)!;
    expect(res.factorX).toBeNull();
    expect(res.cal.mmPerDevicePxX).toBe(0.2);
    expect(res.factorY).toBeCloseTo(277 / 280, 6);
  });

  it('非法输入全部拒绝：两轴无效 → null；超 ±50% 偏差 → null', () => {
    expect(boardAlignCalibration(base, 280, 0, 280, 0)).toBeNull();
    expect(boardAlignCalibration(base, 280, 280 * 2.5, 280, 0)).toBeNull(); // 比率>2
    expect(boardAlignCalibration(base, 280, 100, 280, NaN)).toBeNull(); // 比率≤0.5 边界外
  });

  it('校正到位后再量 = 理论值：比率 1，数值不再漂移', () => {
    const once = boardAlignCalibration(base, 280.05, 278, 280.05, 278)!;
    const twice = boardAlignCalibration(once.cal, 280.05, 280.05, 280.05, 280.05)!;
    expect(twice.factorX).toBeCloseTo(1, 9);
    expect(twice.cal.mmPerDevicePxX).toBeCloseTo(once.cal.mmPerDevicePxX, 9);
  });
});
