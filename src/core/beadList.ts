/**
 * core/beadList.ts —— 外部图纸色号清单的解析与匹配（纯函数，Node 可测）。
 *
 * 使用场景（色号清单导入）：拿到别人图纸的用料清单（文本/表格复制），
 * 逐行是「色号 [数量]」，例如：
 *   A1 ×120
 *   B3 45
 *   M15: 8
 *   C2,200
 * 解析后把每个色号匹配到**当前色板**：
 *   1. 精确匹配——忽略大小写/空格/连字符（mard-05 ≡ MARD05 ≡ M5）；
 *   2. 跨色板近似——色号在当前色板不存在时，先在其余内置色板里找同号颜色，
 *      再用 CIEDE2000 在当前色板里找最接近的色（ΔE ≤ 12 才采纳）；
 *   3. 都找不到 → unmatched（清单里保留原样，不猜）。
 *
 * 注意：没有位置信息，清单只用于「对色号/估算用量」，不能反推板面图案。
 */
import type { BeadPalette } from './types';
import { deltaE2000 } from '../color/deltaE';
import { rgbToLab } from '../color/convert';
import { getPalette, BUILTIN_PALETTE_IDS } from '../palettes';

export interface ParsedBeadLine {
  /** 原始行（trim 后） */
  raw: string;
  /** 解析出的色号（保留用户写法） */
  code: string;
  /** 数量；null = 行里没写 */
  count: number | null;
}

/** 无法解析的行（原样返回，UI 里展示跳过原因） */
export type SkippedLine = string;

/** 色号规范化：大写、去空格/连字符/下划线 */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s\-_]/g, '');
}

/**
 * 解析多行清单。每行允许的形态（分隔符可混用）：
 *   「色号 数量」「色号×数量」「色号x数量」「色号:数量」「色号：数量」「色号,数量」「色号」
 * 行首的序号/项目符号（1. / - / • / *）自动剥离。数量为非负整数（可带千分位逗号）。
 */
export function parseBeadList(text: string): { lines: ParsedBeadLine[]; skipped: SkippedLine[] } {
  const lines: ParsedBeadLine[] = [];
  const skipped: SkippedLine[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) continue; // 空行/注释
    // 剥离行首序号/项目符号
    const body = raw.replace(/^(?:\d+[.、)]|[-•*·])\s*/u, '');
    // 1) 提取色号：字母段 + 可选的「分隔符+字母段」（如 G-W01）+ 分隔符 + 数字（A1 / S03 / D-34 / G-W01）
    const codeMatch = body.match(/^\s*([A-Za-z]{1,3}(?:[\s\-_][A-Za-z]{1,2})?[\s\-_]?\d{1,3})(?![0-9A-Za-z])/u);
    if (!codeMatch) {
      skipped.push(raw);
      continue;
    }
    const code = codeMatch[1].replace(/[\s_]/gu, ''); // 空格/下划线去掉；连字符保留原写法
    let rest = body.slice(codeMatch[0].length);
    // 2) 提取数量：分隔符（×/x/*/、:：,空格）后的整数
    rest = rest.replace(/^[\s×xX*、:：,，]+/u, '');
    const countMatch = rest.match(/^(\d{1,3}(?:,\d{3})+|\d+)/u);
    const count = countMatch ? Number(countMatch[1].replace(/,/g, '')) : null;
    lines.push({ raw, code, count: count !== null && Number.isFinite(count) ? count : null });
  }

  return { lines, skipped };
}

export type BeadMatchStatus = 'exact' | 'similar' | 'unmatched';

export interface BeadMatch {
  parsed: ParsedBeadLine;
  /** 当前色板中的索引；unmatched 时为 -1 */
  index: number;
  /** 匹配到的当前色板色号 */
  matchedCode: string;
  hex: string;
  name: string;
  /** 命中方式说明（近似时给出来源色板与色号） */
  hint?: string;
  status: BeadMatchStatus;
}

