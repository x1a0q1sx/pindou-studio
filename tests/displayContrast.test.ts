/**
 * tests/displayContrast.test.ts —— 暗色豆可见性辅助判定纯函数用例。
 */
import { describe, expect, it } from 'vitest';
import { yiqLuma, hexLuma, lowContrastEdge, dimVeilStyle, EDGE_CONTRAST_THRESHOLD } from '@/core/displayContrast';

describe('yiqLuma / hexLuma', () => {
  it('黑 0、白 255、中灰 128', () => {
    expect(yiqLuma([0, 0, 0])).toBe(0);
    expect(yiqLuma([255, 255, 255])).toBe(255);
    expect(yiqLuma([128, 128, 128])).toBeCloseTo(128, 0);
  });
  it('hex 支持 3 位/6 位，非法回退黑', () => {
    expect(hexLuma('#000')).toBe(0);
    expect(hexLuma('#FFF')).toBe(255);
    expect(hexLuma('#000000')).toBe(0);
    expect(hexLuma('garbage')).toBe(0);
  });
});

describe('lowContrastEdge（救援描边判定）', () => {
  it('黑豆 on 纯黑底（glowDark）→ 白色浅描边', () => {
    // MARD H6 #0d0d0d 亮度 13，底色 0 → 差 13 < 60
    expect(lowContrastEdge(13, 0)).toBe('rgba(255,255,255,0.55)');
  });
  it('白豆 on 白底 → 黑色描边；亮度相等同样触发', () => {
    expect(lowContrastEdge(255, 255)).toBe('rgba(0,0,0,0.45)');
  });
  it('对比充足（深灰豆 on 黑底差 ≥60）→ 不补边', () => {
    expect(lowContrastEdge(EDGE_CONTRAST_THRESHOLD, 0)).toBeNull();
    expect(lowContrastEdge(200, 0)).toBeNull();
  });
  it('阈值边界：差 59 补边、差 60 不补', () => {
    expect(lowContrastEdge(59, 0)).not.toBeNull();
    expect(lowContrastEdge(60, 0)).toBeNull();
  });
});

describe('dimVeilStyle（压暗分级）', () => {
  it('与底色差 <90 的深色豆用浅 veil，高对比豆维持 0.65', () => {
    expect(dimVeilStyle(13, 0)).toBe('rgba(0,0,0,0.40)'); // 黑豆在暗底上被筛选压暗
    expect(dimVeilStyle(200, 0)).toBe('rgba(0,0,0,0.65)'); // 亮豆正常压暗
    expect(dimVeilStyle(80, 0)).toBe('rgba(0,0,0,0.40)'); // 差 80 < 90
    expect(dimVeilStyle(95, 0)).toBe('rgba(0,0,0,0.65)');
  });
});
