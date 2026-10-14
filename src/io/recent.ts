/**
 * io/recent.ts —— 最近项目列表（纯逻辑，无 React）。
 *
 * 两套后端，按运行环境自动选择，对外 API 完全一致：
 *
 *  1) **Electron**：条目列表持久化到应用私有数据目录（appData）的 `recent.json`；
 *     同时把整份项目 JSON 镜像为 `recent-<id>.json`。这样「重开」不需要主进程开放任意路径读能力
 *     （安全契约：绝不暴露任意路径读写），镜像缺失时回落到原生打开对话框按 entry.path 重开。
 *
 *  2) **浏览器**：IndexedDB（库 `pindou-studio` / 表 `projects` / keyPath `id`）存整份项目 JSON；
 *     IndexedDB 不可用（隐私模式、老浏览器、Node 环境）时**静默降级** localStorage，绝不抛错崩溃。
 *
 * 规则：上限 20 条 · 按 updatedAt 降序 · 相同 path（path 为空时按 name）去重，保留最新一条。
 */
import type { ProjectFile } from '@/core/types';
import { getBridge, isElectron } from '@/io/bridge';
import { projectFromText, projectToText, sanitizeFileName } from '@/io/project';

/* ==================== 常量 ==================== */

export const RECENT_LIMIT = 20;
export const IDB_NAME = 'pindou-studio';
export const IDB_STORE = 'projects';
export const IDB_VERSION = 1;

/** appData 下的列表文件名（受主进程白名单约束：只允许 [A-Za-z0-9._-]，不含路径分隔符） */
export const APPDATA_RECENT_INDEX = 'recent.json';
/** appData 下项目镜像文件名前缀 */
export const APPDATA_RECENT_PROJECT_PREFIX = 'recent-';

const LS_INDEX_KEY = 'pindou-studio:recent:index';
const LS_PROJECT_PREFIX = 'pindou-studio:recent:project:';
const LS_ID_PREFIX = 'pindou-studio:recent:id:';
/** 缩略图上限：超过就不进最近列表（列表要能秒开） */
const THUMB_MAX_BYTES = 96 * 1024;

/* ==================== 类型 ==================== */

export interface RecentEntry {
  /** 稳定 id（由 path/name 派生，文件名安全：仅 [a-z0-9]） */
  id: string;
  name: string;
  /** Electron 下为真实绝对路径；浏览器下为文件名（无真实路径能力） */
  path: string;
  /** ISO 8601；按此降序排列 */
  updatedAt: string;
  /** 可选缩略图 dataUrl（≤96KB 才存） */
  thumb?: string;
}

/** getRecent 的返回：project 为 null 表示需要走原生对话框按 path 重开 */
export interface RecentProject {
  entry: RecentEntry;
  project: ProjectFile | null;
}

/** IndexedDB / localStorage 里的整条记录 */
interface RecentRecord extends RecentEntry {
  project?: ProjectFile | null;
}

/* ==================== 工具 ==================== */

function nowIso(): string {
  return new Date().toISOString();
}

function ts(value: string | undefined | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** FNV-1a 32bit → base36，产出文件名安全的稳定 id */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 由 path（无 path 时用 name）派生稳定 id —— 同一文件重复保存会命中同一条目，天然去重 */
export function makeRecentId(seed: string): string {
  const s = String(seed ?? '').trim();
  return `p${fnv1a(s.length > 0 ? s : nowIso())}`;
}

/** 补全/消毒一条条目（id 缺失时派生，name 消毒，updatedAt 兜底，thumb 超限丢弃） */
export function normalizeRecentEntry(entry: Partial<RecentEntry> & { name?: string }): RecentEntry {
  const path = typeof entry.path === 'string' ? entry.path : '';
  const name = sanitizeFileName(typeof entry.name === 'string' ? entry.name : '', '未命名项目');
  const id =
    typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.id)
      ? entry.id
      : makeRecentId(path || name);
  const thumb = typeof entry.thumb === 'string' && entry.thumb.length <= THUMB_MAX_BYTES ? entry.thumb : undefined;
  const out: RecentEntry = {
    id,
    name,
    path,
    updatedAt: typeof entry.updatedAt === 'string' && ts(entry.updatedAt) > 0 ? entry.updatedAt : nowIso(),
  };
  if (thumb) out.thumb = thumb;
  return out;
}

