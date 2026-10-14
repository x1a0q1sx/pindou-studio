/**
 * store/index.ts —— zustand 根 store 全量形状（契约层）。
 *
 * 【核心约定 · typed array 与 zustand】
 *   beads(Uint16Array) / placedMask(Uint8Array) 的**内容**变更 zustand 感知不到（引用不变）。
 *   一切内容修改必须走 `mutateBeads(fn)` / `mutatePlaced(fn)`：它们原地改数组并配套 `beadsVersion++`，
 *   渲染器订阅 beadsVersion 做脏矩形重绘。**严禁**绕过它们直接写 typed array，
 *   也**严禁**为触发更新而复制整个大数组（104×104=21.6KB 尚可，200×200 就成了性能陷阱）。
 *
 * 【索引约定】i = row*cols + col；row = (i/cols)|0；col = i % cols。
 * 【取值约定】beads[i] 存调色板索引+1，0=空格；placedMask[i] 1=已物理放置。
 *
 * 历史（store/history.ts）接管 past/future 的读写：笔画 pushEdit / 扩板 pushBoardEdit /
 * 撤销栈清空 clearHistory 全部经 history 单例（内部还持有 tailMeta/事务等模块级元数据，
 * 直接 set({past,future}) 会漏掉它们——清栈必须走 clearHistory action）。
 * TODO: display/calibration 由 useDisplayInfo/CalibrationWizard 写入。
 */
import { create } from 'zustand';
import type {
  AppMode,
  BeadPalette,
  BoardConfig,
  Calibration,
  DisplayMetrics,
  EditEntry,
  FilterMode,
  LayoutId,
  ThemeId,
  Toast,
  ToastKind,
  ToolId,
  VbLightPattern,
} from '@/core/types';
import {
  BUILTIN_PALETTE_IDS,
  DEFAULT_PALETTE_ID,
  getPalette,
  hydrateColor,
  saveCustomPalette,
} from '@/palettes';
import type { BeadColorInput } from '@/palettes/types';
import { autoSuggestSplits, calibrationFromDisplay, fitsOnScreen, sanitizeCalibration } from '@/core/geometry';
import { mapPaletteColors } from '@/color/match';
import { clearHistory as clearHistoryStack, pushBoardEdit, pushEdit, SNAPSHOT_THRESHOLD } from '@/store/history';
import type { CellDiff } from '@/core/editOps';

/* ---------------- 默认值（契约：实测规格） ---------------- */

export const DEFAULT_BOARD: BoardConfig = {
  cols: 104,
  rows: 104,
  pitchMm: 2.6923,      // 2.6mm 迷你豆 104 钉板：280mm/104
  beadFillRatio: 0.90,
  marginMm: 2.0,
  cellShape: 'circle',
  showGrid: true,
  showMajorGrid: true,
  majorEvery: 10,
  showNumbers: true,
  numberEvery: 10,
  showRuler: true,
  emptyCheckerboard: true,
  showColorCodes: false,
  darkBeadEdge: true,
};

/** 默认加载真实的通用色板（hydrate 时统一补全每色的 rgb/lab）。 */
const INITIAL_PALETTE: BeadPalette = getPalette(DEFAULT_PALETTE_ID);

/* ---------------- store 形状 ---------------- */

export interface ViewportState {
  /** 设计视图缩放倍率；拼豆 1:1 模式由 渲染器强制锁 1.0 */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface RegionState {
  /** 横/纵切分数（块数） */
  splitsX: number;
  splitsY: number;
  activeIndex: number;
  /** 满块容量（用户反馈：第一块尽量占满一屏，余量给末块）。
   *  给定时前面每块 = 容量、末块 = 余量；缺省 = 均分。 */
  blockCols?: number;
  blockRows?: number;
  /** 分块是否「屏容量驱动」（换大屏自动合回、换小屏自动分块）：
   *  undefined/true = 自动方案，可被容量重估**双向**调整（含合并成单块）；
   *  false = 用户在进度面板手动定的分块（当分页用），重估时只增不减。 */
  autoSized?: boolean;
}

export interface PdbState {
  /* ---- 板与豆 ---- */
  board: BoardConfig;
  /** 调色板索引+1，0=空。内容变更只能走 mutateBeads */
  beads: Uint16Array;
  /** 1=已物理放置。内容变更只能走 mutatePlaced */
  placedMask: Uint8Array;
  /** typed array 变更计数器：每次内容修改 +1，渲染器据此重绘（zustand 感知不到内容变更） */
  beadsVersion: number;
  /** 已放总数（增量统计）：每次 beads/placed 变更入口重算一次，布局组件渲染期 O(1) 读取 */
  placedCount: number;
  /** 每色统计：total[i]=该色（编码 i=索引+1）格子数，placed[i]=该色已放数，下标 0 恒 0 */
  colorStats: { total: Int32Array; placed: Int32Array };

  /* ---- 调色板 ---- */
  paletteId: string;
  palette: BeadPalette;
  /** 当前选中颜色的调色板索引（非 +1 编码） */
  activeColorIndex: number;

