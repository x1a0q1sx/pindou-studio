/**
 * src/store/selectors.ts —— 统计与派生选择器（统计的数据源）。
 *
 * ══════════════════════ 【职责边界与铁律】 ══════════════════════
 * · 纯函数、**无副作用**：只读 state，绝不写 store、绝不动 typed array。
 * · 依赖面**仅** `@/core/types`（type-only）、`@/core/region`（blockSizes，容量优先分块）
 *   与 `@/store/index`（`usePdbStore` + `PdbState` 类型）。
 *   → 分区矩形派生与 core/region.ts 共用同一 `blockSizes` 实现，保证口径一致。
 * · **绝不模块级缓存 typed array 引用**：`setBoardConfig`/`applyBoardPreset`/`replaceBeads`
 *   会整体换掉 `beads`/`placedMask` 引用。缓存只存**派生结果**，且 key 里带 `beadsVersion`
 *   与 `cols×rows`，一旦数据或尺寸变化立刻失效重算。
 * · `beads[i]` = 调色板索引+1（0 = 空格）；`placedMask[i]` = 1 表示已物理放置。
 *   `placedMask` 的变更同样会 bump `beadsVersion`（走 `mutatePlaced`），故缓存 key 天然覆盖。
 * ══════════════════════════════════════════════════════════
 *
 * 【记忆化策略（「切换筛选时一次性重建，不做每帧重建」）】
 * 这些函数会被 React 组件在渲染期高频调用，因此对**昂贵且返回新引用**的结果做基于版本号的记忆化：
 *   复合 key = `beadsVersion | cols×rows | paletteId | colors.length | <额外维度>`
 * - `beadsVersion`：`mutateBeads` / `mutatePlaced` / `replaceBeads` / `setBoardConfig` 都会 +1 → 覆盖内容与尺寸变化；
 * - `paletteId + colors.length`：色板增删改（`addColor`/`updateColor`/`removeColor`/`setPaletteId`）
 *   **不 bump beadsVersion**，必须靠这两个维度兜住，否则用量列表会显示旧色号；
 * - 额外维度：分区矩形串 / `filterColorIndex` / `cellValue`。
 * **命中即返回同一引用**（单测用 `===` 断言），因此可以安全地作为 `useEffect` 依赖。
 *
 * ⚠ **React 使用注意**：未命中缓存时会返回**新数组/新对象**。凡返回值直接进 `useEffect` 依赖
 *   或作为 props 下传的地方，调用方必须用 `useMemo` 包裹，或用 zustand 的 `useShallow`：
 *   ```ts
 *   const usage = usePdbStore(useShallow((s) => selectColorUsage(s)));   // ✅ 浅比较，不会死循环
 *   const usageBad = usePdbStore((s) => selectColorUsage(s));            // ❌ 每次新数组 → 无限重渲染
 *   ```
 *   缓存命中时引用稳定，但**首帧/失效帧**仍是新引用，故上述纪律不可省。
 */
import type { BeadColor, BeadPalette } from '@/core/types';
import { blockSizes } from '@/core/region';
import { usePdbStore, type PdbState } from '@/store/index';

/* ------------------------------------------------------------------ 类型 */

/**
 * 选择器只读切片：任何满足该形状的对象都能传入（含 `usePdbStore.getState()`）。
 * 用 `Pick` 而非自定义结构，保证与 store 契约永不漂移。
 */
export type SelectorState = Pick<
  PdbState,
  | 'beads'
  | 'placedMask'
  | 'beadsVersion'
  | 'board'
  | 'palette'
  | 'paletteId'
  | 'region'
  | 'filterColorIndex'
  | 'filterMode'
  | 'activeColorIndex'
>;

/** 分区矩形（格子坐标域，半开区间 `[col0, col0+cols)` × `[row0, row0+rows)`） */
export interface RegionRect {
  col0: number;
  row0: number;
  cols: number;
  rows: number;
}

/** 分区矩形 + 身份信息（供 RegionNavigator / PlacementBar / MiniMap 使用） */
export interface RegionInfo extends RegionRect {
  /** 在**非退化块序列**中的下标（= store 的 `region.activeIndex`） */
  index: number;
  ix: number;
  iy: number;
  /** `A1 / A2 / B1 / B2 …` */
  label: string;
  /** 该区格数 = cols*rows */
  total: number;
}

