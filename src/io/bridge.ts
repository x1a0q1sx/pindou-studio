/**
 * io/bridge.ts —— 环境桥接（契约层）。
 * 能力探测：window.pdb 是否存在。Electron 分支走 IPC；浏览器分支降级：
 *   显示器信息 → window.screen + devicePixelRatio（physicalMm=null，等手动校准）
 *   全屏 → Fullscreen API；防休眠 → Wake Lock（不稳，拿不到就静默降级）
 *   保存 → showSaveFilePicker → <a download>；打开 → <input type=file>
 * 【契约】对外暴露统一 Promise 接口（PdbBridge），调用方不需要知道自己在哪个环境。
 */
import type { DisplayMetrics } from '@/core/types';
import type {
  PdbApi,
  PdbAppInfo,
  PdbOpenFileFilter,
  PdbSavePayload,
  PdbWebFetchResult,
  PdbBtPickerRequest,
  PdbCastState,
  PdbCastPayload,
  PdbVbEvent,
} from '@/pdb';

/** webFetch 返回契约（与 preload/pdb.d.ts 同源，这里做重导出便于业务引用） */
export type WebFetchResult = PdbWebFetchResult;
/** 蓝牙选择器请求（主进程接管 select-bluetooth-device 后转发） */
export type BtPickerRequest = PdbBtPickerRequest;
/** 手机投图：服务状态与上传载荷 */
export type CastState = PdbCastState;
export type CastPayload = PdbCastPayload;
/** PC 虚拟板事件 */
export type VbEvent = PdbVbEvent;
/** PC 虚拟板启动配置 */
export interface VbConfig {
  name?: string;
  service?: string;
  char?: string;
  w?: number;
  h?: number;
  /** kmpd=酷猫开放协议（单特征）；pixdou=颂拼豆（PIXDOU）双特征（0x54 同构帧） */
  protocol?: 'kmpd' | 'pixdou';
}

/* File System Access API 不在 lib.dom 里，声明最小形状（仅 Chromium 支持，运行时已做特性探测） */
interface FsaWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FsaFileHandle {
  name: string;
  createWritable(): Promise<FsaWritable>;
}
declare global {
  interface Window {
    showSaveFilePicker?(opts: { suggestedName: string }): Promise<FsaFileHandle>;
  }
}

/** 统一桥接接口 —— 后续任务只依赖这个形状 */
export interface PdbBridge {
  /** 运行环境（探测一次即定型） */
  readonly env: 'electron' | 'browser';
  /** → DisplayMetrics[]；浏览器恒为 1 条（当前屏），physicalMm=null */
  getDisplays(): Promise<DisplayMetrics[]>;
  /** (id) → {id,widthCm,heightCm} | null；浏览器恒为 null（无 API，只能手动校准） */
  getDisplayPhysical(id: string): Promise<{ id: string; widthCm: number; heightCm: number } | null>;
  /** 进入全屏（Electron 可指定显示器无边框全屏；浏览器只能当前屏 Fullscreen API） */
  enterFullscreen(displayId?: string): Promise<void>;
  exitFullscreen(): Promise<void>;
  /** 防休眠（Electron powerSaveBlocker；浏览器 Wake Lock，失败静默） */
  keepAwake(on: boolean): Promise<void>;
  /** 打开文件 → {path,dataUrl} | null（用户取消也是 null） */
  openFile(filters?: PdbOpenFileFilter[]): Promise<{ path: string; dataUrl: string } | null>;
  /** 保存文件 → {path} | null；浏览器无路径时 path 为空串 */
  saveFile(defaultName: string, payload: PdbSavePayload): Promise<{ path: string } | null>;
  getAppInfo(): Promise<PdbAppInfo>;
  /** 订阅显示器变化；返回取消函数（浏览器为 DPR/resize 变化的近似信号） */
  onDisplaysChanged(callback: () => void): () => void;