  /* ---- 显示器与校准（由校准向导写入） ---- */
  display: DisplayMetrics | null;
  calibration: Calibration | null;

  /* ---- 模式与视图 ---- */
  mode: AppMode;
  view: ViewportState;
  region: RegionState;

  /* ---- 图 B 通道（双图同屏；B 独立板/豆/区块，编辑与绘制仍在 A） ---- */
  boardB: BoardConfig;
  beadsB: Uint16Array;
  placedB: Uint8Array;
  /** B 通道独立的变更计数（与 A 的 beadsVersion 互不触发） */
  beadsBVersion: number;
  regionB: RegionState;
  /** 双画布局部激活画布：远程指令/快捷键作用于该通道 */
  activePane: 'A' | 'B';

  /* ---- 按色筛选与进度 ---- */
  /** 被筛选颜色的调色板索引；-1 = 未选定 */
  filterColorIndex: number;
  filterMode: FilterMode;
  /** 手机点亮图案（虚拟板收到 PIXDOU 节目后解码；null=无。panel 档优先渲染它而非本地筛选色） */
  vbLight: VbLightPattern | null;
  /* ---- 虚拟板旁路状态（设计模式右下角小窗 VbMiniBoard 显示用；对话框 onEvent 写入） ---- */
  vbRunning: boolean;
  vbConnected: boolean;
  /** PIXDOU 节目下发进度文本（null=无进行中的下发） */
  vbProg: string | null;
  /** 设计模式「画布点亮」开关：把主画布临时切成 panel（发光板）档显示手机图案 */
  vbCanvasOn: boolean;
  /** 开画布点亮前的 filterMode 快照（关掉时还原）；null=panel 非本开关所设，还原时不改档 */
  vbFilterPrev: FilterMode | null;

  /* ---- 历史 ---- */
  past: EditEntry[];
  future: EditEntry[];

  /* ---- 外观 ---- */
  theme: ThemeId;
  layout: LayoutId;
  tool: ToolId;
  toasts: Toast[];

  /* ================= actions（名称即契约，后续任务按此调用） ================= */

  /** 合并板参数；cols/rows 变化时自动重建 typed array（内容清空，beadsVersion++） */
  setBoardConfig: (patch: Partial<BoardConfig>) => void;
  /**
   * 唯一合法的 beads 修改入口：原地改 + beadsVersion++。
   * fn 内可批量修改（一次拖拽笔画），只在结束时 bump 一次版本。
   */
  mutateBeads: (fn: (beads: Uint16Array, placed: Uint8Array) => void) => void;
  /** 唯一合法的 placedMask 修改入口（markPlaced 工具/Shift+点击，） */
  mutatePlaced: (fn: (placed: Uint8Array, beads: Uint16Array) => void) => void;
  /** 整板替换（像素化结果落地，Transferable 零拷贝接收后调用）；cols/rows 必须已是新值 */
  replaceBeads: (beads: Uint16Array, placed?: Uint8Array) => void;
  /**
   * 像素化落图 / 整板导入的统一落地入口（**可撤销**）：板尺寸不一致时先同步尺寸，
   * 然后整板替换 beads + 清零 placedMask，并把整次替换记为一条扩板型 BoardEdit ——
   * 落图后 Ctrl+Z 能完整回到导入前的板（尺寸 + 内容 + 已放标记）。
   * 旧实现（setBoardConfig + replaceBeads 裸调）会让旧撤销记录带着失效索引写进新数组，
   * 撤销出「鬼影」甚至数据错乱（缺陷：导入后撤销栈未接管）。
   * @returns false 表示 beads.length 与 cols*rows 不符（调用方数据 bug），已 toast 且未落地
   */
  applyImportedBeads: (beads: Uint16Array, dims: { cols: number; rows: number }, label?: string) => boolean;
  /**
   * 包边：沿图案非空格外接矩形加一圈 colorIndex 色豆。
   * 板内放得下 → 只画圈（可撤销）；放不下 → 自动扩板并居中迁移内容（同导入落地语义，不可撤销）。
   * 返回 null 表示没有内容可包边。
   */
  applyBorderRing: (colorIndex: number) => { expanded: boolean; cols: number; rows: number; cells: number } | null;

  setPalette: (id: string, palette: BeadPalette) => void;
  setActiveColorIndex: (i: number) => void;

  /* ---- 调色板编辑（改色后若影响 beads 索引，一律走 mutateBeads） ---- */
  /** 追加一个自定义色到色板末尾，并设为当前色（不影响既有 beads 索引） */
  addColor: (color: BeadColorInput) => void;
  /** 原地修改某色（改 hex 自动重算 rgb/lab；不改结构，beads 索引不变） */
  updateColor: (index: number, patch: Partial<BeadColorInput>) => void;
  /** 删除某色并重映射 beads 索引；replacementIndex=null 表示该色格子全部留空 */
  removeColor: (index: number, replacementIndex: number | null) => void;
  /** 全图把 fromIndex 的格子迁移到 toIndex（不改色板结构，仅改 beads） */
  replaceColorGlobal: (fromIndex: number, toIndex: number) => void;
  /** 按 id 切换色板（内置或自定义），自动夹回 activeColorIndex/filterColorIndex */
  setPaletteId: (id: string) => void;
  /** 把当前内置色板恢复为注册表里的原始版本（丢弃内存工作副本的临时编辑） */
  resetPaletteToBuiltin: () => void;

