/**
 * tests/history-core.test.ts —— history.ts 核心行为的单元回归（注入式 adapter，无 store 依赖）：
 * coalesce 窗口、大 diff 转 snapshot、HISTORY_LIMIT 淘汰、空操作保护、
 * undo/redo 往返、以及「diff 型记录按格标脏」的渲染接线（markCellsDirty 钩子）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  SNAPSHOT_THRESHOLD,
  createHistoryManager,
  type BoardEditArgs,
  type HistoryAdapter,
} from '@/store/history';
import type { EditEntry, ToolId } from '@/core/types';
import type { CellDiff } from '@/core/editOps';

/** 可控时钟 + 全量 Spy 的 mock adapter */
function makeAdapter() {
  let beads: Uint16Array = new Uint16Array(100); // 10×10
  let past: EditEntry[] = [];
  let future: EditEntry[] = [];
  const tool: ToolId = 'pen';
  const calls = {
    markCellsDirty: [] as Array<{ cells: ArrayLike<number>; cols: number }>,
    restoreBoard: [] as Array<{ cols: number; rows: number; beads: Uint16Array; placed: Uint8Array }>,
  };
  const adapter: HistoryAdapter = {
    getBeads: () => beads,
    mutateBeads: (fn) => fn(beads),
    getPast: () => past,
    getFuture: () => future,
    setHistory: (p, f) => {
      past = p;
      future = f;
    },
    getTool: () => tool,
    getBoardDims: () => ({ cols: 10, rows: 10 }),
    restoreBoard: (state) => {
      calls.restoreBoard.push(state);
      beads = state.beads;
    },
    markCellsDirty: (cells, cols) => {
      calls.markCellsDirty.push({ cells, cols });
    },
  };
  return {
    adapter,
    calls,
    setBeads: (b: Uint16Array) => (beads = b),
    getBeads: (): Uint16Array => beads,
    getPast: () => past,
    getFuture: () => future,
  };
}

/** 生成一段线性 diff：格 [start, start+count) 值 prev→next */
function linearDiff(start: number, count: number, prev = 0, next = 1): CellDiff[] {
  const cells: CellDiff[] = [];
  for (let k = 0; k < count; k++) cells.push({ i: start + k, prev, next });
  return cells;
}

describe('createHistoryManager：coalesce / snapshot / 限长 / 空操作', () => {
  beforeEach(() => {});

  it('400ms 内同工具同目标值合并为一条；换值或跨窗口另起一条', () => {
    const env = makeAdapter();
    const h = createHistoryManager(env.adapter);
    let now = 1000;
    h.__setNow(() => now);

    h.pushEdit({ label: '画笔', ts: now, cells: linearDiff(0, 2, 0, 5) }, { tool: 'pen', value: 5, ts: now });
    now += COALESCE_MS - 100; // 窗口内
    h.pushEdit({ label: '画笔', ts: now, cells: linearDiff(5, 2, 0, 5) }, { tool: 'pen', value: 5, ts: now });
    expect(env.getPast().length).toBe(1);
    expect(env.getPast()[0]!.cells!.length).toBe(4); // 合并 cells

    now += COALESCE_MS + 1; // 跨窗口
    h.pushEdit({ label: '画笔', ts: now, cells: linearDiff(10, 1, 0, 5) }, { tool: 'pen', value: 5, ts: now });
    expect(env.getPast().length).toBe(2);

    // 同窗口换目标值 → 另起一条
    h.pushEdit({ label: '画笔', ts: now, cells: linearDiff(11, 1, 0, 7) }, { tool: 'pen', value: 7, ts: now });
    expect(env.getPast().length).toBe(3);
  });

  it('空 diff 不入栈', () => {
    const env = makeAdapter();
    const h = createHistoryManager(env.adapter);
    expect(h.pushEdit({ label: '画笔', ts: 1, cells: [] })).toBe(false);
    expect(env.getPast().length).toBe(0);
    expect(h.canUndo()).toBe(false);
  });

  it(`diff 超 ${SNAPSHOT_THRESHOLD} 格转 snapshot；undo/redo 往返正确`, () => {
    const env = makeAdapter();
    const h = createHistoryManager(env.adapter);
    // 改前状态：格 [0, N) 值 3
    const before = new Uint16Array(100).fill(0);
    for (let i = 0; i < 100; i++) before[i] = 3;
    env.setBeads(before);

    const count = SNAPSHOT_THRESHOLD + 1; // 20001 > 100 格数组——用超数组长的 diff 触发转换
    const cells: CellDiff[] = [];
    for (let i = 0; i < Math.min(count, 100); i++) cells.push({ i, prev: 3, next: 9 });
    // 注：SNAPSHOT_THRESHOLD(20000) 远大于本 mock 板的 100 格；为验证「超限即转 snapshot」
    // 的分支本身，直接构造一条 cells 数超过阈值的记录（diff 与实际板解耦是 history 的既有契约）。
    for (let i = 100; i < count; i++) cells.push({ i, prev: 0, next: 9 });

    h.pushEdit({ label: '大填充', ts: 1, cells });
    const entry = env.getPast()[0]!;
    expect(entry.snapshot).toBeDefined(); // 已转快照
    expect(entry.cells).toBeUndefined();

    // mutate mock beads 到改后状态再 undo：应恢复为改前（全 3）
    env.setBeads(new Uint16Array(100).fill(9));
    expect(h.undo()).toBe(true);
    expect(env.getBeads().every((v) => v === 3)).toBe(true);

    // redo：WeakMap 旁挂的改后快照在同进程内可用
    expect(h.redo()).toBe(true);
    expect(env.getBeads().every((v) => v === 9)).toBe(true);
  });

  it(`超过 ${HISTORY_LIMIT} 条从最旧端淘汰`, () => {
    const env = makeAdapter();
    const h = createHistoryManager(env.adapter);
    let now = 0;
    for (let k = 0; k < HISTORY_LIMIT + 5; k++) {
      now += COALESCE_MS + 1; // 每条都不合并
      h.pushEdit({ label: `op${k}`, ts: now, cells: linearDiff(k % 100, 1, 0, 1) }, { tool: 'pen', value: 1, ts: now });
    }
    expect(env.getPast().length).toBe(HISTORY_LIMIT);
    expect(h.stats().droppedOldest).toBe(5);
    expect(env.getPast()[0]!.label).toBe('op5'); // 最旧的 5 条被丢
  });

  it('事务：一次 begin→add→commit 只落一条；空事务不入栈', () => {
    const env = makeAdapter();
    const h = createHistoryManager(env.adapter);
    h.beginTransaction('画笔', 'pen', 4);
    h.addTransactionCells(linearDiff(0, 2, 0, 4));
    h.addTransactionCells(linearDiff(2, 3, 0, 4)); // 同一笔画多帧
    expect(h.commitTransaction()).toBe(true);
    expect(env.getPast().length).toBe(1);
    expect(env.getPast()[0]!.cells!.length).toBe(5);

    h.beginTransaction('画笔', 'pen', 4);
    expect(h.commitTransaction()).toBe(false); // 空事务
    expect(env.getPast().length).toBe(1);
  });
});

