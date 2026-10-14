/**
 * Electron 主进程 —— 窗口 / 多显示器 / 无边框全屏 / 防休眠 / 文件读写 / IPC 路由。
 *
 * 安全基线（安全基线）：
 *   contextIsolation: true · nodeIntegration: false · sandbox: false（preload 需 ESM import）· webSecurity: true
 *   渲染进程只能经 preload 暴露的 window.pdb 8 个能力触达主进程，拿不到 ipcRenderer 本体。
 */
import { app, BrowserWindow, screen, ipcMain, dialog, powerSaveBlocker, net, shell, session } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fsp, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  PDB_DISPLAYS_LIST,
  PDB_DISPLAY_PHYSICAL,
  PDB_FULLSCREEN_ENTER,
  PDB_FULLSCREEN_EXIT,
  PDB_KEEP_AWAKE,
  PDB_FILE_OPEN,
  PDB_FILE_SAVE,
  PDB_APP_INFO,
  PDB_DISPLAYS_CHANGED,
  PDB_WINDOW_MINIMIZE,
  PDB_WINDOW_MAXIMIZE_TOGGLE,
  PDB_WINDOW_CLOSE,
} from '../shared/ipc.mjs';
import { queryDisplaysPhysicalCm } from './wmi.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** powerSaveBlocker 句柄（-1 = 未开启） */
let awakeBlockerId = -1;
/** WMI 物理厘米缓存：启动查一次，显示器拓扑变化时失效重查（查询本身有 3s 超时兜底，绝不阻塞） */
let wmiCache = null;
let wmiQueried = false;
/**
 * 进指定屏全屏前的「普通状态」边界（缺陷 #46）。
 * 全屏路径里的 setBounds(目标屏尺寸) 会把窗口的「还原尺寸」覆盖成整屏大小，
 * 退出全屏后窗口就停在整屏尺寸——最大化/还原看似失灵。进出全屏时成对保存/恢复。
 */
let preFullscreenBounds = null;

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,             // 发光底板：无系统边框，自绘标题区
    backgroundColor: '#FFF8F2',
    title: 'PinDou Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // preload 为 .mjs（ESM），sandbox:true 下无法 import
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 新窗口一律拦截：http(s) 链接交系统浏览器（图纸 Web「打开原帖」用），其余拒绝
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:') void shell.openExternal(url);
    } catch { /* 非法 URL 忽略 */ }
    return { action: 'deny' };
  });

  // dev：Vite 开发服务器；start/build 产物：dist/index.html（base:'./' 保证 file:// 下资源可寻）
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    // mainWindow.webContents.openDevTools({ mode: 'detach' }); // 需要调试时取消注释
  } else {
    void mainWindow.loadURL(pathToFileURL(path.join(PROJECT_ROOT, 'dist', 'index.html')).href);
  }
}

/**
 * 枚举全部显示器 → DisplayMetrics[]（src/core/types.ts 的运行时对应物，字段名一字不差）。
 * bounds/workArea 在 Electron 中即 DIP≈CSS px；devicePx = bounds × scaleFactor。
 * 物理厘米来自 WMI（失败/虚拟屏 → physicalMm=null, isVirtual=true）。
 */
