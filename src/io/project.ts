/**
 * io/project.ts —— 项目文件（.pdp.json）编解码、严格校验与版本迁移（纯逻辑，零 DOM / 零 store 依赖）。
 *
 * 【契约来源】项目文件契约 ProjectFile + src/core/types.ts（字段名一字不差）。
 *   format:'pindou-studio/project' · version:1
 *   beads      = base64(Uint16Array **小端**)，值 = 调色板索引 + 1，0 = 空格
 *   placedMask = base64(Uint8Array)，1 = 已物理放置
 *   palette.colors = Omit<BeadColor,'lab'>[]（lab 反序列化时由 color/convert.ts 重算，省体积也防漂移）
 *   sourceImage 仅当 dataUrl 解码后 ≤ 2MB 才内嵌，超限丢弃并写入 warnings
 *
 * 【为什么手写 base64】必须同时正确工作于浏览器 / Electron 渲染进程 / Node（esbuild 打包后跑单测）。
 *   btoa/atob 三端都有（Node ≥16），走快路径；不可用时退回纯 JS 实现，行为完全一致。
 *   绝不用 String.fromCharCode(...bigArray)（大数组会爆调用栈），一律分块。
 *
 * 【错误处理】projectFromText 永不抛异常，一律返回 {ok:false, error:'中文可读原因'}，
 *   该 error 会被 UI 直接展示给用户。
 */
import type { BeadColor, BeadPalette, BoardConfig, Calibration, ProjectFile } from '@/core/types';
import { hexToRgb, rgbToLab } from '@/color/convert';

/* ==================== 常量 ==================== */

/** 项目文件魔数（契约，禁止改） */
export const PROJECT_FORMAT = 'pindou-studio/project';
/** 当前实现的文件格式版本 */
export const PROJECT_VERSION = 1;
/** 已知可解析的版本集合（迁移接缝：将来加 2 就在这里加） */
export const KNOWN_VERSIONS: readonly number[] = [1];
/** 项目文件扩展名 */
export const PROJECT_EXT = '.pdp.json';
/** 源图内嵌体积上限（2MB，项目契约） */
export const MAX_SOURCE_IMAGE_BYTES = 2 * 1024 * 1024;
/** cols/rows 合法区间 */
export const BOARD_DIM_MIN = 1;
export const BOARD_DIM_MAX = 1024;