/** 单个调色板颜色的用量统计（需求6 `ColorProgressList` 的数据源） */
export interface ColorUsage {
  /** 调色板索引（**非** +1 编码） */
  index: number;
  color: BeadColor;
  /** 图案中该色总格数 */
  total: number;
  /** 其中已物理放置（`placedMask===1`）的格数 */
  placed: number;
  /** 待拼颗数 = `total - placed` */
  remaining: number;
  /** 已放置占比 = `placed/total`（0..1，`total===0` 时为 0），供进度环 `stroke-dasharray` 用 */
  ratio: number;
}

/** 整体进度（需求6 顶部进度条 + 状态栏） */
export interface ProgressInfo {
  /** 板总格数 = cols*rows */
  totalCells: number;
  /** 已填色格数（`beads[i] !== 0`） */
  filledCells: number;
  /** 空格数 = `totalCells - filledCells` */
  emptyCells: number;
  /**
   * 已放置颗数 = `beads[i] !== 0 && placedMask[i] === 1`。
   * 注：`placedMask` 若被异常标记在空格上（数据脏），**不计入**此值 —— 这样
   * `placedCells` 与 `percentPlaced`、`remainingCells` 三者恒自洽。
   */
  placedCells: number;
  /** 待拼颗数 = `filledCells - placedCells` */
  remainingCells: number;
  /** 图案用到的不同颜色数（非零 value 去重） */
  distinctColors: number;
  /** 填色率 = `filledCells/totalCells`（0..1） */
  percentFilled: number;
  /** 拼豆完成率 = `placedCells/filledCells`（0..1，`filledCells===0` 时为 0） */
  percentPlaced: number;
}

/** `sortColorUsage` 支持的排序维度 */
export type UsageSortKey = 'remaining' | 'total' | 'placed' | 'code';

/* ------------------------------------------------------------------ 分区派生（同构复刻，禁止 import core/region.ts） */

/**
 * 分区约定常量。**canonical 源是 `src/core/region.ts:buildRegions()`**（他人所有，本文件禁止 import），
 * 这里为并发隔离做同构复刻；把约定写成常量便于后续任何一侧改动时逐条核对同步：
 * - 行优先：`index = iy * splitsX + ix`
 * - 区块尺寸：`regionCols = ceil(boardCols / splitsX)`、`regionRows = ceil(boardRows / splitsY)`
 * - 退化块（`cols<=0 || rows<=0`）**跳过** → `activeIndex` 是「非退化块序列」的下标
 * - 标签：列字母 + 行号（`A1 A2 B1 B2 …`，`ix>=26` 用双字母）
 */
export const REGION_CONVENTION = {
  canonicalSource: 'src/core/region.ts:buildRegions()',
  indexOrder: 'row-major: index = iy * splitsX + ix',
  regionCols: 'Math.ceil(boardCols / splitsX)',
  regionRows: 'Math.ceil(boardRows / splitsY)',
  degenerateBlocks: 'skipped (cols<=0 || rows<=0)',
  label: 'column letter + (iy+1), e.g. A1 A2 B1 B2',
} as const;

export function regionLabelOf(ix: number, iy: number): string {
  let letter: string;
  if (ix < 26) {
    letter = String.fromCharCode(65 + ix);
  } else {
    letter = String.fromCharCode(65 + Math.floor(ix / 26) - 1) + String.fromCharCode(65 + (ix % 26));
  }
  return `${letter}${iy + 1}`;
}

/* ------------------------------------------------------------------ 缓存基础设施 */

interface CacheSlot<T> {
  key: string;
  value: T;
}

/** 读多槽缓存（LRU 简化版：命中即视为最新） */
function readCache<T>(slots: CacheSlot<T>[], key: string): T | undefined {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].key === key) return slots[i].value;
  }
  return undefined;
}

/** 写多槽缓存：新条目插到队首，超出 max 丢弃最久未写入的 */
function writeCache<T>(slots: CacheSlot<T>[], key: string, value: T, max: number): void {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].key === key) {
      slots[i].value = value;
      return;
    }
  }
  slots.unshift({ key, value });
  if (slots.length > max) slots.length = max;
}

