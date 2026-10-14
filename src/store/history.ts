/**
 * src/store/history.ts —— 命令式稀疏 diff 撤销/重做（逐条实现）。
 *
 * ══════════════════════ 【职责边界】 ══════════════════════
 * · 本模块**接管** `store/index.ts` 里留白的 `past` / `future`（其 TODO 注释点名的
 *   `pushHistory/undo/redo` 全部在此实现），但**不修改** store 文件本身：
 *   一律通过「读 `usePdbStore.getState()` + 调用现有 actions（mutateBeads / setHistory）」落地。
 * · 一切 beads 写回**必须**包在 `mutateBeads(fn)` 里（内部 `beadsVersion++`），
 *   否则渲染层（订阅 beadsVersion 的脏矩形重绘）收不到通知 → 撤销后画面不刷新。
 *   undo / redo 的整条记录**只在一次 `mutateBeads` 里写完**，即只 bump 一次版本、只重绘一次。
 * · **绝不模块级缓存 typed array 引用**：`setBoardConfig` / `applyBoardPreset` /
 *   `replaceBeads` 会整体换掉 `beads` 引用，缓存引用会写到废弃数组上。每次都 `getState()` 现取。
 * · `placedMask`（已物理放置标记）**不进撤销栈、不可撤销**：契约 `EditEntry` 只有
 *   `cells`/`snapshot` 两个载荷字段，均只描述 beads；设计上只要求撤销图案编辑。
 *   `editOps.markPlacedCells/markRegionPlaced` 因此只返回改变格数、不返回 diff。
 * · 依赖面**仅** `@/core/types`（type-only）、`@/store/index`、`@/core/editOps`（均为本轮无人并发改写的文件）。
 * ══════════════════════════════════════════════════════════
 *
 * 【四条硬规则（设计约定）】
 * 1. **笔画合并 coalesce**：`COALESCE_MS`(400ms) 内、**同一 tool**、**同一目标值**的连续操作
 *    合并为**一条** `EditEntry`（合并 cells、ts 取最新、label 保留首次）。跨 400ms 或换工具/换色必须另起一条。
 *    ⚠ 契约 `EditEntry` **没有 tool/value 字段**，而 `core/types.ts` 是全项目共享契约（另有 3 个 Agent
 *    并发依赖，不得改动）→ 判据保存在**本模块内部元数据** `tailMeta`（不进 store、不进 EditEntry）。
 *    `pushEdit(entry, meta?)` 的 `meta` 缺省时：tool 回退读 `state.tool`、value 回退推断为 diff 末元素 `next`。
 * 2. **历史上限 `HISTORY_LIMIT`(300) 条**：超出丢弃最旧一条（`stats().droppedOldest` 计数）。
 * 3. **大改动转 snapshot**：单条 `cells.length > SNAPSHOT_THRESHOLD`(20000) 时不存 diff，
 *    改存**操作前**的整份 `snapshot: Uint16Array`（由 `editOps.preStateFromDiff` 从 diff 精确还原），
 *    省内存（20001 个对象 vs 21.6KB 定长数组）并保证还原正确性。
 * 4. **空操作保护**：diff 为空（如 flood fill 目标色 == 原色）时**不产生任何历史记录**，
 *    否则会污染撤销栈让用户「按了 Ctrl+Z 什么都没发生」。
 *
 * 【内存保护策略（200 万格预算，务必读懂）】
 * past 中所有 diff 的累计格子数超过 `CELL_BUDGET`(2,000,000) 时，**从最旧端逐条丢弃**直到回到预算内，
 * 丢弃数累加到 `stats().droppedOldest`（可被状态栏/Toast 上报）。
 * 为什么是「丢弃」而不是「压缩合并」：把最旧的若干条 diff 合并成一条，需要知道「最旧那条之前」的
 * 整板状态，而我们只保存了每条的**改前增量**（snapshot 型才存整板改前态，且仅一条）。
 * 强行合并会破坏 undo 语义（还原到错误的中间态），因此这里选择牺牲**最远的撤销步数**，
 * 换取「剩余每一步撤销都绝对正确」——这也是主流图形编辑器（Photoshop/Krita）的通行做法。
 * 触发条件：diff 型单条上限 20000 格 → 预算约等于 100 条大笔画，正常创作极少触及；
 * 且始终**保留至少 1 条**，保证用户刚做的操作一定可撤销。
 *
 * 【snapshot 型记录的 redo 能力】
 * 契约 `EditEntry.snapshot` 只存「改前」整板，redo 需要「改后」整板。本模块用**模块内
 * `WeakMap<EditEntry, Uint16Array>` 旁挂**改后快照（在 `undo()` 时捕获当前板），
 * 既不改 `types.ts`、也不把它塞进 store（避免 21.6KB × N 的持久化负担）。
 * ⚠ WeakMap 内容在**页面刷新后丢失** → snapshot 型记录的 redo 能力在刷新后
 *   由 ** 的项目持久化（store/persistence.ts + io/project.ts）兜底**：刷新后 past/future
 *   本就重建为空，不存在「有 snapshot 却无 post」的悬挂状态；`redo()` 仍对该情形做了防御（返回 false）。
 */
