/**
 * src/core/editOps.ts —— 图案编辑原语（纯 TypeScript，零 store 依赖）。
 *
 * ══════════════════════ 【调用约定 · 必读，误用会静默丢更新】 ══════════════════════
 * 1. 本模块所有「写入型」函数（setCell / applyLine / fillConnectedRegion /
 *    replaceAllOfColor / clearCells / clearAll / applyDiff）**原地修改传入的
 *    `beads`（或 `placed`）**，并**返回描述这次写入的稀疏 diff**
 *    （`CellDiff = { i, prev, next }`，prev = 写入前值，next = 写入后值）。
 *    「已应用」是这些函数的默认语义：**返回时数据已经改完了**，diff 只是副作用清单。
 *
 * 2. 本模块**不接触 store、不 bump beadsVersion**。是否让 zustand 感知（必须走
 *    `usePdbStore.getState().mutateBeads(b => { …调用本模块… })`）与是否把 diff
 *    压入撤销栈，完全由调用方决定。典型用法见 §末尾「对接示例」。
 *
 * 3. **越界一律静默跳过**：坐标越界的格子既不写入也不产生 diff 元素，不抛异常。
 *    这让「板尺寸被改小后重放旧历史索引」不会崩（history.ts 依赖此保证）。
 *
 * 4. **无变化的写入不产生 diff 元素**（`beads[i] === value` 时跳过）。因此
 *    「diff 为空」⇔「数据一个字节都没变」，history.ts 据此做空操作保护。
 *
 * 5. 值语义（与 store/index.ts 铁律一致）：`beads[i]` 存**调色板索引 + 1**，`0` = 空格。
 *    索引换算：`i = row*cols + col`、`row = (i/cols)|0`、`col = i % cols`。
 *
 * 6. `placedMask`（Uint8Array，1 = 已物理放置）是**独立数组，不进撤销栈、不可撤销**：
 *    契约类型 `EditEntry` 只有 `cells`/`snapshot` 两个载荷字段，均描述 beads，
 *    设计上只要求撤销图案编辑。因此 `markPlacedCells`/`markRegionPlaced`
 *    **只返回改变格数，不返回 diff**，调用方不要试图把它们塞进历史。
 *
 * 7. 性能：全部算法单次线性/近线性，10816 格（104×104）下 replaceAllOfColor 与
 *    countValue < 1ms、最坏 flood fill < 10ms；**flood fill 用显式栈，绝不递归**
 *    （递归 10816 层在 V8 默认栈上会 RangeError 爆栈）。
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * 本文件不 import 任何值模块（只 type-only import 契约类型），因此可被 esbuild 单独
 * 打成 node ESM 直接跑单测，也可被 Worker / 渲染层 / 导出层安全复用。
 */
import type { EditEntry } from '@/core/types';

/* ------------------------------------------------------------------ 类型 */

/**
 * 单格变更。**直接复用契约里的 `EditEntry['cells']` 元素形状**，绝不另立结构类型，
 * 保证 diff 可以零转换地塞进 `EditEntry.cells`（撤销栈）与项目文件。
 */
export type CellDiff = NonNullable<EditEntry['cells']>[number];

/** 一次写入产生的稀疏 diff 清单（可能为空数组 = 什么都没改）。 */
export type Diff = CellDiff[];

/** 格坐标（col = 列 = x 方向，row = 行 = y 方向，均 0 起）。 */
export interface CellPos {
  col: number;
  row: number;
}

/* ------------------------------------------------------------------ 边界工具 */

/** 线性索引 → 列行：`row = (i/cols)|0`、`col = i % cols`。cols<=0 时返回 (0,0) 防止除零。 */
export function cellCoords(i: number, cols: number): CellPos {
  if (cols <= 0) return { col: 0, row: 0 };
  return { col: i % cols, row: (i / cols) | 0 };
}

