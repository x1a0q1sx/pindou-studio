/**
 * src/render/renderer.ts —— 主渲染器（Canvas 2D 四层离屏缓存 + 脏矩形局部重绘）。
 *
 * 【物理精度铁律】
 * - 所有几何计算在设备像素域完成
 * - Canvas backing store 严格 = CSS 尺寸 × DPR
 * - 每格边界独立取整：x0=round(originX + col*pitchDevX)，x1=round(originX + (col+1)*pitchDevX)
 * - 严禁「首格取整 + 累加固定整数步长」——会系统性漂移
 * - 必须分轴用 pitchDevX / pitchDevY
 * - mode==='placement' 时 view.scale 强制锁 1.0
 *
 * 【缩放平移策略】
 * 手势期间对缓存做 drawImage **仿射差量变换**（快但略糊）：按当前 view 与 lastView（缓存内容
 * 对应的视图快照）之差计算平移 tx/ty 与缩放比 k，把各层缓存贴到主画布的仿射映射位置——
 * store 的 offset/scale 已实时更新，画面逐帧跟手（缺陷 #24 修复：旧实现恒等拷贝导致手势期
 * 画面冻结、松手后 120ms 防抖才整帧突跳到终点）。
 * 差量露白/形变超限（平移超每侧 15% 视口，或 k 越出 [0.8, 1.25]）时，同步把缓存全量重绘到
 * 当前视图（把 lastView 拉回当前），露白区域以主题 tokens.canvasBg 铺底，随后继续差量 blit。
 * 手势结束/防抖 120ms 后按新 scale 重绘清晰缓存。每帧只做 3–4 次 drawImage 合成。
 *
 * 【blit 源矩形语义（#18 既有约定，保持不变）】
 * 层内容的绘制域是视口 0-based 区：源矩形恒 (0,0,devW,devH)，层画布多出的 30% overscan
 * 尺寸仅是分配预留（其上无内容），变换 blit 不使用 overscan 区，露白一律由铺底兜底。
 */
import type { BoardConfig, Calibration, CanvasTokens, FilterMode, BeadPalette, ToolId, VbLightPattern } from '@/core/types';
import { pitchToDevicePx } from '@/core/geometry';
import { cellIndex } from '@/core/board';
import { regionLabel } from '@/core/region';
import { DirtyRectTracker } from './dirtyRect';
import type { DirtyTile } from './dirtyRect';
import { LayerSystem, clampDpr } from './layers';
import type { LayerId } from './layers';
import { getGlowPrefs } from '@/store/placementPrefs';
import { dimVeilStyle, hexLuma, lowContrastEdge, yiqLuma } from '@/core/displayContrast';

/** 空格填充色：发光底板开启「纯黑空格」时用纯黑（LCD 不漏光），否则用主题 emptyCell。
 *  L2 hide 模式复用同一规则，保证隐藏区与空格视觉无缝。 */
function resolveEmptyCellFill(tokens: CanvasTokens): string {
  const glow = getGlowPrefs();
  return glow.pureBlackEmpty && tokens.highlightGlow ? '#000000' : tokens.emptyCell;
}

/** 发光板（filterMode==='panel'）熄灭格的填充：必须**不透明纯黑**。
 *  理由：L2 是覆盖层，若用半透明的 emptyCell，下层 L1 的豆点色会透出来，
 *  「已拼熄灭 / 其他色隐藏」的语义就破了；纯黑同时让 LCD 漏光最小。 */
const PANEL_OFF_FILL = '#000000';
/** 发光板亮点外发光半径（乘 glowBoost 后使用） */
const PANEL_GLOW_BLUR = 10;

/* =============== 渲染器所需的外部状态快照 =============== */

export interface RendererState {
  board: BoardConfig;
  beads: Uint16Array;
  placedMask: Uint8Array;
  beadsVersion: number;
  palette: BeadPalette;
  calibration: Calibration;
  view: { scale: number; offsetX: number; offsetY: number };
  mode: 'design' | 'placement';
  filterColorIndex: number;
  filterMode: FilterMode;
  region: { splitsX: number; splitsY: number; activeIndex: number };
  canvasTokens: CanvasTokens;
  /** 当前悬停格 (null=无) */
  hoverCell: { row: number; col: number } | null;
  /** 当前工具（笔刷预览框只对画笔/橡皮显示 N×N 范围） */
  tool: ToolId;
  /** 笔刷边长（1 = 单格） */
  brushSize: number;
  /** 当前活跃区块的起始 row/col（region mode） */
  regionOffset: { row0: number; col0: number; rows: number; cols: number } | null;
  /** 手机点亮图案（虚拟板收到 PIXDOU 节目后解码）。panel 档有它时优先渲染（App 选色=板子显示） */
  vbLight: VbLightPattern | null;
}

export type GetStateFn = () => RendererState;

/* =============== 视口矩形（设备像素域） =============== */

export interface CellRect {
  x0: number; y0: number; x1: number; y1: number;
}