  setDisplay: (d: DisplayMetrics | null) => void;
  setCalibration: (c: Calibration | null) => void;

  /** 应用板预设（cols/rows/pitchMm/marginMm 一次性写入） */
  applyBoardPreset: (preset: Partial<BoardConfig>) => void;
  /** 根据当前 display + board 自动建议分区并写入 region */
  autoSuggestRegion: () => void;
  /** 按「当前屏 1:1 容量」重估分块——装得下把自动分块合回单块，
   *  装不下按最小方案分块；用户手动分块（autoSized=false）只增不减。幂等，可反复调。 */
  reconcileRegionWithDisplay: () => void;
  /** 重置校准为当前 display 的自动检测值 */
  resetCalibration: () => void;

  setMode: (m: AppMode) => void;
  setView: (patch: Partial<ViewportState>) => void;
  /** 双板并排布局（dual）的右画布视图；左画布用 view */
  viewB: ViewportState;
  setViewB: (patch: Partial<ViewportState>) => void;
  /** 笔刷大小：画笔/橡皮的方形笔刷边长，1–9，默认 1 */
  brushSize: number;
  setBrushSize: (size: number) => void;
  setRegion: (patch: Partial<RegionState>) => void;

  setFilter: (colorIndex: number, mode: FilterMode) => void;
  setFilterMode: (mode: FilterMode) => void;
  /** 写入/清除手机点亮图案（虚拟板节目收齐后调用；null=清除） */
  setVbLight: (p: VbLightPattern | null) => void;
  /** 虚拟板旁路状态上浮（对话框 onEvent → 设计模式小窗）；prog 传 null 清进度 */
  setVbStatus: (running: boolean, connected: boolean, prog: string | null) => void;
  /** 只更新下发进度文本（0x06/0x00 分片推进时高频调用） */
  setVbProg: (text: string | null) => void;
  /** 设计模式「画布点亮」开关：on 记快照并切 panel 档，off 还原快照 */
  setVbCanvasOn: (on: boolean) => void;

  /* ---- 图 B---- */
  /** 把当前图 A 整体拷贝到图 B（板参数 + 内容 + 已放标记 + 区块方案），双画布对照用 */
  copyAtoB: () => void;
  /** 整体写入 B 通道（手机投图直接进 B 等）；数组按引用存入，调用方须给新对象 */
  setPatternB: (board: BoardConfig, beads: Uint16Array, placed?: Uint8Array) => void;
  /** 清空 B 图案（保持 B 当前板尺寸） */
  clearPatternB: () => void;
  setRegionB: (patch: Partial<RegionState>) => void;
  setActivePane: (p: 'A' | 'B') => void;

  /** 临时入口：直接设历史栈（history.ts 提供 pushHistory/undo/redo） */
  setHistory: (past: EditEntry[], future: EditEntry[]) => void;
  clearHistory: () => void;

  setTheme: (t: ThemeId) => void;
  setLayout: (l: LayoutId) => void;
  setTool: (t: ToolId) => void;