/** 板参数兜底默认值（与 store/index.ts 的 DEFAULT_BOARD 一致；此处本地持有以免把 zustand 拖进纯逻辑层） */
const BOARD_FALLBACK: BoardConfig = {
  cols: 104,
  rows: 104,
  pitchMm: 2.6923,
  beadFillRatio: 0.9,
  marginMm: 2.0,
  cellShape: 'circle',
  showGrid: true,
  showMajorGrid: true,
  majorEvery: 10,
  showNumbers: true,
  numberEvery: 10,
  showRuler: true,
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CALIBRATION_SOURCES: readonly Calibration['source'][] = [
  'auto-wmi',
  'manual-ruler',
  'manual-ppi',
  'manual-span',
  'browser-fallback',
];

/* ==================== base64 底层（二进制安全 + 三端一致） ==================== */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 反查表：非法字符 = -1 */
const B64_INDEX: Int16Array = (() => {
  const t = new Int16Array(128);
  t.fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

/** 纯 JS 字节 → base64（含 padding），分块 join 避免超长字符串拼接退化 */
function bytesToBase64Pure(bytes: Uint8Array): string {
  const n = bytes.length;
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(
      B64_CHARS[(v >>> 18) & 63] + B64_CHARS[(v >>> 12) & 63] + B64_CHARS[(v >>> 6) & 63] + B64_CHARS[v & 63],
    );
  }
  const rem = n - i;
  if (rem === 1) {
    const v = bytes[i] << 16;
    parts.push(B64_CHARS[(v >>> 18) & 63] + B64_CHARS[(v >>> 12) & 63] + '==');
  } else if (rem === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    parts.push(B64_CHARS[(v >>> 18) & 63] + B64_CHARS[(v >>> 12) & 63] + B64_CHARS[(v >>> 6) & 63] + '=');
  }
  return parts.join('');
}

/** 纯 JS base64 → 字节。输入必须已 trim 且通过 B64_STRICT_RE 校验，否则抛错 */
function base64ToBytesPure(b64: string): Uint8Array {
  const len = b64.length;
  if (len % 4 !== 0) throw new Error('base64 长度不是 4 的倍数');
  let pad = 0;
  if (len >= 1 && b64[len - 1] === '=') pad++;
  if (len >= 2 && b64[len - 2] === '=') pad++;
  const outLen = Math.max(0, (len / 4) * 3 - pad);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = b64.charCodeAt(i);
    const b = b64.charCodeAt(i + 1);
    const c = b64.charCodeAt(i + 2);
    const d = b64.charCodeAt(i + 3);
    const va = a < 128 ? B64_INDEX[a] : -1;
    const vb = b < 128 ? B64_INDEX[b] : -1;
    const vc = c === 61 /* '=' */ ? 0 : c < 128 ? B64_INDEX[c] : -1;
    const vd = d === 61 ? 0 : d < 128 ? B64_INDEX[d] : -1;
    if (va < 0 || vb < 0 || vc < 0 || vd < 0) throw new Error('base64 含非法字符');
    const v = (va << 18) | (vb << 12) | (vc << 6) | vd;
    if (o < outLen) out[o++] = (v >>> 16) & 0xff;
    if (o < outLen) out[o++] = (v >>> 8) & 0xff;
    if (o < outLen) out[o++] = v & 0xff;
  }
  return out;
}

/** 允许空白（换行折行的 base64）；用于清洗后再校验 */
function stripB64Whitespace(b64: string): string {
  return b64.replace(/[\r\n\t\s]/g, '');
}

const B64_STRICT_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 字节 → base64 字符串（btoa 快路径 + 纯 JS 兜底） */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    const CHUNK = 0x8000; // 分块，避免 String.fromCharCode 参数过多爆栈
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
    }
    try {
      return btoa(parts.join(''));
    } catch {
      return bytesToBase64Pure(bytes);
    }
  }
  return bytesToBase64Pure(bytes);
}

/** base64 字符串 → 字节。非法输入抛 Error（调用方负责 catch 转成中文提示） */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = stripB64Whitespace(String(b64 ?? ''));
  if (!B64_STRICT_RE.test(clean)) throw new Error('base64 字符串非法');
  if (typeof atob === 'function') {
    try {
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return base64ToBytesPure(clean);
    }
  }
  return base64ToBytesPure(clean);
}

/** Uint16Array → base64（**小端** 2 字节/元素） */
export function encodeU16(u16: Uint16Array): string {
  const bytes = new Uint8Array(u16.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < u16.length; i++) view.setUint16(i * 2, u16[i], true);
  return bytesToBase64(bytes);
}

/** base64 → Uint16Array（小端）。字节数为奇数时抛错 */
export function decodeU16(b64: string): Uint16Array {
  const bytes = base64ToBytes(b64);
  if (bytes.length % 2 !== 0) throw new Error('Uint16 数据字节数为奇数，无法还原');
  const out = new Uint16Array(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

/** Uint8Array → base64 */
export function encodeU8(u8: Uint8Array): string {
  return bytesToBase64(u8);
}

/** base64 → Uint8Array */
export function decodeU8(b64: string): Uint8Array {
  return base64ToBytes(b64);
}

/** dataUrl 解码后的真实字节数估算（用于 2MB 源图判定）；非 base64 dataUrl 按字符数计 */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (!head.includes(';base64')) return body.length;
  const pad = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - pad);
}

/** 通用 UTF-8 文本 → base64（导出/镜像时会用到） */
export function encodeText(text: string): string {
  return bytesToBase64(utf8ToBytes(text));
}

/** base64 → UTF-8 文本 */
export function decodeText(b64: string): string {
  return bytesToUtf8(base64ToBytes(b64));
}

function utf8ToBytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  // 兜底：仅 ASCII/拉丁1 场景足够；实际运行环境（浏览器/Electron/Node≥16）都有 TextEncoder
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

function bytesToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** `data:application/json;base64,....` → UTF-8 文本（openFile 返回值解码用） */
export function dataUrlToText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl;
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (head.includes(';base64')) return bytesToUtf8(base64ToBytes(body));
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

