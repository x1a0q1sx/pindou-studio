/**
 * Preload —— contextBridge 暴露 window.pdb。
 * 【安全契约】只暴露下面 8 个能力 + 1 个订阅；不暴露 ipcRenderer 本体、不暴露任意路径读写、
 * 不暴露 Node API。渲染进程一切经 src/io/bridge.ts 调用（浏览器环境自动降级）。
 * 【追加】另增 readAppData/writeAppData/listAppData 三个受限能力：只能读写主进程
 * appData/pindou-studio-data/ 下白名单文件名（^[A-Za-z0-9._-]{1,128}$）的 UTF-8 文本，
 * 消毒在主进程侧强制执行，渲染进程拿不到路径拼接能力。
 */
import { contextBridge, ipcRenderer } from 'electron';
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
  PDB_APPDATA_READ,
  PDB_APPDATA_WRITE,
  PDB_APPDATA_LIST,
  PDB_WEB_FETCH,
  PDB_BT_PICKER,
  PDB_BT_PICKED,
  PDB_CAST_START,
  PDB_CAST_STOP,
  PDB_CAST_STATE,
  PDB_CAST_PUSH,
  PDB_VB_START,
  PDB_VB_STOP,
  PDB_VB_NOTIFY,
  PDB_VB_CTRL,
  PDB_VB_EVENT,
} from '../shared/ipc.mjs';