  pushToast: (kind: ToastKind, message: string, duration?: number) => number;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

function makeArrays(board: BoardConfig): { beads: Uint16Array; placedMask: Uint8Array } {
  const n = board.cols * board.rows;
  return { beads: new Uint16Array(n), placedMask: new Uint8Array(n) };
}

/**
 * 全板重算已放总数与每色统计（O(n) 单次扫描，~1 万格 ≈ 数十 μs）。
 * 只在 beads/placed 的变更入口（mutateBeads/mutatePlaced/replaceBeads/导入/扩板/重建）调用，
 * 布局组件渲染期一律 O(1) 读 store 字段——原 SplitLayout/FocusLayout 各自渲染期全板扫描，
 * 拖拽笔画每帧双扫描。
 */
function computeStats(
  beads: Uint16Array,
  placed: Uint8Array,
  colorCount: number,
): { placedCount: number; colorStats: { total: Int32Array; placed: Int32Array } } {
  const total = new Int32Array(colorCount + 2);
  const placedBy = new Int32Array(colorCount + 2);
  let placedCount = 0;
  for (let i = 0; i < beads.length; i++) {
    const b = beads[i]!;
    if (b !== 0) total[b]!++;
    if (placed[i] === 1) {
      placedCount++;
      if (b !== 0) placedBy[b]!++;
    }
  }
  return { placedCount, colorStats: { total, placed: placedBy } };
}

const initialArrays = makeArrays(DEFAULT_BOARD);

/** 自定义色板（非内置 id）改动后持久化到 localStorage；内置色板只在内存工作副本生效，绝不写盘。 */
function persistIfCustom(palette: BeadPalette): void {
  if (!BUILTIN_PALETTE_IDS.includes(palette.id)) saveCustomPalette(palette);
}

export const usePdbStore = create<PdbState>()((set, get) => ({
  board: DEFAULT_BOARD,
  beads: initialArrays.beads,
  placedMask: initialArrays.placedMask,
  beadsVersion: 0,
  placedCount: 0,
  colorStats: { total: new Int32Array(2), placed: new Int32Array(2) },

  paletteId: DEFAULT_PALETTE_ID,
  palette: INITIAL_PALETTE,
  activeColorIndex: 0,

  display: null,
  calibration: null,

  mode: 'design',
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  viewB: { scale: 1, offsetX: 0, offsetY: 0 },
  brushSize: 1,
  region: { splitsX: 1, splitsY: 1, activeIndex: 0 },

  /* 图 B：与 A 同尺寸的空白通道，区块/视图独立 */
  boardB: { ...DEFAULT_BOARD },
  beadsB: makeArrays(DEFAULT_BOARD).beads,
  placedB: makeArrays(DEFAULT_BOARD).placedMask,
  beadsBVersion: 0,
  regionB: { splitsX: 1, splitsY: 1, activeIndex: 0 },
  activePane: 'A' as const,

  filterColorIndex: -1,
  filterMode: 'off',
  vbLight: null,
  vbRunning: false,
  vbConnected: false,
  vbProg: null,
  vbCanvasOn: false,
  vbFilterPrev: null,

  past: [],
  future: [],

  theme: 'macaron',
  layout: 'classic',
  tool: 'pen',
  toasts: [],

  /* ---------------- actions ---------------- */

  setBoardConfig: (patch) => {
    const prev = get().board;
    const board: BoardConfig = { ...prev, ...patch };
    if (board.cols !== prev.cols || board.rows !== prev.rows) {
      const { beads, placedMask } = makeArrays(board);
      set({
        board,
        beads,
        placedMask,
        beadsVersion: get().beadsVersion + 1,
        ...computeStats(beads, placedMask, get().palette.colors.length),
      });
    } else {
      set({ board });
    }
  },

  mutateBeads: (fn) => {
    const { beads, placedMask, beadsVersion } = get();
    fn(beads, placedMask);
    set({
      beadsVersion: beadsVersion + 1,
      ...computeStats(beads, placedMask, get().palette.colors.length),
    });
  },

  mutatePlaced: (fn) => {
    const { beads, placedMask, beadsVersion } = get();
    fn(placedMask, beads);
    set({
      beadsVersion: beadsVersion + 1,
      ...computeStats(beads, placedMask, get().palette.colors.length),
    });
  },

  replaceBeads: (beads, placed) => {
    const placedMask = placed ?? new Uint8Array(beads.length);
    set({
      beads,
      placedMask,
      beadsVersion: get().beadsVersion + 1,
      ...computeStats(beads, placedMask, get().palette.colors.length),
    });
  },

  applyImportedBeads: (beads, dims, label = '导入图案') => {
    const n = dims.cols * dims.rows;
    if (dims.cols < 1 || dims.rows < 1 || beads.length !== n) {
      get().pushToast('danger', `图案数据（${beads.length} 格）与板尺寸 ${dims.cols}×${dims.rows}（${n} 格）不一致，落地已中止`);
      return false;
    }
    const before = get();
    const beforeDims = { cols: before.board.cols, rows: before.board.rows };
    const beadsBefore = before.beads;
    const placedBeforeArr = before.placedMask;
    const placedAfter = new Uint8Array(n);
    // 尺寸 + 内容一步 set（= 旧 setBoardConfig + replaceBeads 组合，但只 bump 一次版本）
    set({
      board: { ...before.board, cols: dims.cols, rows: dims.rows },
      beads,
      placedMask: placedAfter,
      beadsVersion: before.beadsVersion + 1,
      ...computeStats(beads, placedAfter, get().palette.colors.length),
    });
    // 整板替换型历史（与包边扩板同机制）：undo/redo 连尺寸带 placedMask 一并恢复
    pushBoardEdit({
      label,
      ts: Date.now(),
      before: beforeDims,
      after: { cols: dims.cols, rows: dims.rows },
      beadsBefore,
      beadsAfter: beads,
      placedBefore: placedBeforeArr,
      placedAfter,
    });
    return true;
  },

  applyBorderRing: (colorIndex) => {
    const { board, beads, placedMask, palette } = get();
    const { cols, rows } = board;
    const value = colorIndex + 1;
    if (colorIndex < 0 || colorIndex >= palette.colors.length) {
      get().pushToast('danger', '包边色号无效');
      return null;
    }

    // 1. 有没有内容（轮廓由后面的 8 邻域膨胀直接算，无需外接矩形）
    let anyBead = false;
    for (let i = 0; i < beads.length; i++) {
      if (beads[i] !== 0) { anyBead = true; break; }
    }
    if (!anyBead) {
      get().pushToast('info', '画板是空的——先画点内容或导入图片，再加包边');
      return null;
    }

    /**
     * 2. 轮廓包边（用户反馈：不是外接方框，而是**沿图像轮廓**加一圈）：
     *    包边位 = 「空格 && 8 邻域中存在豆子」，即把图案做一次 8 邻域膨胀，
     *    膨胀出来的空格放包边豆。效果 = 贴着图案边缘描边：
     *    ・圆形/不规则图案得到贴轮廓的一圈，而不是外接矩形；
     *    ・图案内部空洞的边缘同样描边（描边语义，包边位全是空格，绝不覆盖豆子）。
     */
    const collectRing = (
      src: Uint16Array, w: number, h: number,
    ): { cells: number[]; touchesEdge: boolean } => {
      const cells: number[] = [];
      let touchesEdge = false;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const i = r * w + c;
          if (src[i] !== 0) {
            // 贴边豆：外侧包边位会出界 → 需要扩板
            if (r === 0 || r === h - 1 || c === 0 || c === w - 1) touchesEdge = true;
            continue; // 豆子本身不放包边
          }
          let nearBead = false;
          for (let dr = -1; dr <= 1 && !nearBead; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const rr = r + dr;
              const cc = c + dc;
              if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
              if (src[rr * w + cc] !== 0) { nearBead = true; break; }
            }
          }
          if (nearBead) cells.push(i);
        }
      }
      return { cells, touchesEdge };
    };

    // 2a. 板内放得下：直接描边（走 mutateBeads + 历史记录，可撤销）
    const ring = collectRing(beads, cols, rows);
    if (!ring.touchesEdge) {
      const diffs: CellDiff[] = [];
      get().mutateBeads((b) => {
        for (const i of ring.cells) {
          if (b[i] === 0) {
            b[i] = value;
            diffs.push({ i, prev: 0, next: value });
          }
        }
      });
      if (diffs.length === 0) {
        get().pushToast('info', '没有可加包边的位置（图案已铺满整板？）');
        return null;
      }
      pushEdit({ label: `包边 · ${palette.colors[colorIndex].code}`, ts: Date.now(), cells: diffs });
      get().pushToast('success', `已沿图案轮廓加包边（${diffs.length} 颗），Ctrl+Z 可撤销`, 2600);
      return { expanded: false, cols, rows, cells: diffs.length };
    }

    // 2b. 贴边：扩板（各方向 +2，内容整体迁移 1 格），迁移后在新板上重新描边。
    //     走整板替换型历史，可撤销/重做。
    const newCols = cols + 2;
    const newRows = rows + 2;
    const nb = new Uint16Array(newCols * newRows);
    const np = new Uint8Array(newCols * newRows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (beads[i] === 0) continue;
        const ni = (r + 1) * newCols + (c + 1);
        nb[ni] = beads[i];
        np[ni] = placedMask[i];
      }
    }
    const ring2 = collectRing(nb, newCols, newRows);
    let ringCells = 0;
    for (const i of ring2.cells) {
      if (nb[i] === 0) {
        nb[i] = value;
        ringCells++;
      }
    }
    pushBoardEdit({
      label: `包边（扩板 ${newCols}×${newRows}）`,
      ts: Date.now(),
      before: { cols, rows },
      after: { cols: newCols, rows: newRows },
      beadsBefore: beads,
      beadsAfter: nb,
      placedBefore: placedMask,
      placedAfter: np,
    });
    set({
      board: { ...board, cols: newCols, rows: newRows },
      beads: nb,
      placedMask: np,
      beadsVersion: get().beadsVersion + 1,
      ...computeStats(nb, np, get().palette.colors.length),
    });
    get().pushToast('success', `图案贴边，已扩板至 ${newCols}×${newRows} 并沿轮廓加包边（${ringCells} 颗），Ctrl+Z 可撤销`, 4200);
    return { expanded: true, cols: newCols, rows: newRows, cells: ringCells };
  },