export interface BeadListMatchResult {
  matches: BeadMatch[];
  /** 匹配摘要：总数（写了数量的行求和；全没写则为 null） */
  totalCount: number | null;
}

/** 跨色板查找同号颜色：返回 [色板名, 颜色]（跳过当前色板本身） */
function findCodeInOtherPalettes(code: string, currentId: string): Array<{ paletteName: string; color: BeadPalette['colors'][number] }> {
  const out: Array<{ paletteName: string; color: BeadPalette['colors'][number] }> = [];
  const target = normalizeCode(code);
  for (const id of BUILTIN_PALETTE_IDS) {
    if (id === currentId) continue;
    let p: BeadPalette;
    try {
      p = getPalette(id);
    } catch {
      continue;
    }
    for (const c of p.colors) {
      if (normalizeCode(c.code) === target) out.push({ paletteName: p.brand, color: c });
    }
  }
  return out;
}

/** 近似匹配采纳阈值：ΔE2000 超过它视为找不到可靠对应（宁可 unmatched 也不误导） */
const SIMILAR_MAX_DELTA_E = 12;

/**
 * 把解析结果匹配到当前色板。见文件头说明的三级匹配策略。
 */
export function matchBeadList(lines: ParsedBeadLine[], palette: BeadPalette): BeadListMatchResult {
  // 预计算当前色板 Lab（一次）
  const labs = palette.colors.map((c) => rgbToLab(c.rgb));

  const matches: BeadMatch[] = lines.map((parsed) => {
    const target = normalizeCode(parsed.code);

    // 1. 精确匹配当前色板
    const exactIdx = palette.colors.findIndex((c) => normalizeCode(c.code) === target);
    if (exactIdx >= 0) {
      const c = palette.colors[exactIdx];
      return {
        parsed,
        index: exactIdx,
        matchedCode: c.code,
        hex: c.hex,
        name: c.nameZh ?? c.name,
        status: 'exact',
      };
    }

    // 2. 跨色板同号 → 当前色板最近色
    const others = findCodeInOtherPalettes(parsed.code, palette.id);
    if (others.length > 0) {
      const srcLab = rgbToLab(others[0].color.rgb);
      let bestIdx = -1;
      let bestDe = Infinity;
      for (let i = 0; i < palette.colors.length; i++) {
        const de = deltaE2000(srcLab, labs[i]);
        if (de < bestDe) { bestDe = de; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestDe <= SIMILAR_MAX_DELTA_E) {
        const c = palette.colors[bestIdx];
        return {
          parsed,
          index: bestIdx,
          matchedCode: c.code,
          hex: c.hex,
          name: c.nameZh ?? c.name,
          hint: `${others[0].paletteName} ${others[0].color.code} 的最近色（ΔE ${bestDe.toFixed(1)}）`,
          status: 'similar',
        };
      }
    }

    // 3. 匹配不到
    return { parsed, index: -1, matchedCode: parsed.code, hex: '', name: '', status: 'unmatched' };
  });

  const counted = matches.filter((m) => m.parsed.count !== null);
  const totalCount = counted.length > 0 ? counted.reduce((s, m) => s + (m.parsed.count ?? 0), 0) : null;

  return { matches, totalCount };
}

/** 生成规范化清单文本（复制/导出用）：未匹配行保留原样并标注 */
export function beadListToText(result: BeadListMatchResult): string {
  const rows = result.matches.map((m) => {
    const count = m.parsed.count !== null ? ` ×${m.parsed.count}` : '';
    if (m.status === 'unmatched') return `${m.parsed.code}${count}  → 未匹配`;
    return `${m.matchedCode}${count}  # ${m.name}${m.hint ? `（${m.hint}）` : ''}`;
  });
  const total = result.totalCount !== null ? `\n合计：${result.totalCount} 颗` : '';
  return rows.join('\n') + total;
}
