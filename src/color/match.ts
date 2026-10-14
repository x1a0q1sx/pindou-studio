/**
 * color/match.ts —— 把任意 RGB 匹配到品牌色板（纯函数 + 预计算索引）。
 *
 * 性能铁律：**先量化到 K 色（K ≤ 64），再把这 K 色匹配到色板**，
 * 即最多 64 × 250 = 16000 次 CIEDE2000；严禁对 104×104=10816 个格子逐格
 * 匹配全色板（那是 270 万次）。匹配结果用 Map<hex, ...> 缓存，格子只查 Map。
 */
import type { BeadColor, BeadPalette } from '../core/types';
import type { Lab, Rgb } from './convert';
import { rgbToLab } from './convert';
import { deltaE2000 } from './deltaE';
import type { QuantizedColor } from './quantize';

/** 预计算色板索引：每色的 Lab（避免每次匹配重复 rgb→lab 转换） */
export interface PaletteIndex {
  colors: BeadColor[];
  labs: Lab[];
}

/** 构建色板 Lab 索引 */
export function buildPaletteIndex(palette: BeadPalette): PaletteIndex {
  return {
    colors: palette.colors,
    labs: palette.colors.map((c) => rgbToLab(c.rgb)),
  };
}

export interface MatchResult {
  color: BeadColor;
  deltaE: number;
}

export interface PaletteMatchEntry {
  colorId: string;
  index: number;
  deltaE: number;
}

/** 单色匹配到色板中 ΔE2000 最小的一色 */
export function matchToPalette(rgb: Rgb, palette: BeadPalette): MatchResult {
  const index = buildPaletteIndex(palette);
  const lab = rgbToLab(rgb);
  const best = matchIndexWithPalette(lab, index);
  return { color: index.colors[best], deltaE: deltaE2000(lab, index.labs[best]) };
}

/** 用预计算索引匹配单个 Lab，返回最匹配色的下标（内部热路径） */
function matchIndexWithPalette(lab: Lab, index: PaletteIndex): number {
  let best = 0;
  let bestDe = Infinity;
  for (let i = 0; i < index.labs.length; i++) {
    const de = deltaE2000(lab, index.labs[i]);
    if (de < bestDe) {
      bestDe = de;
      best = i;
    }
  }
  return best;
}

/**
 * 批量匹配：量化色 → 色板。返回 Map<hex, {colorId, index, deltaE}>，
 * 后续像素化/渲染阶段按 hex 查表，O(1) 命中。
 * 调用方必须保证 colors.length ≤ 64（量化阶段控制 K）。
 */
export function matchManyToPalette(
  colors: QuantizedColor[],
  palette: BeadPalette,
): Map<string, PaletteMatchEntry> {
  const index = buildPaletteIndex(palette);
  const out = new Map<string, PaletteMatchEntry>();
  for (const c of colors) {
    const lab = rgbToLab(c.rgb);
    const at = matchIndexWithPalette(lab, index);
    out.set(c.hex, { colorId: index.colors[at].id, index: at, deltaE: deltaE2000(lab, index.labs[at]) });
  }
  return out;
}

/**
 * 生成旧色板到目标色板的索引映射：按 CIEDE2000 把每个旧色匹配到目标色板最近色。
 * 返回 `Map<oldIndex, newIndex>`，只包含能稳定匹配的旧色。
 */
export function mapPaletteColors(
  source: BeadColor[],
  target: BeadPalette,
): Map<number, number> {
  const out = new Map<number, number>();
  if (source.length === 0 || target.colors.length === 0) return out;
  const quantized: QuantizedColor[] = source.map((c) => ({
    rgb: c.rgb,
    hex: c.hex,
    count: 1,
  }));
  const byHex = matchManyToPalette(quantized, target);
  for (let i = 0; i < source.length; i++) {
    const entry = byHex.get(source[i].hex);
    if (entry) out.set(i, entry.index);
  }
  return out;
}