  setPalette: (id, palette) =>
    set({
      paletteId: id,
      palette,
      // 色板切换后旧索引可能越界，夹回安全区（旧图色号迁移映射待实现）
      activeColorIndex: Math.min(get().activeColorIndex, Math.max(0, palette.colors.length - 1)),
    }),

  setActiveColorIndex: (i) => set({ activeColorIndex: i }),

  /* ---- 调色板编辑 ---- */

  addColor: (color) => {
    const { palette } = get();
    const newColors = [...palette.colors, hydrateColor(color)];
    const newPalette: BeadPalette = { ...palette, colors: newColors };
    set({ palette: newPalette, activeColorIndex: newColors.length - 1 });
    persistIfCustom(newPalette);
  },

  updateColor: (index, patch) => {
    const { palette } = get();
    if (index < 0 || index >= palette.colors.length) return;
    const cur = palette.colors[index];
    const merged: BeadColorInput = {
      id: patch.id ?? cur.id,
      code: patch.code ?? cur.code,
      name: patch.name ?? cur.name,
      nameZh: patch.nameZh !== undefined ? patch.nameZh : cur.nameZh,
      hex: patch.hex ?? cur.hex,
      series: patch.series !== undefined ? patch.series : cur.series,
      builtin: patch.builtin ?? cur.builtin,
    };
    const newColors = palette.colors.slice();
    newColors[index] = hydrateColor(merged);
    const newPalette: BeadPalette = { ...palette, colors: newColors };
    set({ palette: newPalette });
    persistIfCustom(newPalette);
  },