const usageCache: CacheSlot<ColorUsage[]>[] = [];
const progressCache: CacheSlot<ProgressInfo>[] = [];
const cellsCache: CacheSlot<number[]>[] = [];
const regionCache: CacheSlot<RegionInfo[]>[] = [];
/** filterSet 单槽缓存：值可能是 `null`（合法结果），故不能复用 `readCache` 的 undefined 语义 */
let filterCache: { key: string; value: Uint8Array | null } | null = null;

/** palette 对象身份 token：`updateColor` 会新建 palette 对象，必须让缓存失效 */
const paletteTokens = new WeakMap<object, number>();
let nextPaletteToken = 1;

function paletteToken(palette: BeadPalette): number {
  let token = paletteTokens.get(palette);
  if (token === undefined) {
    token = nextPaletteToken++;
    paletteTokens.set(palette, token);
  }
  return token;
}

/**
 * 手动清空全部派生缓存。
 * 正常流程**不需要调用**（key 含 `beadsVersion` 会自动失效）；留给单测与「外部直接替换 typed array
 * 却没 bump 版本」的异常兜底。
 */
export function invalidateSelectorCaches(): void {
  usageCache.length = 0;
  progressCache.length = 0;
  cellsCache.length = 0;
  regionCache.length = 0;
  filterCache = null;
}

/** 缺省 state：每次调用现取，**绝不缓存**（见文件头铁律） */
function resolve(state?: SelectorState): SelectorState {
  return state ?? usePdbStore.getState();
}

/** 复合缓存 key 前缀：数据版本 + 板尺寸 + 色板身份 */
function baseKey(s: SelectorState): string {
  return `${s.beadsVersion}|${s.board.cols}x${s.board.rows}|${s.paletteId}|${s.palette.colors.length}|P${paletteToken(s.palette)}`;
}

/** 有效遍历长度（board 与 typed array 长度短暂不一致时取小，绝不越界） */
function dataLen(s: SelectorState): number {
  return Math.min(s.beads.length, s.board.cols * s.board.rows);
}

/* ------------------------------------------------------------------ 分区选择器 */

/**
 * 当前分区方案下的全部区块（非退化块，行优先）。
 * `splitsX<=1 && splitsY<=1` → 返回单块「整板」。
 */
export function selectRegionList(state?: SelectorState): RegionInfo[] {
  const s = resolve(state);
  const key = `${baseKey(s)}|R|${s.region.splitsX}x${s.region.splitsY}|${s.region.blockCols ?? '-'}x${s.region.blockRows ?? '-'}`;
  const hit = readCache(regionCache, key);
  if (hit) return hit;

  const boardCols = s.board.cols;
  const boardRows = s.board.rows;
  const splitsX = Math.max(1, Math.floor(s.region.splitsX) || 1);
  const splitsY = Math.max(1, Math.floor(s.region.splitsY) || 1);
  const out: RegionInfo[] = [];

  if (splitsX <= 1 && splitsY <= 1) {
    out.push({
      index: 0,
      ix: 0,
      iy: 0,
      label: regionLabelOf(0, 0),
      col0: 0,
      row0: 0,
      cols: boardCols,
      rows: boardRows,
      total: boardCols * boardRows,
    });
  } else {
    // ↓↓ 与 core/region.ts:blockSizes 同构：容量优先（首块尽量满、末块吃余量）+ 行优先 + 退化块剔除
    const colSizes = blockSizes(boardCols, splitsX, s.region.blockCols);
    const rowSizes = blockSizes(boardRows, splitsY, s.region.blockRows);
    let row0 = 0;
    for (let iy = 0; iy < rowSizes.length; iy++) {
      let col0 = 0;
      for (let ix = 0; ix < colSizes.length; ix++) {
        const cols = colSizes[ix];
        const rows = rowSizes[iy];
        if (cols > 0 && rows > 0) {
          out.push({
            index: out.length,
            ix,
            iy,
            label: regionLabelOf(ix, iy),
            col0,
            row0,
            cols,
            rows,
            total: cols * rows,
          });
        }
        col0 += cols;
      }
      row0 += rowSizes[iy];
    }
  }
  writeCache(regionCache, key, out, 4);
  return out;
}

/**
 * 当前活跃区块。`activeIndex` 越界时**夹到最后一块**（分区数变化后旧索引不至于返回 null 让 UI 崩）。
 * 恒返回有效对象，调用方无需判空。
 */
