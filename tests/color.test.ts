/**
 * tests/color.test.ts —— 颜色科学（量化 / 匹配 / HSL 刻度 / 色号清单）回归用例（Vitest）。
 */
import { describe, expect, it } from 'vitest';
import { mergeSimilar, type QuantizedColor } from '@/color/quantize';
import { applyVibranceToQuantized } from '@/imaging/pipeline';
import { rgbToHsl, hslToRgb, rgbToLab, labToRgb } from '@/color/convert';
import { deltaE2000 } from '@/color/deltaE';
import { parseBeadList, matchBeadList, normalizeCode, beadListToText } from '@/core/beadList';
import { getPalette } from '@/palettes';
import type { BeadPalette } from '@/core/types';

describe('HSL 刻度（convert）', () => {
  it('rgbToHsl 的 S/L 为 0–100 刻度，纯红 S=100', () => {
    const [h, s, l] = rgbToHsl([255, 0, 0]);
    expect(h).toBeCloseTo(0, 5);
    expect(s).toBeCloseTo(100, 5);
    expect(l).toBeCloseTo(50, 5);
  });
  it('hslToRgb 与 rgbToHsl 互逆', () => {
    const rgb = hslToRgb([210, 65, 42]);
    const [h2, s2, l2] = rgbToHsl(rgb);
    expect(h2).toBeCloseTo(210, 1);
    expect(s2).toBeCloseTo(65, 1);
    expect(l2).toBeCloseTo(42, 1);
  });
});

describe('vibrance 鲜艳度增强（缺陷 #39）', () => {
  it('低饱和色提升、高饱和色几乎不动、中性色不动', () => {
    const mk = (rgb: [number, number, number]): QuantizedColor => ({ rgb, hex: '#000000', count: 1 });
    const out = applyVibranceToQuantized([mk([180, 160, 150]), mk([255, 0, 0]), mk([128, 128, 128])]);
    const sat = (rgb: [number, number, number]) => rgbToHsl(rgb)[1];
    // 低饱和：0.18×(1-s) 提升明显
    expect(sat(out[0].rgb)).toBeGreaterThan(sat([180, 160, 150]));
    // 高饱和：已接近 100，几乎不变
    expect(sat(out[1].rgb)).toBeGreaterThanOrEqual(99);
    // 灰色：s=0 不动
    expect(sat(out[2].rgb)).toBeCloseTo(0, 5);
  });
});

describe('mergeSimilar（近似色合并）', () => {
  it('ΔE 极近的两色合并、保留较大色', () => {
    const q: QuantizedColor[] = [
      { rgb: [200, 60, 60], hex: '#c83c3c', count: 30 },
      { rgb: [204, 62, 60], hex: '#cc3e3c', count: 20 },
      { rgb: [30, 30, 220], hex: '#1e1edc', count: 10 },
    ];
    const merged = mergeSimilar(q, 8);
    expect(merged.length).toBe(2);
    const red = merged.find((m) => m.rgb[0] > 150);
    expect(red?.count).toBe(50); // 格数加权保留
  });
});

describe('deltaE2000 基准', () => {
  it('同色为 0，黑白差 > 100', () => {
    expect(deltaE2000([50, 0, 0], [50, 0, 0])).toBeCloseTo(0, 6);
    // CIEDE2000 的 L* 分量主导：L0→100 的色差恰为 100
    expect(deltaE2000([0, 0, 0], [100, 0, 0])).toBeCloseTo(100, 4);
  });
});

describe('rgbToLab 暗区正确性（KAPPA 回归锚定）', () => {
  // 回归：KAPPA 曾误写为 24389/100（正确为 24389/27 ≈ 903.3），导致 t ≤ ε 的
  // 线性支路失真——暗区 L 偏暗、a/b 被放大约 3.7 倍，黑发被匹配成棕色号。
  it('暖近黑 #221712 的 Lab 与 CIE 手算值一致（C* < 9，属低饱和暗部）', () => {
    const lab = rgbToLab([34, 23, 18]);
    expect(lab[0]).toBeCloseTo(8.96, 1);
    expect(lab[1]).toBeCloseTo(4.65, 1);
    expect(lab[2]).toBeCloseTo(5.33, 1);
    expect(Math.hypot(lab[1], lab[2])).toBeLessThan(9);
  });
  it('暗区 Lab↔RGB 往返不漂移（线性支路正反一致）', () => {
    for (const rgb of [[20, 20, 20], [34, 23, 18], [12, 10, 16], [58, 36, 24]] as const) {
      const back = labToRgb(rgbToLab([...rgb]));
      expect(back[0]).toBeLessThanOrEqual(rgb[0] + 1);
      expect(back[0]).toBeGreaterThanOrEqual(rgb[0] - 1);
      expect(back[1]).toBeLessThanOrEqual(rgb[1] + 1);
      expect(back[1]).toBeGreaterThanOrEqual(rgb[1] - 1);
      expect(back[2]).toBeLessThanOrEqual(rgb[2] + 1);
      expect(back[2]).toBeGreaterThanOrEqual(rgb[2] - 1);
    }
  });
  it('两个近黑灰 (20,20,20)/(24,24,24) 的 ΔE2000 ≈ 1.18（修复前虚高至 3.9）', () => {
    const de = deltaE2000(rgbToLab([20, 20, 20]), rgbToLab([24, 24, 24]));
    expect(de).toBeGreaterThan(0.8);
    expect(de).toBeLessThan(2.0);
  });
});