  removeColor: (index, replacementIndex) => {
    const { palette } = get();
    const n = palette.colors.length;
    if (index < 0 || index >= n) return;
    const newColors = palette.colors.filter((_, i) => i !== index);
    // 被删色格子的替换值（删除后的编码：新索引+1，0=留空）
    let replValue = 0;
    if (replacementIndex !== null && replacementIndex !== index && replacementIndex >= 0 && replacementIndex < n) {
      const postIdx = replacementIndex > index ? replacementIndex - 1 : replacementIndex;
      replValue = postIdx + 1;
    }
    // beads 存索引+1：删除某色后，其后所有色的索引整体下移一位——必须走 mutateBeads
    get().mutateBeads((beads) => {
      for (let i = 0; i < beads.length; i++) {
        const v = beads[i];
        if (v === 0) continue;
        const k = v - 1;
        if (k === index) beads[i] = replValue;
        else if (k > index) beads[i] = v - 1;
      }
    });
    // 索引整体重映射使旧历史记录的编码语义失效（undo 会把旧值写回已移位的数组 → 错色）。
    // 色板结构变化本身不可撤销，故一并清空撤销栈（与切换色板同策略）。
    clearHistoryStack();
    const maxIdx = Math.max(0, newColors.length - 1);
    let active = get().activeColorIndex;
    if (active === index) active = Math.min(index, maxIdx);
    else if (active > index) active -= 1;
    active = Math.min(Math.max(0, active), maxIdx);
    let filter = get().filterColorIndex;
    if (filter === index) filter = -1;
    else if (filter > index) filter -= 1;
    const newPalette: BeadPalette = { ...palette, colors: newColors };
    set({ palette: newPalette, activeColorIndex: active, filterColorIndex: filter });
    persistIfCustom(newPalette);
  },

  replaceColorGlobal: (fromIndex, toIndex) => {
    const { palette } = get();
    const n = palette.colors.length;
    if (fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex >= n || fromIndex === toIndex) return;
    const fromVal = fromIndex + 1;
    const toVal = toIndex + 1;
    // 改前整板快照先截一份：大板全图替换的 diff 可能上百万格（对象数组内存不可控），
    // 超阈值时直接走 snapshot 型历史（定长数组 vs 百万对象）；小编辑仍用稀疏 diff。
    const pre = get().beads.slice();
    const diffs: CellDiff[] = [];
    get().mutateBeads((beads) => {
      for (let i = 0; i < beads.length; i++) {
        if (beads[i] === fromVal) {
          beads[i] = toVal;
          diffs.push({ i, prev: fromVal, next: toVal });
        }
      }
    });
    const active = get().activeColorIndex === fromIndex ? toIndex : get().activeColorIndex;
    const filter = get().filterColorIndex === fromIndex ? toIndex : get().filterColorIndex;
    set({ activeColorIndex: active, filterColorIndex: filter });
    if (diffs.length === 0) return; // 无格子命中：不产生历史
    const label = `全局换色 ${palette.colors[fromIndex]?.code ?? fromIndex}→${palette.colors[toIndex]?.code ?? toIndex}`;
    const ts = Date.now();
    if (diffs.length > SNAPSHOT_THRESHOLD) {
      pushEdit({ label, ts, snapshot: pre });
    } else {
      pushEdit({ label, ts, cells: diffs }, { tool: 'replaceColor', value: toVal });
    }
  },

  setPaletteId: (id) => {
    const palette = getPalette(id);
    const current = get();
    if (current.paletteId !== palette.id) {
      const beads = current.beads;
      let hasAny = false;
      for (let i = 0; i < beads.length; i++) {
        if (beads[i] !== 0) {
          hasAny = true;
          break;
        }
      }
      const remap = hasAny ? mapPaletteColors(current.palette.colors, palette) : new Map<number, number>();
      if (hasAny && remap.size > 0) {
        current.mutateBeads((beads) => {
          for (let i = 0; i < beads.length; i++) {
            const v = beads[i];
            if (v === 0) continue;
            const target = remap.get(v - 1);
            if (target !== undefined) beads[i] = target + 1;
          }
        });
      }
      // 色板切换后 beads 编码已按新色板重映射，旧历史记录的索引语义失效
      // （undo 写回旧值 → 错色甚至越界）——与删除颜色同策略，清空撤销栈。
      clearHistoryStack();
    }
    const maxIdx = Math.max(0, palette.colors.length - 1);
    const { activeColorIndex, filterColorIndex } = get();
    set({
      paletteId: palette.id,
      palette,
      activeColorIndex: Math.min(activeColorIndex, maxIdx),
      filterColorIndex: filterColorIndex > maxIdx ? -1 : filterColorIndex,
    });
  },