/** 由项目文件 + 路径直接构造条目 */
export function recentEntryFromProject(project: ProjectFile, path: string): RecentEntry {
  return normalizeRecentEntry({
    id: makeRecentId(path || project.meta.name),
    name: project.meta.name,
    path,
    updatedAt: project.meta.updatedAt || nowIso(),
  });
}

/**
 * 去重 + 排序 + 截断。
 * 两轮收敛：先按 path（path 为空时按 name）保留最新一条，再按 id 保留最新一条；
 * 最后按 updatedAt 降序（同时刻按名称稳定排序）并截断到 RECENT_LIMIT。
 */
export function normalizeRecentList(entries: RecentEntry[]): RecentEntry[] {
  const keepNewer = (map: Map<string, RecentEntry>, key: string, entry: RecentEntry): void => {
    const prev = map.get(key);
    if (!prev || ts(entry.updatedAt) >= ts(prev.updatedAt)) map.set(key, entry);
  };

  const cleaned: RecentEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    cleaned.push(normalizeRecentEntry(raw));
  }

  // 第一轮：相同路径（或相同名称）只留最新
  const byLocation = new Map<string, RecentEntry>();
  for (const entry of cleaned) {
    const key =
      entry.path.length > 0 ? `path:${entry.path.toLowerCase()}` : `name:${entry.name.toLowerCase()}`;
    keepNewer(byLocation, key, entry);
  }

  // 第二轮：相同 id 只留最新（id 由 path/name 派生，此处兼容外部传入的自定义 id）
  const byId = new Map<string, RecentEntry>();
  for (const entry of byLocation.values()) keepNewer(byId, entry.id, entry);

  return [...byId.values()]
    .sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt) || a.name.localeCompare(b.name))
    .slice(0, RECENT_LIMIT);
}

function parseEntries(text: string | null): RecentEntry[] {
  if (!text || text.trim().length === 0) return [];
  try {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return normalizeRecentList(raw as RecentEntry[]);
  } catch {
    return [];
  }
}

/* ==================== localStorage 兜底层 ==================== */

function ls(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__pdb_recent_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

function lsReadIndex(): RecentEntry[] {
  const store = ls();
  if (!store) return [];
  try {
    return parseEntries(store.getItem(LS_INDEX_KEY));
  } catch {
    return [];
  }
}

function lsWriteIndex(entries: RecentEntry[]): void {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(LS_INDEX_KEY, JSON.stringify(entries));
  } catch {
    /* 配额满：静默 */
  }
}

function lsReadRecord(id: string): RecentRecord | null {
  const store = ls();
  if (!store) return null;
  try {
    const raw = store.getItem(LS_ID_PREFIX + id);
    if (raw) {
      const parsed = JSON.parse(raw) as RecentRecord;
      if (parsed && typeof parsed === 'object' && parsed.id) return parsed;
    }
    // 老格式兜底：索引里有但没有整条记录
    const entry = lsReadIndex().find((e) => e.id === id);
    return entry ? { ...entry, project: null } : null;
  } catch {
    return null;
  }
}

function lsWriteRecord(record: RecentRecord): void {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(LS_ID_PREFIX + record.id, JSON.stringify(record));
    if (record.project) store.setItem(LS_PROJECT_PREFIX + record.id, projectToText(record.project));
  } catch {
    /* 配额满：静默（整份项目可能几百 KB，localStorage 5MB 上限要留意） */
  }
}

function lsDeleteRecord(id: string): void {
  const store = ls();
  if (!store) return;
  try {
    store.removeItem(LS_ID_PREFIX + id);
    store.removeItem(LS_PROJECT_PREFIX + id);
  } catch {
    /* 静默 */
  }
}

function lsClearAll(): void {
  const store = ls();
  if (!store) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key) continue;
      if (key.startsWith(LS_ID_PREFIX) || key.startsWith(LS_PROJECT_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
    store.removeItem(LS_INDEX_KEY);
  } catch {
    /* 静默 */
  }
}

/* ==================== IndexedDB 层（浏览器主路径） ==================== */

let dbPromise: Promise<IDBDatabase | null> | null = null;

/**
 * 打开 IndexedDB（含 onupgradeneeded 建表）。库/表不可用时 resolve(null) —— **永不 reject**，
 * 调用方据此降级 localStorage。单例缓存，避免重复 open。
 */
