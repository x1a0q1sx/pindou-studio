/**
 * tests/dirtyRect.test.ts —— src/render/dirtyRect.ts 脏矩形管理全量覆盖。
 *
 * 纯逻辑（64×64 设备像素瓦片划分 / Set 去重 / peek 矩形裁剪），node 环境直跑，无 DOM 依赖。
 * 覆盖：正常路径 + 边界（空集、单格、瓦片边界对齐、负坐标、越出画布、退化矩形、未 setSize）。
 * 注：markRectDirty 对「画布外右侧/下方」不做标记域裁剪（只有 peek 时夹到画布边），
 *     本文件把这类口径锁定为行为基线，避免后续重构时无意识变更。
 */
import { describe, expect, it } from 'vitest';
import { DirtyRectTracker, TILE_SIZE, type DirtyTile } from '@/render/dirtyRect';

/** 取瓦片 key 并排序，消除 Set 遍历顺序带来的断言噪音 */
function keysOf(tiles: DirtyTile[]): string[] {
  return tiles.map((t) => `${t.tx},${t.ty}`).sort();
}

describe('TILE_SIZE 常量', () => {
  it('瓦片边长恒为 64 设备像素（渲染器与消费方共同依赖的口径）', () => {
    expect(TILE_SIZE).toBe(64);
  });
});

describe('DirtyRectTracker 初始状态', () => {
  it('新建实例：无脏瓦片，peek / consume 均返回空数组', () => {
    const t = new DirtyRectTracker();
    expect(t.hasDirty()).toBe(false);
    expect(t.dirtyCount).toBe(0);
    expect(t.peekDirty()).toEqual([]);
    expect(t.consumeDirty()).toEqual([]);
  });
});

describe('markRectDirty 瓦片划分', () => {
  it('单瓦片内小矩形 → 恰 1 个瓦片，矩形为整块瓦片（含画布边裁剪）', () => {
    const t = new DirtyRectTracker();
    t.setSize(100, 50); // 不足整瓦片：1×1 瓦片网格
    t.markRectDirty(10, 20, 50, 60);
    expect(t.dirtyCount).toBe(1);
    const tiles = t.consumeDirty();
    expect(keysOf(tiles)).toEqual(['0,0']);
    // 瓦片矩形 = 瓦片网格块（64px）与画布边的交集：100×50 画布的首瓦片右边界被裁到 64
    expect(tiles[0]).toMatchObject({ tx: 0, ty: 0, x0: 0, y0: 0, x1: 64, y1: 50 });
  });

  it('跨瓦片矩形 → 覆盖所有相交瓦片（2×2 网格中 3×2 瓦片）', () => {
    const t = new DirtyRectTracker();
    t.setSize(200, 100); // ceil(200/64)=4 列、ceil(100/64)=2 行，此处矩形触到 3×2
    t.markRectDirty(60, 30, 130, 70);
    expect(t.dirtyCount).toBe(6);
    expect(keysOf(t.consumeDirty())).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1']);
  });

  it('瓦片边界对齐：[0,64) 半开区间 → 只标 1 瓦片；压过边界 1px → 4 瓦片', () => {
    const t = new DirtyRectTracker();
    t.setSize(128, 128);
    t.markRectDirty(0, 0, 64, 64); // x1=64 恰为边界，属半开区间不含
    expect(t.dirtyCount).toBe(1);
    t.clear();

    t.markRectDirty(63, 63, 65, 65); // 跨越 64 边界各 1px → 4 个瓦片
    expect(t.dirtyCount).toBe(4);
    expect(keysOf(t.consumeDirty())).toEqual(['0,0', '0,1', '1,0', '1,1']);
    t.clear();

    t.markRectDirty(64, 64, 65, 65); // 完整落在第二行第二列瓦片内
    expect(keysOf(t.consumeDirty())).toEqual(['1,1']);
  });

  it('重复标记同一区域天然去重（Set key 口径）', () => {
    const t = new DirtyRectTracker();
    t.setSize(128, 128);
    t.markRectDirty(0, 0, 64, 64);
    t.markRectDirty(0, 0, 64, 64);
    t.markRectDirty(10, 10, 20, 20); // 同瓦片子区域
    expect(t.dirtyCount).toBe(1);
  });

  it('负坐标被 clamp 到瓦片 0（不产生负索引 key）', () => {
    const t = new DirtyRectTracker();
    t.setSize(128, 128);
    t.markRectDirty(-100, -100, 10, 10);
    expect(keysOf(t.consumeDirty())).toEqual(['0,0']);
  });

  it('负值矩形（x1 ≤ 0）：仍标 tile(0,0) —— max(0, x1-1) 的口径锁定', () => {
    const t = new DirtyRectTracker();
    t.markRectDirty(-50, -50, -10, -10);
    expect(t.dirtyCount).toBe(1);
    expect(keysOf(t.consumeDirty())).toEqual(['0,0']);
  });

  it('零面积矩形（x0===x1 且 y0===y1）→ 仍标所在瓦片', () => {
    const t = new DirtyRectTracker();
    t.setSize(128, 128);
    t.markRectDirty(0, 0, 0, 0); // 原点上：max(0, -1)=0 → tile(0,0)
    expect(keysOf(t.consumeDirty())).toEqual(['0,0']);
    t.markRectDirty(100, 50, 100, 50); // tile(1,0) 内部
    expect(keysOf(t.consumeDirty())).toEqual(['1,0']);
  });

  it('矩形完全越出画布右侧：标记域不裁剪（观察点），peek 矩形夹到画布边后退化', () => {
    const t = new DirtyRectTracker();
    t.setSize(64, 64);
    t.markRectDirty(1024, 0, 1088, 64); // 恰好覆盖 tile(16,0)，画布仅 1 瓦片宽
    expect(keysOf(t.consumeDirty())).toEqual(['16,0']);
    t.markRectDirty(1024, 0, 1088, 64);
    const tile = t.peekDirty()[0]!;
    expect(tile.x0).toBe(1024);
    expect(tile.x1).toBe(64); // min(1088, 64) → x1 < x0 的退化矩形
  });

  it('未 setSize 时 markRectDirty 也可标记，但 peek 矩形按 canvasW=0 退化（markAllDirty 有守卫、markRectDirty 没有的口径差异）', () => {
    const t = new DirtyRectTracker();
    t.markRectDirty(0, 0, 64, 64);
    expect(t.dirtyCount).toBe(1);
    const tile = t.peekDirty()[0]!;
    expect(tile.x0).toBe(0);
    expect(tile.x1).toBe(0); // min(64, 0) = 0
  });
});