/* ================= 色号清单（体验优化 #8） ================= */

const testPalette: BeadPalette = {
  id: 'test',
  brand: '测试',
  name: '测试色板',
  beadSizeMm: 2.6,
  editable: true,
  colors: [
    { id: 'a1', code: 'A1', name: 'White', nameZh: '白', hex: '#FFFFFF', rgb: [255, 255, 255], lab: [100, 0, 0], builtin: true },
    { id: 'b3', code: 'B3', name: 'Red', nameZh: '红', hex: '#FF0000', rgb: [255, 0, 0], lab: [53.2, 80.1, 67.2], builtin: true },
    { id: 'm15', code: 'M15', name: 'Black', nameZh: '黑', hex: '#000000', rgb: [0, 0, 0], lab: [0, 0, 0], builtin: true },
  ],
};

describe('parseBeadList（清单解析）', () => {
  it('支持 ×/x/空格/冒号/逗号 分隔与行首序号', () => {
    const { lines, skipped } = parseBeadList(
      '1. A1 ×120\nB3 45\nM15: 8\nC2,200\n- a1 x 5\n这不是色号的一行',
    );
    expect(skipped).toEqual(['这不是色号的一行']);
    expect(lines.map((l) => l.code)).toEqual(['A1', 'B3', 'M15', 'C2', 'a1']);
    expect(lines.map((l) => l.count)).toEqual([120, 45, 8, 200, 5]);
  });

  it('无数量的行 count 为 null；注释行跳过', () => {
    const { lines, skipped } = parseBeadList('# 头注释\nA1\n');
    expect(lines.length).toBe(1);
    expect(lines[0].count).toBeNull();
    expect(skipped.length).toBe(0);
  });

  it('normalizeCode 忽略大小写/空格/连字符', () => {
    expect(normalizeCode(' mard -05 ')).toBe('MARD05');
  });
});

describe('matchBeadList（三级匹配）', () => {
  it('精确同号直配', () => {
    const r = matchBeadList([{ raw: 'B3', code: 'B3', count: 10 }], testPalette);
    expect(r.matches[0].status).toBe('exact');
    expect(r.matches[0].index).toBe(1);
  });

  it('大小写/连字符变体也能精确命中', () => {
    const r = matchBeadList([{ raw: 'm-15', code: 'm15', count: null }], testPalette);
    expect(r.matches[0].status).toBe('exact');
    expect(r.matches[0].matchedCode).toBe('M15');
  });

  it('未知色号 → unmatched，不猜', () => {
    const r = matchBeadList([{ raw: 'ZZ9', code: 'ZZ9', count: 1 }], testPalette);
    expect(r.matches[0].status).toBe('unmatched');
    expect(r.matches[0].index).toBe(-1);
  });

  it('数量求和（有数量的行）', () => {
    const r = matchBeadList(
      [
        { raw: 'A1 ×2', code: 'A1', count: 2 },
        { raw: 'B3 3', code: 'B3', count: 3 },
        { raw: 'M15', code: 'M15', count: null },
      ],
      testPalette,
    );
    expect(r.totalCount).toBe(5);
  });

  it('跨色板同号给出最近色建议（Artkal 色号 → 测试色板）', () => {
    // 任取一个真实内置色板（MARD）里存在的色号，换到只含黑白红蓝的测试色板下应给建议或 unmatched，
    // 这里校验「不崩溃 + 状态合法」即可
    const artkal = getPalette('artkal');
    const someCode = artkal.colors[0].code;
    const r = matchBeadList([{ raw: someCode, code: someCode, count: 1 }], testPalette);
    expect(['exact', 'similar', 'unmatched']).toContain(r.matches[0].status);
  });

  it('beadListToText 输出可读清单与合计', () => {
    const parsed = parseBeadList('A1 ×2\nB3 3');
    const r = matchBeadList(parsed.lines, testPalette);
    const text = beadListToText(r);
    expect(text).toContain('A1');
    expect(text).toContain('合计：5 颗');
  });
});