export function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined' || indexedDB === null) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'id' });
          }
        } catch {
          /* 建表失败：resolve(null) 走降级 */
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.close();
            resolve(null);
            return;
          }
        } catch {
          resolve(null);
          return;
        }
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** 包一层 Promise 的事务执行；任何异常都 resolve(null) */
function idbRun<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(IDB_STORE, mode);
          const store = tx.objectStore(IDB_STORE);
          const req = run(store);
          tx.oncomplete = () => resolve((req ? (req.result as T) : null) ?? null);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function idbGetAllRecords(): Promise<RecentRecord[] | null> {
  return idbRun<RecentRecord[]>('readonly', (store) => store.getAll() as IDBRequest<RecentRecord[]>);
}

function idbPutRecord(record: RecentRecord): Promise<boolean> {
  return idbRun<IDBValidKey>('readwrite', (store) => store.put(record) as IDBRequest<IDBValidKey>).then(
    (key) => key !== null,
  );
}

function idbGetRecord(id: string): Promise<RecentRecord | null> {
  return idbRun<RecentRecord>('readonly', (store) => store.get(id) as IDBRequest<RecentRecord>);
}

function idbDeleteRecord(id: string): Promise<boolean> {
  return idbRun<undefined>('readwrite', (store) => store.delete(id) as IDBRequest<undefined>).then(() => true);
}

function idbClearStore(): Promise<boolean> {
  return idbRun<undefined>('readwrite', (store) => store.clear() as IDBRequest<undefined>).then(() => true);
}

/* ==================== appData 层（Electron 主路径） ==================== */

function appDataNameForProject(id: string): string {
  // id 已由 makeRecentId 保证为 [a-z0-9]，再过滤一次以防外部传入脏值
  return `${APPDATA_RECENT_PROJECT_PREFIX}${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.json`;
}

async function appDataReadIndex(): Promise<RecentEntry[] | null> {
  try {
    const text = await getBridge().readAppData(APPDATA_RECENT_INDEX);
    if (text === null) return null;
    return parseEntries(text);
  } catch {
    return null;
  }
}

async function appDataWriteIndex(entries: RecentEntry[]): Promise<boolean> {
  try {
    return await getBridge().writeAppData(APPDATA_RECENT_INDEX, JSON.stringify(entries, null, 2));
  } catch {
    return false;
  }
}

/* ==================== 对外 API ==================== */

/**
 * 列出最近项目（按 updatedAt 降序，≤20 条）。
 * Electron 走 appData；浏览器走 IndexedDB → localStorage 三级降级。任何失败都返回 []。
 */
export async function listRecent(): Promise<RecentEntry[]> {
  if (isElectron()) {
    const fromAppData = await appDataReadIndex();
    if (fromAppData) return fromAppData;
    // appData 不可用（例如 preload 未注入）时回落本地存储，保证列表功能不消失
  }
  const records = await idbGetAllRecords();
  if (records) return normalizeRecentList(records.map(stripProject));
  return lsReadIndex();
}

function stripProject(record: RecentRecord): RecentEntry {
  const entry: RecentEntry = {
    id: record.id,
    name: record.name,
    path: record.path,
    updatedAt: record.updatedAt,
  };
  if (record.thumb) entry.thumb = record.thumb;
  return entry;
}

/**
 * 新增/更新一条最近项目。返回归一化后的完整列表。
 * @param entry  条目（id/name/updatedAt/thumb 缺省时自动补全）
 * @param project 整份项目 JSON：浏览器存 IndexedDB；Electron 额外镜像到 appData 以便免对话框重开
 */