  /* ---------------- 追加（既有 9 个方法的签名/行为/返回类型一字未改） ---------------- */
  /**
   * 读取应用私有数据文件（Electron: userData/pindou-studio-data/<name>；浏览器: localStorage）。
   * 不存在 / 非法文件名 / IO 失败 均返回 null，**永不抛异常**（自动保存镜像失败不得影响主流程）。
   */
  readAppData(name: string): Promise<string | null>;
  /** 写入应用私有数据文件；成功 true，失败 false（不抛异常） */
  writeAppData(name: string, text: string): Promise<boolean>;
  /** 列出匹配前缀的 .json/.pdp.json 文件名（升序）；不可用时返回空数组 */
  listAppData(prefix?: string): Promise<string[]>;
  /* ---------------- 窗口控制（仅 Electron 有效，浏览器为 no-op） ---------------- */
  /** 最小化窗口（浏览器 no-op） */
  windowMinimize(): Promise<void>;
  /** 最大化/还原切换；返回切换后是否为最大化（浏览器恒 false） */
  windowMaximizeToggle(): Promise<boolean>;
  /** 关闭窗口（浏览器 no-op） */
  windowClose(): Promise<void>;

  /* ---------------- 图纸 Web（社区检索） ---------------- */
  /**
   * 受限 https GET 代理（仅 Electron；域名白名单，走系统网络栈=自动跟随系统代理）。
   * 浏览器环境降级为直连 fetch（reddit 无 CORS 头，预期失败并给出可读 error）。
   * 永不抛异常：失败返回 {ok:false,error}。
   */
  webFetch(req: string | { url: string; method?: 'GET' | 'POST'; body?: string }): Promise<WebFetchResult>;

  /* ---------------- 智能拼豆板（Web Bluetooth 选择器接管） ---------------- */
  /**
   * 订阅主进程转发的蓝牙设备选择请求（Electron 专属；浏览器模式由 Chrome
   * 原生弹选择框，订阅是 no-op 且永不触发）。返回取消函数。
   */
  onBtDeviceRequest(cb: (req: BtPickerRequest | null) => void): () => void;
  /** 回传用户选择（null=取消）；返回是否被受理（过期/无挂起 = false） */
  resolveBtDevice(requestId: string, deviceId: string | null): Promise<boolean>;

  /* ---------------- 手机投图（局域网 HTTP） ---------------- */
  /** 启动/查询/停止本机上传服务；浏览器模式恒返回 running:false + 不支持。永不抛。 */
  castStart(): Promise<CastState>;
  castStop(): Promise<CastState>;
  castState(): Promise<CastState>;
  /** 订阅手机上传（Electron）；浏览器模式 no-op。返回取消函数。 */
  onCastPush(cb: (payload: CastPayload) => void): () => void;

  /* ---------------- PC 虚拟智能拼豆板（仅 Electron） ---------------- */
  /** 启动/停止虚拟板旁路（主进程按需编译并 spawn C# GATT 服务）；浏览器恒 ok:false。
      成功时附带旁路实际生效的板配置 w/h（main.mjs 夹取到 1..255 后）。 */
  vbStart(cfg: VbConfig): Promise<{ ok: boolean; error?: string; w?: number; h?: number }>;
  vbStop(): Promise<{ ok: boolean }>;
  /** 设备→App 主动通知（hex 帧，如按键 0x05/0x06） */
  vbNotify(hex: string): Promise<{ ok: boolean }>;
  /** 旁路控制行（PIXDOU 回码热调）：ack9/acka/ack0/ackz/push；浏览器恒 ok:false。 */
  vbCtrl(line: string): Promise<{ ok: boolean; error?: string }>;
  /** 订阅虚拟板事件（ready/connected/write/error/stopped…）；浏览器 no-op。 */
  onVbEvent(cb: (evt: VbEvent) => void): () => void;
}

/* ================= Electron 分支 ================= */