import type { EditEntry, ToolId } from '@/core/types';
import { usePdbStore } from '@/store/index';
import { applyDiff, preStateFromDiff, type CellDiff } from '@/core/editOps';
import { getActiveRenderer } from '@/render/activeRenderer';

/* ------------------------------------------------------------------ 可调常量（导出便于测试与后续调参） */

/** 笔画合并窗口（毫秒）：窗口内同工具同目标值的连续操作合并为一条历史 */
export const COALESCE_MS = 400;
/** past 栈最大条数，超出丢弃最旧 */
export const HISTORY_LIMIT = 300;
/** 单条 cells 超过此格数 → 改存 snapshot（Uint16Array 整板改前态） */
export const SNAPSHOT_THRESHOLD = 20000;
/** past 中 diff 累计格数预算，超出从最旧端丢弃（策略见文件头注释） */
export const CELL_BUDGET = 2_000_000;
/**
 * 开放事务的最长存活时间（毫秒）= COALESCE_MS × 8 = 3.2s。
 * 兜底：指针卡死 / 宿主未派发 pointerup 时自动 commit 并重开事务，避免事务缓冲无限增长。
 */
export const TRANSACTION_TIMEOUT_MS = COALESCE_MS * 8;

/* ------------------------------------------------------------------ 类型 */

/** pushEdit 的可选元数据：补齐契约 EditEntry 缺失的 tool/value 判据（见文件头注释） */
export interface EditMeta {
  /** 产生这次编辑的工具；缺省读 `usePdbStore.getState().tool` */
  tool?: ToolId;
  /** 本次写入的目标值（索引+1，0=擦除）；缺省推断为 diff 末元素的 `next` */
  value?: number;
  /** 覆盖时间戳（默认取 `entry.ts || now()`），主要供单测注入 */
  ts?: number;
}

/** 状态栏 / Tooltip 用的结构化历史摘要 */
export interface UndoInfo {
  label: string;
  /** 该条影响的格子数（snapshot 型为整板格数） */
  cells: number;
  ts: number;
  isSnapshot: boolean;
}

/** 历史栈统计（供内存监控与调试面板） */
export interface HistoryStats {
  past: number;
  future: number;
  /** past 中累计的格子数（diff 型按 cells.length，snapshot 型按整板长度计一次） */
  totalCells: number;
  /** 因超出 HISTORY_LIMIT / CELL_BUDGET 而被丢弃的最旧条目总数 */
  droppedOldest: number;
  /** past 中 snapshot 型条目数 */
  snapshots: number;
}

/**
 * 可注入的 store 适配层。
 * 存在的意义：① 单测无需拉起真实 zustand 也能验证纯算法；② 未来若要给「多板文档」做独立历史，
 * 只需换 adapter，算法零改动。**默认实现 `createStoreAdapter()` 绑真实 store**。
 */
export interface HistoryAdapter {
  /** 现取当前 beads（**禁止**缓存返回值） */
  getBeads(): Uint16Array;
  /** 唯一合法写入口：内部必须保证 `beadsVersion++` */
  mutateBeads(fn: (beads: Uint16Array) => void): void;
  getPast(): EditEntry[];
  getFuture(): EditEntry[];
  setHistory(past: EditEntry[], future: EditEntry[]): void;
  /** 可选：coalesce 缺省 tool 的来源 */
  getTool?(): ToolId;
  /** 可选：读取当前板尺寸（扩板型 undo/redo 恢复尺寸用） */
  getBoardDims?(): { cols: number; rows: number };
  /** 可选：整板替换（尺寸 + beads + placedMask 一次性恢复，version++ 只 bump 一次）。
   *  扩板型记录（entry.board 存在）的 undo/redo 专用；实现必须直接 set 而不走
   *  setBoardConfig（那会重建空数组把 beads 丢掉）。 */
  restoreBoard?(state: { cols: number; rows: number; beads: Uint16Array; placed: Uint8Array }): void;
  /**
   * 可选：把 diff 涉及的格按格标脏（渲染器走脏瓦片局部重绘，避免全量重绘）。
   * 仅在「本次变更已通过 mutateBeads/restoreBoard 落地、beadsVersion 已 bump」之后调用
   * ——调用方（生产 adapter）内部读当前 beadsVersion 做快照，与 StageCanvas 的
   * beadsVersion effect 做竞态匹配。大 diff（> SNAPSHOT_THRESHOLD）由本模块自行跳过，
   * 回落全量重绘。单测 adapter 不实现即可（跳过标脏不影响正确性，只是多一次全量重绘）。
   */
  markCellsDirty?(cells: ArrayLike<number>, cols: number): void;
}

