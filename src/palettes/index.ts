/**
 * palettes/index.ts —— 色板注册表 + 水合（hydrate）+ 用户自定义色板（localStorage）。
 *
 * 【设计要点】
 * - 数据文件（general/artkal/perler/hama）只写 hex，派生字段 rgb/lab 统一在这里用
 *   color/convert.ts 计算，保证「量化 → 匹配 → 渲染」全链路数值一致（同一套 D65 公式）。
 * - 内置色板水合结果按 id 缓存且**只读**：store 的编辑 action 一律产出新 colors 数组与新
 *   palette 对象，绝不原地改缓存，因此内置数据永不被污染。
 * - 用户自定义色板独立存 localStorage（键见 CUSTOM_STORAGE_KEY），与内置数据物理隔离；
 *   每次读取都用 hex 重新水合，避免历史存档里的 rgb/lab 与当前算法漂移。
 */
import type { BeadColor, BeadPalette } from '@/core/types';
import type { BeadColorInput } from './types';
import { hexToRgb, rgbToHex, rgbToLab } from '@/color/convert';
import { GENERAL_COLORS } from './general';
import { ARTKAL_COLORS } from './artkal';
import { PERLER_COLORS } from './perler';
import { HAMA_COLORS } from './hama';
import { MARD_COLORS } from './mard';

/** 色板「输入形态」：BeadPalette 去掉派生字段，colors 为只写 hex 的 BeadColorInput */
export interface BeadPaletteInput {
  id: string;
  brand: string;
  name: string;
  beadSizeMm: number;
  editable: boolean;
  source?: string;
  colors: BeadColorInput[];
}

/** listPalettes 的摘要项（Picker / Manager 共用） */
export interface PaletteSummary {
  id: string;
  brand: string;
  name: string;
  beadSizeMm: number;
  colorCount: number;
  source?: string;
  builtin: boolean;
}

/* ================= 内置色板注册表 ================= */

/** 内置色板 id（新增一套 = 数据文件 + 这里加一行） */
export const BUILTIN_PALETTE_IDS: string[] = ['general', 'artkal', 'mard', 'perler', 'hama'];
export const DEFAULT_PALETTE_ID = 'mard'; // 默认色板用 MARD（221 色官方色卡）

const BUILTIN_INPUTS: Record<string, BeadPaletteInput> = {
  general: {
    id: 'general',
    brand: '通用',
    name: '通用拼豆色板',
    beadSizeMm: 2.6,
    editable: true,
    source: '社区整理值 · 九大色族渐变阶梯（可用吸管实测校正）',
    colors: GENERAL_COLORS,
  },
  artkal: {
    id: 'artkal',
    brand: 'Artkal',
    name: '阿缇卡 Artkal（迷你豆）',
    beadSizeMm: 2.6,
    editable: true,
    source: 'https://www.pixel-beads.com/zh/artkal-bead-color-chart',
    colors: ARTKAL_COLORS,
  },
  mard: {
    id: 'mard',
    brand: 'MARD',
    name: 'MARD 拼豆（迷你豆 · 官方 221 色）',
    beadSizeMm: 2.6,
    editable: true,
    source: 'https://pd.anqstar.com/colors（MARD 官方色卡，2026-09 抓取，221 色 HEX 全核实）',
    colors: MARD_COLORS,
  },
  perler: {
    id: 'perler',
    brand: 'Perler',
    name: 'Perler 拼豆（标准豆）',
    beadSizeMm: 5,
    editable: true,
    source: 'https://www.pixel-beads.com/zh/perler-bead-color-chart',
    colors: PERLER_COLORS,
  },
  hama: {
    id: 'hama',
    brand: 'Hama',
    name: 'Hama 拼豆（MIDI 标准豆）',
    beadSizeMm: 5,
    editable: true,
    source: 'https://www.pixel-beads.com/zh/hama-bead-color-chart',
    colors: HAMA_COLORS,
  },
};

/* ================= 水合（hydrate） ================= */