/** 格坐标是否在板内（半开区间 `[0, cols)` × `[0, rows)`）。 */
export function inBounds(col: number, row: number, cols: number, rows: number): boolean {
  return col >= 0 && row >= 0 && col < cols && row < rows;
}

/* ------------------------------------------------------------------ 几何插值 */

/**
 * Bresenham 直线（整数运算，无浮点累积误差），用于拖拽快速划过时补齐中间格子，避免断线。
 *
 * 正确性保证（单测逐条覆盖）：
 * - 起点与终点**必在结果中**（终点靠 `col===c1 && row===r1` 判定收尾后 push）；
 * - 结果**无重复格**（每轮循环至少在一个轴上前进 1）；
 * - 相邻两格恒 **8 连通**（`max(|Δcol|,|Δrow|) === 1`）；
 * - 长度 = `max(|Δcol|,|Δrow|) + 1`；
 * - 覆盖水平、垂直、45° 对角、缓斜率（dx>dy）、陡斜率（dy>dx）、单点（起终点相同）、
 *   以及起终点顺序颠倒（自然反向绘制，结果对称）七种情形。
 *
 * 入参会被 `|0` 截断为整数（渲染层传进来的可能是浮点格坐标）。
 */
export function bresenhamLine(c0: number, r0: number, c1: number, r1: number): CellPos[] {
  let col = c0 | 0;
  let row = r0 | 0;
  const endCol = c1 | 0;
  const endRow = r1 | 0;
  const out: CellPos[] = [];

  const dc = Math.abs(endCol - col);
  const dr = Math.abs(endRow - row);
  const sc = col < endCol ? 1 : -1; // 列步进方向
  const sr = row < endRow ? 1 : -1; // 行步进方向
  let err = dc - dr;

  for (;;) {
    out.push({ col, row });
    if (col === endCol && row === endRow) break;
    const e2 = err * 2;
    if (e2 > -dr) {
      err -= dr;
      col += sc;
    }
    if (e2 < dc) {
      err += dc;
      row += sr;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 写入型原语 */

/**
 * 写入单格。`value` 为「调色板索引 + 1」语义，`0` = 擦除。
 * @returns 长度 0（越界 / 值未变）或 1 的 diff。
 */
export function setCell(
  beads: Uint16Array,
  cols: number,
  rows: number,
  col: number,
  row: number,
  value: number,
): Diff {
  if (!inBounds(col, row, cols, rows)) return [];
  const i = row * cols + col;
  const prev = beads[i];
  if (prev === value) return []; // 无变化 → 不产生 diff（空 diff ⇔ 数据未变）
  beads[i] = value;
  return [{ i, prev, next: value }];
}

/**
 * 沿 Bresenham 直线批量写入（画笔/橡皮拖拽的核心原语）。
 * 内部复用 `bresenhamLine`，逐格写入并**汇总成一条 diff**。
 */
export function applyLine(
  beads: Uint16Array,
  cols: number,
  rows: number,
  from: CellPos,
  to: CellPos,
  value: number,
): Diff {
  const path = bresenhamLine(from.col, from.row, to.col, to.row);
  const diff: Diff = [];
  for (let k = 0; k < path.length; k++) {
    const col = path[k].col;
    const row = path[k].row;
    if (!inBounds(col, row, cols, rows)) continue;
    const i = row * cols + col;
    const prev = beads[i];
    if (prev === value) continue;
    beads[i] = value;
    diff.push({ i, prev, next: value });
  }
  return diff;
}

/**
 * 笔刷版 applyLine：沿 Bresenham 直线的每个格子盖章一个 **size×size** 的
 * 方形笔刷（以该格为中心，half = floor((size-1)/2) 向四周扩展）。size=1 时与 applyLine
 * 等价。段内用 Set 去重避免重复 diff；跨段的重复写因 prev===value 天然跳过， undo/redo
 * 由事务提交时的 mergeCells（保留最早 prev）保证正确。
 */
export function applyBrushLine(
  beads: Uint16Array,
  cols: number,
  rows: number,
  from: CellPos,
  to: CellPos,
  value: number,
  size: number,
): Diff {
  const path = bresenhamLine(from.col, from.row, to.col, to.row);
  const half = Math.max(0, Math.min(8, Math.floor((Math.max(1, size) - 1) / 2)));
  const diff: Diff = [];
  const seen = new Set<number>();
  for (let k = 0; k < path.length; k++) {
    const col = path[k].col;
    const row = path[k].row;
    if (!inBounds(col, row, cols, rows)) continue;
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const c = col + dx;
        const r = row + dy;
        if (!inBounds(c, r, cols, rows)) continue;
        const i = r * cols + c;
        if (seen.has(i)) continue;
        seen.add(i);
        const prev = beads[i];
        if (prev === value) continue;
        beads[i] = value;
        diff.push({ i, prev, next: value });
      }
    }
  }
  return diff;
}

/**
 * 连通同色区域填充（油漆桶），**4 连通 + 扫描线 + 显式栈**。
 *
 * 为什么是扫描线而不是逐格四邻域入栈：逐格法在整板同色时会产生 O(n) 量级的栈元素与
 * 重复判重开销；扫描线按「行游程」扩张，栈里只放游程种子，10816 格一次填满实测 < 10ms。
 *
 * **不需要 visited 数组**，依赖一个不变式：只有 `value !== source` 才会进入填充流程，
 * 于是任何被写入的格子立刻不再等于 `source`，天然不会被二次访问（这也是
 * `source === value` 必须提前返回的根本原因 —— 否则条件恒真 → 死循环 + 无限增长）。
 *
 * 正确覆盖：从空格(0)填充、填充到板边界、整板同色一次填满（10816 格，不爆栈）、
 * 被异色包围的封闭区域不外泄（4 连通不穿对角缝）、`value === source` 时零写入零 diff。
 */
export function fillConnectedRegion(
  beads: Uint16Array,
  cols: number,
  rows: number,
  col: number,
  row: number,
  value: number,
): Diff {
  if (!inBounds(col, row, cols, rows)) return [];
  const n = rows * cols;
  const start = row * cols + col;
  if (start >= n) return [];
  const source = beads[start];
  if (source === value) return []; // 目标色 == 原色：立即返回，一个字节都不写（杜绝死循环）

  const diff: Diff = [];
  /** 显式栈：存待扩展的「行游程种子」索引，绝不用递归（10816 层递归会爆 V8 默认栈） */
  const stack: number[] = [start];

  while (stack.length > 0) {
    const seed = stack.pop() as number;
    if (beads[seed] !== source) continue; // 该游程已被先前扫描覆盖

    const seedRow = (seed / cols) | 0;
    const rowBase = seedRow * cols;

    // 1) 从种子向左找到游程左端
    let left = seed - rowBase;
    while (left > 0 && beads[rowBase + left - 1] === source) left--;

    // 2) 从左端向右扫完整条游程，逐格写入并探测上/下行的新游程
    const hasUp = seedRow > 0;
    const hasDown = seedRow + 1 < rows;
    let upQueued = false;
    let downQueued = false;
    let c = left;
    while (c < cols && beads[rowBase + c] === source) {
      const i = rowBase + c;
      beads[i] = value;
      diff.push({ i, prev: source, next: value });

      if (hasUp) {
        const up = i - cols;
        if (beads[up] === source) {
          // 每段连续的可扩展列只入栈一次（游程合并，避免重复种子）
          if (!upQueued) {
            stack.push(up);
            upQueued = true;
          }
        } else {
          upQueued = false;
        }
      }
      if (hasDown) {
        const dn = i + cols;
        if (beads[dn] === source) {
          if (!downQueued) {
            stack.push(dn);
            downQueued = true;
          }
        } else {
          downQueued = false;
        }
      }
      c++;
    }
  }
  return diff;
}

/**
 * 全图同色替换：把所有 `fromValue` 的格子改成 `toValue`。
 * **单次线性扫描**（无正则、无多次遍历、无中间数组），10816 格实测 < 1ms。
 * `fromValue === toValue` → 空 diff 且零写入。
 */
export function replaceAllOfColor(
  beads: Uint16Array,
  cols: number,
  rows: number,
  fromValue: number,
  toValue: number,
): Diff {
  if (fromValue === toValue) return [];
  const n = Math.min(beads.length, rows * cols);
  const diff: Diff = [];
  for (let i = 0; i < n; i++) {
    if (beads[i] === fromValue) {
      beads[i] = toValue;
      diff.push({ i, prev: fromValue, next: toValue });
    }
  }
  return diff;
}

/**
 * 批量擦除指定格子（value = 0）。indices 允许重复、乱序、越界（越界/重复自动跳过）。
 * 接受 `ArrayLike<number>`（含 Int32Array / number[]）与任意可迭代对象。
 * `cols/rows` 用于边界校验（板尺寸变更后旧索引不会误伤新布局的数据）。
 */
export function clearCells(
  beads: Uint16Array,
  cols: number,
  rows: number,
  indices: ArrayLike<number> | Iterable<number>,
): Diff {
  return writeValueToIndices(beads, cols, rows, indices, 0);
}

/** 全板清空（新建/重置）。线性扫描，已为 0 的格不产生 diff 元素。 */
export function clearAll(beads: Uint16Array): Diff {
  const diff: Diff = [];
  for (let i = 0; i < beads.length; i++) {
    const prev = beads[i];
    if (prev === 0) continue;
    beads[i] = 0;
    diff.push({ i, prev, next: 0 });
  }
  return diff;
}

/** 批量把指定格子写成同一值（clearCells / 未来的「选区填色」共用内核）。 */
export function writeValueToIndices(
  beads: Uint16Array,
  cols: number,
  rows: number,
  indices: ArrayLike<number> | Iterable<number>,
  value: number,
): Diff {
  const n = Math.min(beads.length, rows * cols);
  const diff: Diff = [];
  const list = indices as Iterable<number>;
  if (typeof (list as Iterable<number>)[Symbol.iterator] === 'function') {
    for (const i of list) {
      if (!(i >= 0) || i >= n) continue; // 同时挡掉 NaN / 越界
      const prev = beads[i];
      if (prev === value) continue;
      beads[i] = value;
      diff.push({ i, prev, next: value });
    }
    return diff;
  }
  // ArrayLike 但不可迭代（极少数宿主对象）：按下标取
  const arr = indices as ArrayLike<number>;
  for (let k = 0; k < arr.length; k++) {
    const i = arr[k];
    if (!(i >= 0) || i >= n) continue;
    const prev = beads[i];
    if (prev === value) continue;
    beads[i] = value;
    diff.push({ i, prev, next: value });
  }
  return diff;
}

/* ------------------------------------------------------------------ 放置标记（不可撤销） */

/**
 * 标记/取消「已物理放置」。**placedMask 是独立的 Uint8Array，不进撤销栈**
 * （契约 `EditEntry` 只描述 beads；设计上未要求撤销放置标记）。
 * 调用方必须走 `mutatePlaced(p => markPlacedCells(p, …))` 以 bump beadsVersion。
 * @returns 实际发生改变的格子数（幂等写入不计）
 */
export function markPlacedCells(
  placed: Uint8Array,
  cols: number,
  rows: number,
  indices: ArrayLike<number> | Iterable<number>,
  on: boolean,
): number {
  const n = Math.min(placed.length, rows * cols);
  const target = on ? 1 : 0;
  let changed = 0;
  const list = indices as Iterable<number>;
  if (typeof (list as Iterable<number>)[Symbol.iterator] === 'function') {
    for (const i of list) {
      if (!(i >= 0) || i >= n) continue;
      if (placed[i] === target) continue;
      placed[i] = target;
      changed++;
    }
    return changed;
  }
  const arr = indices as ArrayLike<number>;
  for (let k = 0; k < arr.length; k++) {
    const i = arr[k];
    if (!(i >= 0) || i >= n) continue;
    if (placed[i] === target) continue;
    placed[i] = target;
    changed++;
  }
  return changed;
}

/**
 * 标记矩形区域为已放置/未放置（「本区全部标记完成」按钮用）。
 * 矩形超出板范围会被自动夹取（`col0+w` 可以大于 cols）。
 * **同样不进撤销栈**，理由见 `markPlacedCells`。
 * @returns 实际发生改变的格子数
 */
export function markRegionPlaced(
  placed: Uint8Array,
  cols: number,
  rows: number,
  col0: number,
  row0: number,
  w: number,
  h: number,
  on: boolean,
): number {
  const target = on ? 1 : 0;
  const cStart = Math.max(0, col0 | 0);
  const rStart = Math.max(0, row0 | 0);
  const cEnd = Math.min(cols, (col0 | 0) + (w | 0));
  const rEnd = Math.min(rows, (row0 | 0) + (h | 0));
  let changed = 0;
  for (let r = rStart; r < rEnd; r++) {
    const base = r * cols;
    for (let c = cStart; c < cEnd; c++) {
      const i = base + c;
      if (i >= placed.length) continue;
      if (placed[i] === target) continue;
      placed[i] = target;
      changed++;
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ 统计 */

/**
 * 快速计数槽位数。`beads[i]` = 调色板索引+1，而设计约束色板最多 250 色
 * → 正常值域 ≤ 251。4096 槽（仅 16KB）已留 16× 余量，又避开 65536 槽（256KB）
 * **首次触碰时的页面提交成本**（实测 ~0.56ms，会把单次调用从 0.05ms 括到 0.65ms）。
 * ≥ 4096 的值只可能是脏数据（或未来超大色板），走 `COUNT_SLOW` 稀疏 Map 兜底，
 * 仍会被完整统计出来（该场景正是本函数用于排查脏数据的用途）。
 */
const COUNT_SLOTS = 4096;
/**
 * 计数工作缓冲：用**定长数组直接下标计数**（O(1) 纯整数寻址），
 * 把每格 2 次 Map 哈希操作（get+set）降为 1 次数组自增。
 * 10816 格实测：旧 Map 实现 0.1778ms → 现 0.0533ms（JIT 预热后 50 次均值）。
 *
 * 模块级复用避免每次调用分配；返回前把触碰过的槽位复位为 0，保证缓冲恒以全零入口。
 * ⚠ 这**不是**「缓存 store 的 typed array 引用」（那条铁律针对 `beads`/`placedMask`），
 *   而是本模块私有的纯计算 scratch buffer，不持有任何外部数据。
 * ⚠ 非可重入：本模块所有函数都是同步无 await 的，不存在并发写入该缓冲的路径。
 */
const COUNT_BUF = new Int32Array(COUNT_SLOTS);
/** 本次调用触碰过的 value（按**首次出现顺序**，快/慢路径均入列），用于建表与复位缓冲 */
const COUNT_ORDER: number[] = [];
/** ≥ COUNT_SLOTS 的越界脏值计数兜底 */
const COUNT_SLOW = new Map<number, number>();

/**
 * 单次遍历统计每个 value 的用量（键包含 `0` = 空格数）。
 * 返回的 `Map` 键序 = 各 value 在 `beads` 中**首次出现的顺序**；天然覆盖
 * 「beads 里出现越界色号」的脏数据排查场景（越界值也会作为一个键被统计出来）。
 * 返回的 `Map` 是独立快照，后续调用不会篡改它。
 * 10816 格实测 < 0.1ms（含首次调用的缓冲预热）。
 */
export function countValues(beads: Uint16Array): Map<number, number> {
  const buf = COUNT_BUF;
  const order = COUNT_ORDER;
  const slow = COUNT_SLOW;
  order.length = 0;
  slow.clear();
  const n = beads.length;
  for (let i = 0; i < n; i++) {
    const v = beads[i];
    if (v < COUNT_SLOTS) {
      if (buf[v] === 0) order.push(v); // 首次出现 → 记入待建表清单
      buf[v] = buf[v] + 1;
    } else {
      const c = slow.get(v);
      if (c === undefined) {
        slow.set(v, 1);
        order.push(v); // 脏值同样按首次出现顺序入列，保证键序语义统一
      } else {
        slow.set(v, c + 1);
      }
    }
  }
  const map = new Map<number, number>();
  for (let k = 0; k < order.length; k++) {
    const v = order[k];
    if (v < COUNT_SLOTS) {
      const c = buf[v];
      map.set(v, c);
      buf[v] = 0; // 复位：保证下次调用入口全零
    } else {
      map.set(v, slow.get(v) as number);
    }
  }
  slow.clear();
  return map;
}

/* ------------------------------------------------------------------ diff 应用（history.ts 复用） */

/**
 * 把一条 diff 应用到 beads 上：`'undo'` 写回 `prev`（反向），`'redo'` 写入 `next`（正向）。
 * **不 bump beadsVersion** —— 调用方（history.ts）必须把它包在 `mutateBeads(fn)` 里。
 * 越界索引静默跳过（板尺寸被改小后重放旧历史不会崩）。
 * @returns 实际写入的格数
 */
export function applyDiff(beads: Uint16Array, cells: CellDiff[], dir: 'undo' | 'redo'): number {
  const n = beads.length;
  let written = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    const i = c.i;
    if (!(i >= 0) || i >= n) continue;
    beads[i] = dir === 'undo' ? c.prev : c.next;
    written++;
  }
  return written;
}

/**
 * 由「当前板 + diff 的 prev 值」重建**改动前**的整板快照。
 * 用途：history.ts 的「单条 cells > 20000 转 snapshot」分支 —— 契约 `EditEntry.snapshot`
 * 存的就是操作前的整份 `Uint16Array`，而调用方在超阈值时往往只算出了 diff，
 * 用本函数即可精确还原改前状态（合并型 entry 的 `prev` 恒为该格**最早**值，故结果精确）。
 * 成本：一次 21.6KB 拷贝 + O(cells)，远小于 20001 个 diff 对象的常驻内存。
 */
export function preStateFromDiff(beads: Uint16Array, cells: CellDiff[]): Uint16Array {
  const out = beads.slice();
  const n = out.length;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (!(c.i >= 0) || c.i >= n) continue;
    out[c.i] = c.prev;
  }
  return out;
}

/* ══════════════════════════ 对接示例（usePointerPaint 参考） ══════════════════════════
 *
 * import { usePdbStore } from '@/store/index';
 * import { applyLine, beginTransaction, addTransactionCells, commitTransaction } from '…';
 *
 * // pointerdown
 * const s = usePdbStore.getState();
 * beginTransaction('画笔', s.tool, s.activeColorIndex + 1);
 *
 * // pointermove（快速划过用 Bresenham 补齐，绝不断线）
 * usePdbStore.getState().mutateBeads((beads) => {          // ← 唯一合法写入口，内部 beadsVersion++
 *   const st = usePdbStore.getState();
 *   const diff = applyLine(beads, st.board.cols, st.board.rows, lastCell, curCell, value);
 *   addTransactionCells(diff);                              // 只累积，一次拖拽 = 一条历史
 * });
 *
 * // pointerup
 * commitTransaction();                                      // 组装 EditEntry → pushEdit → 入 past
 * ═════════════════════════════════════════════════════════════════════════════════════ */