/** pushBoardEdit 的参数包（扩板型编辑：板尺寸 + 前后整板内容 + 前后 placedMask） */
export interface BoardEditArgs {
  label: string;
  ts: number;
  before: { cols: number; rows: number };
  after: { cols: number; rows: number };
  beadsBefore: Uint16Array;
  beadsAfter: Uint16Array;
  placedBefore: Uint8Array;
  placedAfter: Uint8Array;
}
/** 历史管理器完整接口（顶层便捷函数与 `history` 单例均按此暴露） */
export interface HistoryManager {
  /**
   * 压入一条编辑记录：清空 future、按规则 coalesce / 转 snapshot / 限长 / 限内存。
   * @returns 是否真的产生了历史记录（空 diff → `false`，且**不**污染撤销栈）
   */
  pushEdit(entry: EditEntry, meta?: EditMeta): boolean;
  /** 撤销一步（写回 typed array 并 bump beadsVersion）；无可撤销 → false */
  undo(): boolean;
  /** 重做一步；无可重做 → false */
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 供状态栏显示，例：`画笔 ×12`；past 为空 → null */
  peekLabel(): string | null;
  peekUndoInfo(): UndoInfo | null;
  peekRedoInfo(): UndoInfo | null;
  /** 一次 pointerdown→pointerup 期间开启事务，保证「一次拖拽 = 一条历史记录」 */
  beginTransaction(label: string, tool: ToolId, value?: number): void;
  /** 拖拽过程中累积 diff（只累积，不写历史；beads 的实时写入由调用方走 mutateBeads） */
  addTransactionCells(cells: CellDiff[]): void;
  /** 结束事务并落地为一条 EditEntry；@returns 是否产生历史记录 */
  commitTransaction(): boolean;
  /** 丢弃事务缓冲（**不回滚** beads —— 回滚请显式调 undo()） */
  cancelTransaction(): void;
  /** 扩板型编辑入队：板尺寸变化的整板替换型记录，undo/redo 会连同板尺寸与 placedMask 一并恢复 */
  pushBoardEdit(args: BoardEditArgs): boolean;
  isTransactionOpen(): boolean;
  /** 清空 past/future + 复位全部内部元数据 */
  clear(): void;
  stats(): HistoryStats;
  /** 【仅测试用】注入时钟，避免为验证 400ms 边界而真实 sleep */
  __setNow(fn: () => number): void;
  /** 【仅测试用】复位内部状态（tail 元数据 / 事务 / 丢弃计数 / 时钟） */
  __reset(): void;
}

/* ------------------------------------------------------------------ 默认 adapter（绑真实 store） */

/**
 * 构造绑定 `usePdbStore` 的 adapter。
 * 注意 `getBeads()` 每次都 `getState()` 现取 —— 见文件头「绝不缓存 typed array 引用」。
 */
export function createStoreAdapter(): HistoryAdapter {
  return {
    getBeads: () => usePdbStore.getState().beads,
    mutateBeads: (fn) => {
      usePdbStore.getState().mutateBeads((beads) => fn(beads));
    },
    getPast: () => usePdbStore.getState().past,
    getFuture: () => usePdbStore.getState().future,
    setHistory: (past, future) => {
      usePdbStore.getState().setHistory(past, future);
    },
    getTool: () => usePdbStore.getState().tool,
    getBoardDims: () => ({ cols: usePdbStore.getState().board.cols, rows: usePdbStore.getState().board.rows }),
    restoreBoard: (state) => {
      usePdbStore.setState({
        board: { ...usePdbStore.getState().board, cols: state.cols, rows: state.rows },
        beads: state.beads,
        placedMask: state.placed,
        beadsVersion: usePdbStore.getState().beadsVersion + 1,
      });
    },
    // 撤销/重做/pushEdit 的 diff 型记录按格标脏 → 渲染层走脏瓦片局部重绘而非全量。
    // 无活动渲染器（画布未挂载/dual 非悬停窗格）时 no-op：StageCanvas 的版本快照
    // 竞态守卫（#24）会自动回落 invalidateAll 全量重绘，正确性不受影响。
    markCellsDirty: (cells, cols) => {
      const renderer = getActiveRenderer();
      if (renderer) renderer.markCellsDirty(cells, cols);
    },
  };
}