/** 由 BeadColorInput（只写 hex）计算 rgb/lab，产出完整 BeadColor */
export function hydrateColor(input: BeadColorInput): BeadColor {
  const rgb = hexToRgb(input.hex);
  const lab = rgbToLab(rgb);
  return {
    id: input.id,
    code: input.code,
    name: input.name,
    nameZh: input.nameZh,
    hex: rgbToHex(rgb[0], rgb[1], rgb[2]), // 规范化为 #RRGGBB 大写
    rgb,
    lab,
    series: input.series,
    builtin: input.builtin,
  };
}

/** 由 BeadPaletteInput 水合出完整 BeadPalette（逐色补全 rgb/lab） */
export function hydratePalette(input: BeadPaletteInput): BeadPalette {
  return {
    id: input.id,
    brand: input.brand,
    name: input.name,
    beadSizeMm: input.beadSizeMm,
    editable: input.editable,
    source: input.source,
    colors: input.colors.map(hydrateColor),
  };
}

/* ---- 内置水合缓存（只读，永不被 store 原地修改） ---- */
const builtinCache = new Map<string, BeadPalette>();

function builtinHydrated(id: string): BeadPalette {
  let p = builtinCache.get(id);
  if (!p) {
    const input = BUILTIN_INPUTS[id];
    if (!input) throw new Error(`未知内置色板 id: ${id}`);
    p = hydratePalette(input);
    builtinCache.set(id, p);
  }
  return p;
}

/* ================= 自定义色板（localStorage，永不污染内置） ================= */

const CUSTOM_STORAGE_KEY = 'pindou.customPalettes.v1';

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