async function collectDisplays() {
  if (!wmiQueried) {
    wmiQueried = true;
    wmiCache = await queryDisplaysPhysicalCm(); // 3s 超时兜底，永不 throw
  }
  const wmi = Array.isArray(wmiCache) ? wmiCache : [];
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  // WMI 行 ↔ 显示器匹配：按设备分辨率宽高比贪心配对（Index 顺序在存在虚拟屏/多屏时会错配）。
  // WMI InstanceName 与 Chromium display id 之间无可靠 EDID 桥接，宽高比是最稳定的可观测信号。
  const namedVirtual = new Set();
  const candidates = [];
  all.forEach((d, idx) => {
    if (/virtual|indirect/i.test(d.label || '')) {
      namedVirtual.add(idx);
    } else {
      candidates.push({ idx, aspect: (d.bounds.width * (d.scaleFactor || 1)) / (d.bounds.height * (d.scaleFactor || 1)) });
    }
  });
  const wmiByDisplayIdx = new Map();
  const wmiDiffByDisplayIdx = new Map();
  if (candidates.length > 0 && wmi.length > 0) {
    const rows = wmi.map((r) => ({
      row: r,
      aspect: r.widthCm > 0 && r.heightCm > 0 ? r.widthCm / r.heightCm : 1,
      used: false,
    }));
    // 贪心：每轮取「显示器×剩余 WMI 行」中宽高比差最小的一对（显示器数 ≠ 行数时也能各取所需）
    for (let n = Math.min(candidates.length, rows.length); n > 0; n--) {
      let best = null;
      for (const c of candidates) {
        for (const r of rows) {
          if (r.used) continue;
          const diff = Math.abs(Math.log(c.aspect / r.aspect));
          if (!best || diff < best.diff) best = { c, r, diff };
        }
      }
      if (!best) break;
      best.r.used = true;
      wmiByDisplayIdx.set(best.c.idx, best.r.row);
      // 记下匹配差：UI 据此提示「物理尺寸是否张冠李戴」（|log(aspect 比)|≈相对比例偏差）
      wmiDiffByDisplayIdx.set(best.c.idx, best.diff);
    }
  }

  return all.map((d, idx) => {
    const dpr = d.scaleFactor || 1;
    const devicePx = {
      width: Math.round(d.bounds.width * dpr),
      height: Math.round(d.bounds.height * dpr),
    };
    const label = d.label || `显示器 ${idx + 1}`;
    // 虚拟屏识别：label 含 Virtual/Indirect，或没能匹配到任何 WMI 物理尺寸
    const virtualByName = namedVirtual.has(idx);
    const phys = wmiByDisplayIdx.get(idx);
    const physicalMm = phys && !virtualByName
      ? { width: phys.widthCm * 10, height: phys.heightCm * 10 }
      : null;
    // 匹配置信度：<2% 视为高可信，<6% 中，再大说明物理尺寸可能张冠李戴（UI 提示复核）
    const aspectDiff = wmiDiffByDisplayIdx.get(idx);
    const matchConfidence = physicalMm
      ? (aspectDiff < 0.02 ? 'high' : aspectDiff < 0.06 ? 'medium' : 'low')
      : undefined;
    return {
      id: String(d.id),
      label,
      isPrimary: d.id === primary.id,
      isVirtual: virtualByName || physicalMm === null,
      boundsCss: { width: d.bounds.width, height: d.bounds.height },
      workAreaCss: { width: d.workArea.width, height: d.workArea.height },
      devicePx,
      devicePixelRatio: dpr,
      physicalMm,
      matchConfidence,
      ppi: physicalMm
        ? { x: devicePx.width / (physicalMm.width / 25.4), y: devicePx.height / (physicalMm.height / 25.4) }
        : null,
      mmPerDevicePx: physicalMm
        ? { x: physicalMm.width / devicePx.width, y: physicalMm.height / devicePx.height }
        : null,
    };
  });
}

/* ---------------- IPC 路由（频道名全部来自 shared/ipc.mjs 契约） ---------------- */

ipcMain.handle(PDB_DISPLAYS_LIST, () => collectDisplays());

ipcMain.handle(PDB_DISPLAY_PHYSICAL, async (_e, id) => {
  const displays = await collectDisplays();
  const d = displays.find((x) => x.id === String(id));
  if (!d || !d.physicalMm) return null;
  return { id: d.id, widthCm: d.physicalMm.width / 10, heightCm: d.physicalMm.height / 10 };
});

ipcMain.handle(PDB_FULLSCREEN_ENTER, (_e, displayId) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) ?? screen.getPrimaryDisplay();
  // 在指定显示器无边框全屏：先贴到目标屏 bounds，再进全屏（发光底板零浏览器 UI）
  // 缺陷 #46：setBounds 会覆盖窗口的「还原尺寸」，进全屏前记住普通状态边界
  try {
    preFullscreenBounds = mainWindow.getNormalBounds();
  } catch {
    preFullscreenBounds = null;
  }
  mainWindow.setBounds(target.bounds);
  mainWindow.setFullScreen(true);
});

ipcMain.handle(PDB_FULLSCREEN_EXIT, () => {
  if (mainWindow && mainWindow.isDestroyed()) return;
  if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  // 缺陷 #46：把进全屏前的小窗口边界还回去（setFullScreen 只会回到被覆盖过的还原尺寸）
  if (preFullscreenBounds) {
    mainWindow.setBounds(preFullscreenBounds);
    preFullscreenBounds = null;
  }
});

/* 窗口控制：无边框窗口的最小化/最大化切换/关闭 */
ipcMain.handle(PDB_WINDOW_MINIMIZE, () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle(PDB_WINDOW_MAXIMIZE_TOGGLE, () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});