/* ==================== 调色板 lab 水合 ==================== */

/**
 * 反序列化时补回 lab：契约里 palette 存 Omit<BeadColor,'lab'>，lab 由 hex/rgb 重算
 * （用 color/convert.ts 已有的 hexToRgb / rgbToLab，不臆造函数）。
 * rgb 缺失或非法时按 hex 重算；hex 非法时用 #000000 兜底并把 code 标注出来。
 */
export function hydratePaletteColors(colors: Omit<BeadColor, 'lab'>[]): BeadColor[] {
  return colors.map((c) => {
    let rgb: [number, number, number];
    if (Array.isArray(c.rgb) && c.rgb.length === 3 && c.rgb.every((v) => typeof v === 'number' && isFinite(v))) {
      rgb = [c.rgb[0], c.rgb[1], c.rgb[2]];
    } else {
      try {
        rgb = hexToRgb(c.hex);
      } catch {
        rgb = [0, 0, 0];
      }
    }
    return { ...c, rgb, lab: rgbToLab(rgb) };
  });
}

/** 序列化时剥离 lab（存盘只留 Omit<BeadColor,'lab'>） */
export function dehydratePaletteColors(colors: BeadColor[]): Omit<BeadColor, 'lab'>[] {
  return colors.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    nameZh: c.nameZh,
    hex: c.hex,
    rgb: c.rgb,
    series: c.series,
    builtin: c.builtin,
  }));
}

/**
 * 由项目里的 palette 段还原成完整 BeadPalette。
 * base 传入注册表里的原始色板（id 匹配时继承 brand/name/beadSizeMm/editable/source）；
 * 不传（或 id 不匹配）时用中性兜底值 —— 本模块**不** import palettes 注册表，避免与并发任务产生编译竞态。
 */
export function paletteFromProject(
  palette: ProjectFile['palette'],
  base?: BeadPalette | null,
): BeadPalette {
  const colors = hydratePaletteColors(palette.colors);
  const usableBase = base && base.id === palette.baseId ? base : null;
  return {
    id: palette.baseId || usableBase?.id || 'project',
    brand: usableBase?.brand ?? '项目',
    name: usableBase?.name ?? (palette.customized ? '项目自定义色板' : '项目色板'),
    beadSizeMm: usableBase?.beadSizeMm ?? 2.6,
    colors,
    editable: usableBase ? usableBase.editable || palette.customized : true,
    source: usableBase?.source,
  };
}

/* ==================== 序列化 ==================== */

/** serializeProject 的输入形状（PdbState 的子集，结构化类型，避免把 store 拖进纯逻辑层） */
export interface ProjectSource {
  board: BoardConfig;
  beads: Uint16Array;
  placedMask: Uint8Array;
  palette: BeadPalette;
  /** 色板基准 id（未自定义时等于 palette.id）；缺省取 palette.id */
  paletteId?: string;
  /** 是否被用户校正/增删过；缺省按 baseId !== palette.id 推断 */
  paletteCustomized?: boolean;
  calibration?: Calibration | null;
  sourceImage?: { name: string; dataUrl: string } | null;
  meta?: Partial<ProjectFile['meta']>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 文件名/项目名消毒：去掉路径分隔符与控制字符，长度截断 */
export function sanitizeFileName(name: string, fallback = '未命名项目'): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const limited = cleaned.slice(0, 80);
  return limited.length > 0 ? limited : fallback;
}

/** 标准项目文件名：`<名字>.pdp.json` */
export function projectFileName(name: string): string {
  return `${sanitizeFileName(name)}${PROJECT_EXT}`;
}

/**
 * 当前状态 → ProjectFile。
 * @param warnings 可选数组；源图超 2MB 被丢弃时会 push 一条中文说明（不抛异常、不改契约字段）
 */