/* ------------------------------------------------------------------ 模块内工具 */

/**
 * snapshot 型记录的「改后整板」旁挂表（见文件头注释：不改 types.ts、不进 store、刷新后丢失）。
 * 用 WeakMap：entry 从 past/future 双双移除后可被 GC 回收，不会内存泄漏。
 */
const postSnapshots = new WeakMap<EditEntry, Uint16Array>();

/**
 * 扩板型编辑（entry.board 存在）的旁挂数据：改后板尺寸 + 前后 placedMask。
 * beads 的前后值走既有 snapshot（前）与 postSnapshots（后）机制，不在此重复。
 * WeakMap 与 postSnapshots 同理：entry 离开历史后可被 GC，无泄漏。
 */
const boardAfter = new WeakMap<EditEntry, { cols: number; rows: number }>();
const placedBefore = new WeakMap<EditEntry, Uint8Array>();
const placedAfter = new WeakMap<EditEntry, Uint8Array>();

/**
 * 把整板快照写回 beads，兼容**长度不一致**（板尺寸在编辑后被改过的情形）：
 * - snapshot 比当前板长 → 只取前 `beads.length` 个（多余部分丢弃）；
 * - snapshot 比当前板短 → 先整板清零再写入（新增区域视为空板）。
 * 不用 `beads.set(snapshot)` 裸调，否则超长会抛 RangeError 让撤销直接失败。
 */
function restoreSnapshot(beads: Uint16Array, snapshot: Uint16Array): void {
  if (snapshot.length === beads.length) {
    beads.set(snapshot);
    return;
  }
  if (snapshot.length > beads.length) {
    beads.set(snapshot.subarray(0, beads.length));
    return;
  }
  beads.fill(0);
  beads.set(snapshot);
}

/** 一条记录影响的格子数（snapshot 型按整板长度计一次） */
function entryCellCount(entry: EditEntry): number {
  if (entry.cells) return entry.cells.length;
  if (entry.snapshot) return entry.snapshot.length;
  return 0;
}

/** entry 是否为空操作（既无 cells 也无 snapshot） */
function isEmptyEntry(entry: EditEntry): boolean {
  return (!entry.cells || entry.cells.length === 0) && !entry.snapshot;
}

function toInfo(entry: EditEntry): UndoInfo {
  return {
    label: entry.label,
    cells: entryCellCount(entry),
    ts: entry.ts,
    isSnapshot: !!entry.snapshot,
  };
}

/** 合并中的尾条目元数据（coalesce 判据；契约 EditEntry 里没有 tool/value 故存此处） */
interface TailMeta {
  entry: EditEntry;
  tool: ToolId;
  value: number;
  ts: number;
  /** cellIndex → 在 entry.cells 中的位置，用于同格重复写时 O(1) 定位合并 */
  indexMap: Map<number, number>;
}

/** 开放事务（一次 pointerdown→pointerup） */
interface Transaction {
  label: string;
  tool: ToolId;
  value: number;
  startedAt: number;
  cells: CellDiff[];
  indexMap: Map<number, number>;
}

/* ------------------------------------------------------------------ 工厂实现 */

/**
 * 创建一个历史管理器。纯逻辑 + 注入式 adapter，可脱离 zustand 单测；
 * 生产用 `history`（= `createHistoryManager(createStoreAdapter())`）。
 */
