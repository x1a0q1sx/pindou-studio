/**
 * tests/placementNav.test.ts —— 拼豆模式换色算法纯函数用例。
 * 覆盖：下一色（剩余量最多）/ 上一色 / 全拼完的边界 / 确认文案 / 用量查找。
 */
import { describe, expect, it } from 'vitest';
import {
  buildColorDonePrompt,
  findUsage,
  pickColorByDirection,
  pickNextColor,
  pickPrevColor,
  pickUpcoming,
  sortForPlacement,
  type NavColorUsage,
} from '@/core/placementNav';

/** 构造用量条目（省略字段按 0 补） */
function u(index: number, remaining: number, total = remaining, placed = total - remaining): NavColorUsage {
  return { index, total, placed, remaining };
}

describe('pickNextColor —— 剩余量最多优先', () => {
  it('挑剩余最多的色', () => {
    const usages = [u(0, 10), u(1, 37), u(2, 5)];
    expect(pickNextColor(usages, -1)).toBe(1);
  });

  it('跳过已拼完的色（remaining=0）', () => {
    const usages = [u(0, 0), u(1, 3)];
    expect(pickNextColor(usages, -1)).toBe(1);
  });

  it('并列剩余量时取索引小者（结果可复现）', () => {
    const usages = [u(5, 20), u(2, 20), u(9, 20)];
    expect(pickNextColor(usages, -1)).toBe(2);
  });

  it('不返回当前色（还有别的色待拼时）', () => {
    const usages = [u(0, 99), u(1, 5)];
    expect(pickNextColor(usages, 0)).toBe(1);
  });

  it('只剩当前色没拼完时仍返回它（避免「下一色」无响应）', () => {
    const usages = [u(0, 12), u(1, 0)];
    expect(pickNextColor(usages, 0)).toBe(0);
  });

  it('全部拼完 → null', () => {
    expect(pickNextColor([u(0, 0), u(1, 0)], 0)).toBeNull();
  });

  it('空列表 → null', () => {
    expect(pickNextColor([], 0)).toBeNull();
  });

  it('allowSelf=true 时当前色可被选中（即使它不是最多）', () => {
    const usages = [u(0, 5), u(1, 99)];
    expect(pickNextColor(usages, 0, { allowSelf: true })).toBe(1); // 仍是 1 最多
    expect(pickNextColor([u(0, 5)], 0, { allowSelf: true })).toBe(0);
  });
});

describe('pickPrevColor', () => {
  it('当前色不是最多时 → 返回最多者', () => {
    const usages = [u(0, 5), u(1, 30)];
    expect(pickPrevColor(usages, 0)).toBe(1);
  });

  it('当前色就是最多时 → 返回次多者（避免原地不动）', () => {
    const usages = [u(0, 30), u(1, 20), u(2, 10)];
    expect(pickPrevColor(usages, 0)).toBe(1);
  });

  it('只有一个色待拼 → 返回它自身', () => {
    const usages = [u(0, 7), u(1, 0)];
    expect(pickPrevColor(usages, 0)).toBe(0);
  });

  it('全部拼完 → null', () => {
    expect(pickPrevColor([u(0, 0)], 0)).toBeNull();
  });
});

describe('pickColorByDirection', () => {
  const usages = [u(0, 30), u(1, 20)];
  it('next 与 prev 分派到对应实现', () => {
    expect(pickColorByDirection(usages, 'next', 1)).toBe(0);
    expect(pickColorByDirection(usages, 'prev', 0)).toBe(1);
  });
  it('全拼完两个方向都返回 null', () => {
    const done = [u(0, 0)];
    expect(pickColorByDirection(done, 'next', 0)).toBeNull();
    expect(pickColorByDirection(done, 'prev', 0)).toBeNull();
  });
});

describe('buildColorDonePrompt', () => {
  it('包含色号与剩余颗数', () => {
    const p = buildColorDonePrompt('A3', 37);
    expect(p.title).toContain('A3');
    expect(p.body).toContain('37');
    expect(p.confirm).toContain('37');
  });

  it('带范围标签时正文含标签', () => {
    const p = buildColorDonePrompt('S10', 5, '区块 A2');
    expect(p.body).toContain('区块 A2');
    expect(p.body).toContain('S10');
  });

  it('无范围标签时正文不含「范围：」前缀', () => {
    expect(buildColorDonePrompt('A1', 3).body).not.toContain('范围：');
  });
});

describe('sortForPlacement / pickUpcoming —— 顶部色卡队列（点谁切谁）', () => {
  it('排序：剩余多在前；并列取 total 大者，再取索引小者', () => {
    const usages = [u(2, 10, 40), u(0, 10, 90), u(1, 30), u(3, 0, 12)];
    expect(sortForPlacement(usages, -1).map((x) => x.index)).toEqual([1, 0, 2, 3]);
  });

  it('pickUpcoming：排除当前色与已拼完色，按序取前 count 个', () => {
    const usages = [u(0, 12), u(1, 40), u(2, 7), u(3, 0)];
    expect(pickUpcoming(usages, 1, 2)).toEqual([0, 2]);
    expect(pickUpcoming(usages, -1, 3)).toEqual([1, 0, 2]);
  });

  it('pickUpcoming：只剩当前色待拼 → 空数组（色卡区隐藏，读数自己说话）', () => {
    expect(pickUpcoming([u(0, 9), u(1, 0)], 0, 2)).toEqual([]);
  });

  it('pickUpcoming：全拼完 → 空数组', () => {
    expect(pickUpcoming([u(0, 0), u(1, 0)], 0, 2)).toEqual([]);
  });

  it('队列顺序与热键 N 一致：upcoming[0] 就是 pickNextColor 的结果', () => {
    const usages = [u(0, 12), u(1, 40), u(2, 7)];
    const next = pickNextColor(usages, 1);
    expect(pickUpcoming(usages, 1, 1)[0]).toBe(next);
  });
});

describe('findUsage', () => {
  const usages = [u(0, 1), u(3, 2)];
  it('找到返回条目', () => {
    expect(findUsage(usages, 3)?.remaining).toBe(2);
  });
  it('找不到 / 负索引 → null', () => {
    expect(findUsage(usages, 9)).toBeNull();
    expect(findUsage(usages, -1)).toBeNull();
  });
});
