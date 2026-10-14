/**
 * tests/gridPattern.test.ts —— 色号图纸网格采样用例。
 * 核心：格子中央窗口的众数色不受「色号文字笔画/格线」污染；
 *       透明格输出 0；越界/退化输入容错。
 */
import { describe, expect, it } from 'vitest';
import { sampleGridCells } from '@/imaging/gridPattern';
import type { RgbaData } from '@/imaging/loader';

/** 构造 RgbaData（全不透明） */
function makeRgba(w: number, h: number): RgbaData {
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
}

function fillRect(img: RgbaData, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * img.width + x) * 4;
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
    }
  }
}

describe('imaging · gridPattern（色号图纸逐格采样）', () => {
  it('3×2 网格：每格底色被正确还原，中央黑色「色号文字」不污染结果', () => {
    // 300×200 → 每格 100×100；三列底色：红 / 白 / 蓝；两行同色
    const img = makeRgba(300, 200);
    fillRect(img, 0, 0, 100, 200, 220, 40, 40); // 红
    fillRect(img, 100, 0, 200, 200, 245, 245, 245); // 白
    fillRect(img, 200, 0, 300, 200, 40, 70, 200); // 蓝
    // 在每个格子中央画 20×20 的黑色「文字块」（少数派）
    for (const cx of [50, 150, 250]) {
      for (const cy of [50, 150]) {
        fillRect(img, cx - 10, cy - 10, cx + 10, cy + 10, 20, 20, 20);
      }
    }
    const r = sampleGridCells(img, 3, 2);
    expect(r.cols).toBe(3);
    expect(r.rows).toBe(2);
    const exp = [
      (220 << 16) | (40 << 8) | 40,
      (245 << 16) | (245 << 8) | 245,
      (40 << 16) | (70 << 8) | 200,
    ];
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        expect(r.cells[y * 3 + x]).toBe(exp[x]);
      }
    }
  });

  it('纯黑格子：文字与底色同色，输出仍为黑', () => {
    const img = makeRgba(100, 100);
    fillRect(img, 0, 0, 100, 100, 10, 10, 10);
    fillRect(img, 40, 40, 60, 60, 5, 5, 5); // 中央更深的文字
    const r = sampleGridCells(img, 1, 1);
    const v = r.cells[0];
    expect(((v >> 16) & 255) as number).toBeLessThan(30);
  });

  it('全透明格输出 0（空格）', () => {
    const img = makeRgba(100, 100); // 默认全 0 = 透明
    fillRect(img, 0, 0, 50, 100, 200, 200, 200); // 左半上色
    const r = sampleGridCells(img, 2, 1);
    expect(r.cells[0] !== 0).toBe(true);
    expect(r.cells[1]).toBe(0);
  });

  it('格子内有浅色网格线（边缘 1px）也不影响中央采样', () => {
    const img = makeRgba(200, 100);
    fillRect(img, 0, 0, 200, 100, 180, 220, 180);
    // 竖向浅灰格线穿过两列交界
    fillRect(img, 98, 0, 102, 100, 200, 200, 200);
    const r = sampleGridCells(img, 2, 1);
    const v = r.cells[0];
    expect(((v >> 16) & 255) as number).toBeLessThan(195); // 绿底而非灰线
  });

  it('行列数与源尺寸不成整除时按比例定位，不越界不抛', () => {
    const img = makeRgba(101, 100);
    fillRect(img, 0, 0, 101, 100, 90, 90, 90);
    expect(() => sampleGridCells(img, 101, 100)).not.toThrow();
    const r = sampleGridCells(img, 101, 100);
    expect(r.cells.length).toBe(101 * 100);
    expect(r.cells.every((v) => v !== 0)).toBe(true);
  });
});