export function createHistoryManager(adapter: HistoryAdapter): HistoryManager {
  let nowFn: () => number = () => Date.now();
  let tailMeta: TailMeta | null = null;
  let tx: Transaction | null = null;
  let droppedOldest = 0;

  const now = (): number => nowFn();

  /**
   * 累积 cells 到缓冲区：同格重复写时**保留最早 prev、更新为最新 next**。
   * 这样一次笔画内反复涂同一格，undo 能回到笔画前、redo 能到笔画后的最终值。
   */
  function mergeCells(buffer: CellDiff[], indexMap: Map<number, number>, incoming: CellDiff[]): void {
    for (let k = 0; k < incoming.length; k++) {
      const c = incoming[k];
      const at = indexMap.get(c.i);
      if (at === undefined) {
        indexMap.set(c.i, buffer.length);
        buffer.push({ i: c.i, prev: c.prev, next: c.next });
      } else {
        buffer[at].next = c.next; // prev 保持最早值
      }
    }
  }

  /**
   * 超阈值转 snapshot：用 diff 的 prev 值把「改前整板」精确还原出来存进 entry，并丢掉 cells。
   * 必须在**数据已写入 beads 之后**调用（调用方先 mutateBeads 再 pushEdit）。
   */
  function maybeSnapshotify(entry: EditEntry): boolean {
    if (!entry.cells || entry.cells.length <= SNAPSHOT_THRESHOLD) return false;
    entry.snapshot = preStateFromDiff(adapter.getBeads(), entry.cells);
    entry.cells = undefined;
    return true;
  }

  /** 限长（300 条）+ 限内存（200 万格），均从最旧端丢弃 */
  function enforceLimits(past: EditEntry[]): void {
    while (past.length > HISTORY_LIMIT) {
      const dropped = past.shift();
      droppedOldest++;
      if (dropped && tailMeta && tailMeta.entry === dropped) tailMeta = null;
    }
    let total = 0;
    for (let i = 0; i < past.length; i++) total += entryCellCount(past[i]);
    // 保留至少 1 条：用户刚做的操作必须可撤销，否则体验比内存问题更糟
    while (total > CELL_BUDGET && past.length > 1) {
      const dropped = past.shift();
      droppedOldest++;
      if (dropped) {
        total -= entryCellCount(dropped);
        if (tailMeta && tailMeta.entry === dropped) tailMeta = null;
      }
    }
  }

  /**
   * diff 型变更落地后的按格标脏接线（局部重绘）：把 diff 索引交给渲染器标脏瓦片，
   * StageCanvas 的 beadsVersion effect 即可跳过 invalidateAll 走 drawL1Partial/drawL2Partial。
   * 超过 SNAPSHOT_THRESHOLD 的大 diff 跳过（万格级标脏本身开销可观，且这类记录本就会转
   * snapshot）→ 渲染层按「未按格标脏」回落全量重绘，正确性不受影响。
   * 必须在 mutateBeads（beadsVersion 已 bump）之后调用：markCellsDirty 内部快照当前版本，
   * 与 StageCanvas effect 收到的版本做 #24 竞态匹配。
   */
  function markDiffDirty(cells: CellDiff[] | undefined): void {
    if (!cells || cells.length === 0 || cells.length > SNAPSHOT_THRESHOLD) return;
    if (!adapter.markCellsDirty) return;
    const indices = new Array<number>(cells.length);
    for (let k = 0; k < cells.length; k++) indices[k] = cells[k]!.i;
    adapter.markCellsDirty(indices, adapter.getBoardDims?.().cols ?? 0);
  }

  /**
   * 扩板型编辑：板尺寸发生变化的编辑（如「包边自动扩板」）专用入队口。
 * 与普通 diff 记录的区别：尺寸变了 → 索引语义全变，diff/snapshot 复用都不安全，
 * 因此**整板替换**：undo 回到 before 尺寸 + 旧内容；redo 前进到 after 尺寸 + 新内容；
 * placedMask 一并前后恢复（内容迁移会搬动已放标记，不恢复会对不上位）。
   * @returns 是否入队成功
   */
  function pushBoardEdit(args: BoardEditArgs): boolean {
    if (tx) commitTransaction(); // 扩板是整板级操作：先落地未完成事务
    tailMeta = null;
    const entry: EditEntry = {
      label: args.label,
      ts: args.ts,
      snapshot: args.beadsBefore.slice(),
      board: { ...args.before },
    };
    postSnapshots.set(entry, args.beadsAfter.slice());
    boardAfter.set(entry, { ...args.after });
    placedBefore.set(entry, args.placedBefore.slice());
    placedAfter.set(entry, args.placedAfter.slice());
    const past = adapter.getPast().slice();
    past.push(entry);
    enforceLimits(past);
    adapter.setHistory(past, []); // 新编辑必然清空 future
    return true;
  }
  function pushEdit(entry: EditEntry, meta?: EditMeta): boolean {
    /* ---- 空操作保护：diff 为空绝不产生历史记录 ---- */
    if (isEmptyEntry(entry)) return false;

    /* ---- 事务开放时并入事务缓冲（一次拖拽 = 一条记录的语义要求） ---- */
    const open = tx;
    if (open) {
      if (entry.cells) mergeCells(open.cells, open.indexMap, entry.cells);
      return true;
    }

    const tool: ToolId = meta?.tool ?? adapter.getTool?.() ?? 'pen';
    const incoming = entry.cells ?? [];
    const value: number =
      meta?.value ?? (incoming.length > 0 ? incoming[incoming.length - 1].next : -1);
    const ts = meta?.ts ?? (entry.ts || now());

    const past = adapter.getPast().slice();
    const last = past.length > 0 ? past[past.length - 1] : null;
    const lastCells = last?.cells;

    /* ---- coalesce：400ms 内 + 同 tool + 同目标值 + 尾条目仍是 diff 型 ---- */
    const canCoalesce =
      tailMeta !== null &&
      last !== null &&
      lastCells !== undefined && // snapshot 型不再合并（改前整板已定型，继续合并语义不清）
      tailMeta.entry === last &&
      tool === tailMeta.tool &&
      value === tailMeta.value &&
      ts - tailMeta.ts >= 0 &&
      ts - tailMeta.ts <= COALESCE_MS;

    if (canCoalesce && tailMeta && last && lastCells && entry.cells) {
      mergeCells(lastCells, tailMeta.indexMap, entry.cells);
      tailMeta.ts = ts;
      /**
       * entry 做**浅拷贝替换**（让 past 内元素引用变化对订阅者可观察），
       * 但 cells 数组**故意原地追加**：拖拽时每帧复制上万元素的代价不可接受。
       * → 消费方不要对 `cells` 做引用相等性缓存，请读 `past.length` / `peekLabel()` / `stats()`。
       */
      const merged: EditEntry = { label: last.label, ts, cells: lastCells };
      past[past.length - 1] = merged;
      tailMeta.entry = merged;
      if (maybeSnapshotify(merged)) tailMeta = null; // 转快照后不再合并
      markDiffDirty(entry.cells); // 本次增量按格标脏（merged.cells 含历史增量，标 incoming 即可）
      enforceLimits(past);
      adapter.setHistory(past, []); // 新编辑必然清空 future
      return true;
    }

    /* ---- 另起一条 ---- */
    const fresh: EditEntry = {
      label: entry.label,
      ts,
      cells: entry.cells ? entry.cells.slice() : undefined,
      snapshot: entry.snapshot,
    };
    const snapshotified = maybeSnapshotify(fresh);
    past.push(fresh);
    markDiffDirty(fresh.cells); // 转快照后 cells 已被置空 → 自动跳过（全量重绘兜底）
    enforceLimits(past);
    adapter.setHistory(past, []);

    if (snapshotified) {
      tailMeta = null;
    } else {
      const indexMap = new Map<number, number>();
      const cells = fresh.cells;
      if (cells) {
        // 预填 indexMap：调用方传入的 cells 本身可能含重复格
        for (let i = 0; i < cells.length; i++) {
          const key = cells[i].i;
          if (!indexMap.has(key)) indexMap.set(key, i);
        }
      }
      tailMeta = { entry: fresh, tool, value, ts, indexMap };
    }
    return true;
  }

  function undo(): boolean {
    // 拖拽途中按 Ctrl+Z：先落地未完成的事务，避免笔画被吞
    if (tx) commitTransaction();
    tailMeta = null; // 撤销后不再与后续操作合并

    const past = adapter.getPast().slice();
    const entry = past.pop();
    if (!entry) return false;

    // 扩板型记录：整板（尺寸 + beads + placedMask）一次性恢复到编辑前
    if (entry.board && adapter.restoreBoard) {
      const beforePlaced = placedBefore.get(entry);
      if (!entry.snapshot || !beforePlaced) return false;
      adapter.restoreBoard({
        cols: entry.board.cols,
        rows: entry.board.rows,
        beads: entry.snapshot.slice(),
        placed: beforePlaced.slice(),
      });
      const future = adapter.getFuture().slice();
      future.push(entry);
      adapter.setHistory(past, future);
      return true;
    }

    const snap = entry.snapshot;
    const cells = entry.cells;
    // 整条记录的写回**只包在一次 mutateBeads 内** → beadsVersion 只 +1、渲染层只重绘一次
    adapter.mutateBeads((beads) => {
      if (snap) {
        postSnapshots.set(entry, beads.slice()); // 旁挂改后整板，供 redo 用
        restoreSnapshot(beads, snap);
      } else if (cells) {
        applyDiff(beads, cells, 'undo');
      }
    });
    // diff 型记录：只标脏被改的格（大 diff/快照走全量），渲染层据此局部重绘（见文件头 #24）
    if (!snap) markDiffDirty(cells);

    const future = adapter.getFuture().slice();
    future.push(entry);
    adapter.setHistory(past, future);
    return true;
  }

  function redo(): boolean {
    const future = adapter.getFuture().slice();
    const entry = future.pop();
    if (!entry) return false;

    // 扩板型记录：整板前进到编辑后（尺寸 + beads + placedMask）
    if (entry.board && adapter.restoreBoard) {
      const post = postSnapshots.get(entry);
      const afterDims = boardAfter.get(entry);
      const placedAfterMask = placedAfter.get(entry);
      if (!post || !afterDims || !placedAfterMask) {
        future.push(entry);
        return false;
      }
      adapter.restoreBoard({
        cols: afterDims.cols,
        rows: afterDims.rows,
        beads: post.slice(),
        placed: placedAfterMask.slice(),
      });
      tailMeta = null;
      const pastNow = adapter.getPast().slice();
      pastNow.push(entry);
      enforceLimits(pastNow);
      adapter.setHistory(pastNow, future);
      return true;
    }

    const snap = entry.snapshot;
    const cells = entry.cells;
    if (snap) {
      const post = postSnapshots.get(entry);
      if (!post) {
        // 理论上不可达：entry 只能经 undo() 进入 future，届时必已旁挂 post。
        // 唯一例外是宿主刷新后外部把 future 塞了回来 —— 由  持久化兜底（见文件头）。
        future.push(entry);
        return false;
      }
      adapter.mutateBeads((beads) => restoreSnapshot(beads, post));
    } else if (cells) {
      adapter.mutateBeads((beads) => {
        applyDiff(beads, cells, 'redo');
      });
      // 同 undo：diff 型前进只标脏改动格，触发局部重绘
      markDiffDirty(cells);
    } else {
      return false; // 空记录：不该出现，丢弃不搬移
    }

    tailMeta = null;
    const past = adapter.getPast().slice();
    past.push(entry);
    enforceLimits(past);
    adapter.setHistory(past, future);
    return true;
  }

  function canUndo(): boolean {
    return adapter.getPast().length > 0;
  }

  function canRedo(): boolean {
    return adapter.getFuture().length > 0;
  }

  function peekUndoInfo(): UndoInfo | null {
    const past = adapter.getPast();
    if (past.length === 0) return null;
    return toInfo(past[past.length - 1]);
  }

  function peekRedoInfo(): UndoInfo | null {
    const future = adapter.getFuture();
    if (future.length === 0) return null;
    return toInfo(future[future.length - 1]);
  }

  /** 状态栏文案：`画笔 ×12`（调用方自行加「撤销：」前缀） */
  function peekLabel(): string | null {
    const info = peekUndoInfo();
    if (!info) return null;
    return `${info.label} ×${info.cells}`;
  }

  function beginTransaction(label: string, tool: ToolId, value?: number): void {
    if (tx) commitTransaction(); // 上一个事务未收尾（宿主漏派 pointerup）→ 先落地
    tx = {
      label,
      tool,
      // 缺省 -1 = 「未知目标值」：此时与后续无 meta 的 pushEdit 不会 coalesce。
      // 建议调用方显式传 `activeColorIndex + 1`（擦除传 0）。
      value: value ?? -1,
      startedAt: now(),
      cells: [],
      indexMap: new Map<number, number>(),
    };
  }

  function addTransactionCells(cells: CellDiff[]): void {
    let t = tx;
    if (!t) return; // 无开放事务：调用方应先 beginTransaction（这里静默忽略，不抛异常）
    // 事务超时兜底：自动落地并按同参数重开，防止缓冲无限增长
    if (now() - t.startedAt > TRANSACTION_TIMEOUT_MS) {
      const { label, tool, value } = t;
      commitTransaction();
      beginTransaction(label, tool, value);
      t = tx;
      if (!t) return;
    }
    mergeCells(t.cells, t.indexMap, cells);
  }

  function commitTransaction(): boolean {
    const t = tx;
    tx = null;
    if (!t) return false;
    if (t.cells.length === 0) return false; // 空操作保护：拖了一圈没改任何格 → 不入栈
    const entry: EditEntry = { label: t.label, ts: now(), cells: t.cells };
    return pushEdit(entry, { tool: t.tool, value: t.value, ts: now() });
  }

  function cancelTransaction(): void {
    // 仅丢弃缓冲，**不回滚 beads**（拖拽期间的实时绘制是用户可见的既成事实）。
    // 需要回滚请显式调 undo()。
    tx = null;
  }

  function isTransactionOpen(): boolean {
    return tx !== null;
  }

  function clear(): void {
    tx = null;
    tailMeta = null;
    droppedOldest = 0;
    adapter.setHistory([], []);
  }

  function stats(): HistoryStats {
    const past = adapter.getPast();
    const future = adapter.getFuture();
    let totalCells = 0;
    let snapshots = 0;
    for (let i = 0; i < past.length; i++) {
      totalCells += entryCellCount(past[i]);
      if (past[i].snapshot) snapshots++;
    }
    return { past: past.length, future: future.length, totalCells, droppedOldest, snapshots };
  }

  return {
    pushEdit,
    undo,
    redo,
    canUndo,
    canRedo,
    peekLabel,
    peekUndoInfo,
    peekRedoInfo,
    beginTransaction,
    addTransactionCells,
    commitTransaction,
    cancelTransaction,
    pushBoardEdit,
    isTransactionOpen,
    clear,
    stats,
    __setNow(fn) {
      nowFn = fn;
    },
    __reset() {
      nowFn = () => Date.now();
      tailMeta = null;
      tx = null;
      droppedOldest = 0;
    },
  };
}