export function serializeProject(state: ProjectSource, warnings?: string[]): ProjectFile {
  const n = state.board.cols * state.board.rows;
  // 尺寸与 typed array 长度不一致时按 board 为准裁切/补零，保证存盘数据永远自洽
  const beads = new Uint16Array(n);
  const placedMask = new Uint8Array(n);
  const srcBeads = state.beads;
  const srcPlaced = state.placedMask;
  const copyLen = Math.min(n, srcBeads?.length ?? 0);
  for (let i = 0; i < copyLen; i++) beads[i] = srcBeads[i];
  const copyLenP = Math.min(n, srcPlaced?.length ?? 0);
  for (let i = 0; i < copyLenP; i++) placedMask[i] = srcPlaced[i];

  const baseId = state.paletteId ?? state.palette.id;
  const customized = state.paletteCustomized ?? baseId !== state.palette.id;

  const meta = state.meta ?? {};
  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION as 1,
    meta: {
      name: sanitizeFileName(meta.name ?? '未命名项目'),
      createdAt: meta.createdAt ?? nowIso(),
      updatedAt: meta.updatedAt ?? nowIso(),
      appVersion: meta.appVersion ?? '0.1.0',
    },
    board: { ...state.board },
    palette: {
      baseId,
      customized,
      colors: dehydratePaletteColors(state.palette.colors),
    },
    beads: encodeU16(beads),
    placedMask: encodeU8(placedMask),
  };

  if (state.calibration) project.calibration = { ...state.calibration };

  const img = state.sourceImage;
  if (img && typeof img.dataUrl === 'string' && img.dataUrl.length > 0) {
    const size = dataUrlByteSize(img.dataUrl);
    if (size <= MAX_SOURCE_IMAGE_BYTES) {
      project.sourceImage = { name: img.name ?? '', dataUrl: img.dataUrl };
    } else {
      warnings?.push(
        `源图「${img.name || '未命名'}」约 ${(size / 1024 / 1024).toFixed(1)}MB，超过 2MB 内嵌上限，已不写入项目文件（图案数据不受影响）`,
      );
    }
  }

  return project;
}

