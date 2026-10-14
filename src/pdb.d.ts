/**
 * window.pdb 类型声明 —— 与 electron/preload.mjs 暴露面逐字对应。
 * 业务代码不直接使用 window.pdb，一律经 src/io/bridge.ts（自动降级浏览器分支）。
 */
import type { DisplayMetrics } from './core/types';

export interface PdbOpenFileFilter {
  name: string;
  extensions: string[];
}

/** PDB_FILE_SAVE 载荷契约：{base64} 或 {text} 二选一 */
export type PdbSavePayload = { base64: string } | { text: string };

/** 受限 https GET 代理（PDB_WEB_FETCH）的返回契约：失败不抛、恒 resolve */
export interface PdbWebFetchResult {
  ok: boolean;
  /** HTTP 状态码（拿到响应时） */
  status?: number;
  contentType?: string;
  /** 成功时的响应体字节（≤15MB；IPC 结构化克隆为 Uint8Array） */
  data?: Uint8Array;
  /** via 字段：direct / 代理规则（命中回退时） */
  via?: string;
  /** bad-url | https-only | host-not-allowed | too-large | http-<status> | abort | network… */
  error?: string;
}

/** 主进程转发的蓝牙设备选择请求（select-bluetooth-device 接管） */
export interface PdbBtPickerRequest {
  requestId: string;
  devices: Array<{ id: string; name: string }>;
}

/** 手机投图服务状态（PDB_CAST_START/STOP/STATE 返回） */
export interface PdbCastState {
  ok: boolean;
  /** 'port-busy' 等启动失败原因 */
  error?: string;
  running: boolean;
  port: number;
  token: string;
  /** 带 token 的局域网上传页 URL 列表（每个生成一个二维码） */
  urls: string[];
}

/** 手机上传推送载荷（PDB_CAST_PUSH） */
export interface PdbCastPayload {
  pane: 'A' | 'B';
  name: string;
  mime: string;
  /** data:image/...;base64,... */
  dataUrl: string;
}

/** PC 虚拟板事件（PDB_VB_EVENT）：旁路进程 stdout JSONL 转发 */
export interface PdbVbEvent {
  ev: 'ready' | 'connected' | 'disconnected' | 'write' | 'read' | 'error' | 'stopped' | 'adv'
    | 'advstat' | 'ack' | 'ack9' | 'ackto' | 'cfg' | 'push';
  name?: string;
  /** ready 事件：是否 PIXDOU 双特征模式（false=kmpd 单特征） */
  pixdou?: boolean;
  /** ready 事件：本机蓝牙静态地址（Windows 广播实际可能用随机地址 RPA） */
  addr?: string;
  w?: number;
  h?: number;
  subs?: number;
  /** connected/disconnected 附带特征标识（pixdou 模式：a951/a952） */
  ch?: string;
  /** write 事件：手机 App 写入的原始帧（hex）；read 事件：读轮询回给 App 的应答帧 */
  hex?: string;
  msg?: string;
  /** ack9/ack 事件：回码命令字节（两位 hex 字符串，C# 侧 Emit 时 ToString("x2")） */
  cmd?: string;
  /** 历史预留：旁路从不发送（ack9 实发 {ev:'ack9', cmd, hex}），恒缺省 */
  i?: number;
  /** ackto 事件：投递目标与状态 */
  to?: string;
  st?: string;
  err?: string;
  /** cfg 事件：被设置的响应（payload hex 或 auto） */
  ack9?: string;
  acka?: string;
  ack0?: string;
  ackz?: string;
  /** write/ack 事件：写入所在特征 UUID（pixdou 区分 a951/a952） */
  uuid?: string;
  /** adv 事件：实际启用的广播通道（gatt=可连接+带服务 UUID / publisher=退路） */
  mode?: 'gatt' | 'publisher';
  /** adv 事件：广播状态（Started/Aborted…） */
  status?: string;
  /** stopped 事件：旁路退出码（0=正常，其他=异常） */
  code?: number;
}

export interface PdbAppInfo {
  version: string;
  platform: string;
  isElectron: boolean;
  node?: string;
  electron?: string;
}