describe('createHistoryManager：markCellsDirty 渲染接线', () => {
  it('pushEdit / undo / redo 的 diff 型记录都会按格标脏', () => {
    const env = makeAdapter();
    const h = createHistoryManager(env.adapter);
    h.pushEdit({ label: '画笔', ts: 1, cells: linearDiff(3, 2, 0, 5) }, { tool: 'pen', value: 5, ts: 1 });
    // pushEdit 标脏：incoming diff 的索引
    expect(env.calls.markCellsDirty.length).toBe(1);
    expect(Array.from(env.calls.markCellsDirty[0]!.cells)).toEqual([3, 4]);
    expect(env.calls.markCellsDirty[0]!.cols).toBe(10);

    // 模拟 beads 已处于改后状态，undo 恢复 → 再次标脏
    expect(h.undo()).toBe(true);
    expect(env.calls.markCellsDirty.length).toBe(2);
    expect(Array.from(env.calls.markCellsDirty[1]!.cells)).toEqual([3, 4]);

    expect(h.redo()).toBe(true);
    expect(env.calls.markCellsDirty.length).toBe(3);
  });

  it('snapshot 型 / 扩板型记录跳过按格标脏（回落全量重绘）', () => {
    const env = makeAdapter();
    const h = createHistoryManager(env.adapter);

    // snapshot 型 pushEdit
    const big: CellDiff[] = [];
    for (let i = 0; i < SNAPSHOT_THRESHOLD + 1; i++) big.push({ i: i % 100, prev: 0, next: 1 });
    h.pushEdit({ label: '大改', ts: 1, cells: big });
    expect(env.calls.markCellsDirty.length).toBe(0); // 超阈值不标脏
    h.undo();
    expect(env.calls.markCellsDirty.length).toBe(0); // snapshot 型 undo 不标脏

    // 扩板型 pushBoardEdit → undo/redo 走 restoreBoard，不标脏
    const args: BoardEditArgs = {
      label: '扩板',
      ts: 1,
      before: { cols: 10, rows: 10 },
      after: { cols: 12, rows: 12 },
      beadsBefore: new Uint16Array(100),
      beadsAfter: new Uint16Array(144),
      placedBefore: new Uint8Array(100),
      placedAfter: new Uint8Array(144),
    };
    expect(h.pushBoardEdit(args)).toBe(true);
    expect(h.undo()).toBe(true);
    expect(h.redo()).toBe(true);
    expect(env.calls.markCellsDirty.length).toBe(0);
    expect(env.calls.restoreBoard.length).toBe(2); // undo 一次 + redo 一次
  });
});