contextBridge.exposeInMainWorld('pdb', {
  /** → DisplayMetrics[] */
  getDisplays: () => ipcRenderer.invoke(PDB_DISPLAYS_LIST),
  /** (id) → {id,widthCm,heightCm} | null（WMI，失败为 null） */
  getDisplayPhysical: (id) => ipcRenderer.invoke(PDB_DISPLAY_PHYSICAL, id),
  /** (displayId?) → void 在指定显示器无边框全屏 */
  enterFullscreen: (displayId) => ipcRenderer.invoke(PDB_FULLSCREEN_ENTER, displayId),
  /** → void */
  exitFullscreen: () => ipcRenderer.invoke(PDB_FULLSCREEN_EXIT),
  /** (on:boolean) → void powerSaveBlocker 防休眠 */
  keepAwake: (on) => ipcRenderer.invoke(PDB_KEEP_AWAKE, !!on),
  /** (filters?) → {path,dataUrl} | null 原生打开对话框 */
  openFile: (filters) => ipcRenderer.invoke(PDB_FILE_OPEN, filters),
  /** (defaultName, {base64}|{text}) → {path} | null 原生保存对话框 */
  saveFile: (defaultName, payload) => ipcRenderer.invoke(PDB_FILE_SAVE, defaultName, payload),
  /** → {version,platform,isElectron:true,...} */
  getAppInfo: () => ipcRenderer.invoke(PDB_APP_INFO),
  /** (callback) → 取消订阅函数（display-metrics-changed 推送） */
  onDisplaysChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(PDB_DISPLAYS_CHANGED, listener);
    return () => ipcRenderer.removeListener(PDB_DISPLAYS_CHANGED, listener);
  },

  /* ----------------------------------------------------------------------
   * 追加（仅向对象末尾新增 3 个能力，上方 9 个既有方法一字未改）
   * 只能读写主进程 appData 下白名单文件名的文本；拿不到路径拼接能力。
   * -------------------------------------------------------------------- */
  /** (name) → string | null 读取应用私有数据文件（不存在/非法名/失败 = null） */
  readAppData: (name) => ipcRenderer.invoke(PDB_APPDATA_READ, typeof name === 'string' ? name : ''),
  /** (name, text) → boolean 写入应用私有数据文件 */
  writeAppData: (name, text) =>
    ipcRenderer.invoke(PDB_APPDATA_WRITE, typeof name === 'string' ? name : '', typeof text === 'string' ? text : ''),
  /** (prefix?) → string[] 列出匹配前缀的 .json/.pdp.json 文件名 */
  listAppData: (prefix) => ipcRenderer.invoke(PDB_APPDATA_LIST, typeof prefix === 'string' ? prefix : ''),

  /* ----------------------------------------------------------------------
   * 窗口控制（无边框窗口的最小化/最大化切换/关闭）
   * -------------------------------------------------------------------- */
  /** → void 最小化 */
  windowMinimize: () => ipcRenderer.invoke(PDB_WINDOW_MINIMIZE),
  /** → boolean 最大化/还原切换（true=切换后为最大化） */
  windowMaximizeToggle: () => ipcRenderer.invoke(PDB_WINDOW_MAXIMIZE_TOGGLE),
  /** → void 关闭窗口（走标准 close 流程，自动保存兜底） */
  windowClose: () => ipcRenderer.invoke(PDB_WINDOW_CLOSE),

  /* ----------------------------------------------------------------------
   * 图纸 Web（社区图纸检索）：受限 https GET 代理（白名单域名，走系统代理）。
   * -------------------------------------------------------------------- */
  /** (url) → {ok,status?,contentType?,data?,error?} 失败不抛、恒 resolve */
  webFetch: (req) => ipcRenderer.invoke(PDB_WEB_FETCH, req),

  /* ----------------------------------------------------------------------
   * 智能拼豆板（Web Bluetooth）：主进程接管设备选择器，列表推到这里自绘。
   * -------------------------------------------------------------------- */
  /** (cb(req|null)) → 取消订阅；req={requestId, devices:[{id,name}]}，null=主进程已取消 */
  onBtDeviceRequest: (cb) => {
    const listener = (_e, req) => cb(req);
    ipcRenderer.on(PDB_BT_PICKER, listener);
    return () => ipcRenderer.removeListener(PDB_BT_PICKER, listener);
  },
  /** (requestId, deviceId|null) → boolean 是否被受理（false=已过期/取消） */
  resolveBtDevice: (requestId, deviceId) =>
    ipcRenderer.invoke(
      PDB_BT_PICKED,
      typeof requestId === 'string' ? requestId : '',
      typeof deviceId === 'string' ? deviceId : null,
    ),

  /* ----------------------------------------------------------------------
   * 手机投图（局域网 HTTP）：start/stop/state + 上传推送订阅。
   * -------------------------------------------------------------------- */
  castStart: () => ipcRenderer.invoke(PDB_CAST_START),
  castStop: () => ipcRenderer.invoke(PDB_CAST_STOP),
  castState: () => ipcRenderer.invoke(PDB_CAST_STATE),
  /** (cb(payload)) → 取消订阅；payload={pane,name,mime,dataUrl} */
  onCastPush: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(PDB_CAST_PUSH, listener);
    return () => ipcRenderer.removeListener(PDB_CAST_PUSH, listener);
  },

  /* ----------------------------------------------------------------------
   * PC 虚拟智能拼豆板：主进程托管 C# 旁路（WinRT GATT + 广播）。
   * -------------------------------------------------------------------- */
  vbStart: (cfg) => ipcRenderer.invoke(PDB_VB_START, cfg ?? null),
  vbStop: () => ipcRenderer.invoke(PDB_VB_STOP),
  vbNotify: (hex) => ipcRenderer.invoke(PDB_VB_NOTIFY, typeof hex === 'string' ? hex : ''),
  vbCtrl: (line) => ipcRenderer.invoke(PDB_VB_CTRL, typeof line === 'string' ? line : ''),
  /** (cb(evt)) → 取消订阅；evt={ev:'ready'|'connected'|'write'|'error'|'stopped',...} */
  onVbEvent: (cb) => {
    const listener = (_e, evt) => cb(evt);
    ipcRenderer.on(PDB_VB_EVENT, listener);
    return () => ipcRenderer.removeListener(PDB_VB_EVENT, listener);
  },
});
