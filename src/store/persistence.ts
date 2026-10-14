/**
 * store/persistence.ts —— 自动保存与项目存取编排。
 *
 * 职责边界：本文件只做**编排**（订阅 store → 序列化 → 落地 → 恢复），
 * 编解码与严格校验在 io/project.ts，最近列表在 io/recent.ts，文本导出在 io/exporters.ts。
 *
 * 【自动保存】
 *   startAutoSave() 订阅 usePdbStore，**3 秒防抖**后写入 localStorage `pindou-studio:autosave:v1`；
 *   Electron 下**同时**镜像到 appData（`pdb:appdata-write`）。镜像失败不影响 localStorage 主保存，
 *   也绝不抛异常（静默 + 一次性 toast）。
 *
 * 【只在真实内容变化时触发】
 *   typed array 的内容变更 zustand 感知不到，因此以 `beadsVersion` 为准；
 *   其余只比较 **引用**（board / palette / calibration）与少量低频字段（paletteId / theme / layout / mode）。
 *   刻意**不**纳入 view（平移缩放每帧变）、tool、filterColorIndex、region.activeIndex、toasts —— 纯 UI 状态。
 *
 * 【恢复项目】必须走 store 现有 actions：setBoardConfig → setPalette → replaceBeads → setCalibration → clearHistory。
 *   顺序有讲究：setBoardConfig 在 cols/rows 变化时会重建 typed array，所以 replaceBeads 必须在其之后调用。
 *
 * 【命名说明】方案里写的镜像路径是 `autosave/current.pdp.json`；但 appData IPC 的安全消毒
 *   **拒绝任何路径分隔符**（防路径穿越，见 electron/main.mjs），故此处扁平化为单级文件名
 *   `autosave-current.pdp.json`，仍可用 `listAppData('autosave')` 前缀检索到。
 */
import type { AppMode, BeadPalette, FilterMode, LayoutId, ProjectFile, ThemeId, ToolId } from '@/core/types';
import { getBridge, isElectron } from '@/io/bridge';
import {
  MAX_SOURCE_IMAGE_BYTES,
  dataUrlByteSize,
  dataUrlToText,
  projectFileName,
  projectFromText,
  projectToRuntime,
  projectToText,
  sanitizeFileName,
  serializeProject,
  type ProjectRuntime,
  type ProjectSource,
} from '@/io/project';
import { compressDataUrlToFit } from '@/imaging/loader';
import {
  addRecent,
  getRecent,
  listRecent,
  normalizeRecentEntry,
  recentEntryFromProject,
  type RecentEntry,
} from '@/io/recent';
import { BUILTIN_PALETTE_IDS, getPalette } from '@/palettes';
import { DEFAULT_BOARD, usePdbStore, type PdbState } from '@/store/index';

/* ==================== 常量 ==================== */

/** localStorage 里的自动保存 key（契约，UI/文档均按此名） */
export const AUTOSAVE_LS_KEY = 'pindou-studio:autosave:v1';
/** 防抖时长（变更后 3s 写盘） */
export const AUTOSAVE_DEBOUNCE_MS = 3000;
/** appData 镜像文件名（受白名单约束，不含路径分隔符） */
export const AUTOSAVE_APPDATA_NAME = 'autosave-current.pdp.json';
/** 自动保存文件的魔数 */
export const AUTOSAVE_KIND = 'pindou-studio/autosave';
/** 原生打开对话框的过滤器 */
export const PROJECT_OPEN_FILTERS = [
  { name: 'PinDou Studio 项目 (*.pdp.json)', extensions: ['pdp.json', 'json'] },
  { name: '全部文件', extensions: ['*'] },
];

/* ==================== 类型 ==================== */

/** 随自动保存一起记住的会话状态（不属于 ProjectFile 契约，是本模块自己的信封字段） */
export interface AutosaveSession {
  theme: ThemeId;
  layout: LayoutId;
  mode: AppMode;
  tool: ToolId;
  activeColorIndex: number;
  region: { splitsX: number; splitsY: number; activeIndex: number };
  filter: { colorIndex: number; mode: FilterMode };
}

/** 自动保存文件（信封 = 元信息 + 标准 ProjectFile + 会话状态） */
export interface AutosaveFile {
  kind: typeof AUTOSAVE_KIND;
  version: 1;
  savedAt: string;
  appVersion: string;
  project: ProjectFile;
  session: AutosaveSession | null;
}