  resetPaletteToBuiltin: () => {
    const { paletteId } = get();
    if (!BUILTIN_PALETTE_IDS.includes(paletteId)) return; // 自定义色板无内置源，忽略
    const palette = getPalette(paletteId); // 注册表里的原始只读版本
    const maxIdx = Math.max(0, palette.colors.length - 1);
    const { activeColorIndex, filterColorIndex } = get();
    set({
      palette,
      activeColorIndex: Math.min(activeColorIndex, maxIdx),
      filterColorIndex: filterColorIndex > maxIdx ? -1 : filterColorIndex,
    });
  },

  setDisplay: (d) => set({ display: d }),
  setCalibration: (c) => set({ calibration: c }),

  applyBoardPreset: (preset) => {
    const prev = get().board;
    const board: BoardConfig = { ...prev, ...preset };
    if (board.cols !== prev.cols || board.rows !== prev.rows) {
      const { beads, placedMask } = makeArrays(board);
      set({ board, beads, placedMask, beadsVersion: get().beadsVersion + 1 });
    } else {
      set({ board });
    }
    // 板尺寸变化后按屏容量重估分块（与进拼豆/换屏同一规则：装得下合回、装不下分块）
    get().reconcileRegionWithDisplay();
  },

  autoSuggestRegion: () => {
    get().reconcileRegionWithDisplay();
  },

  /**
   * 按当前屏（store.display = 全屏目标屏，与 enterFullscreen 同源）的
   * 1:1 容量重估分块——
   *  · 整板放得下 → 自动分块合回单块（修「切到大屏还是两块」）；
   *  · 放不下 → 应用最小容量方案（双向：变大屏收缩、变大屏合并）；
   *  · 用户手动分块（autoSized=false，当分页用）→ 只在容量不足时被迫扩大，绝不合并/收缩。
   * 幂等：region 已是最优方案时不写状态、不弹提示。
   */
  reconcileRegionWithDisplay: () => {
    const { board, display, calibration, region, setRegion, pushToast } = get();
    if (!display || !calibration) return;
    const fit = fitsOnScreen(board, sanitizeCalibration(calibration), display);
    const curCount = Math.max(1, region.splitsX) * Math.max(1, region.splitsY);
    const manual = region.autoSized === false;

    if (fit.fits) {
      if (curCount > 1 && !manual) {
        setRegion({ splitsX: 1, splitsY: 1, blockCols: undefined, blockRows: undefined, activeIndex: 0, autoSized: true });
        pushToast('info', `当前屏可整板 1:1 显示（${board.cols}×${board.rows}），分块已自动合并为单块`, 4200);
      }
      return;
    }

    const sug = autoSuggestSplits(board.cols, board.rows, fit.colsMax, fit.rowsMax);
    const sugCount = sug.splitsX * sug.splitsY;
    // 容量不足：无论手动/自动都必须扩到位（格子绝不缩小）；
    // 容量有余：自动方案跟随新屏收缩合并，手动分页保持不动
    if (curCount < sugCount || !manual) {
      const changed =
        region.splitsX !== sug.splitsX ||
        region.splitsY !== sug.splitsY ||
        region.blockCols !== sug.blockCols ||
        region.blockRows !== sug.blockRows;
      if (changed) {
        setRegion({
          splitsX: sug.splitsX,
          splitsY: sug.splitsY,
          blockCols: sug.blockCols,
          blockRows: sug.blockRows,
          activeIndex: 0,
          autoSized: !manual,
        });
        pushToast(
          'info',
          `板 ${board.cols}×${board.rows} 超出该屏 1:1 可视区（最多 ${fit.colsMax}×${fit.rowsMax} 格），已按屏分块 ${sug.splitsX}×${sug.splitsY}：首块 ${sug.blockCols}×${sug.blockRows} 尽量占满，余量归末块；格子保持 1:1 不缩小`,
          5600,
        );
      }
    }
  },

  resetCalibration: () => {
    const { display } = get();
    if (!display) return;
    const cal = sanitizeCalibration(calibrationFromDisplay(display));
    set({ calibration: cal });
  },