ipcMain.handle(PDB_WINDOW_CLOSE, () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

ipcMain.handle(PDB_KEEP_AWAKE, (_e, on) => {
  if (on) {
    if (awakeBlockerId === -1) {
      awakeBlockerId = powerSaveBlocker.start('prevent-display-sleep'); // 长时间拼豆必需
    }
  } else if (awakeBlockerId !== -1) {
    powerSaveBlocker.stop(awakeBlockerId);
    awakeBlockerId = -1;
  }
});

ipcMain.handle(PDB_FILE_OPEN, async (_e, filters) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开文件',
    properties: ['openFile'],
    filters: Array.isArray(filters) && filters.length > 0
      ? filters
      : [{ name: '支持的文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const data = await fsp.readFile(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'bin';
  const mime = ext === 'json' ? 'application/json' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return { path: filePath, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
});

/**
 * 从 defaultName 末尾取**多段扩展名**（如 x.pdp.json → '.pdp.json'）。
 * path.extname 只认最后一段，曾把 '*.pdp.json' 文件误判为 '.json'，
 * 导致保存对话框过滤器显示 *.json 而非 *.pdp.json。
 * 规则：文件名含主名（首段非空）且末尾至少两段扩展时取末尾两段，否则回退 path.extname。
 */
function multiSegmentExt(defaultName) {
  const base = String(defaultName || '').trim();
  if (!base) return '.json';
  const parts = base.split('.');
  const last = parts[parts.length - 1] || '';
  const secondLast = parts[parts.length - 2] || '';
  if (parts.length >= 3 && parts[0].length > 0 && last.length > 0 && secondLast.length > 0) {
    return `.${parts.slice(-2).join('.')}`;
  }
  return path.extname(base) || '.json';
}

ipcMain.handle(PDB_FILE_SAVE, async (_e, defaultName, payload) => {
  if (!mainWindow) return null;
  const ext = multiSegmentExt(defaultName);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存文件',
    defaultPath: defaultName || `pindou${ext}`,
    filters: [{ name: `*${ext}`, extensions: [ext.slice(1)] }, { name: '全部文件', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  // 契约：payload = {base64} 或 {text} 二选一
  if (payload && typeof payload.base64 === 'string') {
    await fsp.writeFile(result.filePath, Buffer.from(payload.base64, 'base64'));
  } else {
    await fsp.writeFile(result.filePath, String((payload && payload.text) ?? ''), 'utf8');
  }
  return { path: result.filePath };
});

ipcMain.handle(PDB_APP_INFO, () => ({
  version: pkgVersion(),
  platform: process.platform,
  isElectron: true,
  node: process.versions.node,
  electron: process.versions.electron,
}));

/* ---------------- 生命周期 ---------------- */

// 单实例锁：重复点击桌面快捷方式时**聚焦已有窗口**而不是再开一个进程——
// 多实例会共用同一份 localStorage（LevelDB 被锁）且自动保存互相覆盖，
// 也是「点了快捷方式怎么界面还是旧的」的最常见原因（旧窗口一直停在屏幕上）。
// dev 模式（npm run dev）豁免：开发时可能需要与正式实例并存。
const useSingleInstance = !process.env.VITE_DEV_SERVER_URL;
if (useSingleInstance && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!useSingleInstance) return;
    const win = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    // 分辨率/缩放/显示器插拔 → 推送给渲染进程（据此弹重校准提示）
    screen.on('display-metrics-changed', () => {
      // 插拔/改分辨率后 WMI 物理尺寸表可能变化：失效缓存，下次 collectDisplays 重查
      wmiQueried = false;
      wmiCache = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(PDB_DISPLAYS_CHANGED);
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (awakeBlockerId !== -1) {
    powerSaveBlocker.stop(awakeBlockerId);
    awakeBlockerId = -1;
  }
  if (process.platform !== 'darwin') app.quit();
});

/* ============================================================================
 * 追加：应用私有数据目录（appData）受限文本读写 IPC
 * ----------------------------------------------------------------------------
 * 仅新增，上方所有既有 handler / 生命周期代码 / 安全基线配置一字未改。
 *
 * 安全设计（渲染进程拿不到任意路径能力）：
 *   ・根目录写死为 app.getPath('userData')/pindou-studio-data/，不可由渲染进程参数改变；
 *   ・文件名白名单 ^[A-Za-z0-9._-]{1,128}$；显式拒绝 '..'、绝对路径、/ \ : 等任何分隔符；
 *   ・另外做一次 path.resolve 后的“包含关系”校验（双保险，防未来白名单被放宽后遗漏）；
 *   ・只做 UTF-8 文本读写，不返回 Buffer/句柄，不暴露 fs/path 本体；
 *   ・全部 try/catch + 超时，失败一律降级为 null / false / []，绝不抛到渲染进程。
 * ========================================================================== */
// ESM import 声明会被提升到模块顶部求值，因此放在文件末尾仍先于下方 handler 注册完成。
import {
  PDB_APPDATA_READ,
  PDB_APPDATA_WRITE,
  PDB_APPDATA_LIST,
} from '../shared/ipc.mjs';

/** 应用私有数据子目录名（位于 userData 之下） */
const APPDATA_DIRNAME = 'pindou-studio-data';
/** 文件名白名单：只允许安全字符，不包含任何分隔符 */
const APPDATA_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** 前缀白名单：允许空字符串（= 列全部） */
const APPDATA_PREFIX_RE = /^[A-Za-z0-9._-]{0,64}$/;
/** 文件 IO 超时（沿用 wmi.mjs 的“超时则降级”风格） */
const APPDATA_TIMEOUT_MS = 5000;
/** 单次写入上限（防误操作把巨大 base64 源图刷进 appData） */
const APPDATA_MAX_WRITE_BYTES = 32 * 1024 * 1024;

function appDataDir() {
  return path.join(app.getPath('userData'), APPDATA_DIRNAME);
}

/** 文件名消毒：不合法返回 null（而非抛错） */
function safeAppDataName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (n.length === 0 || n.length > 128) return null;
  if (n === '.' || n === '..') return null;
  if (n.includes('..')) return null;                 // 拒绝任何形式的目录回退
  if (/[/\\:]/.test(n)) return null;                  // 拒绝任何路径分隔符与 Windows 盘符
  if (path.isAbsolute(n)) return null;                // 拒绝绝对路径
  if (!APPDATA_NAME_RE.test(n)) return null;          // 白名单校验
  return n;
}

/** 前缀消毒（listAppData） */
function safeAppDataPrefix(prefix) {
  if (prefix === undefined || prefix === null) return '';
  if (typeof prefix !== 'string') return null;
  const p = prefix.trim();
  if (p.includes('..') || /[/\\:]/.test(p)) return null;
  return APPDATA_PREFIX_RE.test(p) ? p : null;
}

/** 双保险：解析后的绝对路径必须仍位于 appData 目录内 */
function resolveInsideAppData(safeName) {
  const dir = appDataDir();
  const full = path.resolve(dir, safeName);
  const rel = path.relative(dir, full);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (path.dirname(full) !== dir) return null;        // 只允许一层，不允许子目录
  return full;
}

/** 给文件 IO 加超时；超时/异常统一返回 fallback */
function withAppDataTimeout(promise, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, APPDATA_TIMEOUT_MS);
    promise.then(
      (value) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

ipcMain.handle(PDB_APPDATA_READ, async (_e, name) => {
  try {
    const safe = safeAppDataName(name);
    if (!safe) return null;
    const full = resolveInsideAppData(safe);
    if (!full) return null;
    // 不存在（ENOENT）也走 catch → null，渲染进程无需区分“没写过”与“读失败”
    return await withAppDataTimeout(fsp.readFile(full, 'utf8'), null);
  } catch {
    return null;
  }
});

ipcMain.handle(PDB_APPDATA_WRITE, async (_e, name, text) => {
  try {
    const safe = safeAppDataName(name);
    if (!safe) return false;
    const full = resolveInsideAppData(safe);
    if (!full) return false;
    const body = typeof text === 'string' ? text : '';
    if (Buffer.byteLength(body, 'utf8') > APPDATA_MAX_WRITE_BYTES) return false;
    const dir = appDataDir();
    await withAppDataTimeout(fsp.mkdir(dir, { recursive: true }), undefined);
    const ok = await withAppDataTimeout(
      fsp.writeFile(full, body, 'utf8').then(() => true),
      false,
    );
    return ok === true;
  } catch {
    return false;
  }
});

ipcMain.handle(PDB_APPDATA_LIST, async (_e, prefix) => {
  try {
    const p = safeAppDataPrefix(prefix);
    if (p === null) return [];
    const dir = appDataDir();
    const entries = await withAppDataTimeout(fsp.readdir(dir, { withFileTypes: true }), []);
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e) => e.isFile() && e.name.startsWith(p) && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
});

/* ============================================================================
 * 图纸 Web（社区图纸检索）——受限 HTTPS GET 代理
 * ----------------------------------------------------------------------------
 * 动机：渲染进程直连 reddit.com 受 CORS 限制且 UA 会被拒；Electron net.fetch
 * 走 Chromium 网络栈——**自动跟随系统代理**，用户开着 Clash 等代理软件时
 * 海外社区即可达，无需在应用里再做代理配置。
 * 安全约束（本侧强制执行）：仅 https、主机白名单、仅 GET、响应上限 15MB、
 * 不透传调用方任何头。失败一律 resolve {ok:false,error}，不抛。
 * ========================================================================== */
import { PDB_WEB_FETCH } from '../shared/ipc.mjs';


const WEB_FETCH_ALLOWED_HOSTS = new Set([
  // KandiPatterns 图纸库（列表/搜索页 + S3 图源）
  'kandipatterns.com', 'www.kandipatterns.com', 's3.amazonaws.com',
  // 拼豆社区（国内图纸库：API + 静态图）
  'beans-api.moss-art.cn', 'static.pindouclub.cn',
]);
const WEB_FETCH_MAX_BYTES = 15 * 1024 * 1024;

/* 出口回退链：直连失败（网络错误 / 403 / 429）时，依次试本机常见代理端口。
 * 每个候选用独立 partition session 注入 proxyRules（不影响默认会话/页面加载）。
 * 命中过的候选会缓存到 _webFetchProxy，之后的请求直接用它。 */
let _webFetchProxy = null;
let _webFetchSession = null;
const WEB_FETCH_PROXY_CANDIDATES = [
  'socks5://127.0.0.1:7891',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:10809',
  'socks5://127.0.0.1:1080',
];
/** 惰性建 partition session（app ready 前不能拿 Session） */
function webFetchSession() {
  if (!_webFetchSession) _webFetchSession = session.fromPartition('pdb-webfetch');
  return _webFetchSession;
}

/** 探测一个代理候选是否可用（4s 超时；204 = 通） */
async function probeWebFetchProxy(rules) {
  try {
    await webFetchSession().setProxy({ proxyRules: rules });
    const res = await webFetchSession().fetch('https://www.gstatic.com/generate_204', {
      signal: AbortSignal.timeout(4000),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/** redirect:'error' 拒绝跟随时的报错识别。Electron ClientRequest（net-client-request.ts）在
 *  redirect 政策为 error 命中 30x 时以 Error("Attempted to redirect, but redirect policy was 'error'")
 *  使 fetch reject；按片段匹配，避免把普通网络错误误判成重定向拒绝。 */
function isRedirectBlocked(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /redirect policy was 'error'|attempted to redirect/i.test(msg);
}

/** 上次代理取回失败是否因重定向被拒（上游 30x 与出口无关，不应据此清代理缓存） */
let _webFetchRedirectBlocked = false;

/** 用当前（或探测到的）代理会话取一次 URL；失败返回 null */
async function fetchViaProxy(url, headers, postBody = null) {
  _webFetchRedirectBlocked = false;
  if (!_webFetchProxy) {
    for (const cand of WEB_FETCH_PROXY_CANDIDATES) {
      if (await probeWebFetchProxy(cand)) {
        _webFetchProxy = cand;
        console.warn('[WEB_FETCH] proxy adopted:', cand);
        break;
      }
    }
    if (!_webFetchProxy) return null;
  }
  try {
    await webFetchSession().setProxy({ proxyRules: _webFetchProxy });
    return await webFetchSession().fetch(url, {
      headers,
      method: postBody ? 'POST' : 'GET',
      body: postBody ?? undefined,
      redirect: 'error', // 白名单只校验初始 URL：不能放任 30x 把请求甩到任意主机
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (isRedirectBlocked(err)) {
      _webFetchRedirectBlocked = true;
      return null;
    }
    _webFetchProxy = null; // 失效，下次重新探测
    return null;
  }
}

/** 是否值得换出口重试：网络层失败或被风控/限流 */
function shouldRetryViaProxy(status) {
  return status === undefined || status === null || status === 403 || status === 429 || status >= 500;
}

/** 统一读响应体：先按 content-length 预检，超限直接拒绝（不把大 body 拉进内存）；
 *  没有该头（chunked 等）时仍下载后按实际字节数兜底。 */
async function readUpstreamBody(res, via) {
  const cl = parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(cl) && cl > WEB_FETCH_MAX_BYTES) return { ok: false, error: 'too-large' };
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > WEB_FETCH_MAX_BYTES) return { ok: false, error: 'too-large' };
  return { ok: true, status: res.status, contentType: res.headers.get('content-type') ?? '', data: body, via };
}

ipcMain.handle(PDB_WEB_FETCH, async (_e, rawReq) => {
  // 兼容两种入参：字符串（GET）或 {url, method, body}
  let rawUrl = typeof rawReq === 'string' ? rawReq : rawReq?.url;
  let postBody = typeof rawReq === 'object' && rawReq && typeof rawReq.body === 'string' ? rawReq.body : null;
  try {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
      return { ok: false, error: 'bad-url' };
    }
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return { ok: false, error: 'bad-url' };
    }
    if (u.protocol !== 'https:') return { ok: false, error: 'https-only' };
    if (!WEB_FETCH_ALLOWED_HOSTS.has(u.hostname)) return { ok: false, error: 'host-not-allowed' };
    const headers = {
      // Reddit 对无标识 UA 会 429/403；带描述性 UA 走公开 JSON 接口
      'User-Agent': 'pindou-studio/0.1 (desktop bead pattern importer)',
      Accept: '*/*',
    };
    let res = null;
    try {
      res = await net.fetch(u.toString(), {
        method: postBody ? 'POST' : 'GET',
        headers: postBody ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: postBody ?? undefined,
        redirect: 'error', // 白名单只校验初始 URL：默认跟随重定向可被 30x 甩到任意主机，必须拒绝
        // 直连也限时（与代理路径 20s 对齐）：白名单主机挂起时 handler 永不 resolve，
        // 渲染层裸 await 会永久 loading；超时落入下方 catch 后照常走代理回退
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      // 重定向被拒是策略拒绝而非网络故障，换出口（代理）上游照样 30x：直接回报，不再回退
      if (isRedirectBlocked(err)) return { ok: false, error: 'upstream-redirect-blocked' };
      res = null; // 网络层失败 → 走代理回退
    }
    if ((!res || shouldRetryViaProxy(res.status))) {
      const proxied = await fetchViaProxy(u.toString(), headers, postBody);
      if (proxied) {
        if (proxied.ok) return await readUpstreamBody(proxied, _webFetchProxy ?? 'proxy');
        // 代理有明确 HTTP 回应：透传真实状态码（与浏览器分支 http-N 契约一致）；
        // 丢掉后落到底部会冒报 network/via:'none'，既失真也不利排查
        return { ok: false, status: proxied.status, error: `http-${proxied.status}`, via: 'proxy' };
      }
    }
    if (!res) return { ok: false, error: _webFetchRedirectBlocked ? 'upstream-redirect-blocked' : 'network', via: 'none' };
    if (!res.ok) return { ok: false, status: res.status, error: `http-${res.status}` };
    return await readUpstreamBody(res, 'direct');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name.toLowerCase() : 'network' };
  }
});

/* ============================================================================
 * 智能拼豆板 · Web Bluetooth 设备选择器接管
 * ----------------------------------------------------------------------------
 * Electron 没有内建的蓝牙选择框：requestDevice() 扫描到设备后，session 抛
 * select-bluetooth-device，我们必须 preventDefault 并**自己**把设备列表交给渲染
 * 进程画选择 UI，用户点选后回调喂回 Promise。本段只做"转发 + 等待回执"，
 * 真正连 GATT / 读写特征全在渲染进程（Web Bluetooth API）完成。
 * 约束：同时最多挂起一个选择请求（requestDevice 本就串行）；60s 无回执自动取消。
 * ========================================================================== */
import { PDB_BT_PICKER, PDB_BT_PICKED } from '../shared/ipc.mjs';

const BT_PICK_TIMEOUT_MS = 60_000;
/** @type {{ requestId: string, done: (deviceId: string|null) => void, timer: NodeJS.Timeout } | null} */
let btPickPending = null;

function btPickSettle(deviceId) {
  if (!btPickPending) return false;
  clearTimeout(btPickPending.timer);
  const { done } = btPickPending;
  btPickPending = null;
  done(typeof deviceId === 'string' && deviceId ? deviceId : null);
  return true;
}

/**
 * 兼容两种 Electron 事件签名：
 *   (event, devices, callback)            —— 现行文档形态
 *   (event, details{devices, callback})   —— 个别版本把后两者打包进 details
 * 统一归一化后走同一条路。
 */
function registerBluetoothDevicePicker() {
  session.defaultSession.on('select-bluetooth-device', (event, arg2, arg3) => {
    // 先 preventDefault 声明由我们接管；不接管时 Electron 直接取消
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    let devices = arg2;
    let callback = arg3;
    if (arg2 && !Array.isArray(arg2) && Array.isArray(arg2.devices)) {
      devices = arg2.devices;
      callback = typeof arg2.callback === 'function' ? arg2.callback : arg3;
    }
    if (typeof callback !== 'function') {
      callback = typeof arg2 === 'function' ? arg2 : null;
    }
    if (!Array.isArray(devices) || typeof callback !== 'function') return;

    if (!mainWindow || mainWindow.isDestroyed()) {
      callback(null); // 没有窗口可问，直接取消，Promise 不悬挂
      return;
    }
    // 旧挂起请求（理论上不该出现）：先取消旧的
    if (btPickPending) btPickSettle(null);

    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    btPickPending = {
      requestId,
      done: callback,
      timer: setTimeout(() => {
        if (btPickPending && btPickPending.requestId === requestId) {
          btPickPending = null;
          callback(null);
          mainWindow?.webContents.send(PDB_BT_PICKER, null); // 通知渲染层收起选择 UI
        }
      }, BT_PICK_TIMEOUT_MS),
    };
    mainWindow.webContents.send(
      PDB_BT_PICKER,
      {
        requestId,
        devices: devices.map((d) => ({
          id: String(d.deviceId ?? ''),
          name: String(d.name ?? d.forgettableName ?? ''),
        })),
      },
    );
  });
}

ipcMain.handle(PDB_BT_PICKED, (_e, requestId, deviceId) => {
  if (!btPickPending || typeof requestId !== 'string' || btPickPending.requestId !== requestId) {
    return false; // 已过期/取消
  }
  btPickSettle(typeof deviceId === 'string' ? deviceId : null);
  return true;
});

// 蓝牙选择器与 session 无关窗口生命周期，注册一次即可
app.whenReady().then(registerBluetoothDevicePicker);

/* ============================================================================
 * PC 虚拟智能拼豆板——C# 旁路进程托管
 * ----------------------------------------------------------------------------
 * VirtualBoard.cs（WinRT GATT Server + BLE 广播）按需编译到 userData 下并 spawn，
 * stdout JSONL → PDB_VB_EVENT 推给渲染进程；渲染进程可回发 notify（设备→App）。
 * 编译依赖：.NET Framework 4.x csc + WinMetadata（Win10/11 自带），零第三方。
 * ========================================================================== */
import { PDB_VB_START, PDB_VB_STOP, PDB_VB_NOTIFY, PDB_VB_CTRL, PDB_VB_EVENT } from '../shared/ipc.mjs';
import { spawn } from 'node:child_process';

const VB = { proc: null, exe: null, compiling: false, quitting: false };

/** 定位旁路源码：打包后走 resources/tools，开发态走工程根 tools/ */
function vbSourcePath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'tools', 'virtualboard', 'VirtualBoard.cs'),
    path.join(PROJECT_ROOT, 'tools', 'virtualboard', 'VirtualBoard.cs'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** 确保 exe 存在且不比源码旧；成功返回 exe 路径，失败返回 { exe:null, why } 供日志透出。
 *  异步版（spawn + exit 事件）：首次「开始广播」的同步编译曾用 spawnSync 卡死主进程
 *  事件循环数秒，这里改为等待 Promise，判定逻辑（cs 比 exe 新则重编译、否则复用）不变。 */
async function ensureVbExe() {
  const cs = vbSourcePath();
  if (!cs) return { exe: null, why: '未找到 tools/virtualboard/VirtualBoard.cs 源码' };
  const outDir = path.join(app.getPath('userData'), 'virtualboard');
  const exe = path.join(outDir, 'VirtualBoard.exe');
  try {
    const st = statSync(cs);
    if (existsSync(exe) && statSync(exe).mtimeMs >= st.mtimeMs) return { exe, why: null };
  } catch { /* 首次编译 */ }
  const root = process.env.SystemRoot || 'C:\\Windows';
  const fxDir = existsSync(path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'))
    ? path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
    : path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319');
  if (!existsSync(path.join(fxDir, 'csc.exe'))) {
    return { exe: null, why: `未找到 .NET Framework 4.x csc（${fxDir}）` };
  }
  const winmd = (n) => path.join(root, 'System32', 'WinMetadata', n);
  const gac = (short) => path.join(root, 'Microsoft.Net', 'assembly', 'GAC_MSIL', short,
    'v4.0_4.0.0.0__b03f5f7f11d50a3a', short + '.dll');
  const args = [
    '-nologo', '-target:exe', `-out:${exe}`,
    '-r:' + winmd('Windows.Foundation.winmd'),
    '-r:' + winmd('Windows.Devices.winmd'),
    '-r:' + winmd('Windows.Networking.winmd'),
    '-r:' + winmd('Windows.Storage.winmd'),
    '-r:' + winmd('Windows.Security.winmd'),
    '-r:' + path.join(fxDir, 'System.Runtime.WindowsRuntime.dll'),
    '-r:' + gac('System.Runtime'),
    '-r:' + gac('System.Runtime.InteropServices.WindowsRuntime'),
    cs,
  ];
  try {
    mkdirSync(outDir, { recursive: true });
  } catch { /* 已存在 */ }
  return new Promise((resolve) => {
    const csc = spawn(path.join(fxDir, 'csc.exe'), args, { windowsHide: true });
    let out = '';
    let settled = false;
    let timer;
    // 统一出口：error/exit/超时三路竞态只兑现一次（并清理定时器）
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // 超时兜底：csc 若挂起（无输出不退出）Promise 永不 resolve，VB.compiling 恒 true，
    // 之后所有 START 恒回 compiling，旁路功能永久失效——60s 足够这个单文件编译
    timer = setTimeout(() => {
      try { csc.kill(); } catch { /* 已退出 */ }
      console.warn('[VB] csc 编译超时（60s），已终止');
      done({ exe: null, why: 'csc 编译超时（60s）' });
    }, 60000);
    csc.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    csc.stderr?.on('data', (d) => { out += d.toString('utf8'); });
    csc.on('error', (err) => {
      const why = `csc 编译失败: ${err.name}: ${err.message}`;
      console.warn('[VB]', why);
      done({ exe: null, why });
    });
    csc.on('exit', (code) => {
      if (code !== 0) {
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        const why = `csc 编译失败: ${lines.slice(-3).join(' ⏎ ') || `exit ${code ?? '?'}`}`;
        console.warn('[VB]', why);
        done({ exe: null, why });
        return;
      }
      done({ exe, why: null });
    });
  });
}

/** 停掉旁路进程：先写 exit 指令再延迟 1.5s 补刀（留优雅退出窗口）。
 *  quit 路径必须传 syncKill=true 同步杀——before-quit 之后事件循环随时终结，
 *  setTimeout 的延迟补刀不会执行，等于不杀，旁路会残留成僵尸继续占用 BLE 广播。 */
function vbStop(syncKill = false) {
  if (!VB.proc) return;
  try {
    VB.proc.stdin.write('{"cmd":"exit"}\n');
    VB.proc.stdin.write('exit\n');
  } catch { /* 管道已断 */ }
  const p = VB.proc;
  VB.proc = null;
  if (syncKill) {
    try { p.kill(); } catch { /* 已退出 */ }
    return;
  }
  setTimeout(() => { try { p.kill(); } catch { /* 已退出 */ } }, 1500);
}

ipcMain.handle(PDB_VB_START, async (_e, cfg) => {
  // 防重入：编译进行中再次点「开始广播」直接拒绝，避免双击产生双编译/双进程
  if (VB.compiling) return { ok: false, error: 'compiling' };
  vbStop();
  VB.compiling = true;
  let built;
  try {
    built = await ensureVbExe(); // 异步编译：不再卡主进程事件循环
  } finally {
    VB.compiling = false;
  }
  if (!built.exe) return { ok: false, error: `compile-failed: ${built.why}` };
  if (VB.quitting) return { ok: false, error: 'quitting' }; // 编译兜完应用已在退出：不再拉起旁路
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const name = typeof c.name === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(c.name) ? c.name : 'pindou-PC01';
  const guid = (s) => (typeof s === 'string' && /^[0-9a-fA-F-]{36}$/.test(s) ? s : null);
  const service = guid(c.service) || '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
  const char = guid(c.char) || 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
  const w = Math.min(255, Math.max(1, Math.round(Number(c.w) || 104)));
  const h = Math.min(255, Math.max(1, Math.round(Number(c.h) || 104)));
  const pixdou = c.protocol === 'pixdou'; // 颂拼豆 PIXDOU：双特征 a950/51/52 + 0x54 同构帧（回码结果字节=1）
  const args = ['--name', name, '--w', String(w), '--h', String(h)];
  if (pixdou) args.push('--pixdou');
  else args.push('--service', service, '--char', char);
  try {
    VB.proc = spawn(built.exe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return { ok: false, error: 'spawn-failed' };
  }
  // spawn 同步成功 ≠ 进程真能跑：异步失败（exe 被杀软隔离等）时无监听的 'error'
  // 事件会让 Node 直接 throw，整个主进程崩掉——必须挂监听
  VB.proc.on('error', (err) => {
    VB.proc = null;
    console.warn('[VB] 旁路进程异常:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(PDB_VB_EVENT, { ev: 'error', msg: '旁路进程异常：' + (err instanceof Error ? err.message : String(err)) });
    }
  });
  let stderrTail = '';
  VB.proc.stderr?.on('data', (d) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-500);
  });
  let buf = '';
  VB.proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const payload = JSON.parse(line);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(PDB_VB_EVENT, payload);
      } catch { /* 非 JSON 行忽略 */ }
    }
  });
  VB.proc.on('exit', (code, sig) => {
    VB.proc = null;
    const tail = stderrTail.replace(/\s+/g, ' ').trim();
    if (code !== 0 || tail) {
      console.warn('[VB] exited code=' + code + ' sig=' + sig + (tail ? ' stderr: ' + tail : ''));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(PDB_VB_EVENT, { ev: 'error', msg: '旁路异常退出 code=' + code + (tail ? '：' + tail : '') });
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(PDB_VB_EVENT, { ev: 'stopped', code: code ?? -1 });
    }
  });
  return { ok: true, name, service: pixdou ? '0000a950-0000-1000-8000-00805f9b34fb' : service, char: pixdou ? '0000a951-0000-1000-8000-00805f9b34fb' : char, w, h, protocol: pixdou ? 'pixdou' : 'kmpd' };
});

ipcMain.handle(PDB_VB_STOP, () => { vbStop(); return { ok: true }; });

/** 旁路控制行（PIXDOU 回码调试）：只放行白名单命令，直接写 stdin */
ipcMain.handle(PDB_VB_CTRL, (_e, line) => {
  if (!VB.proc) return { ok: false, error: 'not-running' };
  const s = typeof line === 'string' ? line.trim() : '';
  const ok = /^(ack9|acka|ack0|ackz)\s+(auto|[0-9a-fA-F]{2,256})$/.test(s) || /^push\s+[0-9a-fA-F]{2,512}$/.test(s);
  if (!ok) return { ok: false, error: 'bad-command' };
  try {
    VB.proc.stdin.write(s + '\n');
    return { ok: true };
  } catch {
    return { ok: false, error: 'write-failed' };
  }
});

ipcMain.handle(PDB_VB_NOTIFY, (_e, hex) => {
  if (!VB.proc || typeof hex !== 'string' || !/^[0-9a-fA-F]{2,400}$/.test(hex)) return { ok: false };
  try {
    VB.proc.stdin.write(`{"cmd":"notify","hex":"${hex.toLowerCase()}"}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

/* ============================================================================
 * 手机投图（局域网 HTTP）—— * ----------------------------------------------------------------------------
 * 渲染进程点「开启」→ startCast 拉起本机 HTTP 服务并拿回二维码 URL 列表；
 * 手机上传 → onPush 回调经 PDB_CAST_PUSH 单向推给主窗口渲染进程落地。
 * 服务生命周期由渲染进程显式 start/stop；窗口销毁时兜底停服（防端口泄漏）。
 * ========================================================================== */
import { PDB_CAST_START, PDB_CAST_STOP, PDB_CAST_STATE, PDB_CAST_PUSH } from '../shared/ipc.mjs';
import { startCast, stopCast, castState } from './cast.mjs';

ipcMain.handle(PDB_CAST_START, async () => {
  const res = await startCast((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(PDB_CAST_PUSH, payload);
    }
  });
  return res;
});

ipcMain.handle(PDB_CAST_STOP, () => stopCast());
ipcMain.handle(PDB_CAST_STATE, () => castState());

// 应用退出前确保关闭局域网服务，并**同步**杀掉虚拟板旁路进程（P0：僵尸 VirtualBoard.exe
// 永久占用 BLE 广播）——vbStop 默认走 setTimeout 延迟补刀，before-quit 之后事件循环
// 随时终结、延迟回调不会执行，quit 路径必须同步 kill。
app.on('before-quit', () => {
  VB.quitting = true; // 若编译还在飞：让 csc 自然结束写完 exe，但完成回调里检查此标志后不再 spawn
  stopCast();
  vbStop(true);
});