export async function addRecent(entry: Partial<RecentEntry>, project?: ProjectFile | null): Promise<RecentEntry[]> {
  const normalized = normalizeRecentEntry(entry);
  const record: RecentRecord = { ...normalized, project: project ?? null };

  if (isElectron()) {
    const existing = (await appDataReadIndex()) ?? lsReadIndex();
    const next = normalizeRecentList([normalized, ...existing]);
    await appDataWriteIndex(next);
    if (project) {
      try {
        await getBridge().writeAppData(appDataNameForProject(normalized.id), projectToText(project));
      } catch {
        /* 镜像失败不影响列表本身 */
      }
    }
    // 被淘汰出前 20 的条目顺手清掉镜像，避免 appData 无限增长
    const kept = new Set(next.map((e) => e.id));
    for (const old of existing) {
      if (!kept.has(old.id)) {
        try {
          await getBridge().writeAppData(appDataNameForProject(old.id), '');
        } catch {
          /* 静默 */
        }
      }
    }
    lsWriteIndex(next); // 双写：Electron 下 localStorage 也可用，作为 appData 读失败时的兜底
    return next;
  }

  const okIdb = await idbPutRecord(record);
  if (!okIdb) {
    lsWriteRecord(record);
    const next = normalizeRecentList([normalized, ...lsReadIndex()]);
    lsWriteIndex(next);
    for (const old of lsReadIndex()) {
      if (!next.some((e) => e.id === old.id)) lsDeleteRecord(old.id);
    }
    return next;
  }

  const all = await idbGetAllRecords();
  const next = normalizeRecentList((all ?? lsReadIndex().map((e) => ({ ...e, project: null }))).map(stripRecordSafe));
  const kept = new Set(next.map((e) => e.id));
  for (const old of all ?? []) {
    if (!kept.has(old.id)) await idbDeleteRecord(old.id);
  }
  // 同步维护索引副本（localStorage），让 IDB 事务失败时仍有数据可读
  lsWriteIndex(next);
  return next;
}

/** idbGetAllRecords() 降级为 localStorage 条目时的形状对齐 */
function stripRecordSafe(value: RecentRecord | RecentEntry): RecentEntry {
  return stripProject(value as RecentRecord);
}

/**
 * 读取一条最近项目的完整内容。
 * 返回 `project: null` 表示本地没有缓存副本 —— Electron 下调用方应回落到原生对话框按 entry.path 重开。
 */
export async function getRecent(id: string): Promise<RecentProject | null> {
  const safeId = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (safeId.length === 0) return null;

  if (isElectron()) {
    let entry: RecentEntry | null = null;
    const list = (await appDataReadIndex()) ?? lsReadIndex();
    entry = list.find((e) => e.id === safeId) ?? null;
    let project: ProjectFile | null = null;
    try {
      const text = await getBridge().readAppData(appDataNameForProject(safeId));
      if (text && text.trim().length > 0) {
        const parsed = projectFromText(text);
        if (parsed.ok) project = parsed.project;
      }
    } catch {
      project = null;
    }
    if (!entry && project) entry = recentEntryFromProject(project, '');
    if (!entry) return null;
    return { entry, project };
  }

  const record = await idbGetRecord(safeId);
  if (record) return { entry: stripProject(record), project: record.project ?? null };

  const lsRecord = lsReadRecord(safeId);
  if (lsRecord) {
    let project = lsRecord.project ?? null;
    if (!project) {
      const store = ls();
      const text = store ? store.getItem(LS_PROJECT_PREFIX + safeId) : null;
      if (text) {
        const parsed = projectFromText(text);
        if (parsed.ok) project = parsed.project;
      }
    }
    return { entry: stripProject(lsRecord), project };
  }
  return null;
}

/** 删除一条；返回删除后的列表 */
export async function removeRecent(id: string): Promise<RecentEntry[]> {
  const safeId = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (isElectron()) {
    const existing = (await appDataReadIndex()) ?? lsReadIndex();
    const next = normalizeRecentList(existing.filter((e) => e.id !== safeId));
    await appDataWriteIndex(next);
    try {
      await getBridge().writeAppData(appDataNameForProject(safeId), '');
    } catch {
      /* 静默 */
    }
    lsDeleteRecord(safeId);
    lsWriteIndex(next);
    return next;
  }

  await idbDeleteRecord(safeId);
  lsDeleteRecord(safeId);
  const all = await idbGetAllRecords();
  if (all) {
    const next = normalizeRecentList(all.map(stripProject));
    lsWriteIndex(next);
    return next;
  }
  // IndexedDB 不可用 → 以 localStorage 索引为准
  const next = normalizeRecentList(lsReadIndex().filter((e) => e.id !== safeId));
  lsWriteIndex(next);
  return next;
}

/** 清空最近列表（连同缓存的项目副本） */
export async function clearRecent(): Promise<void> {
  if (isElectron()) {
    const existing = (await appDataReadIndex()) ?? lsReadIndex();
    for (const entry of existing) {
      try {
        await getBridge().writeAppData(appDataNameForProject(entry.id), '');
      } catch {
        /* 静默 */
      }
    }
    await appDataWriteIndex([]);
  }
  await idbClearStore();
  lsClearAll();
}