  setMode: (m) => set({ mode: m }),
  setView: (patch) => set({ view: { ...get().view, ...patch } }),
  setViewB: (patch) => set({ viewB: { ...get().viewB, ...patch } }),
  setBrushSize: (size) => set({ brushSize: Math.max(1, Math.min(9, Math.round(size) || 1)) }),
  setRegion: (patch) => {
    const prev = get().region;
    set({ region: { ...prev, ...patch } });
    // 拼豆模式下切换区块：复位平移偏移（每块都对齐屏幕原点）。
    // 否则上一块拖拽出来的 offset 会带到新块上，画面跑出视口 → "第二页显示不全"（用户反馈 bug）。
    if (
      get().mode === 'placement' &&
      patch.activeIndex !== undefined &&
      patch.activeIndex !== prev.activeIndex
    ) {
      if (get().view.offsetX !== 0 || get().view.offsetY !== 0) {
        set({ view: { ...get().view, offsetX: 0, offsetY: 0 } });
      }
      if (get().viewB.offsetX !== 0 || get().viewB.offsetY !== 0) {
        set({ viewB: { ...get().viewB, offsetX: 0, offsetY: 0 } });
      }
    }
  },

  setFilter: (colorIndex, mode) => set({ filterColorIndex: colorIndex, filterMode: mode }),
  setFilterMode: (mode) => set({ filterMode: mode }),
  setVbLight: (p) => {
    if (p === null && get().vbCanvasOn) {
      // 清图案时联动关掉「画布点亮」并还原档位 —— 对话框/顶栏 chip/小窗三处清除共用此入口
      const prev = get().vbFilterPrev;
      set({ vbLight: null, vbCanvasOn: false, vbFilterPrev: null, filterMode: prev ?? get().filterMode });
      return;
    }
    set({ vbLight: p });
  },
  setVbStatus: (running, connected, prog) => set({ vbRunning: running, vbConnected: connected, vbProg: prog }),
  setVbProg: (text) => set({ vbProg: text }),
  setVbCanvasOn: (on) => {
    const s = get();
    if (on) {
      // 已是 panel 档时不覆盖快照（可能用户自己设的 panel，关掉时不应改动它）
      const prev = s.filterMode === 'panel' ? s.vbFilterPrev : s.filterMode;
      set({ vbCanvasOn: true, vbFilterPrev: prev, filterMode: 'panel' });
    } else {
      if (!s.vbCanvasOn) return;
      const prev = s.vbFilterPrev;
      set({ vbCanvasOn: false, vbFilterPrev: null, filterMode: prev ?? s.filterMode });
    }
  },

  /* ---------------- 图 B（双图同屏） ---------------- */
  copyAtoB: () => {
    const { board, beads, placedMask } = get();
    set({
      boardB: { ...board },
      beadsB: beads.slice(),
      placedB: placedMask.slice(),
      beadsBVersion: get().beadsBVersion + 1,
    });
    get().pushToast('success', '已把图 A 拷贝到图 B', 1800);
  },
  setPatternB: (board, beads, placed) => {
    if (beads.length !== board.cols * board.rows) {
      get().pushToast('danger', `图 B 数据（${beads.length} 格）与板尺寸 ${board.cols}×${board.rows} 不符，已忽略`);
      return;
    }
    const placedB = placed ?? new Uint8Array(beads.length);
    // 区块方案按 B 板尺寸复位（避免 A 的分块套到不同尺寸的 B 上）
    const fit = get().display && get().calibration
      ? fitsOnScreen(board, sanitizeCalibration(get().calibration), get().display!)
      : { fits: true };
    set({
      boardB: board,
      beadsB: beads,
      placedB,
      beadsBVersion: get().beadsBVersion + 1,
      regionB: fit.fits
        ? { splitsX: 1, splitsY: 1, activeIndex: 0 }
        : get().regionB,
    });
  },
  clearPatternB: () => {
    const { beads, placedMask } = makeArrays(get().boardB);
    set({ beadsB: beads, placedB: placedMask, beadsBVersion: get().beadsBVersion + 1 });
  },
  setRegionB: (patch) => set({ regionB: { ...get().regionB, ...patch } }),
  setActivePane: (p) => set({ activePane: p }),

  setHistory: (past, future) => set({ past, future }),
  // 委托 history 单例的 clear()：除 past/future 外还复位模块内的 coalesce 元数据、
  // 未收尾事务与丢弃计数（直接 set 空栈会漏掉这些，残留事务可能把后续编辑并进死条目）。
  clearHistory: () => clearHistoryStack(),

  setTheme: (t) => set({ theme: t }),
  setLayout: (l) => set({ layout: l }),
  setTool: (t) => set({ tool: t }),

  pushToast: (kind, message, duration = 2600) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, kind, message, duration }] });
    if (duration > 0) {
      setTimeout(() => get().dismissToast(id), duration);
    }
    return id;
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/* ---------------- 便捷选择器（后续任务共用，避免各处手写索引换算） ---------------- */

/** 当前选中颜色（BeadColor），色板为空时返回 null */
export function selectActiveColor(s: Pick<PdbState, 'palette' | 'activeColorIndex'>) {
  return s.palette.colors[s.activeColorIndex] ?? null;
}

/** beads[i] 存的是索引+1；取调色板颜色用这个换算 */
export function colorAt(s: Pick<PdbState, 'palette'>, cellValue: number) {
  return cellValue === 0 ? null : (s.palette.colors[cellValue - 1] ?? null);
}