export interface SaveOutcome {
  ok: boolean;
  /** 用户在原生对话框点了取消 */
  cancelled: boolean;
  path: string | null;
  name: string;
  error?: string;
}

export interface OpenOutcome {
  ok: boolean;
  cancelled: boolean;
  path: string | null;
  name?: string;
  error?: string;
}

export interface ProjectInfo {
  name: string;
  path: string | null;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
  /** 有未落盘的改动（自上次显式保存/打开后内容变过） */
  dirty: boolean;
}

/* ==================== 模块级会话状态 ====================
 * store 的形状是  契约、不可增字段，故「当前项目名/路径/源图」由本模块持有。
 *  的 SaveDialog / OpenDialog / RecentList 通过下方 getter/setter 读写。
 */

let currentName = '未命名项目';
let currentPath: string | null = null;
let currentCreatedAt = new Date().toISOString();
let currentSourceImage: { name: string; dataUrl: string } | null = null;
let appVersion = '0.1.0';
let dirty = false;
let lastSavedAt: string | null = null;

let stopAutoSave: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorWarned = false;
const toastThrottle = new Map<string, number>();

/** 源图素材变更订阅（供右侧「素材」面板使用，避免把 UI 状态塞进核心 store） */
const sourceImageListeners = new Set<() => void>();

export function subscribeProjectSourceImage(listener: () => void): () => void {
  sourceImageListeners.add(listener);
  return () => {
    sourceImageListeners.delete(listener);
  };
}

function emitProjectSourceImageChanged(): void {
  for (const listener of sourceImageListeners) listener();
}

/**
 * 【缺陷 #2a 守卫】启动以来 store 是否出现过非空豆数据。
 *
 * 启动时若磁盘上存在待恢复快照（「恢复上次会话」弹窗未决），store 处于初见空状态；
 * 此期间应用初始化触碰 store 会触发 3s 防抖写入、beforeunload 也会 flush——若放行，
 * 序列化得到的空项目会抢在用户点击「恢复」之前覆盖磁盘上的含豆快照（静默丢数据）。
 * 用户画出第一颗豆或恢复成功后 store 必然出现非空 beads，本标志置 true，自动保存完全
 * 恢复正常——既不影响正常使用期的防抖写入与关窗 flush，也天然区分「用户主动清空画布」
 * （标志已为 true，空快照照常写入）。
 */
let seenNonEmptyBeads = false;

/**
 * 【恢复守卫解锁】恢复弹窗的决策（恢复 / 丢弃）是否已完成。
 *
 * 原缺陷：seenNonEmptyBeads 守卫只在「画出第一颗豆或恢复成功」时解锁，
 * 而 discardAutosave 只清存储不解锁 → 「打开恢复弹窗 → 点丢弃 → 仅调整板参数/校准/主题 → 关窗」
 * 的会话在 beforeunload flush 时依然被拦截，什么都不落盘。
 * 现在用户在弹窗里做出任一决策（restoreAutosave 进入 / discardAutosave 调用）即置 true，
 * 弹窗未决期的拦截保持不变；有豆会话行为不变。
 */
let restoreDecisionResolved = false;

/* ==================== 小工具 ==================== */