function electronBridge(api: PdbApi): PdbBridge {
  return {
    env: 'electron',
    getDisplays: () => api.getDisplays(),
    getDisplayPhysical: (id) => api.getDisplayPhysical(id),
    enterFullscreen: (displayId) => api.enterFullscreen(displayId),
    exitFullscreen: () => api.exitFullscreen(),
    keepAwake: (on) => api.keepAwake(on),
    openFile: (filters) => api.openFile(filters),
    saveFile: (defaultName, payload) => api.saveFile(defaultName, payload),
    getAppInfo: () => api.getAppInfo(),
    onDisplaysChanged: (cb) => api.onDisplaysChanged(cb),

    /* ---- 追加：appData 受限读写（preload 未注入时静默降级到浏览器实现） ---- */
    readAppData: (name) =>
      typeof api.readAppData === 'function' ? api.readAppData(name) : browserReadAppData(name),
    writeAppData: (name, text) =>
      typeof api.writeAppData === 'function' ? api.writeAppData(name, text) : browserWriteAppData(name, text),
    listAppData: (prefix) =>
      typeof api.listAppData === 'function' ? api.listAppData(prefix) : browserListAppData(prefix),
    windowMinimize: () =>
      typeof api.windowMinimize === 'function' ? api.windowMinimize() : Promise.resolve(),
    windowMaximizeToggle: () =>
      typeof api.windowMaximizeToggle === 'function' ? api.windowMaximizeToggle() : Promise.resolve(false),
    windowClose: () =>
      typeof api.windowClose === 'function' ? api.windowClose() : Promise.resolve(),

    /* ---- 图纸 Web：主进程受限代理（preload 未注入时给可读错误） ---- */
    webFetch: (url) =>
      typeof api.webFetch === 'function'
        ? api.webFetch(url)
        : Promise.resolve({ ok: false, error: 'no-ipc' } satisfies WebFetchResult),

    /* ---- 智能拼豆板：主进程接管设备选择器（旧 preload 无此能力时静默 no-op） ---- */
    onBtDeviceRequest: (cb) =>
      typeof api.onBtDeviceRequest === 'function'
        ? api.onBtDeviceRequest(cb)
        : () => { /* 无能力：不订阅 */ },
    resolveBtDevice: (requestId, deviceId) =>
      typeof api.resolveBtDevice === 'function'
        ? api.resolveBtDevice(requestId, deviceId)
        : Promise.resolve(false),

    /* ---- 手机投图：主进程局域网服务（旧 preload 无此能力时返回不支持） ---- */
    castStart: () =>
      typeof api.castStart === 'function'
        ? api.castStart()
        : Promise.resolve({ ok: false, error: 'no-ipc', running: false, port: 0, token: '', urls: [] }),
    castStop: () =>
      typeof api.castStop === 'function'
        ? api.castStop()
        : Promise.resolve({ ok: false, error: 'no-ipc', running: false, port: 0, token: '', urls: [] }),
    castState: () =>
      typeof api.castState === 'function'
        ? api.castState()
        : Promise.resolve({ ok: true, running: false, port: 0, token: '', urls: [] }),
    onCastPush: (cb) =>
      typeof api.onCastPush === 'function' ? api.onCastPush(cb) : () => { /* no-op */ },

    /* ---- PC 虚拟板：主进程托管旁路（旧 preload 无此能力时恒不支持） ---- */
    vbStart: (cfg) =>
      typeof api.vbStart === 'function'
        ? api.vbStart(cfg)
        : Promise.resolve({ ok: false, error: 'no-ipc' }),
    vbStop: () =>
      typeof api.vbStop === 'function' ? api.vbStop() : Promise.resolve({ ok: false }),
    vbNotify: (hex) =>
      typeof api.vbNotify === 'function' ? api.vbNotify(hex) : Promise.resolve({ ok: false }),
    vbCtrl: (line) =>
      typeof api.vbCtrl === 'function' ? api.vbCtrl(line) : Promise.resolve({ ok: false, error: 'no-ipc' }),
    onVbEvent: (cb) =>
      typeof api.onVbEvent === 'function' ? api.onVbEvent(cb) : () => { /* no-op */ },
  };
}

/* ================= 浏览器降级分支 ================= */