export interface PdbApi {
  getDisplays(): Promise<DisplayMetrics[]>;
  getDisplayPhysical(id: string): Promise<{ id: string; widthCm: number; heightCm: number } | null>;
  enterFullscreen(displayId?: string): Promise<void>;
  exitFullscreen(): Promise<void>;
  keepAwake(on: boolean): Promise<void>;
  openFile(filters?: PdbOpenFileFilter[]): Promise<{ path: string; dataUrl: string } | null>;
  saveFile(defaultName: string, payload: PdbSavePayload): Promise<{ path: string } | null>;
  getAppInfo(): Promise<PdbAppInfo>;
  onDisplaysChanged(callback: () => void): () => void;

  /* ---------------- 追加（既有 9 个方法签名一字未改） ---------------- */
  /**
   * 读取应用私有数据目录（Electron: userData/pindou-studio-data；浏览器: localStorage）下的文本文件。
   * 文件名白名单 ^[A-Za-z0-9._-]{1,128}$；不存在/非法名/失败均返回 null，永不抛异常。
   */
  readAppData(name: string): Promise<string | null>;
  /** 写入应用私有数据目录下的文本文件；成功 true，失败/非法名 false（不抛异常） */
  writeAppData(name: string, text: string): Promise<boolean>;
  /** 列出应用私有数据目录下匹配前缀的 .json/.pdp.json 文件名（升序）；失败返回空数组 */
  listAppData(prefix?: string): Promise<string[]>;

  /* ---------------- 窗口控制（仅 Electron 有效；浏览器为 no-op） ---------------- */
  /** 最小化窗口 */
  windowMinimize(): Promise<void>;
  /** 最大化/还原切换；返回切换后是否为最大化（浏览器恒 false） */
  windowMaximizeToggle(): Promise<boolean>;
  /** 关闭窗口（浏览器 no-op） */
  windowClose(): Promise<void>;

  /* ---------------- 图纸 Web（社区检索；仅 Electron 有效，浏览器降级直连 fetch） ---------------- */
  /**
   * 受限 https GET 代理：域名白名单 + 15MB 上限 + 自动跟随系统代理。
   * 失败不抛异常，返回 {ok:false,error}（见 PdbWebFetchResult）。
   */
  webFetch?(req: string | { url: string; method?: 'GET' | 'POST'; body?: string }): Promise<PdbWebFetchResult>;

  /* ---------------- 智能拼豆板（Web Bluetooth 选择器；仅 Electron） ---------------- */
  /** 订阅主进程转发的蓝牙设备选择请求；req=null 表示主进程侧已取消。返回退订。 */
  onBtDeviceRequest?(cb: (req: PdbBtPickerRequest | null) => void): () => void;
  /** 回传用户选择；deviceId=null 取消。返回是否仍被受理（过期 false）。 */
  resolveBtDevice?(requestId: string, deviceId: string | null): Promise<boolean>;

  /* ---------------- 手机投图（局域网 HTTP；仅 Electron，浏览器模式不可用） ---------------- */
  castStart?(): Promise<PdbCastState>;
  castStop?(): Promise<PdbCastState>;
  castState?(): Promise<PdbCastState>;
  /** (cb(payload)) → 取消订阅；手机上传落地经此推送 */
  onCastPush?(cb: (payload: PdbCastPayload) => void): () => void;

  /* ---------------- PC 虚拟智能拼豆板（仅 Electron） ---------------- */
  /** 成功时附带旁路实际生效的板配置 w/h（main.mjs 夹取到 1..255 后） */
  vbStart?(cfg: { name?: string; service?: string; char?: string; w?: number; h?: number; protocol?: 'kmpd' | 'pixdou' } | null): Promise<{ ok: boolean; error?: string; w?: number; h?: number }>;
  vbStop?(): Promise<{ ok: boolean }>;
  vbNotify?(hex: string): Promise<{ ok: boolean }>;
  /** 旁路控制行：'ack9 auto' | 'ack9 <hex>' | 'acka ...' | 'ack0 ...' | 'ackz ...' | 'push <hex>' */
  vbCtrl?(line: string): Promise<{ ok: boolean; error?: string }>;
  /** (cb(evt)) → 取消订阅；evt 见 PdbVbEvent */
  onVbEvent?(cb: (evt: PdbVbEvent) => void): () => void;
}

declare global {
  interface Window {
    /** 仅 Electron 环境存在（preload contextBridge 注入）；浏览器为 undefined */
    pdb?: PdbApi;
  }
}

export {};
