/**
 * tests/pixelate.test.ts —— 像素化纯算法的回归用例（Vitest）。
 * 重点覆盖本轮新增的四角透视校正（homography + warp）与既有行为锚定。
 */
import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  fitRect,
  homographyFromUnitQuad,
  pixelateFromRgba,
  removeBackgroundByEdge,
  warpPerspective,
  type PixelateSource,
} from '@/imaging/pixelate';

function solidSource(w: number, h: number, rgb: [number, number, number], alpha = 255): PixelateSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = alpha;
  }
  return { data, width: w, height: h };
}

describe('fitRect', () => {
  it('contain：宽图在方板上下留白', () => {
    const f = fitRect(200, 100, 10, 10, 'contain');
    expect(f.dst.h).toBe(5);
    expect(f.dst.y).toBe(3); // round(2.5) = 3（JS 半数向上取整）
    expect(f.src.w).toBe(200);
  });
  it('cover：高图在横板两侧裁剪', () => {
    // 源更高 → 沿纵向裁剪（保持全宽 100，高裁到 100），y 居中 50
    const f = fitRect(100, 200, 10, 10, 'cover');
    expect(f.src.w).toBe(100);
    expect(f.src.h).toBe(100);
    expect(f.src.y).toBe(50);
  });
});

describe('四角透视校正（homography）', () => {
  it('轴对齐矩形 → 单位方的 H 应为纯缩放+平移', () => {
    // quad: (10,20) (110,20) (110,120) (10,120)，H 应把 (u,v) 映到 10+100u, 20+100v
    const h = homographyFromUnitQuad([
      { x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 120 }, { x: 10, y: 120 },
    ]);
    const [ax, ay] = applyHomography(h, 0.5, 0.5);
    expect(ax).toBeCloseTo(60, 6);
    expect(ay).toBeCloseTo(70, 6);
    const [cx, cy] = applyHomography(h, 0, 0);
    expect(cx).toBeCloseTo(10, 6);
    expect(cy).toBeCloseTo(20, 6);
    // 仿射情形下透视分量应为 0
    expect(h[6]).toBeCloseTo(0, 8);
    expect(h[7]).toBeCloseTo(0, 8);
  });

  it('四角点集与单位方一一对应（四点可逆）', () => {
    const quad = [{ x: 0, y: 0 }, { x: 100, y: 5 }, { x: 95, y: 100 }, { x: 3, y: 97 }];
    const h = homographyFromUnitQuad(quad);
    quad.forEach((p, k) => {
      const u = [0, 1, 1, 0][k];
      const v = [0, 0, 1, 1][k];
      const [x, y] = applyHomography(h, u, v);
      expect(x).toBeCloseTo(p.x, 4);
      expect(y).toBeCloseTo(p.y, 4);
    });
  });

  it('warpPerspective：矩形区域拉正后逐像素还原原图', () => {
    // 左红右蓝 2:1 图，按其精确矩形拉正 → 输出左右分界保持
    const w = 60;
    const h = 30;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const red = x < w / 2;
        data[i] = red ? 220 : 30;
        data[i + 1] = 10;
        data[i + 2] = red ? 10 : 200;
        data[i + 3] = 255;
      }
    }
    const out = warpPerspective(
      { data, width: w, height: h },
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      60, 30,
    );
    // 中心采样点 (10,15) → 红；(50,15) → 蓝
    const at = (x: number, y: number) => {
      const i = (y * 60 + x) * 4;
      return [out.data[i], out.data[i + 1], out.data[i + 2]];
    };
    expect(at(10, 15)[0]).toBeGreaterThan(180);
    expect(at(50, 15)[2]).toBeGreaterThan(150);
  });

  it('warpPerspective：出界保持透明（alpha 0）', () => {
    const out = warpPerspective(
      solidSource(20, 20, [255, 0, 0]),
      [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }],
      40, 40,
    );
    const i = (0 * 40 + 0) * 4; // 角落必然出界
    expect(out.data[i + 3]).toBe(0);
  });
});

describe('pixelateFromRgba 接透视参数', () => {
  it('透视开启时采样仍产出 cols×rows 全非零 cells', () => {
    const r = pixelateFromRgba(solidSource(80, 80, [120, 60, 30]), {
      cols: 4,
      rows: 4,
      sampling: 'area-average',
      preprocess: { brightness: 0, contrast: 0, saturation: 0 },
      transparentAsEmpty: true,
      samplingCap: 60000,
      perspective: { corners: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.12 }, { x: 0.88, y: 0.9 }, { x: 0.12, y: 0.88 }] },
    });
    expect(r.cells.length).toBe(16);
    expect([...r.cells].every((v) => v !== 0)).toBe(true);
  });

  it('进度回调按行块上报且单调、终点为 1', () => {
    const seen: number[] = [];
    pixelateFromRgba(solidSource(50, 40, [10, 200, 10]), {
      cols: 5,
      rows: 5,
      sampling: 'area-average',
      preprocess: { brightness: 0, contrast: 0, saturation: 0 },
      transparentAsEmpty: true,
      samplingCap: 60000,
    }, (f) => seen.push(f));
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});

describe('removeBackgroundByEdge（去背景）', () => {
  it('连通背景清空，主体内部同色保留', () => {
    const w = 10;
    const h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
    }
    // 中心 4×4 深色主体
    for (let y = 3; y <= 6; y++) {
      for (let x = 3; x <= 6; x++) {
        const i = (y * w + x) * 4;
        data[i] = 20; data[i + 1] = 20; data[i + 2] = 20;
      }
    }
    // 主体内部一个白点：与边缘背景不连通，必须保留
    const inner = (4 * w + 4) * 4;
    data[inner] = 255; data[inner + 1] = 255; data[inner + 2] = 255; data[inner + 3] = 255;

    removeBackgroundByEdge({ data, width: w, height: h }, 30);
    const alphaAt = (x: number, y: number) => data[(y * w + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0);       // 边角背景被清
    expect(alphaAt(5, 5)).toBe(255);     // 主体内部保留
    expect(alphaAt(4, 4)).toBe(255);     // 主体内的白色孤岛保留（不连通）
  });
});
