/**
 * tests/layers.test.ts —— 四层离屏缓存系统用例（回归补测）。
 *
 * 语义基线：invalidate（全量）/ invalidatePartial（局部，但被待处理的全量吞并）/
 * resize（DPR 封顶 2 + overscan 30%）/ dispose（防泄漏）——这几条是渲染器局部重绘
 * 路径能否进入的关键（缺口 7：fullDirty 复位语义，单格编辑退化成全板重绘的教训）。
 *
 * 环境说明：vitest 配置是 node 环境（无 DOM）。LayerSystem 构造需要
 * document.createElement('canvas') 与 getContext('2d')，这里用**最小 canvas stub**
 * 喂给全局 document：只实现 layers.ts 实际用到的 width/height 与 getContext 空壳。
 * 测试关注的是失效状态机与尺寸计算，不依赖任何真实绘制。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampDpr, LayerSystem } from '@/render/layers';

/** 最小 canvas 元素 stub：width/height 可写，getContext 返回空壳（不参与绘制） */
function makeCanvasStub(): {
  width: number;
  height: number;
  getContext: (id: string, opts?: unknown) => { canvas: unknown };
} {
  const el = {
    width: 300,
    height: 150,
    getContext(_id: string, _opts?: unknown) {
      return { canvas: el };
    },
  };
  return el;
}

let originalDocument: unknown;

beforeEach(() => {
  originalDocument = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return makeCanvasStub();
    },
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).document = originalDocument;
});

describe('clampDpr', () => {
  it('DPR 封顶 2、下限 1（4K 屏内存保护）', () => {
    expect(clampDpr(1)).toBe(1);
    expect(clampDpr(1.5)).toBe(1.5);
    expect(clampDpr(2)).toBe(2);
    expect(clampDpr(2.5)).toBe(2);
    expect(clampDpr(4)).toBe(2);
  });

  it('非法值（0/负数）夹到 1', () => {
    expect(clampDpr(0)).toBe(1);
    expect(clampDpr(-3)).toBe(1);
  });
});

describe('LayerSystem 失效状态机', () => {
  it('构造后四层齐备且初始 dirty/fullDirty', () => {
    const sys = new LayerSystem();
    for (const id of [0, 1, 2, 3] as const) {
      const l = sys.getLayer(id);
      expect(l).toBeTruthy();
      expect(l.dirty).toBe(true);
      expect(l.fullDirty).toBe(true);
    }
  });

  it('invalidate：全量失效置位', () => {
    const sys = new LayerSystem();
    sys.getLayer(1).dirty = false;
    sys.getLayer(1).fullDirty = false;
    sys.invalidate(1);
    expect(sys.getLayer(1).dirty).toBe(true);
    expect(sys.getLayer(1).fullDirty).toBe(true);
  });

  it('invalidatePartial：干净层 → 局部失效（fullDirty=false，走局部重绘路径）', () => {
    const sys = new LayerSystem();
    sys.getLayer(1).dirty = false;
    sys.getLayer(1).fullDirty = true; // 已绘制过的层（render 后 fullDirty 复位为 true）
    sys.invalidatePartial(1);
    expect(sys.getLayer(1).dirty).toBe(true);
    expect(sys.getLayer(1).fullDirty).toBe(false); // 关键：局部路径可进入
  });

  it('invalidatePartial：已有全量待处理 → 局部被吞并，绝不下调为局部', () => {
    const sys = new LayerSystem();
    const l = sys.getLayer(1);
    l.dirty = true;
    l.fullDirty = true; // 全量待处理（如 view/主题变化）
    sys.invalidatePartial(1);
    expect(l.dirty).toBe(true);
    expect(l.fullDirty).toBe(true); // 保持全量——下调会漏绘整板位移
  });

  it('invalidateAll：四层全部置全量', () => {
    const sys = new LayerSystem();
    for (const id of [0, 1, 2, 3] as const) {
      sys.getLayer(id).dirty = false;
      sys.getLayer(id).fullDirty = false;
    }
    sys.invalidateAll();
    for (const id of [0, 1, 2, 3] as const) {
      expect(sys.getLayer(id).dirty).toBe(true);
      expect(sys.getLayer(id).fullDirty).toBe(true);
    }
  });
});

describe('LayerSystem.resize 尺寸计算', () => {
  it('overscan 30% + DPR 1：100×50 CSS → 130×65 设备像素', () => {
    const sys = new LayerSystem();
    sys.resize(100, 50, 1);
    // overscan: ceil(100*0.3)=30 → 130；ceil(50*0.3)=15 → 65
    expect(sys.getLayer(0).width).toBe(130);
    expect(sys.getLayer(0).height).toBe(65);
    expect(sys.dpr).toBe(1);
  });

  it('DPR 2 封顶：200×100 CSS、DPR=3 → clamp 到 2（尺寸 = 260×130 ×2）', () => {
    const sys = new LayerSystem();
    sys.resize(200, 100, 3);
    // overscan: ceil(200*0.3)=60 → 260；ceil(100*0.3)=30 → 130
    expect(sys.getLayer(0).width).toBe(520);
    expect(sys.getLayer(0).height).toBe(260);
    expect(sys.dpr).toBe(2);
  });

  it('尺寸变化 → 全部层标全量失效', () => {
    const sys = new LayerSystem();
    sys.resize(100, 50, 1);
    for (const id of [0, 1, 2, 3] as const) {
      const l = sys.getLayer(id);
      l.dirty = false;
      l.fullDirty = false;
    }
    sys.resize(120, 60, 1);
    for (const id of [0, 1, 2, 3] as const) {
      expect(sys.getLayer(id).dirty).toBe(true);
      expect(sys.getLayer(id).fullDirty).toBe(true);
    }
  });

  it('尺寸不变（重复同参数 resize）→ 不打扰已绘制状态', () => {
    const sys = new LayerSystem();
    sys.resize(100, 50, 1);
    for (const id of [0, 1, 2, 3] as const) {
      sys.getLayer(id).dirty = false;
      sys.getLayer(id).fullDirty = false;
    }
    sys.resize(100, 50, 1);
    expect(sys.getLayer(0).dirty).toBe(false); // sizeChanged=false，不置脏
    expect(sys.getLayer(0).fullDirty).toBe(false);
  });

  it('viewportDev 尺寸 = CSS × clampedDpr（不含 overscan）', () => {
    const sys = new LayerSystem();
    sys.resize(100, 50, 2);
    expect(sys.viewportDevW).toBe(200);
    expect(sys.viewportDevH).toBe(100);
  });

  it('dpr 从 2 降到 1：尺寸变化触发全量失效', () => {
    const sys = new LayerSystem();
    sys.resize(100, 50, 2);
    sys.getLayer(0).dirty = false;
    sys.getLayer(0).fullDirty = false;
    sys.resize(100, 50, 1);
    expect(sys.getLayer(0).width).toBe(130); // 不再是 260
    expect(sys.getLayer(0).dirty).toBe(true);
  });
});

describe('LayerSystem.dispose', () => {
  it('释放后画布尺寸归零、层列表清空', () => {
    const sys = new LayerSystem();
    sys.resize(100, 50, 1);
    sys.dispose();
    // 层已清空：getLayer 越界返回 undefined（数组空）
    expect(sys.getLayer(0)).toBeUndefined();
  });
});
