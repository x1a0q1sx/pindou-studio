/**
 * IPC 频道名常量 —— main / preload / renderer 三方共用，防拼写漂移。
 * 【契约】频道名逐字固定，后续任务（屏幕检测、防休眠联动、文件存取）只准引用这里的常量，禁止手写字符串。
 *
 * 频道 → 载荷/返回 一览：
 *   PDB_DISPLAYS_LIST    invoke()            → DisplayMetrics[]
 *   PDB_DISPLAY_PHYSICAL invoke(id)        → {id,widthCm,heightCm} | null   （WMI，3s 超时降级 null）
 *   PDB_FULLSCREEN_ENTER invoke(displayId)  → void（在指定显示器无边框全屏）
 *   PDB_FULLSCREEN_EXIT  invoke()           → void
 *   PDB_KEEP_AWAKE       invoke(on)        → void（powerSaveBlocker 防休眠）
 *   PDB_FILE_OPEN        invoke(filters?)  → {path,dataUrl} | null
 *   PDB_FILE_SAVE        invoke(defaultName, payload) → {path} | null
 *   PDB_APP_INFO         invoke()           → {version,platform,isElectron:true}
 *   PDB_DISPLAYS_CHANGED main→renderer 单向推送（display-metrics-changed）
 */
export const PDB_DISPLAYS_LIST = 'pdb:displays-list';
export const PDB_DISPLAY_PHYSICAL = 'pdb:display-physical';
export const PDB_FULLSCREEN_ENTER = 'pdb:fullscreen-enter';
export const PDB_FULLSCREEN_EXIT = 'pdb:fullscreen-exit';
export const PDB_KEEP_AWAKE = 'pdb:keep-awake';
export const PDB_FILE_OPEN = 'pdb:file-open';
export const PDB_FILE_SAVE = 'pdb:file-save';
export const PDB_APP_INFO = 'pdb:app-info';
// 窗口控制（无边框窗口的最小化/最大化/关闭按钮）
export const PDB_WINDOW_MINIMIZE = 'pdb:window-minimize';
export const PDB_WINDOW_MAXIMIZE_TOGGLE = 'pdb:window-maximize-toggle'; // → boolean（true=已最大化）
export const PDB_WINDOW_CLOSE = 'pdb:window-close';

/** 主进程 → 渲染进程的 单向推送频道（显示器分辨率/缩放变化， 据此弹「是否重新校准」） */
export const PDB_DISPLAYS_CHANGED = 'pdb:displays-changed';

/* ============================================================================
 * 追加（仅新增，上方 9 个既有频道常量一字未改）
 * 应用私有数据目录（%APPDATA%/<userData>/pindou-studio-data/）下的**受限文本**读写。
 * 用途：最近项目列表（recent.json）、自动保存镜像（autosave-current.pdp.json）、
 *       以及 Electron 下最近项目的只读镜像副本（recent-<id>.json）。
 *
 * 安全约束（main.mjs 侧强制执行）：
 *   1. 根目录固定为 app.getPath('userData')/pindou-studio-data/，渲染进程无法指定其他目录；
 *   2. 文件名白名单 ^[A-Za-z0-9._-]{1,128}$，显式拒绝 '..'、绝对路径、任何路径分隔符；
 *   3. 只做 UTF-8 文本读写，不暴露 fs/path 本体，不开放任意路径能力。
 *
 *   PDB_APPDATA_READ  invoke(name)          → string | null（不存在/非法名/失败 = null）
 *   PDB_APPDATA_WRITE invoke(name, text)    → boolean（成功 true）
 *   PDB_APPDATA_LIST  invoke(prefix?)       → string[]（该目录下匹配前缀的 .json/.pdp.json 文件名）
 * ========================================================================== */
export const PDB_APPDATA_READ = 'pdb:appdata-read';
export const PDB_APPDATA_WRITE = 'pdb:appdata-write';
export const PDB_APPDATA_LIST = 'pdb:appdata-list';

