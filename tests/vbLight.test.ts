/**
 * tests/vbLight.test.ts —— 手机点亮图案掩码构建用例。
 * 语义：GIF 首帧非黑像素 = 点亮格（2026-09-30 真机 573B 节目实测：104×104、1146 红点）。
 */
import { describe, expect, it } from 'vitest';
import { buildLightMaskFromRgba } from '@/core/vbLight';

describe('buildLightMaskFromRgba', () => {
  it('全黑帧 → 全灭', () => {
    const m = buildLightMaskFromRgba(new Uint8ClampedArray(2 * 2 * 4), 2, 2);
    expect(m.w).toBe(2);
    expect(m.h).toBe(2);
    expect(m.count).toBe(0);
    expect(Array.from(m.mask)).toEqual([0, 0, 0, 0]);
  });

  it('非黑像素点亮，掩码行主序（mask[y*w+x]）', () => {
    // 2×2：黑、红、绿、黑
    const d = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 0, 255,
    ]);
    const m = buildLightMaskFromRgba(d, 2, 2);
    expect(m.count).toBe(2);
    expect(m.mask[0 * 2 + 1]).toBe(1); // (x=1, y=0) 红
    expect(m.mask[1 * 2 + 0]).toBe(1); // (x=0, y=1) 绿
    expect(m.mask[0]).toBe(0);
    expect(m.mask[1 * 2 + 1]).toBe(0);
  });

  it('黑色判定只看 RGB 不看 alpha（与对话框预览画布同口径）', () => {
    const d = new Uint8ClampedArray([
      0, 0, 0, 0,    // 全透黑 → 灭
      0, 0, 0, 128,  // 半透黑 → 灭
      10, 0, 0, 0,   // 暗红（alpha 0）→ 亮
    ]);
    const m = buildLightMaskFromRgba(d, 3, 1);
    expect(m.count).toBe(1);
    expect(m.mask[2]).toBe(1);
  });

  it('rgba 原样带回拷贝（小窗按原色重绘用；改拷贝不回写输入）', () => {
    const d = new Uint8ClampedArray([
      0, 0, 0, 255,
      200, 30, 40, 255,
    ]);
    const m = buildLightMaskFromRgba(d, 1, 2);
    expect(m.rgba).not.toBe(d);
    expect(Array.from(m.rgba)).toEqual([0, 0, 0, 255, 200, 30, 40, 255]);
    m.rgba[4] = 1;
    expect(d[4]).toBe(200);
  });
});