export function selectActiveRegion(state?: SelectorState): RegionInfo {
  const s = resolve(state);
  const list = selectRegionList(s);
  const idx = Math.min(Math.max(0, s.region.activeIndex | 0), Math.max(0, list.length - 1));
  return list[idx] ?? list[0];
}

/* ------------------------------------------------------------------ 颜色用量（需求6 核心） */

/**
 * 全板逐色用量：`{index, color, total, placed, remaining, ratio}`。
 * **只列出 `total > 0` 的颜色**（用量为 0 的色不进 `ColorProgressList`，符合需求4「本图用量」语义）。
 * 单次遍历 beads + placedMask，10816 格实测 < 1ms；结果按 `beadsVersion` 等复合 key 记忆化。
 * ⚠ 未命中缓存时返回新数组 → React 侧必须 `useMemo` / `useShallow`（见文件头）。
 */
export function selectColorUsage(state?: SelectorState): ColorUsage[] {
  const s = resolve(state);
  const key = `${baseKey(s)}|U`;
  const hit = readCache(usageCache, key);
  if (hit) return hit;
  const value = computeUsage(s, 0, 0, s.board.cols, s.board.rows);
  writeCache(usageCache, key, value, 4);
  return value;
}

/**
 * 限定在某个分区矩形内的逐色用量（拼豆是分块进行的，必须能按块统计）。
 * `region` 传 `RegionRect` 或 `RegionInfo` 均可（结构子集兼容）。
 * ⚠ 未命中缓存时返回新数组 → React 侧必须 `useMemo` / `useShallow`。
 */
export function selectColorUsageInRegion(state: SelectorState, region: RegionRect): ColorUsage[] {
  const s = resolve(state);
  const key = `${baseKey(s)}|U|${region.col0},${region.row0},${region.cols},${region.rows}`;
  const hit = readCache(usageCache, key);
  if (hit) return hit;
  const value = computeUsage(s, region.col0, region.row0, region.cols, region.rows);
  writeCache(usageCache, key, value, 4);
  return value;
}

/** 逐色用量内核：单次遍历指定矩形（矩形会被夹取到板内） */
function computeUsage(
  s: SelectorState,
  col0: number,
  row0: number,
  w: number,
  h: number,
): ColorUsage[] {
  const colors = s.palette.colors;
  if (colors.length === 0) return [];
  const beads = s.beads;
  const placed = s.placedMask;
  const boardCols = s.board.cols;
  const boardRows = s.board.rows;

  const cStart = Math.max(0, col0 | 0);
  const rStart = Math.max(0, row0 | 0);
  const cEnd = Math.min(boardCols, (col0 | 0) + (w | 0));
  const rEnd = Math.min(boardRows, (row0 | 0) + (h | 0));

  // 定长计数数组（下标 = value = 索引+1），比 Map 更快且无哈希开销
  const totals = new Int32Array(colors.length + 1);
  const placedCounts = new Int32Array(colors.length + 1);

  for (let r = rStart; r < rEnd; r++) {
    const base = r * boardCols;
    for (let c = cStart; c < cEnd; c++) {
      const i = base + c;
      if (i >= beads.length) break;
      const v = beads[i];
      if (v === 0 || v > colors.length) continue; // 空格 / 脏数据（越界色号）不计入任何色
      totals[v]++;
      if (i < placed.length && placed[i] === 1) placedCounts[v]++;
    }
  }

  const out: ColorUsage[] = [];
  for (let k = 1; k <= colors.length; k++) {
    const total = totals[k];
    if (total === 0) continue; // 只列用量 > 0 的色
    const placedN = placedCounts[k];
    out.push({
      index: k - 1,
      color: colors[k - 1],
      total,
      placed: placedN,
      remaining: total - placedN,
      ratio: total > 0 ? placedN / total : 0,
    });
  }
  return out;
}

/**
 * 用量列表排序（需求6：「可按剩余量排序」）。**恒返回新数组**，不修改入参。
 * - `remaining`（默认）/ `total` / `placed`：降序，并列时按调色板索引升序（结果确定、可复现）
 * - `code`：按色号字符串升序（`localeCompare` 数值感知，S9 < S10）
 */
export function sortColorUsage(usages: ColorUsage[], by: UsageSortKey = 'remaining'): ColorUsage[] {
  const out = usages.slice();
  if (by === 'code') {
    out.sort((a, b) => a.color.code.localeCompare(b.color.code, undefined, { numeric: true }));
    return out;
  }
  out.sort((a, b) => (b[by] - a[by]) || (a.index - b.index));
  return out;
}

