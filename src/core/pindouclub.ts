/**
 * core/pindouclub.ts —— 拼豆社区（beans-api.moss-art.cn）数据层。
 *
 * 该 App 为 Flutter 应用，API 为 Go 网关：
 *   POST {API_BASE}/v1/dynamics/today_recommend/list   {}（API_BASE=https://beans-api.moss-art.cn/beans）
 *   POST {API_BASE}/v1/dynamics/today_recommend/detail {dynamic_id}
 * 均为**免登录公开接口**（detail 只读公开帖）。返回的 bean_list[].pixelData 是
 * Base64 的行程编码色号串：`65:,2:G14,46:,1:B32,...`
 *   —— `N:` = N 格空；`N:CODE` = N 格 CODE（如 G14/B32/H18，MARD 色号）。
 * 解码后得到**精确色号矩阵**（无需图片识别），可直接映射 MARD 色板落地画板。
 */
import type { PatternItem } from '@/core/patternSource';

export interface PindouClubBean {
  id: string;
  title: string;
  picture: string;
  beadBrandKey: string;
  gridWidth: number;
  gridHeight: number;
  pixelData: string;
}

export interface PindouClubListItem {
  id: number;
  dynamic_id: number;
  title: string;
  cover_img: string;
  bean_id: string;
  bean_snapshot_id: number;
  bead_count: number;
  recommend_tag?: string;
  recommend_reason?: string;
  rating_count?: number;
  composite_score?: number;
  online_at?: string;
  post?: { likes?: number; user_name?: string };
}

/** 列表 JSON → 图纸卡片（容错不抛） */
export function parsePindouClubList(json: unknown): PatternItem[] {
  const list = (json as { data?: { list?: unknown[] } })?.data?.list;
  if (!Array.isArray(list)) return [];
  const items: PatternItem[] = [];
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const dynamicId = typeof r.dynamic_id === 'number' ? r.dynamic_id : 0;
    const title = typeof r.title === 'string' ? r.title : '(无标题)';
    const cover = typeof r.cover_img === 'string' ? r.cover_img : '';
    if (!dynamicId || !cover) continue;
    items.push({
      id: `club-${dynamicId}`,
      source: '拼豆社区',
      subreddit: typeof r.recommend_tag === 'string' ? r.recommend_tag : '',
      title,
      imageUrl: cover,
      thumbUrl: cover,
      width: 0,
      height: 0,
      permalink: `https://h5.pindouclub.cn/`,
      score: typeof r.bead_count === 'number' ? r.bead_count : 0,
      numComments: typeof r.rating_count === 'number' ? r.rating_count : 0,
    });
  }
  return items;
}

/** Base64 行程编码 → 平铺色号数组（''=空格） */
export function decodePindouPixelData(b64: string): string[] {
  if (typeof b64 !== 'string' || b64.length === 0) return [];
  let text: string;
  try {
    text = atob(b64.replace(/\s+/g, ''));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const tok of text.split(',')) {
    if (!tok) continue;
    const i = tok.indexOf(':');
    if (i < 0) continue;
    const n = parseInt(tok.slice(0, i), 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    const code = tok.slice(i + 1);
    for (let k = 0; k < n; k++) out.push(code);
  }
  return out;
}

export interface PindouClubImport {
  /** 色板索引+1（0=空格），与 store beads 契约一致 */
  beads: Uint16Array;
  cols: number;
  rows: number;
  /** 色号矩阵里出现但当前色板没有的色号（按首次出现顺序） */
  unmatchedCodes: string[];
  matchedCells: number;
  emptyCells: number;
}

export interface PindouClubPaletteCode {
  /** 色板色号，如 'G14' */
  code: string;
  /** 1-based 色板索引（beads 数组值） */
  index: number;
}

/**
 * 色号矩阵 → beads（精确匹配当前色板 code）。
 * 找不到的色号计 unmatchedCodes（该格置 0），不抛。
 */
export function pindouBeanToBeads(
  bean: PindouClubBean,
  codeToIndex: ReadonlyMap<string, number>,
): PindouClubImport {
  const cols = Math.max(1, Math.floor(bean.gridWidth));
  const rows = Math.max(1, Math.floor(bean.gridHeight));
  const beads = new Uint16Array(cols * rows);
  const codes = decodePindouPixelData(bean.pixelData);
  const unmatchedCodes: string[] = [];
  const seenUnmatched = new Set<string>();
  let matchedCells = 0;
  let emptyCells = 0;
  for (let i = 0; i < beads.length; i++) {
    const code = codes[i] ?? '';
    if (!code) { emptyCells++; continue; }
    const idx = codeToIndex.get(code);
    if (idx) { beads[i] = idx; matchedCells++; }
    else {
      beads[i] = 0;
      if (!seenUnmatched.has(code)) { seenUnmatched.add(code); unmatchedCodes.push(code); }
    }
  }
  return { beads, cols, rows, unmatchedCodes, matchedCells, emptyCells };
}