/** 读取全部用户自定义色板（逐色重新水合，保证数值一致） */
export function loadCustomPalettes(): BeadPalette[] {
  if (!hasStorage()) return [];
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: BeadPalette[] = [];
    for (const item of arr) {
      try {
        out.push(importPaletteObject(item));
      } catch {
        // 单条损坏则跳过，不拖垮整体
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 新增或更新一个自定义色板（按 id upsert） */
export function saveCustomPalette(p: BeadPalette): void {
  if (!hasStorage()) return;
  const all = loadCustomPalettes();
  const idx = all.findIndex((x) => x.id === p.id);
  const stored: BeadPalette = { ...p, editable: true };
  if (idx >= 0) all[idx] = stored;
  else all.push(stored);
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 存储配额满 / 隐私模式：静默失败，不阻断编辑
  }
}

/** 删除一个自定义色板 */
export function deleteCustomPalette(id: string): void {
  if (!hasStorage()) return;
  const all = loadCustomPalettes().filter((p) => p.id !== id);
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 静默 */
  }
}

/** 复制内置（或任意）色板为可编辑的自定义副本并持久化 */
export function clonePaletteAsCustom(baseId: string, name: string): BeadPalette {
  const base = getPalette(baseId);
  const id = `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  const clone: BeadPalette = {
    id,
    brand: base.brand,
    name: name.trim() || `${base.name} 副本`,
    beadSizeMm: base.beadSizeMm,
    editable: true,
    source: base.source,
    colors: base.colors.map((c) => ({ ...c, builtin: false })),
  };
  saveCustomPalette(clone);
  return clone;
}

/* ================= 查询 ================= */

/**
 * 按 id 取色板：先内置，再自定义，都没有则回退默认内置色板（不抛错，UI 更稳）。
 * 内置返回只读缓存对象；自定义返回水合后的新对象。
 */
export function getPalette(id: string): BeadPalette {
  if (id in BUILTIN_INPUTS) return builtinHydrated(id);
  const custom = loadCustomPalettes().find((p) => p.id === id);
  if (custom) return custom;
  return builtinHydrated(DEFAULT_PALETTE_ID);
}

/** 列出全部色板摘要（内置在前，自定义在后） */
export function listPalettes(): PaletteSummary[] {
  const out: PaletteSummary[] = BUILTIN_PALETTE_IDS.map((id) => {
    const p = builtinHydrated(id);
    return {
      id: p.id,
      brand: p.brand,
      name: p.name,
      beadSizeMm: p.beadSizeMm,
      colorCount: p.colors.length,
      source: p.source,
      builtin: true,
    };
  });
  for (const p of loadCustomPalettes()) {
    out.push({
      id: p.id,
      brand: p.brand,
      name: p.name,
      beadSizeMm: p.beadSizeMm,
      colorCount: p.colors.length,
      source: p.source,
      builtin: false,
    });
  }
  return out;
}

/* ================= 导入 / 导出 JSON ================= */

/** 导出为可复用 JSON（含格式标记；colors 只保留输入字段，rgb/lab 由导入方重新水合） */
export function exportPaletteJson(p: BeadPalette): string {
  const payload = {
    format: 'pindou-studio/palette',
    version: 1,
    palette: {
      id: p.id,
      brand: p.brand,
      name: p.name,
      beadSizeMm: p.beadSizeMm,
      source: p.source,
      editable: true,
      colors: p.colors.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        nameZh: c.nameZh,
        hex: c.hex,
        series: c.series,
        builtin: false,
      })),
    },
  };
  return JSON.stringify(payload, null, 2);
}

/** 从 JSON 文本导入色板（带格式校验与友好错误提示），返回水合后的 BeadPalette（未持久化） */
export function importPaletteJson(text: string): BeadPalette {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('导入失败：不是合法的 JSON 文本');
  }
  return importPaletteObject(data);
}

/** 校验并水合任意来源的色板对象（loadCustomPalettes / importPaletteJson 共用） */
function importPaletteObject(data: unknown): BeadPalette {
  if (!data || typeof data !== 'object') throw new Error('导入失败：内容不是对象');
  const root = data as Record<string, unknown>;
  if (root.format != null && root.format !== 'pindou-studio/palette') {
    throw new Error(`导入失败：文件格式应为 pindou-studio/palette，实际为 ${String(root.format)}`);
  }
  const p = (root.palette ?? root) as Record<string, unknown>;
  if (!p || typeof p !== 'object') throw new Error('导入失败：缺少 palette 对象');
  const rawColors = p.colors;
  if (!Array.isArray(rawColors) || rawColors.length === 0) {
    throw new Error('导入失败：colors 必须是非空数组');
  }

  const colors: BeadColorInput[] = rawColors.map((rc, i) => {
    if (!rc || typeof rc !== 'object') throw new Error(`导入失败：第 ${i + 1} 个颜色不是对象`);
    const c = rc as Record<string, unknown>;
    if (typeof c.hex !== 'string') throw new Error(`导入失败：第 ${i + 1} 个颜色缺少 hex 字段`);
    let rgb;
    try {
      rgb = hexToRgb(c.hex);
    } catch {
      throw new Error(`导入失败：第 ${i + 1} 个颜色 hex 非法（"${c.hex}"）`);
    }
    return {
      id: typeof c.id === 'string' && c.id ? c.id : `imported-${i + 1}`,
      code: typeof c.code === 'string' ? c.code : `C${i + 1}`,
      name: typeof c.name === 'string' ? c.name : '',
      nameZh: c.nameZh != null ? String(c.nameZh) : undefined,
      hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
      series: c.series != null ? String(c.series) : undefined,
      builtin: false,
    };
  });

  const rawId = typeof p.id === 'string' && p.id ? p.id : `custom-${Date.now().toString(36)}`;
  // 绝不允许导入的 id 覆盖内置色板
  const id = rawId in BUILTIN_INPUTS ? `custom-${Date.now().toString(36)}` : rawId;

  return hydratePalette({
    id,
    brand: typeof p.brand === 'string' && p.brand ? p.brand : '自定义',
    name: typeof p.name === 'string' && p.name ? p.name : '导入色板',
    beadSizeMm: typeof p.beadSizeMm === 'number' && Number.isFinite(p.beadSizeMm) ? p.beadSizeMm : 2.6,
    editable: true,
    source: p.source != null ? String(p.source) : undefined,
    colors,
  });
}