/** ProjectFile → JSON 文本（缩进 2 空格） */
export function projectToText(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

/* ==================== 校验与反序列化 ==================== */

export type ProjectParseResult = { ok: true; project: ProjectFile } | { ok: false; error: string };
export type MigrateResult = { ok: true; project: ProjectFile } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 板参数校验 + 缺失字段兜底；cols/rows 非法返回 null */
function sanitizeBoard(raw: unknown): BoardConfig | null {
  if (!isPlainObject(raw)) return null;
  const cols = raw.cols;
  const rows = raw.rows;
  if (!isPositiveInt(cols) || !isPositiveInt(rows)) return null;
  if (cols < BOARD_DIM_MIN || cols > BOARD_DIM_MAX || rows < BOARD_DIM_MIN || rows > BOARD_DIM_MAX) return null;
  const shape = raw.cellShape;
  return {
    cols,
    rows,
    pitchMm: typeof raw.pitchMm === 'number' && raw.pitchMm > 0 ? raw.pitchMm : BOARD_FALLBACK.pitchMm,
    beadFillRatio:
      typeof raw.beadFillRatio === 'number' && raw.beadFillRatio > 0 && raw.beadFillRatio <= 2
        ? raw.beadFillRatio
        : BOARD_FALLBACK.beadFillRatio,
    marginMm: typeof raw.marginMm === 'number' && raw.marginMm >= 0 ? raw.marginMm : BOARD_FALLBACK.marginMm,
    cellShape: shape === 'square' || shape === 'ring' ? shape : BOARD_FALLBACK.cellShape,
    showGrid: typeof raw.showGrid === 'boolean' ? raw.showGrid : BOARD_FALLBACK.showGrid,
    showMajorGrid:
      typeof raw.showMajorGrid === 'boolean' ? raw.showMajorGrid : BOARD_FALLBACK.showMajorGrid,
    majorEvery: isPositiveInt(raw.majorEvery) ? raw.majorEvery : BOARD_FALLBACK.majorEvery,
    showNumbers: typeof raw.showNumbers === 'boolean' ? raw.showNumbers : BOARD_FALLBACK.showNumbers,
    numberEvery: isPositiveInt(raw.numberEvery) ? raw.numberEvery : BOARD_FALLBACK.numberEvery,
    showRuler: typeof raw.showRuler === 'boolean' ? raw.showRuler : BOARD_FALLBACK.showRuler,
    // 三个可选开关（/豆上色号）：原白名单遗漏 → 保存/恢复往返后用户设置被静默重置
    // （2026-10-11 补测发现）。布尔才带上，非法值省略（字段本身可选，store 侧有默认）。
    ...(typeof raw.emptyCheckerboard === 'boolean' ? { emptyCheckerboard: raw.emptyCheckerboard } : {}),
    ...(typeof raw.showColorCodes === 'boolean' ? { showColorCodes: raw.showColorCodes } : {}),
    ...(typeof raw.darkBeadEdge === 'boolean' ? { darkBeadEdge: raw.darkBeadEdge } : {}),
  };
}

/** 校准档宽松消毒：结构不合法直接丢弃（返回 null），不影响项目其余部分 */
function sanitizeCalibration(raw: unknown): Calibration | null {
  if (!isPlainObject(raw)) return null;
  const { pitchMm, mmPerDevicePxX, mmPerDevicePxY, originDevicePx, source, displayKey, verifiedAt } = raw;
  if (typeof pitchMm !== 'number' || !(pitchMm > 0)) return null;
  if (typeof mmPerDevicePxX !== 'number' || !(mmPerDevicePxX > 0)) return null;
  if (typeof mmPerDevicePxY !== 'number' || !(mmPerDevicePxY > 0)) return null;
  if (!isPlainObject(originDevicePx)) return null;
  const ox = originDevicePx.x;
  const oy = originDevicePx.y;
  if (typeof ox !== 'number' || typeof oy !== 'number' || !isFinite(ox) || !isFinite(oy)) return null;
  const src = CALIBRATION_SOURCES.includes(source as Calibration['source'])
    ? (source as Calibration['source'])
    : 'manual-ppi';
  return {
    pitchMm,
    mmPerDevicePxX,
    mmPerDevicePxY,
    originDevicePx: { x: ox, y: oy },
    source: src,
    displayKey: typeof displayKey === 'string' ? displayKey : '',
    verifiedAt: typeof verifiedAt === 'string' ? verifiedAt : nowIso(),
  };
}

/**
 * 版本迁移接缝。当前只有 version 1（恒等迁移）。
 * 更高版本 → {ok:false, error:'项目文件由更新版本创建，请升级程序'}。
 * 未来加 v2 时：在 switch 里把 1 落到 2 的迁移函数，KNOWN_VERSIONS 追加 2。
 */
export function migrateProject(project: unknown): MigrateResult {
  if (!isPlainObject(project)) return { ok: false, error: '项目文件内容不是一个有效的对象' };
  const version = project.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, error: '项目文件缺少有效的版本号（version）' };
  }
  if (version > PROJECT_VERSION) {
    return {
      ok: false,
      error: `项目文件由更新版本创建（version ${version}，当前程序支持到 ${PROJECT_VERSION}），请升级程序后再打开`,
    };
  }
  if (!KNOWN_VERSIONS.includes(version)) {
    return { ok: false, error: `项目文件版本 ${version} 无法识别，请升级程序后再打开` };
  }
  switch (version) {
    case 1:
      // v1 = 当前版本，恒等迁移（字段级校验交给 projectFromText）
      return { ok: true, project: project as unknown as ProjectFile };
    default:
      return { ok: false, error: `项目文件版本 ${version} 缺少迁移实现，请升级程序` };
  }
}

/**
 * 文本 → ProjectFile，**严格校验**。任何一项不合规都返回中文错误信息（不抛异常）。
 *
 * 校验项：format 魔数 / version 已知 / board.cols,rows ∈ [1,1024] 正整数 /
 * beads 与 placedMask base64 可解码且元素数**恰好** = rows*cols /
 * palette.colors 非空且每项 hex 合法（#RGB|#RRGGBB）/ beads 最大索引 ≤ colors.length。
 */