/** 便捷：直接得到「按剩余量降序」的用量列表（`ColorProgressList` 默认视图） */
export function selectColorUsageSortedByRemaining(state?: SelectorState): ColorUsage[] {
  return sortColorUsage(selectColorUsage(resolve(state)), 'remaining');
}

/* ------------------------------------------------------------------ 筛选掩码（需求6 L2 层数据源） */

/**
 * 构造渲染层需要的按色筛选掩码。
 * - `filterMode === 'off'` 或 `filterColorIndex` 无效（<0 或越界）→ **`null`**（不筛选）
 * - 否则 → `Uint8Array(cols*rows)`，`1` = 该格属于当前筛选色（`beads[i] === filterColorIndex+1`）
 *
 * **掩码只表达「是否目标色」，与 `only` / `dim` / `hide` 无关**：三档模式的差异（极淡轮廓 /
 * 压暗 65% / 完全隐藏）由渲染层按 `filterMode` 决定，同一份掩码即可服务三档 →
 * 切换 only↔dim↔hide **不会**触发掩码重建（key 里不含 filterMode），符合设计约定
 * 「切换筛选时一次性重建，不做每帧重建」。
 *
 * 记忆化：**命中返回同一引用**（单测以 `===` 断言）；仅当 `beadsVersion` / `filterColorIndex` /
 * 板尺寸 / 色板变化时重算。10816 字节常驻，可忽略。
 *
 * 备注：`render/renderer.ts` 目前在 L2 内联计算同等判据（`beads[i] === filterColorIndex+1`），
 * 后续可切换为本函数以复用缓存 —— 本模块不 import 渲染层，故无耦合风险。
 */
export function selectFilterSet(state?: SelectorState): Uint8Array | null {
  const s = resolve(state);
  const colors = s.palette.colors;
  const ci = s.filterColorIndex;
  const off = s.filterMode === 'off' || ci < 0 || ci >= colors.length;
  const key = `${baseKey(s)}|F|${off ? 'off' : ci}`;

  if (filterCache && filterCache.key === key) return filterCache.value; // 同引用命中

  if (off) {
    filterCache = { key, value: null };
    return null;
  }

  const n = dataLen(s);
  const mask = new Uint8Array(s.board.cols * s.board.rows);
  const target = ci + 1;
  const beads = s.beads;
  for (let i = 0; i < n; i++) {
    if (beads[i] === target) mask[i] = 1;
  }
  filterCache = { key, value: mask };
  return mask;
}

/* ------------------------------------------------------------------ 进度 */

/** 全板进度（8 个字段，语义见 `ProgressInfo` 注释）。记忆化，命中返回同一引用。 */
export function selectProgress(state?: SelectorState): ProgressInfo {
  const s = resolve(state);
  const key = `${baseKey(s)}|P`;
  const hit = readCache(progressCache, key);
  if (hit) return hit;
  const value = computeProgress(s, 0, 0, s.board.cols, s.board.rows);
  writeCache(progressCache, key, value, 4);
  return value;
}

/** 指定分区矩形内的进度（PlacementBar「本区剩余 216 颗」的数据源）。 */
export function selectProgressInRegion(state: SelectorState, region: RegionRect): ProgressInfo {
  const s = resolve(state);
  const key = `${baseKey(s)}|P|${region.col0},${region.row0},${region.cols},${region.rows}`;
  const hit = readCache(progressCache, key);
  if (hit) return hit;
  const value = computeProgress(s, region.col0, region.row0, region.cols, region.rows);
  writeCache(progressCache, key, value, 4);
  return value;
}

/** 便捷：当前活跃分区的进度（拼豆模式最常用） */
export function selectActiveRegionProgress(state?: SelectorState): ProgressInfo {
  const s = resolve(state);
  return selectProgressInRegion(s, selectActiveRegion(s));
}