/* ------------------------------------------------------------------ 生产单例（绑真实 store） */

/** 绑定 `usePdbStore` 的全局历史管理器（usePointerPaint / useHotkeys 直接用顶层函数即可） */
export const history: HistoryManager = createHistoryManager(createStoreAdapter());

/* ------------------------------------------------------------------ 顶层便捷函数 */

/**
 * 压入一条编辑记录。**推荐调用序**：
 * `mutateBeads(b => { diff = setCell(b, …) })` → `pushEdit({ label:'画笔', ts:Date.now(), cells: diff }, { tool, value })`
 * @returns 是否真的入栈（空 diff → false）
 */
export function pushEdit(entry: EditEntry, meta?: EditMeta): boolean {
  return history.pushEdit(entry, meta);
}

/** 扩板型编辑入队（模块级便捷委托，与 pushEdit 同一套单例）。 */
export function pushBoardEdit(args: BoardEditArgs): boolean {
  return history.pushBoardEdit(args);
}

/**
 * `pushEdit` 的**别名**，行为完全一致。
 * 存在理由：`store/index.ts` 的 TODO 注释里点名的接口名是 `pushHistory`，
 * 而任务契约要求 `pushEdit`；两个名字都导出以消除  对接时的二义。
 * @deprecated 新代码请优先用 `pushEdit`
 */