export function projectFromText(text: string): ProjectParseResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: '文件内容为空，不是一个有效的项目文件' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是合法的 JSON 文本，无法解析（可能已损坏或被其他程序改动）' };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, error: '文件内容不是一个有效的对象，无法作为项目载入' };
  }

  if (raw.format !== PROJECT_FORMAT) {
    return {
      ok: false,
      error: `不是 PinDou Studio 项目文件（format 应为 "${PROJECT_FORMAT}"，实际为 "${String(raw.format)}"）`,
    };
  }

  const migrated = migrateProject(raw);
  if (!migrated.ok) return migrated;
  const p = migrated.project as unknown as Record<string, unknown>;

  /* ---- board ---- */
  const board = sanitizeBoard(p.board);
  if (!board) {
    const b: Record<string, unknown> = isPlainObject(p.board) ? p.board : {};
    return {
      ok: false,
      error: `板参数无效：列数/行数必须是 ${BOARD_DIM_MIN}~${BOARD_DIM_MAX} 之间的正整数（实际 cols=${String(
        b.cols,
      )}, rows=${String(b.rows)}）`,
    };
  }
  const cellCount = board.cols * board.rows;

  /* ---- palette ---- */
  const paletteRaw = p.palette;
  if (!isPlainObject(paletteRaw)) {
    return { ok: false, error: '项目缺少调色板数据（palette），无法还原颜色' };
  }
  const colorsRaw = paletteRaw.colors;
  if (!Array.isArray(colorsRaw) || colorsRaw.length === 0) {
    return { ok: false, error: '调色板颜色列表为空（palette.colors），项目已损坏或色板被清空' };
  }
  const colors: Omit<BeadColor, 'lab'>[] = [];
  for (let k = 0; k < colorsRaw.length; k++) {
    const c = colorsRaw[k];
    if (!isPlainObject(c)) return { ok: false, error: `调色板第 ${k + 1} 项不是有效的颜色对象` };
    const hex = c.hex;
    if (typeof hex !== 'string' || !HEX_RE.test(hex.trim())) {
      return {
        ok: false,
        error: `调色板第 ${k + 1} 项颜色（${String(c.code ?? c.name ?? '未知')}）的 HEX 值非法：「${String(
          hex,
        )}」，应为 #RGB 或 #RRGGBB`,
      };
    }
    let rgb: [number, number, number];
    if (Array.isArray(c.rgb) && c.rgb.length === 3 && c.rgb.every((v) => typeof v === 'number' && isFinite(v))) {
      rgb = [c.rgb[0], c.rgb[1], c.rgb[2]];
    } else {
      try {
        rgb = hexToRgb(hex.trim());
      } catch {
        return { ok: false, error: `调色板第 ${k + 1} 项颜色无法从 HEX「${hex}」解析出 RGB` };
      }
    }
    colors.push({
      id: typeof c.id === 'string' ? c.id : `color-${k}`,
      code: typeof c.code === 'string' ? c.code : `#${k + 1}`,
      name: typeof c.name === 'string' ? c.name : '未命名颜色',
      nameZh: typeof c.nameZh === 'string' ? c.nameZh : undefined,
      hex: hex.trim(),
      rgb,
      series: typeof c.series === 'string' ? c.series : undefined,
      builtin: typeof c.builtin === 'boolean' ? c.builtin : false,
    });
  }

  /* ---- beads ---- */
  if (typeof p.bads !== 'undefined') {
    // 容错：某些手写文件把 beads 拼错成 bads，这里给出明确提示而不是静默忽略
    return { ok: false, error: '项目字段拼写错误：应为 "beads"（图案数据），检测到 "bads"' };
  }
  if (typeof p.beads !== 'string') {
    return { ok: false, error: '项目缺少图案数据（beads），文件不完整' };
  }
  let beads: Uint16Array;
  try {
    beads = decodeU16(p.beads);
  } catch {
    return { ok: false, error: '图案数据（beads）不是合法的 base64 编码，文件可能已损坏' };
  }
  if (beads.length !== cellCount) {
    return {
      ok: false,
      error: `图案数据长度与板规格不符：板为 ${board.cols}×${board.rows} = ${cellCount} 格，实际解出 ${beads.length} 格`,
    };
  }
  let maxIndex = 0;
  for (let i = 0; i < beads.length; i++) if (beads[i] > maxIndex) maxIndex = beads[i];
  if (maxIndex > colors.length) {
    return {
      ok: false,
      error: `图案数据引用了不存在的颜色：最大颜色索引 ${maxIndex} 超出调色板色数 ${colors.length}（文件与色板不匹配）`,
    };
  }

  /* ---- placedMask ---- */
  if (typeof p.placedMask !== 'string') {
    return { ok: false, error: '项目缺少已放置标记数据（placedMask），文件不完整' };
  }
  let placedMask: Uint8Array;
  try {
    placedMask = decodeU8(p.placedMask);
  } catch {
    return { ok: false, error: '已放置标记数据（placedMask）不是合法的 base64 编码，文件可能已损坏' };
  }
  if (placedMask.length !== cellCount) {
    return {
      ok: false,
      error: `已放置标记长度与板规格不符：板为 ${cellCount} 格，实际解出 ${placedMask.length} 格`,
    };
  }

  /* ---- meta（宽松：缺失就补默认值） ---- */
  const metaRaw = isPlainObject(p.meta) ? p.meta : {};
  const meta = {
    name: typeof metaRaw.name === 'string' ? sanitizeFileName(metaRaw.name) : '未命名项目',
    createdAt: typeof metaRaw.createdAt === 'string' ? metaRaw.createdAt : nowIso(),
    updatedAt: typeof metaRaw.updatedAt === 'string' ? metaRaw.updatedAt : nowIso(),
    appVersion: typeof metaRaw.appVersion === 'string' ? metaRaw.appVersion : 'unknown',
  };

  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION as 1,
    meta,
    board,
    palette: {
      baseId: typeof paletteRaw.baseId === 'string' ? paletteRaw.baseId : 'project',
      customized: typeof paletteRaw.customized === 'boolean' ? paletteRaw.customized : false,
      colors,
    },
    beads: encodeU16(beads),
    placedMask: encodeU8(placedMask),
  };

  const cal = sanitizeCalibration(p.calibration);
  if (cal) project.calibration = cal;

  if (isPlainObject(p.sourceImage)) {
    const si = p.sourceImage;
    if (typeof si.name === 'string' && typeof si.dataUrl === 'string' && si.dataUrl.length > 0) {
      project.sourceImage = { name: si.name, dataUrl: si.dataUrl };
    }
  }

  return { ok: true, project };
}