function computeProgress(
  s: SelectorState,
  col0: number,
  row0: number,
  w: number,
  h: number,
): ProgressInfo {
  const beads = s.beads;
  const placed = s.placedMask;
  const boardCols = s.board.cols;
  const boardRows = s.board.rows;
  const cStart = Math.max(0, col0 | 0);
  const rStart = Math.max(0, row0 | 0);
  const cEnd = Math.min(boardCols, (col0 | 0) + (w | 0));
  const rEnd = Math.min(boardRows, (row0 | 0) + (h | 0));

  const totalCells = Math.max(0, cEnd - cStart) * Math.max(0, rEnd - rStart);
  let filledCells = 0;
  let placedCells = 0;
  const seen = new Set<number>();

  for (let r = rStart; r < rEnd; r++) {
    const base = r * boardCols;
    for (let c = cStart; c < cEnd; c++) {
      const i = base + c;
      if (i >= beads.length) break;
      const v = beads[i];
      if (v === 0) continue;
      filledCells++;
      seen.add(v);
      if (i < placed.length && placed[i] === 1) placedCells++;
    }
  }

  return {
    totalCells,
    filledCells,
    emptyCells: totalCells - filledCells,
    placedCells,
    remainingCells: filledCells - placedCells,
    distinctColors: seen.size,
    percentFilled: totalCells > 0 ? filledCells / totalCells : 0,
    percentPlaced: filledCells > 0 ? placedCells / filledCells : 0,
  };
}

/* ------------------------------------------------------------------ 「下一个待拼颜色」 */

/**
 * 建议下一个待拼颜色：**当前分区内** `remaining > 0` 且 `total` 最大者
 * （并列时取调色板索引小者，保证确定性）。供「跳到下一个待拼颜色」按钮使用。
 * 无候选（本区全部拼完 / 空板）→ `null`。
 *
 * 返回的是缓存用量数组里的**同一元素引用**（未命中缓存时该数组本身是新的），
 * 因此配合 `selectColorUsageInRegion` 的缓存纪律使用即可。
 */
export function selectNextPendingColor(state?: SelectorState): ColorUsage | null {
  const s = resolve(state);
  const region = selectActiveRegion(s);
  const usage = selectColorUsageInRegion(s, region);
  let best: ColorUsage | null = null;
  for (let i = 0; i < usage.length; i++) {
    const u = usage[i];
    if (u.remaining <= 0) continue;
    if (best === null || u.total > best.total || (u.total === best.total && u.index < best.index)) {
      best = u;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ 逐色格子索引（TXT 分色施工图 / 高亮） */

/** 无效查询共用的空数组常量：避免每次返回新 `[]` 破坏引用稳定性 */
const EMPTY_CELLS: number[] = [];

/**
 * 返回该颜色的全部格子索引（**升序**，线性扫描天然有序），供  的 TXT 分色施工图
 * 与画布高亮使用。
 * @param cellValue beads 编码值（= 调色板索引 **+ 1**）；`0` 或越界 → 返回空数组
 * ⚠ 未命中缓存时返回新数组 → React 侧必须 `useMemo` / `useShallow`。
 */
export function selectCellsOfColor(state: SelectorState, cellValue: number): number[] {
  const s = resolve(state);
  const v = cellValue | 0;
  if (v <= 0 || v > s.palette.colors.length) return EMPTY_CELLS;
  const key = `${baseKey(s)}|C|${v}`;
  const hit = readCache(cellsCache, key);
  if (hit) return hit;

  const beads = s.beads;
  const n = dataLen(s);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (beads[i] === v) out.push(i);
  }
  writeCache(cellsCache, key, out, 8);
  return out;
}

/** 便捷：按**调色板索引**（非 +1 编码）查询，内部自动 +1 */
export function selectCellsOfColorIndex(state: SelectorState, colorIndex: number): number[] {
  return selectCellsOfColor(state, (colorIndex | 0) + 1);
}

/* ------------------------------------------------------------------ 小工具 */

/** 当前选中颜色（`activeColorIndex` 对应），色板为空/越界 → `null`。与 store 的 `selectActiveColor` 等价，此处提供以自足本模块。 */
export function selectActiveColorSafe(state?: SelectorState): BeadColor | null {
  const s = resolve(state);
  return s.palette.colors[s.activeColorIndex] ?? null;
}

/** 当前选中颜色的用量条目（`ColorProgressList` 高亮当前行用）；未用到该色 → `null` */
export function selectActiveColorUsage(state?: SelectorState): ColorUsage | null {
  const s = resolve(state);
  const usage = selectColorUsage(s);
  for (let i = 0; i < usage.length; i++) {
    if (usage[i].index === s.activeColorIndex) return usage[i];
  }
  return null;
}