describe('markCellDirty', () => {
  it('与 markRectDirty 完全等价（渲染器传 cellRect 的入口）', () => {
    const a = new DirtyRectTracker();
    const b = new DirtyRectTracker();
    a.setSize(200, 200);
    b.setSize(200, 200);
    a.markCellDirty(60, 30, 130, 70);
    b.markRectDirty(60, 30, 130, 70);
    expect(keysOf(a.consumeDirty())).toEqual(keysOf(b.consumeDirty()));
  });
});

describe('markAllDirty', () => {
  it('未 setSize（画布 0×0）→ no-op', () => {
    const t = new DirtyRectTracker();
    t.markAllDirty();
    expect(t.hasDirty()).toBe(false);
  });

  it('画布任一边 ≤ 0 → no-op', () => {
    const t = new DirtyRectTracker();
    t.setSize(0, 100);
    t.markAllDirty();
    expect(t.hasDirty()).toBe(false);
    t.setSize(100, 0);
    t.markAllDirty();
    expect(t.hasDirty()).toBe(false);
  });

  it('整瓦片画布（64×64）→ 1 瓦片', () => {
    const t = new DirtyRectTracker();
    t.setSize(64, 64);
    t.markAllDirty();
    expect(keysOf(t.consumeDirty())).toEqual(['0,0']);
  });

  it('超出 1 瓦片 1px（65×65）→ 2×2 瓦片（floor((n-1)/64) 口径）', () => {
    const t = new DirtyRectTracker();
    t.setSize(65, 65);
    t.markAllDirty();
    expect(t.dirtyCount).toBe(4);
  });

  it('129×65 → 3×2 瓦片；矩形右下边界按画布尺寸裁剪', () => {
    const t = new DirtyRectTracker();
    t.setSize(129, 65);
    t.markAllDirty();
    expect(t.dirtyCount).toBe(6);
    const tiles = t.consumeDirty();
    const tile = tiles.find((x) => x.tx === 2 && x.ty === 1)!;
    expect(tile.x0).toBe(128);
    expect(tile.x1).toBe(129); // min(192, 129)
    expect(tile.y1).toBe(65); // min(128, 65)
  });
});

describe('consumeDirty / peekDirty / clear 生命周期', () => {
  it('consumeDirty 返回后清空；再次 consume 为空', () => {
    const t = new DirtyRectTracker();
    t.setSize(128, 128);
    t.markRectDirty(0, 0, 128, 128);
    expect(t.consumeDirty().length).toBe(4);
    expect(t.hasDirty()).toBe(false);
    expect(t.consumeDirty()).toEqual([]);
  });

  it('peekDirty 只读不清空', () => {
    const t = new DirtyRectTracker();
    t.setSize(64, 64);
    t.markRectDirty(0, 0, 10, 10);
    expect(t.peekDirty().length).toBe(1);
    expect(t.hasDirty()).toBe(true);
    expect(t.dirtyCount).toBe(1);
    expect(t.peekDirty().length).toBe(1);
  });

  it('clear() 直接丢弃不消费', () => {
    const t = new DirtyRectTracker();
    t.setSize(64, 64);
    t.markRectDirty(0, 0, 10, 10);
    t.clear();
    expect(t.hasDirty()).toBe(false);
    expect(t.consumeDirty()).toEqual([]);
  });

  it('setSize 变更后，遗留脏瓦片的矩形按新尺寸重新裁剪', () => {
    const t = new DirtyRectTracker();
    t.markRectDirty(0, 0, 128, 64); // tiles (0,0),(1,0)
    t.setSize(64, 64); // 画布缩小到 1 瓦片
    const tiles = t.peekDirty();
    const m = new Map(tiles.map((x) => [`${x.tx},${x.ty}`, x]));
    expect(m.get('0,0')!.x1).toBe(64);
    expect(m.get('1,0')).toMatchObject({ x0: 64, x1: 64, y0: 0, y1: 64 }); // 完全在画布外 → 退化
  });

  it('消费后再标记 → 新一轮脏瓦片独立成立', () => {
    const t = new DirtyRectTracker();
    t.setSize(128, 64);
    t.markRectDirty(0, 0, 10, 10);
    expect(t.consumeDirty().length).toBe(1);
    t.markRectDirty(70, 0, 80, 10); // tile(1,0)
    expect(keysOf(t.consumeDirty())).toEqual(['1,0']);
  });
});