function browserBridge(): PdbBridge {
  let wakeLock: WakeLockSentinel | null = null;

  const browserDisplay = (): DisplayMetrics => {
    const dpr = window.devicePixelRatio || 1;
    const width = window.screen.width;
    const height = window.screen.height;
    return {
      id: 'browser-screen',
      label: '当前浏览器屏幕',
      isPrimary: true,
      isVirtual: false,
      boundsCss: { width, height },
      workAreaCss: { width: window.screen.availWidth, height: window.screen.availHeight },
      devicePx: { width: Math.round(width * dpr), height: Math.round(height * dpr) },
      devicePixelRatio: dpr,
      physicalMm: null,   // 浏览器拿不到面板物理尺寸 → 走手动校准（标尺拖拽/实测跨度）
      ppi: null,
      mmPerDevicePx: null,
    };
  };

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error ?? new Error('FileReader 失败'));
      fr.readAsDataURL(file);
    });

  /** <a download> 兜底保存 */
  const anchorDownload = (defaultName: string, blob: Blob): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const payloadToBlob = (payload: PdbSavePayload): Blob =>
    'base64' in payload
      ? new Blob([Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0))])
      : new Blob([payload.text], { type: 'text/plain;charset=utf-8' });

  return {
    env: 'browser',

    getDisplays: async () => [browserDisplay()],

    getDisplayPhysical: async () => null,

    enterFullscreen: async () => {
      const el = document.documentElement;
      if (document.fullscreenElement !== el) await el.requestFullscreen();
    },

    exitFullscreen: async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    },

    keepAwake: async (on) => {
      // Wake Lock 不稳（切标签/省电模式会失效），失败静默降级 —— 不 throw 是契约
      try {
        if (on) {
          if (!wakeLock && 'wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
          }
        } else if (wakeLock) {
          await wakeLock.release();
          wakeLock = null;
        }
      } catch {
        wakeLock = null;
      }
    },

    openFile: async (filters) => {
      // 缺陷#5：'*'（「全部文件」兜底项）不是合法的 accept 扩展名（原先会产出无效的 ".*"），
      // 跳过它；若过滤后为空则完全不设 accept，系统对话框即可选中任意文件
      //（含历史遗留的 .pdp.bin —— 走「全部文件」兜底打开，不强制迁移）。
      const accept = (filters ?? [])
        .flatMap((f) => f.extensions)
        .filter((e) => e !== '*')
        .map((e) => `.${e.replace(/^\./, '')}`)
        .join(',');
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.style.display = 'none';
        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          input.remove();
          if (!file) {
            resolve(null);
            return;
          }
          void fileToDataUrl(file)
            .then((dataUrl) => resolve({ path: file.name, dataUrl })) // 浏览器无真实路径，path=文件名
            .catch(() => resolve(null));
        });
        // 取消对话框无法可靠感知：用 window focus + 延时兜底 resolve(null)
        const onCancel = () => {
          setTimeout(() => {
            window.removeEventListener('focus', onCancel);
            if (!input.files || input.files.length === 0) {
              input.remove();
              resolve(null);
            }
          }, 600);
        };
        window.addEventListener('focus', onCancel);
        document.body.appendChild(input);
        input.click();
      });
    },

    saveFile: async (defaultName, payload) => {
      const blob = payloadToBlob(payload);
      // 优先 File System Access API（Chromium），Safari/Firefox 降级 <a download>
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          // 缺陷#5：不再强行改扩展名为 .bin —— defaultName 已带正确扩展名（项目文件为
          // .pdp.json），原样透传才能与打开过滤器（*.pdp.json / *.json）两端一致。
          const suggestedName = defaultName;
          const handle = await window.showSaveFilePicker({ suggestedName });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return { path: handle.name };
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return null; // 用户取消
          // 其他失败继续走 <a download> 兜底
        }
      }
      anchorDownload(defaultName, blob);
      return { path: '' };
    },

    getAppInfo: async () => ({
      version: 'dev',
      platform: navigator.platform || 'web',
      isElectron: false,
    }),

    onDisplaysChanged: (cb) => {
      // 浏览器近似信号：DPR 变化（窗口跨屏/改缩放）与 resize
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const handler = () => cb();
      mq.addEventListener('change', handler);
      window.addEventListener('resize', handler);
      return () => {
        mq.removeEventListener('change', handler);
        window.removeEventListener('resize', handler);
      };
    },

    /* ---- 追加：浏览器降级用 localStorage 模拟 appData（不可用时返回 null/false/[]） ---- */
    readAppData: (name) => browserReadAppData(name),
    writeAppData: (name, text) => browserWriteAppData(name, text),
    listAppData: (prefix) => browserListAppData(prefix),
    // 窗口控制：浏览器无从控制宿主窗口，全部 no-op
    windowMinimize: () => Promise.resolve(),
    windowMaximizeToggle: () => Promise.resolve(false),
    windowClose: () => Promise.resolve(),

    /* 图纸 Web：浏览器降级直连 fetch（reddit 不提供 CORS 头，多半失败；
       失败时返回可读 error 文案，UI 据此提示「请使用桌面版」） */
    webFetch: async (req) => {
      const url = typeof req === 'string' ? req : req.url;
      const method = typeof req === 'string' ? 'GET' : (req.method ?? 'GET');
      const body = typeof req === 'string' ? undefined : req.body;
      try {
        const res = await fetch(url, { method, body });
        const buf = await res.arrayBuffer();
        if (!res.ok) return { ok: false, status: res.status, error: `http-${res.status}` };
        return {
          ok: true,
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
          data: new Uint8Array(buf),
        };
      } catch {
        return { ok: false, error: 'cors-or-offline' };
      }
    },

    /* 智能拼豆板：浏览器模式由 Chrome 原生弹设备选择框，无需自绘；订阅恒不触发 */
    onBtDeviceRequest: () => () => { /* no-op */ },
    resolveBtDevice: () => Promise.resolve(false),

    /* 手机投图：浏览器无法开本机服务，恒 running:false */
    castStart: () => Promise.resolve({ ok: false, error: 'browser-no-cast', running: false, port: 0, token: '', urls: [] }),
    castStop: () => Promise.resolve({ ok: false, error: 'browser-no-cast', running: false, port: 0, token: '', urls: [] }),
    castState: () => Promise.resolve({ ok: true, running: false, port: 0, token: '', urls: [] }),
    onCastPush: () => () => { /* no-op */ },

    /* PC 虚拟板：浏览器无蓝牙外设能力，恒不支持 */
    vbStart: () => Promise.resolve({ ok: false, error: 'browser-no-vb' }),
    vbStop: () => Promise.resolve({ ok: false }),
    vbNotify: () => Promise.resolve({ ok: false }),
    vbCtrl: () => Promise.resolve({ ok: false, error: 'browser-no-vb' }),
    onVbEvent: () => () => { /* no-op */ },
  };
}