/* ==================== 运行时还原（typed array + 完整色板） ==================== */

/** 项目落回内存后的运行时形状：直接喂给 store 的 replaceBeads / setBoardConfig / setPalette / setCalibration */
export interface ProjectRuntime {
  meta: ProjectFile['meta'];
  board: BoardConfig;
  palette: BeadPalette;
  beads: Uint16Array;
  placedMask: Uint8Array;
  calibration: Calibration | null;
  sourceImage: { name: string; dataUrl: string } | null;
  /** 统计信息，便于 UI 直接显示 */
  stats: { cells: number; filled: number; placed: number; colorCount: number };
}

/** ProjectFile → 运行时数据（typed array 已解码，lab 已水合）。校验由调用方先用 projectFromText 完成 */
export function projectToRuntime(project: ProjectFile, basePalette?: BeadPalette | null): ProjectRuntime {
  const beads = decodeU16(project.beads);
  const placedMask = decodeU8(project.placedMask);
  let filled = 0;
  let placed = 0;
  for (let i = 0; i < beads.length; i++) if (beads[i] !== 0) filled++;
  for (let i = 0; i < placedMask.length; i++) if (placedMask[i] !== 0) placed++;
  return {
    meta: project.meta,
    board: project.board,
    palette: paletteFromProject(project.palette, basePalette),
    beads,
    placedMask,
    calibration: project.calibration ?? null,
    sourceImage: project.sourceImage ?? null,
    stats: {
      cells: project.board.cols * project.board.rows,
      filled,
      placed,
      colorCount: project.palette.colors.length,
    },
  };
}

/** 便捷组合：文本 → 运行时数据（失败返回中文错误） */
export function runtimeFromText(
  text: string,
  basePalette?: BeadPalette | null,
): { ok: true; runtime: ProjectRuntime } | { ok: false; error: string } {
  const parsed = projectFromText(text);
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, runtime: projectToRuntime(parsed.project, basePalette) };
  } catch (err) {
    return { ok: false, error: `项目数据还原失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