/* ============================================================================
 * 图纸 Web（社区图纸检索）追加
 *   PDB_WEB_FETCH invoke(url) → {ok, status?, contentType?, data?: Uint8Array, error?}
 * 受限的 HTTPS GET 代理：渲染进程直连 reddit.com 受 CORS 与 UA 限制，主进程
 * net.fetch 走 Chromium 网络栈（自动跟随系统代理，复用用户的代理软件）。
 * 约束（main 侧强制执行）：仅 https、域名白名单、GET、响应 ≤ 15MB、自定义 UA。
 * ========================================================================== */
export const PDB_WEB_FETCH = 'pdb:web-fetch';

/* ============================================================================
 * 智能拼豆板（Web Bluetooth 探测）追加
 *   PDB_BT_PICKER  main→renderer 单向推送 {requestId, devices:[{id,name}]} | null（null=主进程侧取消）
 *   PDB_BT_PICKED  invoke(requestId, deviceId|null) → boolean（是否仍挂起并被受理）
 * 背景：Electron 没有内建的蓝牙设备选择框——主进程接管 session 的
 * select-bluetooth-device 后，把扫到的设备列表推给渲染进程自绘选择 UI，
 * 渲染层把用户选择回传，主进程再喂给 requestDevice() 的 Promise。
 * ========================================================================== */
export const PDB_BT_PICKER = 'pdb:bt-picker';
export const PDB_BT_PICKED = 'pdb:bt-picked';

/* ============================================================================
 * PC 虚拟智能拼豆板——主进程托管 C# 旁路进程（WinRT GATT Server + 广播）
 *   PDB_VB_START invoke(cfg) → {ok, error?, name, service, char}  cfg={name,service,char,w,h,protocol:'kmpd'|'pixdou'}
 *   PDB_VB_STOP  invoke()     → {ok}
 *   PDB_VB_EVENT main→renderer 单向推送 {ev:'ready'|'connected'|'disconnected'|'write'|'ack'|'ack9'|'cfg'|'push'|'adv'|'advstat'|'error', ...}
 * 旁路进程 VirtualBoard.exe 由主进程按需编译（csc）并 spawn，stdout JSONL 转成 VB_EVENT。
 * ========================================================================== */
export const PDB_VB_START = 'pdb:vb-start';
export const PDB_VB_STOP = 'pdb:vb-stop';
export const PDB_VB_NOTIFY = 'pdb:vb-notify'; // invoke(hex) → {ok} 设备→App 主动通知（如按键 0x05/0x06）
export const PDB_VB_CTRL = 'pdb:vb-ctrl';    // invoke(line) → {ok} 旁路控制命令（ack9/acka/ack0/ackz/push/exit，PIXDOU 回码调试用）
export const PDB_VB_EVENT = 'pdb:vb-event';

/* ============================================================================
 * 手机投图（局域网 HTTP）追加
 *   PDB_CAST_START invoke()            → {running, port, token, urls:string[]}
 *   PDB_CAST_STOP  invoke()            → {running:false}
 *   PDB_CAST_STATE invoke()            → 同上状态（未启动 running:false）
 *   PDB_CAST_PUSH  main→renderer 单向推  {pane:'A'|'B', name, mime, dataUrl}
 * 动机：手机与电脑同一 WiFi，扫码打开上传页，选图 POST 回来 → 落进画板（A 走完整导入
 * 向导，B 走轻量自动像素化直接进图 B）。安全：仅监听时绑定 0.0.0.0，全部接口校验启动
 * 时随机生成的 token（随二维码 URL 一并带出）；上传体上限 8MB；不落盘、转完即弃。
 * ========================================================================== */
export const PDB_CAST_START = 'pdb:cast-start';
export const PDB_CAST_STOP = 'pdb:cast-stop';
export const PDB_CAST_STATE = 'pdb:cast-state';
export const PDB_CAST_PUSH = 'pdb:cast-push';