/* =============== Renderer =============== */

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layers: LayerSystem;
  private dirtyTracker: DirtyRectTracker;
  private getState: GetStateFn;

  /** 画布 CSS 尺寸 */
  private cssW = 0;
  private cssH = 0;
  /** 实际使用的 DPR（clamped） */
  private dpr = 1;

  /** 手势期间标记：跳过重绘缓存，只做 blit 变换 */
  private gestureActive = false;
  private gestureTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 缓存内容对应的视图快照（#24 接线：手势 blit 的差量基准）。
   * 语义：仅在全量重绘缓存时更新（非手势 render 末尾 / 手势期阈值重绘后），
   * 手势差量 blit 不改它——差量必须相对「缓存内容真正的视图」计算，否则累计错位。
   * scale 存的是渲染用 scale（placement 模式锁定为 1 之后的值），与手势差量同口径。
   */
  private lastView = { scale: 1, offsetX: 0, offsetY: 0 };
  /**
   * 缓存内容是否已失效（resize 会清空层画布 backing store）。
   * 手势分支看到它为 true 时必须先同步全量重绘（否则 blit 贴出全空画面），重绘后复位。
   * 非 gesture 期的 invalidateAll 不置位（手势期 view effect 每帧都在 invalidateAll，
   * 若在那处置位会退化成每帧全量重绘，等于放弃 blit 快路径）。
   */
  private cacheStale = true;

  /** 已 dispose */
  private disposed = false;

  /** 豆上色号文字颜色缓存（按豆色亮度取黑/白；调色板对象变化时整体失效） */
  private codeTextColors = new Map<number, string>();
  private codeTextColorsFor: BeadPalette | null = null;

  private codeTextColor(palette: BeadPalette, index: number): string {
    if (this.codeTextColorsFor !== palette) {
      this.codeTextColors = new Map();
      this.codeTextColorsFor = palette;
    }
    let c = this.codeTextColors.get(index);
    if (!c) {
      const rgb = palette.colors[index]?.rgb;
      const yiq = rgb ? (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 : 255;
      c = yiq > 150 ? '#1c1c1c' : '#ffffff';
      this.codeTextColors.set(index, c);
    }
    return c;
  }

  /**
   * 暗色豆高对比救援描边：glowDark 纯黑底上黑/深色豆「看不见」的根治——
   * 豆色与画布底色亮度差不足时，在常规 beadStroke 之外再描一圈反向（浅底黑/深底白）
   * 半透边线，深色豆群立刻可数、可定位。按色板索引缓存判定，调色板或底色变化时失效。
   */
  private edgeColors = new Map<number, string | null>();
  private edgeColorsFor: BeadPalette | null = null;
  private edgeBgHex = '';
  private edgeBgLuma = 0;

  private bgLumaOf(tokens: CanvasTokens): number {
    if (this.edgeBgHex !== tokens.canvasBg) {
      this.edgeBgHex = tokens.canvasBg;
      this.edgeBgLuma = hexLuma(tokens.canvasBg);
    }
    return this.edgeBgLuma;
  }

  private beadEdge(palette: BeadPalette, index: number, bgLuma: number): string | null {
    if (this.edgeColorsFor !== palette) {
      this.edgeColors = new Map();
      this.edgeColorsFor = palette;
    }
    if (this.edgeColors.has(index)) return this.edgeColors.get(index)!;
    const rgb = palette.colors[index]?.rgb;
    const style = rgb ? lowContrastEdge(yiqLuma(rgb), bgLuma) : null;
    this.edgeColors.set(index, style);
    return style;
  }

  /**
   * 「本轮 beads 变更已由绘制按格标脏」标记。
   * usePointerPaint 拖拽笔画每帧调 markCellsDirty 时置 true；StageCanvas 的 beadsVersion
   * effect 通过 consumeCellDirtyPending() 读取并复位——为 true 时跳过 invalidateAll()，
   * 让脏瓦片局部重绘生效（缺口 7：避免每帧全量重绘 10816 格）。
   */
  private cellDirtyPending = false;

  /**
   * 置位 cellDirtyPending 时的 beadsVersion 快照（#24 竞态修复）。
   * 消费方（StageCanvas 的 beadsVersion effect）必须校验「快照 === 当前 effect 收到的
   * beadsVersion」才允许走局部重绘：若置位后同帧插入了另一来源的 beads 变更
   * （如 Ctrl+Z keydown 抢在 React passive effect 之前 bump 了版本），快照失配 →
   * 回落 invalidateAll() 全量重绘，避免按格标脏只覆盖笔画格子、撤销还原的其余格漏绘。
   */
  private cellDirtyVersion = -1;

  constructor(canvas: HTMLCanvasElement, getState: GetStateFn, viewKey: 'view' | 'viewB' = 'view') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.layers = new LayerSystem();
    this.dirtyTracker = new DirtyRectTracker();
    this.getState = getState;
    this.viewKey = viewKey;
  }

  /** 本渲染器绑定的视图（dual 布局右画布 = 'viewB'；快捷键缩放跟随悬停窗格时用） */
  readonly viewKey: 'view' | 'viewB';

  /** 画布元素（快捷键缩放需要它的 CSS 尺寸与设备像素比） */
  get canvasEl(): HTMLCanvasElement {
    return this.canvas;
  }

  /* =============== 公开 API =============== */

  /** 设置视口（resize 时调用） */
  setViewport(cssW: number, cssH: number, dpr: number): void {
    if (this.disposed) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = clampDpr(dpr);

    // 主画布 backing store = CSS × DPR（物理精度铁律）
    const devW = Math.round(cssW * this.dpr);
    const devH = Math.round(cssH * this.dpr);
    if (this.canvas.width !== devW || this.canvas.height !== devH) {
      this.canvas.width = devW;
      this.canvas.height = devH;
    }
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    this.layers.resize(cssW, cssH, dpr);
    this.dirtyTracker.setSize(devW, devH);
    // resize 改变了层画布尺寸（backing store 被清空）：缓存内容不再对应任何视图，
    // 若此刻正处于手势中，手势分支必须先同步全量重绘，否则 blit 贴出全空画面
    this.cacheStale = true;
    this.invalidateAll();
  }

  /** 快捷 resize（从 canvas.parentElement 读尺寸） */
  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w > 0 && h > 0) {
      this.setViewport(w, h, window.devicePixelRatio || 1);
    }
  }

  /** 标记某层失效 */
  invalidate(layer?: LayerId): void {
    if (layer !== undefined) {
      this.layers.invalidate(layer);
    } else {
      this.invalidateAll();
    }
  }

  /** 标记全部层失效 */
  invalidateAll(): void {
    this.layers.invalidateAll();
    this.dirtyTracker.markAllDirty();
  }

  /**
   * dim+glow 场景下按格标脏所需的外扩量（设备像素，#24 光晕溢出修复）。
   *
   * filterMode==='dim' 的目标格用 shadowBlur = 8*glowBoost 发光，光晕可溢出格子矩形十余
   * 像素；若标脏矩形严格取 computeCellRect 的格子矩形，清除范围盖不住溢出区，邻格瓦片
   * 残留旧光晕。外扩 G = ceil(8*glowBoost) + 2 恰好覆盖模糊扩散半径（+2 兜底亚像素溢出）。
   * 非 dim+glow 场景返回 0（豆点/描边均在格内，多扩只会白画瓦片拖慢局部重绘）。
   */
  private glowDirtyPad(s: RendererState): number {
    if (s.filterMode !== 'dim' || !s.canvasTokens.highlightGlow) return 0;
    const glow = getGlowPrefs();
    if (glow.glowBoost <= 0) return 0;
    return Math.ceil(8 * glow.glowBoost) + 2;
  }

  /** 标记 beads 层脏矩形（单格编辑） */
  markCellDirty(row: number, col: number): void {
    const s = this.getState();
    const rect = this.computeCellRect(row, col, s);
    if (rect) {
      const pad = this.glowDirtyPad(s);
      this.dirtyTracker.markCellDirty(rect.x0 - pad, rect.y0 - pad, rect.x1 + pad, rect.y1 + pad);
      this.layers.invalidatePartial(1);
      this.layers.invalidatePartial(2);
      this.cellDirtyPending = true;
      this.cellDirtyVersion = s.beadsVersion;
    }
  }

  /**
   * 批量按格标脏（拖拽笔画每帧调用的热路径）。
   *
   * 与逐格调 markCellDirty 的区别：**只取一次 state 快照**（getState 会重建整份
   * RendererState：getTheme/sanitizeCalibration/getActiveRegionOffset），避免 N 格 N 次重复计算，
   * 是单格编辑 ≤2ms 预算的关键。传入线性索引（i = row*cols + col，来自 editOps 的 Diff.i
   * 或 place 笔画的 cellIndex 列表），内部还原为绝对行列后走同一套 computeCellRect（含 region
   * 偏移与独立取整铁律），标脏对应 64×64 瓦片，并把 L1/L2 置为局部脏。
   *
   * 成功后置 cellDirtyPending，让 StageCanvas 跳过本轮 beadsVersion 的 invalidateAll()。
   * @returns 实际标脏的格数（越界/不可见格被 computeCellRect 过滤后不计）
   */
  markCellsDirty(indices: ArrayLike<number>, cols: number): number {
    if (this.disposed || cols <= 0 || indices.length === 0) return 0;
    const s = this.getState();
    // 外扩量只取一次：dim+glow 下光晕溢出格子矩形，标脏矩形必须按半径外扩（#24）
    const pad = this.glowDirtyPad(s);
    let marked = 0;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]!;
      if (!(i >= 0)) continue;
      const row = (i / cols) | 0;
      const col = i % cols;
      const rect = this.computeCellRect(row, col, s);
      if (!rect) continue;
      this.dirtyTracker.markCellDirty(rect.x0 - pad, rect.y0 - pad, rect.x1 + pad, rect.y1 + pad);
      marked++;
    }
    if (marked > 0) {
      this.layers.invalidatePartial(1);
      this.layers.invalidatePartial(2);
      this.cellDirtyPending = true;
      this.cellDirtyVersion = s.beadsVersion;
    }
    return marked;
  }

  /**
   * 消费「本轮 beads 变更已按格标脏」标记（读后即复位）。
   * StageCanvas 的 beadsVersion effect 据此决定：
   * - ticket.pending && ticket.version === effect 收到的 beadsVersion → 局部重绘已排队，
   *   跳过 invalidateAll；
   * - 其余情况（未按格标脏的一次性大改：撤销/重做、连通填充、同色替换、整板落地；
   *   或 #24 竞态：置位后同帧插入另一来源的 beads 变更导致快照失配）→ 回落全量失效。
   */
  consumeCellDirtyPending(): { pending: boolean; version: number } {
    const pending = this.cellDirtyPending;
    const version = this.cellDirtyVersion;
    this.cellDirtyPending = false;
    this.cellDirtyVersion = -1;
    return { pending, version };
  }

  /**
   * 渲染实际使用的 DPR（clamp 封顶 2 后的值，#24 DPR 一致性）。
   * 缩放锚点/适配视图的推导方（如 StageCanvas 的 Ctrl+滚轮）应使用本值而非原始
   * window.devicePixelRatio：dpr>2 的设备上两者不一致会导致锚点漂移。
   */
  get effectiveDpr(): number {
    return this.dpr;
  }

  /** 开始手势（平移/缩放） */
  beginGesture(): void {
    this.gestureActive = true;
    if (this.gestureTimer) { clearTimeout(this.gestureTimer); this.gestureTimer = null; }
  }

  /** 结束手势 → 120ms 防抖后重绘清晰缓存 */
  endGesture(): void {
    this.gestureActive = false;
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    this.gestureTimer = setTimeout(() => {
      this.gestureTimer = null;
      this.invalidateAll();
      this.render();
    }, 120);
  }

  /**
   * 主渲染入口。每帧调用一次。
   * 手势期间：对缓存做仿射差量 blit（快但略糊，露白/形变超限时同步全量重绘）。
   * 正常：重绘脏层 + 恒等合成。
   */
  render(): void {
    if (this.disposed || this.cssW <= 0) return;
    const s = this.getState();
    const devW = Math.round(this.cssW * this.dpr);
    const devH = Math.round(this.cssH * this.dpr);

    // placement 模式强制 scale=1
    const scale = s.mode === 'placement' ? 1.0 : s.view.scale;

    if (this.gestureActive) {
      this.renderGestureFrame(s, scale, devW, devH);
      return;
    }

    const geo = this.computeViewGeometry(s, scale, devW, devH);
    this.redrawDirtyLayers(s, geo, devW, devH);

    // 合成到主画布（恒等：非手势路径与旧实现逐字节一致，不额外铺底）
    this.blitLayers(devW, devH, s, 0, 0, 1);
    this.lastView = { scale, offsetX: s.view.offsetX, offsetY: s.view.offsetY };
    this.cacheStale = false;
  }

  /**
   * 手势期单帧渲染（#24 核心修复）。
   *
   * 按当前视图与 lastView（缓存内容视图）的仿射差量把缓存贴到主画布：
   *   屏幕点映射  x' = k*x + t （k = scale/baseScale，t = origin' − k*origin，设备像素域）
   * 平移时 k=1 纯平移；缩放时锚点由 zoomViewAtAnchor 的守恒关系自动保持。
   *
   * 触发同步全量重绘（把缓存/lastView 拉回当前视图，继续后续差量 blit）的条件：
   * 1. cacheStale：resize 清空过层画布，缓存已无内容可贴；
   * 2. 平移差量超每侧 15% 视口：露白面积过大（层画布的 overscan 仅是分配预留、
   *    其上无内容，不能拿来贴），铺底只能兜住小量露白；
   * 3. 缩放比 k 越出 [0.8, 1.25]：连续滚轮累计形变过大，拉伸糊化不可接受。
   */
  private renderGestureFrame(s: RendererState, scale: number, devW: number, devH: number): void {
    const base = this.lastView;
    const baseScale = base.scale > 0 ? base.scale : 1;
    const k = scale / baseScale;
    const ox0 = s.calibration.originDevicePx.x + base.offsetX * this.dpr;
    const oy0 = s.calibration.originDevicePx.y + base.offsetY * this.dpr;
    const ox1 = s.calibration.originDevicePx.x + s.view.offsetX * this.dpr;
    const oy1 = s.calibration.originDevicePx.y + s.view.offsetY * this.dpr;
    // 取整：平移对齐整数设备像素，避免 drawImage 双线性重采样引入无谓糊化（k=1 时目标矩形全整数）
    const tx = Math.round(ox1 - k * ox0);
    const ty = Math.round(oy1 - k * oy0);

    const overLimit =
      this.cacheStale ||
      Math.abs(tx) > devW * 0.15 ||
      Math.abs(ty) > devH * 0.15 ||
      k > 1.25 ||
      k < 0.8;

    if (overLimit) {
      // 同步把缓存重绘到当前视图（与非手势路径同一套重绘序列），随后恒等 blit
      this.invalidateAll();
      const geo = this.computeViewGeometry(s, scale, devW, devH);
      this.redrawDirtyLayers(s, geo, devW, devH);
      this.lastView = { scale, offsetX: s.view.offsetX, offsetY: s.view.offsetY };
      this.cacheStale = false;
      this.blitLayers(devW, devH, s, 0, 0, 1);
      return;
    }

    this.blitLayers(devW, devH, s, tx, ty, k);
  }

  /**
   * 当前视图的绘制几何（设备像素域）：pitch、origin、可视行列范围。
   * 非手势路径与手势期阈值重绘共用，保证两条路径算出的缓存内容完全一致。
   */
  private computeViewGeometry(
    s: RendererState,
    scale: number,
    devW: number, devH: number,
  ): { originX: number; originY: number; pitchDevX: number; pitchDevY: number; vis: { row0: number; row1: number; col0: number; col1: number } } {
    const pitch = pitchToDevicePx(s.board.pitchMm, s.calibration);
    const pitchDevX = pitch.x * scale;
    const pitchDevY = pitch.y * scale;
    // origin = calibration.originDevicePx + view.offset（设计模式）
    // placement 模式下 offset 由 region 决定
    const originX = s.calibration.originDevicePx.x + s.view.offsetX * this.dpr;
    const originY = s.calibration.originDevicePx.y + s.view.offsetY * this.dpr;
    const vis = this.computeVisibleRange(originX, originY, pitchDevX, pitchDevY, devW, devH, s);
    return { originX, originY, pitchDevX, pitchDevY, vis };
  }

  /**
   * 重绘各脏层到离屏缓存（非手势主路径与手势期阈值重绘共用）。
   * 逻辑与 #17/#18 修复后的版本逐行一致：L0 全量、L1/L2 全量或脏瓦片局部、L3 全量。
   */
  private redrawDirtyLayers(
    s: RendererState,
    geo: { originX: number; originY: number; pitchDevX: number; pitchDevY: number; vis: { row0: number; row1: number; col0: number; col1: number } },
    devW: number, devH: number,
  ): void {
    const { originX, originY, pitchDevX, pitchDevY, vis } = geo;
    if (this.layers.getLayer(0).dirty) {
      this.drawL0(s, originX, originY, pitchDevX, pitchDevY, vis, devW, devH);
      this.layers.getLayer(0).dirty = false;
    }
    // 统一消费脏瓦片（L1、L2 共享）
    const dirtyTiles = this.dirtyTracker.consumeDirty();
    if (this.layers.getLayer(1).dirty) {
      const l1 = this.layers.getLayer(1);
      if (l1.fullDirty) {
        this.drawL1(s, originX, originY, pitchDevX, pitchDevY, vis, devW, devH);
      } else {
        this.drawL1Partial(s, originX, originY, pitchDevX, pitchDevY, vis, dirtyTiles);
      }
      l1.dirty = false;
      l1.fullDirty = true;
    }
    if (this.layers.getLayer(2).dirty) {
      const l2 = this.layers.getLayer(2);
      if (l2.fullDirty) {
        this.drawL2(s, originX, originY, pitchDevX, pitchDevY, vis, devW, devH);
      } else {
        this.drawL2Partial(s, originX, originY, pitchDevX, pitchDevY, vis, dirtyTiles);
      }
      l2.dirty = false;
      l2.fullDirty = true;
    }
    if (this.layers.getLayer(3).dirty) {
      this.drawL3(s, originX, originY, pitchDevX, pitchDevY, devW, devH);
      this.layers.getLayer(3).dirty = false;
    }
  }

  /**
   * 屏幕坐标(CSS px, clientX/Y) → 格子坐标。
   * 返回 null 表示不在板范围内。
   */
  screenToCell(clientX: number, clientY: number): { row: number; col: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const devX = cssX * this.dpr;
    const devY = cssY * this.dpr;

    const s = this.getState();
    const scale = s.mode === 'placement' ? 1.0 : s.view.scale;
    const pitch = pitchToDevicePx(s.board.pitchMm, s.calibration);
    const pitchDevX = pitch.x * scale;
    const pitchDevY = pitch.y * scale;
    const originX = s.calibration.originDevicePx.x + s.view.offsetX * this.dpr;
    const originY = s.calibration.originDevicePx.y + s.view.offsetY * this.dpr;

    // 反算 col/row（浮点）
    const colF = (devX - originX) / pitchDevX;
    const rowF = (devY - originY) / pitchDevY;
    const col = Math.floor(colF);
    const row = Math.floor(rowF);

    // 考虑 region offset
    const regionOff = s.regionOffset;
    const actualRow = regionOff ? row + regionOff.row0 : row;
    const actualCol = regionOff ? col + regionOff.col0 : col;

    if (actualRow < 0 || actualRow >= s.board.rows || actualCol < 0 || actualCol >= s.board.cols) return null;
    return { row: actualRow, col: actualCol };
  }

  /**
   * 格子坐标 → 屏幕矩形（CSS px，相对于 canvas 元素）。
   */
  cellToScreen(row: number, col: number): CellRect {
    const s = this.getState();
    const scale = s.mode === 'placement' ? 1.0 : s.view.scale;
    const pitch = pitchToDevicePx(s.board.pitchMm, s.calibration);
    const pitchDevX = pitch.x * scale;
    const pitchDevY = pitch.y * scale;
    const originX = s.calibration.originDevicePx.x + s.view.offsetX * this.dpr;
    const originY = s.calibration.originDevicePx.y + s.view.offsetY * this.dpr;

    const regionOff = s.regionOffset;
    const localRow = regionOff ? row - regionOff.row0 : row;
    const localCol = regionOff ? col - regionOff.col0 : col;

    const x0 = (Math.round(originX + localCol * pitchDevX)) / this.dpr;
    const y0 = (Math.round(originY + localRow * pitchDevY)) / this.dpr;
    const x1 = (Math.round(originX + (localCol + 1) * pitchDevX)) / this.dpr;
    const y1 = (Math.round(originY + (localRow + 1) * pitchDevY)) / this.dpr;
    return { x0, y0, x1, y1 };
  }

  /** 释放资源 */
  dispose(): void {
    this.disposed = true;
    if (this.gestureTimer) { clearTimeout(this.gestureTimer); this.gestureTimer = null; }
    this.layers.dispose();
  }

  /* =============== 内部：格子矩形计算（独立取整铁律） =============== */

  private computeCellRect(row: number, col: number, s: RendererState): CellRect | null {
    const scale = s.mode === 'placement' ? 1.0 : s.view.scale;
    const pitch = pitchToDevicePx(s.board.pitchMm, s.calibration);
    const pitchDevX = pitch.x * scale;
    const pitchDevY = pitch.y * scale;
    const originX = s.calibration.originDevicePx.x + s.view.offsetX * this.dpr;
    const originY = s.calibration.originDevicePx.y + s.view.offsetY * this.dpr;

    const regionOff = s.regionOffset;
    const localRow = regionOff ? row - regionOff.row0 : row;
    const localCol = regionOff ? col - regionOff.col0 : col;

    // 独立取整（铁律）
    const x0 = Math.round(originX + localCol * pitchDevX);
    const y0 = Math.round(originY + localRow * pitchDevY);
    const x1 = Math.round(originX + (localCol + 1) * pitchDevX);
    const y1 = Math.round(originY + (localRow + 1) * pitchDevY);
    return { x0, y0, x1, y1 };
  }

  /* =============== 内部：可视范围裁剪 =============== */

  private computeVisibleRange(
    originX: number, originY: number,
    pitchDevX: number, pitchDevY: number,
    devW: number, devH: number,
    s: RendererState,
  ): { row0: number; row1: number; col0: number; col1: number } {
    // 视口边界换算为**绝对格子坐标**：区块对位时内容原点 = baseRow/baseCol（区块首格画在
    // 屏幕原点），视口覆盖的本地行 0..N 对应绝对行 baseRow..baseRow+N。
    // 旧实现漏加基准，容量优先分块后第二区块（绝对行 78..103）被视口行数(79)截断 → 只剩 2 行。
    const baseRow = s.regionOffset ? s.regionOffset.row0 : 0;
    const baseCol = s.regionOffset ? s.regionOffset.col0 : 0;
    const colStart = Math.max(0, baseCol + Math.floor((0 - originX) / pitchDevX));
    const colEnd = Math.min(s.board.cols - 1, baseCol + Math.ceil((devW - originX) / pitchDevX));
    const rowStart = Math.max(0, baseRow + Math.floor((0 - originY) / pitchDevY));
    const rowEnd = Math.min(s.board.rows - 1, baseRow + Math.ceil((devH - originY) / pitchDevY));

    // region 裁剪（拼豆模式）
    const regionOff = s.regionOffset;
    if (regionOff) {
      return {
        row0: Math.max(regionOff.row0, rowStart),
        row1: Math.min(regionOff.row0 + regionOff.rows - 1, rowEnd),
        col0: Math.max(regionOff.col0, colStart),
        col1: Math.min(regionOff.col0 + regionOff.cols - 1, colEnd),
      };
    }
    return { row0: rowStart, row1: rowEnd, col0: colStart, col1: colEnd };
  }

  /* =============== L0：网格层 =============== */

  private drawL0(
    s: RendererState,
    originX: number, originY: number,
    pitchDevX: number, pitchDevY: number,
    vis: { row0: number; row1: number; col0: number; col1: number },
    devW: number, devH: number,
  ): void {
    const layer = this.layers.getLayer(0);
    const ctx = layer.ctx;
    const tokens = s.canvasTokens;
    const board = s.board;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);

    // 底色
    ctx.fillStyle = tokens.canvasBg;
    ctx.fillRect(0, 0, devW, devH);

    const regionOff = s.regionOffset;
    const baseRow = regionOff ? regionOff.row0 : 0;
    const baseCol = regionOff ? regionOff.col0 : 0;

    // 板边轮廓（四边 margin 一致取整，避免对角 1px 不对称）
    const viewScale = s.mode === 'placement' ? 1 : s.view.scale;
    const marginDevX = Math.round((board.marginMm / s.calibration.mmPerDevicePxX) * viewScale);
    const marginDevY = Math.round((board.marginMm / s.calibration.mmPerDevicePxY) * viewScale);
    const boardX0 = Math.round(originX) - marginDevX;
    const boardY0 = Math.round(originY) - marginDevY;
    const regionCols = regionOff ? regionOff.cols : board.cols;
    const regionRows = regionOff ? regionOff.rows : board.rows;
    const boardX1 = Math.round(originX + regionCols * pitchDevX) + marginDevX;
    const boardY1 = Math.round(originY + regionRows * pitchDevY) + marginDevY;

    ctx.strokeStyle = tokens.gridLineMajor;
    ctx.lineWidth = 2;
    ctx.strokeRect(boardX0, boardY0, boardX1 - boardX0, boardY1 - boardY0);

    // 空格底色（先画：网格线/编号必须压在它上面，否则被棋盘格盖住——开关失效的根因）
    if (pitchDevX > 6 && pitchDevY > 6) {
      // 棋盘格：勾选后空格画成经典「透明马赛克」（整格浅色 + 对角两象限深色），
      // 去背景/留空区域一眼可辨；关闭则用主题空格色（或发光底板纯黑）
      if (board.emptyCheckerboard === true) {
        ctx.fillStyle = '#f2f2f2';
        for (let r = vis.row0; r <= vis.row1; r++) {
          for (let c = vis.col0; c <= vis.col1; c++) {
            const localR = r - baseRow;
            const localC = c - baseCol;
            const x0 = Math.round(originX + localC * pitchDevX);
            const y0 = Math.round(originY + localR * pitchDevY);
            const x1 = Math.round(originX + (localC + 1) * pitchDevX);
            const y1 = Math.round(originY + (localR + 1) * pitchDevY);
            ctx.fillRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
          }
        }
        ctx.fillStyle = '#c9c9c9';
        for (let r = vis.row0; r <= vis.row1; r++) {
          for (let c = vis.col0; c <= vis.col1; c++) {
            const localR = r - baseRow;
            const localC = c - baseCol;
            const x0 = Math.round(originX + localC * pitchDevX);
            const y0 = Math.round(originY + localR * pitchDevY);
            const x1 = Math.round(originX + (localC + 1) * pitchDevX);
            const y1 = Math.round(originY + (localR + 1) * pitchDevY);
            const mx = (x0 + x1) / 2;
            const my = (y0 + y1) / 2;
            ctx.fillRect(x0 + 1, y0 + 1, mx - x0 - 1, my - y0 - 1);
            ctx.fillRect(mx, my, x1 - mx - 1, y1 - my - 1);
          }
        }
      } else {
        ctx.fillStyle = resolveEmptyCellFill(tokens);
        for (let r = vis.row0; r <= vis.row1; r++) {
          for (let c = vis.col0; c <= vis.col1; c++) {
            const localR = r - baseRow;
            const localC = c - baseCol;
            const x0 = Math.round(originX + localC * pitchDevX);
            const y0 = Math.round(originY + localR * pitchDevY);
            const x1 = Math.round(originX + (localC + 1) * pitchDevX);
            const y1 = Math.round(originY + (localR + 1) * pitchDevY);
            ctx.fillRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
          }
        }
      }
    }

    // 网格线
    if (board.showGrid) {
      // 细线
      ctx.strokeStyle = tokens.gridLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = vis.col0; c <= vis.col1 + 1; c++) {
        if (board.showMajorGrid && board.majorEvery > 0 && (c - baseCol) % board.majorEvery === 0) continue;
        const localC = c - baseCol;
        const x = Math.round(originX + localC * pitchDevX) + 0.5;
        const yTop = Math.round(originY + (vis.row0 - baseRow) * pitchDevY);
        const yBot = Math.round(originY + (vis.row1 + 1 - baseRow) * pitchDevY);
        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yBot);
      }
      for (let r = vis.row0; r <= vis.row1 + 1; r++) {
        if (board.showMajorGrid && board.majorEvery > 0 && (r - baseRow) % board.majorEvery === 0) continue;
        const localR = r - baseRow;
        const y = Math.round(originY + localR * pitchDevY) + 0.5;
        const xLeft = Math.round(originX + (vis.col0 - baseCol) * pitchDevX);
        const xRight = Math.round(originX + (vis.col1 + 1 - baseCol) * pitchDevX);
        ctx.moveTo(xLeft, y);
        ctx.lineTo(xRight, y);
      }
      ctx.stroke();

      // 主线（每 majorEvery 格加粗）
      if (board.showMajorGrid && board.majorEvery > 0) {
        ctx.strokeStyle = tokens.gridLineMajor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let c = vis.col0; c <= vis.col1 + 1; c++) {
          if ((c - baseCol) % board.majorEvery !== 0 && c !== baseCol) continue;
          const localC = c - baseCol;
          const x = Math.round(originX + localC * pitchDevX) + 0.5;
          const yTop = Math.round(originY + (vis.row0 - baseRow) * pitchDevY);
          const yBot = Math.round(originY + (vis.row1 + 1 - baseRow) * pitchDevY);
          ctx.moveTo(x, yTop);
          ctx.lineTo(x, yBot);
        }
        for (let r = vis.row0; r <= vis.row1 + 1; r++) {
          if ((r - baseRow) % board.majorEvery !== 0 && r !== baseRow) continue;
          const localR = r - baseRow;
          const y = Math.round(originY + localR * pitchDevY) + 0.5;
          const xLeft = Math.round(originX + (vis.col0 - baseCol) * pitchDevX);
          const xRight = Math.round(originX + (vis.col1 + 1 - baseCol) * pitchDevX);
          ctx.moveTo(xLeft, y);
          ctx.lineTo(xRight, y);
        }
        ctx.stroke();
      }
    }

    // 行列编号（始终钉在视口顶部/左侧可见：原点滚出屏幕或被标尺遮挡时自动让位）
    if (board.showNumbers && board.numberEvery > 0 && pitchDevX * board.numberEvery > 14) {
      ctx.fillStyle = tokens.numberText;
      const fontSize = Math.max(8, Math.min(12, pitchDevX * 0.45));
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 标尺开启时让过其 28px 宽度，避免编号被压在尺下
      const edgePad = board.showRuler ? 34 : 8;
      const colLabelY = Math.max(edgePad, Math.min(Math.round(originY) - 8, devH - 6));
      const rowLabelX = Math.max(edgePad, Math.min(Math.round(originX) - 10, devW - 6));
      for (let c = vis.col0; c <= vis.col1; c++) {
        if ((c - baseCol) % board.numberEvery !== 0) continue;
        const localC = c - baseCol;
        const cx = Math.round(originX + (localC + 0.5) * pitchDevX);
        ctx.fillText(String(c + 1), cx, colLabelY);
      }
      for (let r = vis.row0; r <= vis.row1; r++) {
        if ((r - baseRow) % board.numberEvery !== 0) continue;
        const localR = r - baseRow;
        const cy = Math.round(originY + (localR + 0.5) * pitchDevY);
        ctx.fillText(String(r + 1), rowLabelX, cy);
      }
    }
  }

  /* =============== L1：豆点层（单次遍历收集 + 按色批量绘制） =============== */

  private drawL1(
    s: RendererState,
    originX: number, originY: number,
    pitchDevX: number, pitchDevY: number,
    vis: { row0: number; row1: number; col0: number; col1: number },
    _devW: number, _devH: number,
  ): void {
    const layer = this.layers.getLayer(1);
    const ctx = layer.ctx;
    const tokens = s.canvasTokens;
    const board = s.board;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);

    const regionOff = s.regionOffset;
    const baseRow = regionOff ? regionOff.row0 : 0;
    const baseCol = regionOff ? regionOff.col0 : 0;
    const beadFillRatio = board.beadFillRatio;
    const cellShape = board.cellShape;

    // ---- Pass 1: 单次遍历，按色值桶收集几何数据 ----
    // buckets[colorIdx] = Float64Array-like [cx0,cy0,r0, cx1,cy1,r1, ...]
    const buckets: number[][] = [];
    const paletteLen = s.palette.colors.length;
    for (let ci = 0; ci < paletteLen; ci++) buckets.push([]);
    const placedCells: number[] = []; // [cx,cy,r, ...]

    for (let r = vis.row0; r <= vis.row1; r++) {
      for (let c = vis.col0; c <= vis.col1; c++) {
        const i = cellIndex(r, c, board.cols);
        const v = s.beads[i];
        if (v === 0) continue;
        const ci = v - 1;
        if (ci >= paletteLen) continue;

        const localR = r - baseRow;
        const localC = c - baseCol;
        // 独立取整铁律
        const x0 = Math.round(originX + localC * pitchDevX);
        const y0 = Math.round(originY + localR * pitchDevY);
        const x1 = Math.round(originX + (localC + 1) * pitchDevX);
        const y1 = Math.round(originY + (localR + 1) * pitchDevY);
        const cellW = x1 - x0;
        const cellH = y1 - y0;
        const cx = x0 + cellW / 2;
        const cy = y0 + cellH / 2;
        const radius = 0.5 * Math.min(cellW, cellH) * beadFillRatio;
        if (radius < 0.5) continue;

        const bucket = buckets[ci]!;
        bucket.push(cx, cy, radius, cellW, cellH);

        if (s.placedMask[i] === 1 && cellW >= 12) {
          placedCells.push(cx, cy, radius);
        }
      }
    }

    // ---- Pass 2: 按色批量绘制 ----
    // 预览增强：实体塑料豆是反射色，直接用屏幕 HEX 看起来会偏淡；
    // 仅在 L1 豆点层做轻微 saturate/contrast，不改 beads 数据与导出色号。
    // 拼豆模式黑底对比更强，再略提高一点饱和度；设计模式保持更克制，避免过艳。
    ctx.filter = s.mode === 'placement'
      ? 'saturate(1.14) contrast(1.04)'
      : 'saturate(1.10) contrast(1.03)';
    for (let ci = 0; ci < paletteLen; ci++) {
      const bucket = buckets[ci]!;
      if (bucket.length === 0) continue;
      const color = s.palette.colors[ci];
      if (!color) continue;
      const count = bucket.length / 5; // 每豆 5 个值: cx,cy,r,cellW,cellH

      // 批量填充
      ctx.fillStyle = color.hex;
      ctx.beginPath();
      for (let j = 0; j < count; j++) {
        const off = j * 5;
        const cx = bucket[off]!;
        const cy = bucket[off + 1]!;
        const radius = bucket[off + 2]!;
        if (cellShape === 'square') {
          ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
        } else {
          ctx.moveTo(cx + radius, cy);
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        }
      }
      ctx.fill();

      // ring 内圈挖空
      if (cellShape === 'ring') {
        ctx.fillStyle = tokens.canvasBg;
        ctx.beginPath();
        for (let j = 0; j < count; j++) {
          const off = j * 5;
          const cx = bucket[off]!;
          const cy = bucket[off + 1]!;
          const radius = bucket[off + 2]! * 0.45;
          if (radius < 0.5) continue;
          ctx.moveTo(cx + radius, cy);
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      // 批量描边
      ctx.strokeStyle = tokens.beadStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let hasStroke = false;
      for (let j = 0; j < count; j++) {
        const off = j * 5;
        const cellW = bucket[off + 3]!;
        const cellH = bucket[off + 4]!;
        if (cellW < 8 || cellH < 8) continue;
        hasStroke = true;
        const cx = bucket[off]!;
        const cy = bucket[off + 1]!;
        const radius = bucket[off + 2]!;
        if (cellShape === 'square') {
          ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
        } else {
          ctx.moveTo(cx + radius, cy);
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        }
      }
      if (hasStroke) ctx.stroke();

      // 暗色豆救援描边：与底色对比不足的颜色（黑豆 on 纯黑底等）
      // 再补一圈反向高对比边线；开关默认开，板参数「暗色描边」可关
      const edge = board.darkBeadEdge === false ? null : this.beadEdge(s.palette, ci, this.bgLumaOf(tokens));
      if (edge) {
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let hasEdge = false;
        for (let j = 0; j < count; j++) {
          const off = j * 5;
          const cellW = bucket[off + 3]!;
          const cellH = bucket[off + 4]!;
          if (cellW < 6 || cellH < 6) continue;
          hasEdge = true;
          const cx = bucket[off]!;
          const cy = bucket[off + 1]!;
          const radius = bucket[off + 2]!;
          if (cellShape === 'square') {
            ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
          } else {
            ctx.moveTo(cx + radius, cy);
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          }
        }
        if (hasEdge) ctx.stroke();
      }

      // 豆上色号：格子够大时在豆心叠加色号（开启「豆上色号」后生效）
      if (board.showColorCodes === true) {
        const code = s.palette.colors[ci]?.code;
        if (code) {
          const radius0 = bucket[2]!;
          ctx.font = `bold ${Math.min(12, Math.max(7, radius0 * 0.95))}px Consolas, 'Courier New', monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = this.codeTextColor(s.palette, ci);
          for (let j = 0; j < count; j++) {
            const off = j * 5;
            const cellW = bucket[off + 3]!;
            const cellH = bucket[off + 4]!;
            if (cellW < 13 || cellH < 13) continue;
            ctx.fillText(code, bucket[off]!, bucket[off + 1]! + 0.5);
          }
        }
      }
    }

    // 恢复默认滤镜，避免 placedMask 标记或后续图层继承 L1 增强
    ctx.filter = 'none';

    // placedMask 标记（统一批量绘制）
    if (placedCells.length > 0) {
      ctx.strokeStyle = tokens.selectionStroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const pCount = placedCells.length / 3;
      for (let j = 0; j < pCount; j++) {
        const off = j * 3;
        const cx = placedCells[off]!;
        const cy = placedCells[off + 1]!;
        const radius = placedCells[off + 2]!;
        const sz = radius * 0.5;
        ctx.moveTo(cx - sz * 0.5, cy);
        ctx.lineTo(cx - sz * 0.1, cy + sz * 0.4);
        ctx.lineTo(cx + sz * 0.5, cy - sz * 0.3);
      }
      ctx.stroke();
    }
  }

  /** 局部重绘 L1：只重绘脏瓦片内的格子 */
  private drawL1Partial(
    s: RendererState,
    originX: number, originY: number,
    pitchDevX: number, pitchDevY: number,
    vis: { row0: number; row1: number; col0: number; col1: number },
    tiles: DirtyTile[],
  ): void {
    if (tiles.length === 0) return;

    const layer = this.layers.getLayer(1);
    const ctx = layer.ctx;
    const tokens = s.canvasTokens;
    const board = s.board;
    // 与全量 L1 保持一致：脏矩形重绘也使用预览增强，避免编辑某颗豆后该格突然变淡
    ctx.filter = s.mode === 'placement'
      ? 'saturate(1.14) contrast(1.04)'
      : 'saturate(1.10) contrast(1.03)';
    const regionOff = s.regionOffset;
    const baseRow = regionOff ? regionOff.row0 : 0;
    const baseCol = regionOff ? regionOff.col0 : 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    for (const tile of tiles) {
      // 清除瓦片区域
      ctx.clearRect(tile.x0, tile.y0, tile.x1 - tile.x0, tile.y1 - tile.y0);

      // 计算该瓦片影响的格子范围
      const cStart = Math.max(vis.col0, Math.floor((tile.x0 - originX) / pitchDevX) + baseCol);
      const cEnd = Math.min(vis.col1, Math.ceil((tile.x1 - originX) / pitchDevX) + baseCol);
      const rStart = Math.max(vis.row0, Math.floor((tile.y0 - originY) / pitchDevY) + baseRow);
      const rEnd = Math.min(vis.row1, Math.ceil((tile.y1 - originY) / pitchDevY) + baseRow);

      for (let r = rStart; r <= rEnd; r++) {
        for (let c = cStart; c <= cEnd; c++) {
          const i = cellIndex(r, c, board.cols);
          const v = s.beads[i];
          if (v === 0) continue;
          const color = s.palette.colors[v - 1];
          if (!color) continue;

          const localR = r - baseRow;
          const localC = c - baseCol;
          const x0 = Math.round(originX + localC * pitchDevX);
          const y0 = Math.round(originY + localR * pitchDevY);
          const x1 = Math.round(originX + (localC + 1) * pitchDevX);
          const y1 = Math.round(originY + (localR + 1) * pitchDevY);
          const cellW = x1 - x0;
          const cellH = y1 - y0;
          const cx = x0 + cellW / 2;
          const cy = y0 + cellH / 2;
          const radius = 0.5 * Math.min(cellW, cellH) * board.beadFillRatio;
          if (radius < 0.5) continue;

          ctx.fillStyle = color.hex;
          ctx.beginPath();
          if (board.cellShape === 'square') {
            ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
          } else {
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          }
          ctx.fill();

          if (board.cellShape === 'ring') {
            ctx.fillStyle = tokens.canvasBg;
            ctx.beginPath();
            ctx.arc(cx, cy, radius * 0.45, 0, Math.PI * 2);
            ctx.fill();
          }

          if (cellW >= 8 && cellH >= 8) {
            ctx.strokeStyle = tokens.beadStroke;
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (board.cellShape === 'square') {
              ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
            } else {
              ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            }
            ctx.stroke();
          }

          // 暗色豆救援描边（与全量 L1 同款，保证局部重绘后观感一致）
          const edge = board.darkBeadEdge === false ? null : this.beadEdge(s.palette, v - 1, this.bgLumaOf(tokens));
          if (edge && cellW >= 6 && cellH >= 6) {
            ctx.strokeStyle = edge;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (board.cellShape === 'square') {
              ctx.rect(cx - radius, cy - radius, radius * 2, radius * 2);
            } else {
              ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            }
            ctx.stroke();
          }

          if (s.board.showColorCodes === true && cellW >= 13 && cellH >= 13) {
            const code = s.palette.colors[v - 1]?.code;
            if (code) {
              ctx.font = `bold ${Math.min(12, Math.max(7, radius * 0.95))}px Consolas, 'Courier New', monospace`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = this.codeTextColor(s.palette, v - 1);
              ctx.fillText(code, cx, cy + 0.5);
            }
          }

          if (s.placedMask[i] === 1 && cellW >= 12) {
            ctx.strokeStyle = tokens.selectionStroke;
            ctx.lineWidth = 1.5;
            const sz = radius * 0.5;
            ctx.beginPath();
            ctx.moveTo(cx - sz * 0.5, cy);
            ctx.lineTo(cx - sz * 0.1, cy + sz * 0.4);
            ctx.lineTo(cx + sz * 0.5, cy - sz * 0.3);
            ctx.stroke();
          }
        }
      }
    }
    ctx.filter = 'none';
  }

  /* =============== L2：筛选层 =============== */

  private drawL2(
    s: RendererState,
    originX: number, originY: number,
    pitchDevX: number, pitchDevY: number,
    vis: { row0: number; row1: number; col0: number; col1: number },
    _devW: number, _devH: number,
  ): void {
    const layer = this.layers.getLayer(2);
    const ctx = layer.ctx;
    const tokens = s.canvasTokens;
    const board = s.board;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);

    // panel + 手机点亮图案不依赖筛选色（亮点由 App 的掩码决定），设计模式未选筛选色也要画；
    // 其余档位仍要求已选筛选色。
    if (s.filterMode === 'off' || (s.filterColorIndex < 0 && !(s.filterMode === 'panel' && s.vbLight))) return;

    // panel（发光板）走专用快速路径：切色 / 收手机图案是拼豆模式的高频重绘，
    // 整板一次底色 + 只逐格画亮点，比通用逐格循环少一个数量级的调用（见 drawL2Panel）。
    if (s.filterMode === 'panel') {
      this.drawL2Panel(s, originX, originY, pitchDevX, pitchDevY, vis);
      return;
    }

    const filterValue = s.filterColorIndex + 1; // beads 存的是索引+1
    const regionOff = s.regionOffset;
    const baseRow = regionOff ? regionOff.row0 : 0;
    const baseCol = regionOff ? regionOff.col0 : 0;

    // 固定开销提出循环（与 drawL2Panel 同模式）：
    // 原来每个压暗格调一次 bgLumaOf、每个发光格调一次 getGlowPrefs 并重算目标色
    const bgLuma = this.bgLumaOf(tokens);
    const glowBoost = getGlowPrefs().glowBoost;
    const targetHex = s.palette.colors[s.filterColorIndex]?.hex ?? '#fff';

    for (let r = vis.row0; r <= vis.row1; r++) {
      for (let c = vis.col0; c <= vis.col1; c++) {
        const i = cellIndex(r, c, board.cols);
        const v = s.beads[i];
        const isTarget = v === filterValue;

        const localR = r - baseRow;
        const localC = c - baseCol;
        const x0 = Math.round(originX + localC * pitchDevX);
        const y0 = Math.round(originY + localR * pitchDevY);
        const x1 = Math.round(originX + (localC + 1) * pitchDevX);
        const y1 = Math.round(originY + (localR + 1) * pitchDevY);
        const cellW = x1 - x0;
        const cellH = y1 - y0;

        switch (s.filterMode) {
          case 'only': {
            if (!isTarget) {
              // 非目标：极淡轮廓
              ctx.strokeStyle = tokens.emptyCellStroke;
              ctx.lineWidth = 0.5;
              ctx.globalAlpha = 0.3;
              ctx.strokeRect(x0 + 1, y0 + 1, cellW - 2, cellH - 2);
              ctx.globalAlpha = 1;
            }
            break;
          }
          case 'dim': {
            if (!isTarget && v !== 0) {
              // 非目标有豆：压暗；深色豆用更浅的压暗层，保住救援描边轮廓可辨（#56）
              const rgbB = s.palette.colors[v - 1]?.rgb;
              ctx.fillStyle = rgbB ? dimVeilStyle(yiqLuma(rgbB), bgLuma) : 'rgba(0,0,0,0.65)';
              ctx.fillRect(x0, y0, cellW, cellH);
            } else if (isTarget && tokens.highlightGlow) {
              // 目标：发光（shadowBlur × glowBoost）
              ctx.shadowColor = targetHex;
              ctx.shadowBlur = 8 * glowBoost;
              ctx.fillStyle = 'rgba(255,255,255,0.15)';
              ctx.fillRect(x0 + 2, y0 + 2, cellW - 4, cellH - 4);
              ctx.shadowBlur = 0;
            }
            break;
          }
          case 'hide': {
            if (!isTarget) {
              // 完全隐藏：与 L0 空格同色覆盖（glowDark+pureBlackEmpty 时纯黑，视觉无缝）
              ctx.fillStyle = resolveEmptyCellFill(tokens);
              ctx.fillRect(x0, y0, cellW, cellH);
            }
            break;
          }
          // case 'panel' 不在此处：已在函数开头分流到 drawL2Panel 快速路径
        }
      }
    }
  }

  /**
   * 发光板（panel 档）快速路径 —— 拼豆模式的高频重绘（每次切色 / 每次收到手机图案）。
   *
   * 与逐格通用循环语义等价，但省掉固定大头：
   *  · 熄灭格不再逐格 fillRect（2 万可视格 = 2 万次调用），而是整块可视板区**一次填充**。
   *    格子边界本就由同一套 Math.round(origin + n·pitch) 计算、逐格矩形无缝拼合，
   *    其并集恰为 [首格x0, 末格x1]，单块矩形逐像素覆盖同一区域；
   *  · 无手机图案时全部亮点共用同一 shadowColor → shadow 状态提出循环（N 次切换 → 1 次）；
   *  · getGlowPrefs / blur 值提出循环，不再每亮格调一次。
   *
   * 两种数据源（与 drawL2Partial 的 panel 分支逐条对应，改动必须两处同步）：
   *  · 手机点亮（vbLight）：亮灭由 App 掩码决定（不看本地已拼进度），点亮格按 App
   *    下发的**原色**整格填充 + 同色光晕 —— 主画布直接显示整幅手机图案；
   *  · 无手机图案：只亮「当前色 ∩ 未拼」，其余一律纯黑。
   * 熄灭底必须**不透明纯黑**（不能用半透明 emptyCell，否则下层 L1 豆色会透出来）。
   */
  private drawL2Panel(
    s: RendererState,
    originX: number, originY: number,
    pitchDevX: number, pitchDevY: number,
    vis: { row0: number; row1: number; col0: number; col1: number },
  ): void {
    const ctx = this.layers.getLayer(2).ctx;
    const board = s.board;
    const baseRow = s.regionOffset ? s.regionOffset.row0 : 0;
    const baseCol = s.regionOffset ? s.regionOffset.col0 : 0;

    // 区块不在视口内：无可画（原逐格循环同样一次都不会执行）
    if (vis.row1 < vis.row0 || vis.col1 < vis.col0) return;

    // 熄灭底：整块一次填充（vis 已被 computeVisibleRange 夹进板与区块）
    const bx0 = Math.round(originX + (vis.col0 - baseCol) * pitchDevX);
    const by0 = Math.round(originY + (vis.row0 - baseRow) * pitchDevY);
    const bx1 = Math.round(originX + (vis.col1 - baseCol + 1) * pitchDevX);
    const by1 = Math.round(originY + (vis.row1 - baseRow + 1) * pitchDevY);
    ctx.fillStyle = PANEL_OFF_FILL;
    ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);

    const blur = PANEL_GLOW_BLUR * getGlowPrefs().glowBoost;
    const vb = s.vbLight;
    if (vb) {
      // 手机点亮：逐格原色（颜色各异 → shadowColor 逐格设置，blur 只设一次）
      ctx.shadowBlur = blur;
      for (let r = vis.row0; r <= vis.row1; r++) {
        if (r >= vb.h) break; // 图案以下的行全为熄灭，底色已盖
        const maskRow = r * vb.w;
        for (let c = vis.col0; c <= vis.col1; c++) {
          if (c >= vb.w || vb.mask[maskRow + c] !== 1) continue;
          const x0 = Math.round(originX + (c - baseCol) * pitchDevX);
          const y0 = Math.round(originY + (r - baseRow) * pitchDevY);
          const x1 = Math.round(originX + (c - baseCol + 1) * pitchDevX);
          const y1 = Math.round(originY + (r - baseRow + 1) * pitchDevY);
          const i4 = (maskRow + c) * 4;
          const rgb = `rgb(${vb.rgba[i4] ?? 0},${vb.rgba[i4 + 1] ?? 0},${vb.rgba[i4 + 2] ?? 0})`;
          ctx.shadowColor = rgb;
          ctx.fillStyle = rgb;
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
      }
      ctx.shadowBlur = 0;
    } else {
      // 无手机图案：亮 = 当前色 ∩ 未拼，全部共用同一光晕色 → shadow 提出循环
      ctx.shadowColor = s.palette.colors[s.filterColorIndex]?.hex ?? '#fff';
      ctx.shadowBlur = blur;
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      const filterValue = s.filterColorIndex + 1;
      const placed = s.placedMask;
      for (let r = vis.row0; r <= vis.row1; r++) {
        const base = r * board.cols;
        for (let c = vis.col0; c <= vis.col1; c++) {
          const i = base + c;
          if (s.beads[i] !== filterValue || placed[i] === 1) continue;
          const x0 = Math.round(originX + (c - baseCol) * pitchDevX);
          const y0 = Math.round(originY + (r - baseRow) * pitchDevY);
          const x1 = Math.round(originX + (c - baseCol + 1) * pitchDevX);
          const y1 = Math.round(originY + (r - baseRow + 1) * pitchDevY);
          ctx.fillRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
        }
      }
      ctx.shadowBlur = 0;
    }
  }

  /** 局部重绘 L2：只重绘脏瓦片内的格子 */
  private drawL2Partial(
    s: RendererState,
    originX: number, originY: number,
    pitchDevX: number, pitchDevY: number,
    vis: { row0: number; row1: number; col0: number; col1: number },
    tiles: DirtyTile[],
  ): void {
    // 与全量 drawL2 的 guard 逐条对应（panel+vbLight 不依赖筛选色）
    if (s.filterMode === 'off' || (s.filterColorIndex < 0 && !(s.filterMode === 'panel' && s.vbLight))) return;
    if (tiles.length === 0) return;

    const layer = this.layers.getLayer(2);
    const ctx = layer.ctx;
    const tokens = s.canvasTokens;
    const board = s.board;
    const regionOff = s.regionOffset;
    const baseRow = regionOff ? regionOff.row0 : 0;
    const baseCol = regionOff ? regionOff.col0 : 0;
    const filterValue = s.filterColorIndex + 1;
    // 光晕参数提出循环（与 drawL2Panel 同步，改动必须两处同步）：getGlowPrefs 每次
    // 调用都分配新对象，原先是每个亮点格调一次。shadowBlur 的 set/reset 仍留在
    // 分支内——脏瓦片里熄灭格与亮点格交错，提出去会让熄灭格继承上一亮点格的
    // shadowColor 光晕（与全量整块底色先行填充的绘制次序不同，语义会变）。
    const glowPrefs = getGlowPrefs();
    const panelBlur = PANEL_GLOW_BLUR * glowPrefs.glowBoost;

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    for (const tile of tiles) {
      ctx.clearRect(tile.x0, tile.y0, tile.x1 - tile.x0, tile.y1 - tile.y0);

      const cStart = Math.max(vis.col0, Math.floor((tile.x0 - originX) / pitchDevX) + baseCol);
      const cEnd = Math.min(vis.col1, Math.ceil((tile.x1 - originX) / pitchDevX) + baseCol);
      const rStart = Math.max(vis.row0, Math.floor((tile.y0 - originY) / pitchDevY) + baseRow);
      const rEnd = Math.min(vis.row1, Math.ceil((tile.y1 - originY) / pitchDevY) + baseRow);

      for (let r = rStart; r <= rEnd; r++) {
        for (let c = cStart; c <= cEnd; c++) {
          const i = cellIndex(r, c, board.cols);
          const v = s.beads[i];
          const isTarget = v === filterValue;
          const localR = r - baseRow;
          const localC = c - baseCol;
          const x0 = Math.round(originX + localC * pitchDevX);
          const y0 = Math.round(originY + localR * pitchDevY);
          const x1 = Math.round(originX + (localC + 1) * pitchDevX);
          const y1 = Math.round(originY + (localR + 1) * pitchDevY);
          const cellW = x1 - x0;
          const cellH = y1 - y0;

          if (s.filterMode === 'dim' && !isTarget && v !== 0) {
            // 深色豆浅压暗（#56，与全量 L2 同规则）
            const rgbB = s.palette.colors[v - 1]?.rgb;
            ctx.fillStyle = rgbB ? dimVeilStyle(yiqLuma(rgbB), this.bgLumaOf(tokens)) : 'rgba(0,0,0,0.65)';
            ctx.fillRect(x0, y0, cellW, cellH);
          } else if (s.filterMode === 'dim' && isTarget && tokens.highlightGlow) {
            // 局部重绘时也补上目标格发光（glowPrefs 已提出循环）
            ctx.shadowColor = s.palette.colors[s.filterColorIndex]?.hex ?? '#fff';
            ctx.shadowBlur = 8 * glowPrefs.glowBoost;
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.fillRect(x0 + 2, y0 + 2, cellW - 4, cellH - 4);
            ctx.shadowBlur = 0;
          } else if (s.filterMode === 'hide' && !isTarget) {
            ctx.fillStyle = resolveEmptyCellFill(tokens);
            ctx.fillRect(x0, y0, cellW, cellH);
          } else if (s.filterMode === 'only' && !isTarget) {
            ctx.strokeStyle = tokens.emptyCellStroke;
            ctx.lineWidth = 0.5;
            ctx.globalAlpha = 0.3;
            ctx.strokeRect(x0 + 1, y0 + 1, cellW - 2, cellH - 2);
            ctx.globalAlpha = 1;
          } else if (s.filterMode === 'panel') {
            // 与全量 drawL2Panel 的语义逐条对应（脏瓦片重绘必须与快速路径一致）
            const vb = s.vbLight;
            const lit = vb
              ? (c < vb.w && r < vb.h && vb.mask[r * vb.w + c] === 1)
              : isTarget && s.placedMask[i] !== 1;
            if (!lit) {
              ctx.fillStyle = PANEL_OFF_FILL;
              ctx.fillRect(x0, y0, cellW, cellH);
            } else if (vb) {
              // 手机图案原色整格填充（与全量分支同规则；blur 值已提出循环）
              const i4 = (r * vb.w + c) * 4;
              const rgb = `rgb(${vb.rgba[i4] ?? 0},${vb.rgba[i4 + 1] ?? 0},${vb.rgba[i4 + 2] ?? 0})`;
              ctx.shadowColor = rgb;
              ctx.shadowBlur = panelBlur;
              ctx.fillStyle = rgb;
              ctx.fillRect(x0, y0, cellW, cellH);
              ctx.shadowBlur = 0;
            } else {
              ctx.shadowColor = s.palette.colors[s.filterColorIndex]?.hex ?? '#fff';
              ctx.shadowBlur = panelBlur;
              ctx.fillStyle = 'rgba(255,255,255,0.22)';
              ctx.fillRect(x0 + 1, y0 + 1, cellW - 2, cellH - 2);
              ctx.shadowBlur = 0;
            }
          }
        }
      }
    }
  }

  /* =============== L3：交互层 =============== */

  private drawL3(
    s: RendererState,
    originX: number, originY: number,
    pitchDevX: number, pitchDevY: number,
    _devW: number, _devH: number,
  ): void {
    const layer = this.layers.getLayer(3);
    const ctx = layer.ctx;
    const tokens = s.canvasTokens;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);

    const regionOff = s.regionOffset;
    const baseRow = regionOff ? regionOff.row0 : 0;
    const baseCol = regionOff ? regionOff.col0 : 0;

    // 悬停高亮
    if (s.hoverCell) {
      const localR = s.hoverCell.row - baseRow;
      const localC = s.hoverCell.col - baseCol;
      // 笔刷预览：画笔/橡皮且 size>1 时，框住整个 N×N 盖章范围
      const brushActive = (s.tool === 'pen' || s.tool === 'eraser') && s.brushSize > 1;
      const half = brushActive ? Math.floor((s.brushSize - 1) / 2) : 0;
      const span = brushActive ? s.brushSize : 1;
      const cStart = localC - half;
      const rStart = localR - half;
      const x0 = Math.round(originX + cStart * pitchDevX);
      const y0 = Math.round(originY + rStart * pitchDevY);
      const x1 = Math.round(originX + (cStart + span) * pitchDevX);
      const y1 = Math.round(originY + (rStart + span) * pitchDevY);

      // 笔刷范围淡填充（让覆盖的格子一眼可见）
      if (brushActive) {
        ctx.fillStyle = tokens.selectionStroke;
        ctx.globalAlpha = 0.15;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.globalAlpha = 1;
      }

      ctx.strokeStyle = tokens.selectionStroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);

      if (tokens.highlightGlow) {
        ctx.shadowColor = tokens.selectionStroke;
        ctx.shadowBlur = 10;
        ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
        ctx.shadowBlur = 0;
      }
    }

    // 分区括标（L 形对齐标记 + 区块编号）
    if (regionOff && regionOff.rows > 0 && regionOff.cols > 0) {
      const rx0 = Math.round(originX);
      const ry0 = Math.round(originY);
      const rx1 = Math.round(originX + regionOff.cols * pitchDevX);
      const ry1 = Math.round(originY + regionOff.rows * pitchDevY);
      const armLen = Math.min(30, (rx1 - rx0) * 0.15);
      const lw = 3;

      ctx.strokeStyle = tokens.selectionStroke;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';

      // 四角 L 形
      // TL
      ctx.beginPath(); ctx.moveTo(rx0, ry0 + armLen); ctx.lineTo(rx0, ry0); ctx.lineTo(rx0 + armLen, ry0); ctx.stroke();
      // TR
      ctx.beginPath(); ctx.moveTo(rx1 - armLen, ry0); ctx.lineTo(rx1, ry0); ctx.lineTo(rx1, ry0 + armLen); ctx.stroke();
      // BL
      ctx.beginPath(); ctx.moveTo(rx0, ry1 - armLen); ctx.lineTo(rx0, ry1); ctx.lineTo(rx0 + armLen, ry1); ctx.stroke();
      // BR
      ctx.beginPath(); ctx.moveTo(rx1 - armLen, ry1); ctx.lineTo(rx1, ry1); ctx.lineTo(rx1, ry1 - armLen); ctx.stroke();

      // 区块编号（标签规则统一走 core/region.regionLabel）
      const regionIdx = s.region.activeIndex;
      const splitsX = s.region.splitsX;
      const iy = Math.floor(regionIdx / splitsX);
      const ix = regionIdx % splitsX;
      const label = regionLabel(ix, iy);
      ctx.font = `bold ${Math.max(12, armLen * 0.6)}px sans-serif`;
      ctx.fillStyle = tokens.selectionStroke;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, rx0 + 6, ry0 + 6);
    }
  }

  /* =============== 合成 =============== */

  /**
   * 把四层缓存合成到主画布，可带仿射差量（手势期）或恒等（非手势期）。
   *
   * - 恒等（tx=ty=0, k=1）：与旧实现行为逐字节一致（clearRect + 逐层 drawImage，不铺底）。
   * - 差量：源矩形仍恒取视口 0-based 区 (0,0,devW,devH)（#18 约定，层画布的 overscan 区
   *   无内容不可用），目标矩形 = 仿射映射 (tx, ty, devW*k, devH*k)。先以主题底色铺满
   *   主画布兜住露白（缩小时四周、平移时尾随边），再逐层贴图。
   *
   * 手势差量推导：同一格子在两个视图下的设备像素位置
   *   x0 = ox0 + c*pitch*scale0，x1 = ox1 + c*pitch*scale1
   *   ⇒ x1 = k*x0 + (ox1 − k*ox0)，k = scale1/scale0；对缓存像素逐点成立，四层共用同一变换。
   */
  private blitLayers(devW: number, devH: number, s: RendererState, tx: number, ty: number, k: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const identity = tx === 0 && ty === 0 && k === 1;
    ctx.clearRect(0, 0, devW, devH);

    if (!identity) {
      // 露白铺底：手势差量 blit 的目标矩形可能小于视口（缩小/平移尾随边），
      // 先用当前主题底色填满，避免露出透明底（DOM 背景）造成闪烁感
      ctx.fillStyle = s.canvasTokens.canvasBg;
      ctx.fillRect(0, 0, devW, devH);
    }

    // 发光增强：亮度/饱和度补偿透明板色偏（仅对 L1 豆点层应用）
    const glow = getGlowPrefs();
    const needFilter = glow.brightness !== 1 || glow.saturation !== 1;

    for (let i = 0; i <= 3; i++) {
      const layer = this.layers.getLayer(i as LayerId);
      if (layer.width === 0) continue;
      if (needFilter && i === 1) {
        ctx.filter = `brightness(${glow.brightness}) saturate(${glow.saturation})`;
      }
      // 源矩形 0-based：绘制内容落在 layer 的视口 0-based 区，overscan 仅为画布预留边距；
      // 目标矩形 = 仿射映射后的位置（恒等时恰好 = (0,0,devW,devH)）
      ctx.drawImage(layer.canvas, 0, 0, devW, devH, tx, ty, devW * k, devH * k);
      if (needFilter && i === 1) {
        ctx.filter = 'none';
      }
    }
  }
}

/* =============== 辅助函数 =============== */