/* ================= 探测与单例 ================= */

let cached: PdbBridge | null = null;

/** 获取桥接单例（能力探测只做一次）。调用方无需感知环境差异。 */
export function getBridge(): PdbBridge {
  if (!cached) {
    cached = typeof window !== 'undefined' && window.pdb ? electronBridge(window.pdb) : browserBridge();
  }
  return cached;
}

/** 便捷判断（UI 上用于「浏览器模式：物理校准需手动」之类的提示） */
export function isElectron(): boolean {
  return getBridge().env === 'electron';
}

/* ============================================================================
 * 追加：浏览器 appData 降级实现（localStorage）
 * ----------------------------------------------------------------------------
 * 与 Electron 侧一致的安全约束：文件名白名单 ^[A-Za-z0-9._-]{1,128}$，拒绝 '..'、
 * 绝对路径与任何路径分隔符（浏览器侧虽无真实文件系统，仍保持同名消毒以免两侧行为漂移）。
 * localStorage 不可用（隐私模式/配额满）时静默返回 null / false / []，**永不抛异常**。
 * 函数声明会提升，上方 electronBridge/browserBridge 先引用后声明是安全的。
 * ========================================================================== */

/** localStorage key 前缀 */
const APPDATA_LS_PREFIX = 'pindou-studio:appdata:';
const APPDATA_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** 取得可用的 Storage；不可用返回 null */
function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__pdb_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/** 文件名消毒（与 main.mjs 同构）；不合法返回 null */
export function sanitizeAppDataName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (n.length === 0 || n.length > 128) return null;
  if (n === '.' || n === '..') return null;
  if (n.includes('..')) return null;
  if (/[/\\:]/.test(n)) return null;
  if (!APPDATA_NAME_RE.test(n)) return null;
  return n;
}

async function browserReadAppData(name: string): Promise<string | null> {
  const safe = sanitizeAppDataName(name);
  if (!safe) return null;
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    return ls.getItem(APPDATA_LS_PREFIX + safe);
  } catch {
    return null;
  }
}

async function browserWriteAppData(name: string, text: string): Promise<boolean> {
  const safe = sanitizeAppDataName(name);
  if (!safe) return false;
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(APPDATA_LS_PREFIX + safe, typeof text === 'string' ? text : '');
    return true;
  } catch {
    return false; // 配额满/隐私模式：静默失败，不影响 localStorage 主保存路径
  }
}

async function browserListAppData(prefix?: string): Promise<string[]> {
  const ls = safeLocalStorage();
  if (!ls) return [];
  const p = typeof prefix === 'string' ? prefix.trim() : '';
  if (p.includes('..') || /[/\\:]/.test(p)) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (!key || !key.startsWith(APPDATA_LS_PREFIX)) continue;
      const name = key.slice(APPDATA_LS_PREFIX.length);
      if (!name.startsWith(p)) continue;
      if (!name.endsWith('.json')) continue;
      out.push(name);
    }
  } catch {
    return out;
  }
  return out.sort();
}