export const pushHistory: typeof pushEdit = pushEdit;

/** 撤销一步（Ctrl+Z）；@returns 是否执行 */
export function undo(): boolean {
  return history.undo();
}

/** 重做一步（Ctrl+Shift+Z / Ctrl+Y）；@returns 是否执行 */
export function redo(): boolean {
  return history.redo();
}

/** 是否可撤销（供按钮 disabled 态） */
export function canUndo(): boolean {
  return history.canUndo();
}

/** 是否可重做（供按钮 disabled 态） */
export function canRedo(): boolean {
  return history.canRedo();
}

/** 状态栏文案：`画笔 ×12`；past 为空 → null */
export function peekLabel(): string | null {
  return history.peekLabel();
}

/**
 * 撤销栈栈顶详情（`{ label, cells, ts, isSnapshot }`）；past 为空 → null。
 * 供  的撤销按钮 tooltip、状态栏「撤销：填充 ×40000（快照）」使用。
 */
export function peekUndoInfo(): UndoInfo | null {
  return history.peekUndoInfo();
}

/** 重做栈栈顶详情；future 为空 → null（供 redo 按钮 tooltip） */
export function peekRedoInfo(): UndoInfo | null {
  return history.peekRedoInfo();
}

/** 开启一次拖拽事务（pointerdown） */
export function beginTransaction(label: string, tool: ToolId, value?: number): void {
  history.beginTransaction(label, tool, value);
}

/** 累积拖拽 diff（pointermove） */
export function addTransactionCells(cells: CellDiff[]): void {
  history.addTransactionCells(cells);
}

/** 结束拖拽事务（pointerup）→ 落地为一条历史 */
export function commitTransaction(): boolean {
  return history.commitTransaction();
}

/** 丢弃拖拽事务（Esc / 右键取消），不回滚已绘制内容 */
export function cancelTransaction(): void {
  history.cancelTransaction();
}

/** 当前是否有未收尾的拖拽事务 */
export function isTransactionOpen(): boolean {
  return history.isTransactionOpen();
}

/** 清空撤销栈（新建板 / 打开项目 / 像素化落图后调用，避免跨文档撤销） */
export function clearHistory(): void {
  history.clear();
}

/** 历史栈统计（past/future 条数、累计格数、丢弃数、snapshot 数） */
export function historyStats(): HistoryStats {
  return history.stats();
}

/** 【仅测试用】注入时钟 */
export function __setNow(fn: () => number): void {
  history.__setNow(fn);
}

/** 【仅测试用】复位历史模块内部状态（不动 store 的 past/future，请配合 clearHistory()） */
export function __reset(): void {
  history.__reset();
}