function ls(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * ToastKind 契约里没有 'error'（只有 info/success/warning/danger），
 * 故错误一律用 'danger'。30 秒内同文案不重复弹，避免自动保存失败刷屏。
 */
function toast(kind: 'info' | 'success' | 'warning' | 'danger', message: string, duration = 4200): void {
  try {
    const now = Date.now();
    const key = `${kind}:${message}`;
    const prev = toastThrottle.get(key);
    if (prev && now - prev < 30000) return;
    toastThrottle.set(key, now);
    usePdbStore.getState().pushToast(kind, message, duration);
  } catch {
    /* store 尚未就绪（极早期调用）时静默 */
  }
}

function toastError(message: string): void {
  toast('danger', message, 6000);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** beads 全零线性扫描（typed array 内容变更 zustand 感知不到，签名比较无法覆盖内容本身） */
function hasAnyBead(beads: Uint16Array | null | undefined): boolean {
  if (!beads) return false;
  for (let i = 0; i < beads.length; i++) {
    if (beads[i] !== 0) return true;
  }
  return false;
}

/** 取注册表里的基准色板（id 不认识时 getPalette 会回落到默认色板，不会抛错） */
function safeBasePalette(baseId: string): BeadPalette | null {
  try {
    return getPalette(baseId);
  } catch {
    return null;
  }
}

/** 当前内存色板相对注册表是否被用户改动过（决定 ProjectFile.palette.customized） */
function isPaletteCustomized(state: PdbState): boolean {
  if (!BUILTIN_PALETTE_IDS.includes(state.paletteId)) return true;
  try {
    const base = getPalette(state.paletteId);
    if (base.colors.length !== state.palette.colors.length) return true;
    for (let i = 0; i < base.colors.length; i++) {
      const a = base.colors[i];
      const b = state.palette.colors[i];
      if (!a || !b) return true;
      if (a.hex !== b.hex || a.code !== b.code || a.name !== b.name || a.nameZh !== b.nameZh) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** 异步刷新 appVersion（失败保持默认值，不阻塞任何流程） */
async function refreshAppVersion(): Promise<void> {
  try {
    const info = await getBridge().getAppInfo();
    if (info && typeof info.version === 'string' && info.version.length > 0) appVersion = info.version;
  } catch {
    /* 静默 */
  }
}

/* ==================== 变化检测（廉价签名） ==================== */

interface ContentSignature {
  beadsVersion: number;
  board: unknown;
  palette: unknown;
  paletteId: string;
  calibration: unknown;
  theme: ThemeId;
  layout: LayoutId;
  mode: AppMode;
}

function signatureOf(s: PdbState): ContentSignature {
  return {
    beadsVersion: s.beadsVersion,
    board: s.board,
    palette: s.palette,
    paletteId: s.paletteId,
    calibration: s.calibration,
    theme: s.theme,
    layout: s.layout,
    mode: s.mode,
  };
}

function sameSignature(a: ContentSignature, b: ContentSignature): boolean {
  return (
    a.beadsVersion === b.beadsVersion &&
    a.board === b.board &&
    a.palette === b.palette &&
    a.paletteId === b.paletteId &&
    a.calibration === b.calibration &&
    a.theme === b.theme &&
    a.layout === b.layout &&
    a.mode === b.mode
  );
}

/* ==================== 自动保存 ==================== */

/** 由当前 store 状态构造自动保存信封 */
export function buildAutosave(state: PdbState = usePdbStore.getState()): AutosaveFile {
  const savedAt = nowIso();
  const warnings: string[] = [];
  const source: ProjectSource = {
    board: state.board,
    beads: state.beads,
    placedMask: state.placedMask,
    palette: state.palette,
    paletteId: state.paletteId,
    paletteCustomized: isPaletteCustomized(state),
    calibration: state.calibration,
    sourceImage: currentSourceImage,
    meta: { name: currentName, createdAt: currentCreatedAt, updatedAt: savedAt, appVersion },
  };
  const project = serializeProject(source, warnings);
  for (const w of warnings) toast('warning', w, 6000);

  const session: AutosaveSession = {
    theme: state.theme,
    layout: state.layout,
    mode: state.mode,
    tool: state.tool,
    activeColorIndex: state.activeColorIndex,
    region: { ...state.region },
    filter: { colorIndex: state.filterColorIndex, mode: state.filterMode },
  };

  return { kind: AUTOSAVE_KIND, version: 1, savedAt, appVersion, project, session };
}

/** Electron 镜像：失败静默 + 一次性 toast，绝不影响 localStorage 主保存 */
async function mirrorToAppData(text: string): Promise<void> {
  try {
    const ok = await getBridge().writeAppData(AUTOSAVE_APPDATA_NAME, text);
    if (ok) {
      mirrorWarned = false;
    } else if (!mirrorWarned) {
      mirrorWarned = true;
      toast('warning', '自动保存镜像到应用数据目录失败，浏览器本地缓存仍然有效', 6000);
    }
  } catch {
    if (!mirrorWarned) {
      mirrorWarned = true;
      toast('warning', '自动保存镜像到应用数据目录失败，浏览器本地缓存仍然有效', 6000);
    }
  }
}

/**
 * 写一次自动保存（同步写 localStorage，异步镜像 appData）。
 * @returns localStorage 是否写成功
 */
export function writeAutosaveOnce(): boolean {
  // 【缺陷 #2a 守卫】恢复弹窗未决期（启动初见空状态）禁止写入：此刻序列化必然得到空项目，
  // 写入会用空状态覆盖磁盘上的待恢复快照，抢在用户点「恢复」之前。跳过必须静默（不是错误）；
  // 用户做出恢复/丢弃决策（#25 新增的 restoreDecisionResolved）或画出第一颗豆后本守卫自动失效，
  // 正常使用期写入不受影响。
  if (!seenNonEmptyBeads && !restoreDecisionResolved && !hasAnyBead(usePdbStore.getState().beads)) {
    return false;
  }
  let text: string;
  try {
    text = JSON.stringify(buildAutosave());
  } catch (err) {
    toastError(`自动保存序列化失败：${errorMessage(err)}`);
    return false;
  }

  let ok = false;
  const store = ls();
  if (store) {
    try {
      store.setItem(AUTOSAVE_LS_KEY, text);
      ok = true;
    } catch {
      ok = false;
    }
  }

  if (!ok) {
    toastError('自动保存写入本地存储失败（可能是存储空间已满或处于隐私模式），请尽快用「另存为」手动保存项目');
  } else {
    lastSavedAt = nowIso();
    dirty = false;
  }

  if (isElectron()) void mirrorToAppData(text);
  return ok;
}

/**
 * 启动自动保存。返回停止函数（幂等：重复调用不会叠加订阅，直接返回同一个停止函数）。
 */
export function startAutoSave(): () => void {
  if (stopAutoSave) return stopAutoSave;

  let last = signatureOf(usePdbStore.getState());
  // 防御：订阅建立前 store 已有豆（理论不发生——恢复必须由用户在订阅活跃后触发）
  if (hasAnyBead(usePdbStore.getState().beads)) seenNonEmptyBeads = true;

  const unsubscribe = usePdbStore.subscribe((state) => {
    // 【缺陷 #2a】一旦看到非空豆数据（用户作画 / 恢复成功），解除「未决期写入抑制」
    if (!seenNonEmptyBeads && hasAnyBead(state.beads)) seenNonEmptyBeads = true;
    const next = signatureOf(state);
    if (sameSignature(next, last)) return; // 纯 UI 变化（平移/缩放/换工具/切筛选）→ 不写盘
    last = next;
    dirty = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      writeAutosaveOnce();
    }, AUTOSAVE_DEBOUNCE_MS);
  });

  void refreshAppVersion();

  const stop = (): void => {
    // 陈旧 stop 防护（2026-10-11 补测发现）：只有**当前登记在册的那一个** stop 才允许清登记。
    // 原实现只看 stopAutoSave===null，旧实例的 stop 被再次调用（StrictMode 双调用/组件重挂/
    // 测试里复用旧句柄）会把**新登记**的订阅从册子上抹掉——册子认为没在跑、实际订阅还活着，
    // 下次 startAutoSave 再建一条重复订阅（双写盘 + 双 toast）。按引用比对，天然幂等。
    if (stopAutoSave !== stop) return;
    stopAutoSave = null;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      unsubscribe();
    } catch {
      /* 静默 */
    }
  };
  stopAutoSave = stop;
  return stop;
}

/** 立即刷新自动保存（窗口关闭前 / 进入拼豆模式前调用），取消防抖等待 */
export function saveAutosaveNow(): boolean {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  try {
    return writeAutosaveOnce();
  } catch (err) {
    toastError(`自动保存失败：${errorMessage(err)}`);
    return false;
  }
}

/** 校验自动保存文本；不合法返回 null（永不抛异常） */
export function parseAutosave(text: string | null | undefined): AutosaveFile | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  try {
    const raw = JSON.parse(text) as Partial<AutosaveFile> | null;
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind !== AUTOSAVE_KIND) return null;
    if (!raw.project || typeof raw.project !== 'object') return null;
    // 复用 io/project.ts 的严格校验，保证 loadAutosave() 返回的东西一定可恢复
    const checked = projectFromText(projectToText(raw.project as ProjectFile));
    if (!checked.ok) return null;
    const session = raw.session && typeof raw.session === 'object' ? raw.session : null;
    return {
      kind: AUTOSAVE_KIND,
      version: 1,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : checked.project.meta.updatedAt,
      appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : 'unknown',
      project: checked.project,
      session,
    };
  } catch {
    return null;
  }
}

/** 读取自动保存（同步，仅 localStorage）；没有/损坏返回 null */
export function loadAutosave(): AutosaveFile | null {
  const store = ls();
  if (!store) return null;
  try {
    return parseAutosave(store.getItem(AUTOSAVE_LS_KEY));
  } catch {
    return null;
  }
}

/**
 * 读取自动保存（异步）：localStorage 优先，缺失时回落到 Electron 的 appData 镜像
 * （例如用户清了浏览器数据、或换了渲染进程存储分区）。
 */
export async function loadAutosaveAsync(): Promise<AutosaveFile | null> {
  const local = loadAutosave();
  if (local) return local;
  if (!isElectron()) return null;
  try {
    const text = await getBridge().readAppData(AUTOSAVE_APPDATA_NAME);
    const parsed = parseAutosave(text);
    if (parsed) {
      // 把镜像回灌到 localStorage，后续同步路径就能命中
      const store = ls();
      if (store) {
        try {
          store.setItem(AUTOSAVE_LS_KEY, JSON.stringify(parsed));
        } catch {
          /* 静默 */
        }
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 启动时问一句「检测到未保存的上次会话，是否恢复？」用的同步判断 */
export function hasUnsavedSession(): boolean {
  return loadAutosave() !== null;
}

/**
 * 清除自动保存（localStorage + appData 镜像都清）。
 * 【#25】resetSavedAt 默认 true（新建/丢弃场景顺带把「最后保存时间」复位为 null）；
 * 显式保存（saveProjectAs）与打开项目（openProjectFromText）传 false——
 * 它们刚设置了 lastSavedAt，旧的末行复位会导致保存/打开后时间回退到创建时间。
 */
export function clearAutosave(resetSavedAt = true): void {
  const store = ls();
  if (store) {
    try {
      store.removeItem(AUTOSAVE_LS_KEY);
    } catch {
      /* 静默 */
    }
  }
  if (isElectron()) {
    // 没有 delete 频道，写空串即视为删除（parseAutosave 对空串返回 null）
    void getBridge()
      .writeAppData(AUTOSAVE_APPDATA_NAME, '')
      .catch(() => undefined);
  }
  if (resetSavedAt) lastSavedAt = null;
}

/** 自动保存的人类可读摘要，供 UI 直接展示 */
export function describeAutosave(file: AutosaveFile | null = loadAutosave()): string {
  if (!file) return '没有可恢复的自动保存记录';
  const b = file.project.board;
  const when = formatClock(file.savedAt);
  return `「${file.project.meta.name}」· ${b.cols}×${b.rows} · ${file.project.palette.colors.length} 色 · 保存于 ${when}`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (v: number) => (v < 10 ? `0${v}` : String(v));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/* ==================== 恢复 ==================== */

/**
 * 把运行时项目数据写回 store。
 * **顺序不可调换**：setBoardConfig 在 cols/rows 变化时会重建 typed array（内容清空），
 * 因此 replaceBeads 必须放在它之后；最后 clearHistory 清掉跨项目的撤销栈。
 *
 * session 容错（2026-10-11 补测发现）：旧版本/手工损坏的 session 可能缺字段（如 filter），
 * 原实现直接读 session.filter.colorIndex 会中途抛错——此时 runtime 部分已应用、session
 * 部分未应用，留下「板内容已换但主题/筛选还是旧的」的半恢复状态。现改为逐字段判空：
 * 缺失的字段跳过（保留 store 当前值），绝不让一个坏字段炸掉整段恢复。
 */
export function applyRuntime(runtime: ProjectRuntime, session?: AutosaveSession | null): void {
  const s = usePdbStore.getState();
  s.setBoardConfig(runtime.board);
  s.setPalette(runtime.palette.id, runtime.palette);
  s.replaceBeads(runtime.beads, runtime.placedMask);
  s.setCalibration(runtime.calibration);
  // 上下限双夹取：原实现只有上限（Math.min），负值原样进 store（-5 会被后续 UI 当索引用）
  const colorCount = runtime.palette.colors.length;
  const rawIndex = typeof session?.activeColorIndex === 'number' ? session.activeColorIndex : 0;
  s.setActiveColorIndex(Math.max(0, Math.min(rawIndex, Math.max(0, colorCount - 1))));
  if (session) {
    if (session.theme) s.setTheme(session.theme);
    if (session.layout) s.setLayout(session.layout);
    if (session.mode) s.setMode(session.mode);
    if (session.tool) s.setTool(session.tool);
    if (session.region) s.setRegion(session.region);
    if (session.filter) s.setFilter(session.filter.colorIndex, session.filter.mode);
  }
  s.clearHistory();
}

/**
 * 从自动保存恢复会话。
 * @param file 省略时自动 loadAutosave()
 */
export function restoreAutosave(file?: AutosaveFile | null): { ok: boolean; error?: string } {
  // 【#25】进入本函数 = 用户已在恢复弹窗做出决策 → 无论后续校验/恢复成败都解锁
  // 「未决期写入抑制」守卫，避免失败/无豆会话被静默拦截导致什么都不落盘。
  restoreDecisionResolved = true;
  const auto = file === undefined ? loadAutosave() : file;
  if (!auto) return { ok: false, error: '没有找到可恢复的自动保存记录' };
  try {
    const parsed = projectFromText(projectToText(auto.project));
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const runtime = projectToRuntime(parsed.project, safeBasePalette(parsed.project.palette.baseId));
    applyRuntime(runtime, auto.session);
    currentName = runtime.meta.name;
    currentCreatedAt = runtime.meta.createdAt;
    currentPath = null; // 自动保存不携带真实路径，需用户「另存为」落盘
    currentSourceImage = runtime.sourceImage;
    dirty = false;
    emitProjectSourceImageChanged();
    toast('success', `已恢复上次会话：${describeAutosave(auto)}`, 4200);        
    return { ok: true };
  } catch (err) {
    const msg = errorMessage(err);
    toastError(`恢复上次会话失败：${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * 丢弃自动保存（UI 上「不恢复」按钮）。
 * 【#25】丢弃本身就是一次恢复决策：显式解锁 seenNonEmptyBeads 守卫
 * （写入 restoreDecisionResolved），否则「丢弃 → 仅调板参数/校准/主题 → 关窗」的
 * 无豆会话会在 beforeunload flush 时被拦截，整场什么都不落盘。
 */
export function discardAutosave(): void {
  restoreDecisionResolved = true;
  clearAutosave();
}

/* ==================== 显式保存 / 打开 ==================== */

/** 构造当前状态的标准 ProjectFile（供 saveProjectAs 与 UI 预览共用） */
export function buildProjectFile(name?: string): ProjectFile {
  const state = usePdbStore.getState();
  const warnings: string[] = [];
  const source: ProjectSource = {
    board: state.board,
    beads: state.beads,
    placedMask: state.placedMask,
    palette: state.palette,
    paletteId: state.paletteId,
    paletteCustomized: isPaletteCustomized(state),
    calibration: state.calibration,
    sourceImage: currentSourceImage,
    meta: {
      name: sanitizeFileName(name ?? currentName, '未命名项目'),
      createdAt: currentCreatedAt,
      updatedAt: nowIso(),
      appVersion,
    },
  };
  const project = serializeProject(source, warnings);
  for (const w of warnings) toast('warning', w, 6000);
  return project;
}

/**
 * 另存为：走原生保存对话框（浏览器降级已由 bridge 处理）。
 * 用户取消 → `{ok:false, cancelled:true}`，**不弹错误 toast**。
 */
export async function saveProjectAs(name?: string): Promise<SaveOutcome> {
  const project = buildProjectFile(name);
  const filename = projectFileName(project.meta.name);
  try {
    const saved = await getBridge().saveFile(filename, { text: projectToText(project) });
    if (saved === null) {
      return { ok: false, cancelled: true, path: null, name: project.meta.name };
    }
    currentName = project.meta.name;
    currentPath = saved.path && saved.path.length > 0 ? saved.path : null;
    dirty = false;
    lastSavedAt = project.meta.updatedAt;

    // 显式保存成功后清掉「未保存会话」标记；后续再有改动会自动重建。
    // 【#25】传 false 保留刚设置的 lastSavedAt，避免「最后保存时间」回退创建时间
    clearAutosave(false);

    try {
      await addRecent(recentEntryFromProject(project, currentPath ?? project.meta.name), project);
    } catch {
      /* 最近列表失败不影响保存结果 */
    }

    toast('success', `已保存「${currentName}」${currentPath ? `：${currentPath}` : ''}`, 3600);
    return { ok: true, cancelled: false, path: currentPath, name: currentName };
  } catch (err) {
    const msg = errorMessage(err);
    toastError(`保存项目失败：${msg}`);
    return { ok: false, cancelled: false, path: null, name: project.meta.name, error: msg };
  }
}

/** 打开项目：原生对话框 → 严格校验 → 写回 store → 更新最近列表 */
export async function openProject(): Promise<OpenOutcome> {
  let picked: { path: string; dataUrl: string } | null = null;
  try {
    picked = await getBridge().openFile(PROJECT_OPEN_FILTERS);
  } catch (err) {
    const msg = errorMessage(err);
    toastError(`打开文件失败：${msg}`);
    return { ok: false, cancelled: false, path: null, error: msg };
  }
  if (!picked) return { ok: false, cancelled: true, path: null };
  return openProjectFromDataUrl(picked.dataUrl, picked.path);
}

/** 由 dataUrl（bridge.openFile 的返回值）打开项目 —— 拆出来方便 RecentList 与拖拽复用 */
export function openProjectFromDataUrl(dataUrl: string, path?: string | null): OpenOutcome {
  let text: string;
  try {
    text = dataUrlToText(dataUrl);
  } catch (err) {
    const msg = `文件内容解码失败：${errorMessage(err)}`;
    toastError(msg);
    return { ok: false, cancelled: false, path: path ?? null, error: msg };
  }
  return openProjectFromText(text, path ?? null);
}

/** 由项目 JSON 文本打开（严格校验；失败弹中文原因） */
export function openProjectFromText(text: string, path?: string | null): OpenOutcome {
  const parsed = projectFromText(text);
  if (!parsed.ok) {
    toastError(`打开项目失败：${parsed.error}`);
    return { ok: false, cancelled: false, path: path ?? null, error: parsed.error };
  }
  try {
    const project = parsed.project;
    const runtime = projectToRuntime(project, safeBasePalette(project.palette.baseId));
    applyRuntime(runtime, null);

    currentName = runtime.meta.name;
    currentCreatedAt = runtime.meta.createdAt;
    currentPath = path && path.length > 0 ? path : null;
    currentSourceImage = runtime.sourceImage;
    dirty = false;
    emitProjectSourceImageChanged();
    lastSavedAt = runtime.meta.updatedAt;
    // 【#25】传 false 保留刚设置的 lastSavedAt，避免打开项目后「最后保存时间」回退创建时间
    clearAutosave(false);

    const entry = recentEntryFromProject(project, currentPath ?? runtime.meta.name);
    void addRecent(entry, project).catch(() => undefined);

    toast(
      'success',
      `已打开「${runtime.meta.name}」：${runtime.board.cols}×${runtime.board.rows} · ${runtime.stats.colorCount} 色 · ` +
        `已放豆 ${runtime.stats.filled} 颗 · 已放置 ${runtime.stats.placed} 颗`,
      4200,
    );
    return { ok: true, cancelled: false, path: currentPath, name: runtime.meta.name };
  } catch (err) {
    const msg = errorMessage(err);
    toastError(`还原项目数据失败：${msg}`);
    return { ok: false, cancelled: false, path: path ?? null, error: msg };
  }
}

/**
 * 从最近列表打开。本地有镜像副本时直接恢复（无需对话框）；
 * 没有副本时提示用户走原生对话框按路径重开 —— 主进程刻意不开放任意路径读能力。
 */
export async function openRecentProject(id: string): Promise<OpenOutcome> {
  try {
    const found = await getRecent(id);
    if (!found) {
      toastError('这条最近项目记录已不存在');
      return { ok: false, cancelled: false, path: null, error: '记录不存在' };
    }
    if (found.project) {
      return openProjectFromText(projectToText(found.project), found.entry.path || null);
    }
    toast('info', `本地没有「${found.entry.name}」的缓存副本，请在接下来的对话框中选择该文件`, 6000);
    return openProject();
  } catch (err) {
    const msg = errorMessage(err);
    toastError(`打开最近项目失败：${msg}`);
    return { ok: false, cancelled: false, path: null, error: msg };
  }
}

/** 新建空白项目（保留当前主题/布局/色板，清空图案与历史） */
export function newProject(name?: string): void {
  const s = usePdbStore.getState();
  const cells = DEFAULT_BOARD.cols * DEFAULT_BOARD.rows;
  s.setBoardConfig({ ...DEFAULT_BOARD });
  s.replaceBeads(new Uint16Array(cells), new Uint8Array(cells));
  s.setActiveColorIndex(0);
  s.setFilter(-1, 'off');
  s.clearHistory();
  currentName = sanitizeFileName(name ?? '', '未命名项目');
  currentCreatedAt = nowIso();
  currentPath = null;
  currentSourceImage = null;
  dirty = false;
  lastSavedAt = null;
  emitProjectSourceImageChanged();
  clearAutosave();
  toast('info', `已新建空白项目「${currentName}」（${DEFAULT_BOARD.cols}×${DEFAULT_BOARD.rows}）`, 3000);
}

/* ==================== 项目信息 getter / setter（UI 对接点） ==================== */

export function getCurrentProjectInfo(): ProjectInfo {
  return {
    name: currentName,
    path: currentPath,
    createdAt: currentCreatedAt,
    updatedAt: lastSavedAt ?? currentCreatedAt,
    appVersion,
    dirty,
  };
}

/** 只改项目名（不写盘）；下一次自动保存/另存为生效 */
export function setProjectName(name: string): void {
  currentName = sanitizeFileName(name, '未命名项目');
  dirty = true;
}

/**  图片导入完成后调用：把源图挂到项目上（>2MB 会在序列化时自动丢弃并给中文提示） */
export function setProjectSourceImage(image: { name: string; dataUrl: string } | null): void {
  currentSourceImage = image && typeof image.dataUrl === 'string' && image.dataUrl.length > 0 ? image : null;
  dirty = true;
  emitProjectSourceImageChanged();
}

/**
 * 源图入库（导入路径的推荐入口，异步）：超过 2MB 内嵌上限时**自动降采样 + JPEG 重编码**
 * 压到上限内再挂载——旧实现超限静默不写入项目文件，用户重开项目就找不到原图了。
 * 压缩失败（环境不支持 canvas 等）时保留原图入库，由序列化层兜底丢弃（行为同旧版）。
 * @returns 最终入库的字节数；compressed=是否动过压缩；null 表示传入了空素材
 */
export async function attachProjectSourceImage(
  image: { name: string; dataUrl: string } | null,
): Promise<{ compressed: boolean; bytes: number } | null> {
  if (!image || typeof image.dataUrl !== 'string' || image.dataUrl.length === 0) {
    setProjectSourceImage(null);
    return null;
  }
  const originalBytes = dataUrlByteSize(image.dataUrl);
  if (originalBytes <= MAX_SOURCE_IMAGE_BYTES) {
    setProjectSourceImage(image);
    return { compressed: false, bytes: originalBytes };
  }
  const compressed = await compressDataUrlToFit(image.dataUrl, MAX_SOURCE_IMAGE_BYTES);
  if (compressed) {
    const bytes = dataUrlByteSize(compressed);
    setProjectSourceImage({ name: image.name, dataUrl: compressed });
    return { compressed: true, bytes };
  }
  setProjectSourceImage(image);
  return { compressed: false, bytes: originalBytes };
}

export function getProjectSourceImage(): { name: string; dataUrl: string } | null {
  return currentSourceImage;
}

/** 标记内容已变（供 store 之外的改动源使用，例如未来的多板拼接） */
export function markDirty(): void {
  dirty = true;
}

/** 供 UI 展示「最近项目」的薄封装：失败返回空数组，绝不抛错 */
export async function listRecentProjects(): Promise<RecentEntry[]> {
  try {
    return await listRecent();
  } catch {
    return [];
  }
}

/** 归一化一条最近项目条目（UI 手动构造条目时用） */
export function toRecentEntry(entry: Partial<RecentEntry>): RecentEntry {
  return normalizeRecentEntry(entry);
}
