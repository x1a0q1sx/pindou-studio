/**
 * core/patternSource.ts —— 「图纸 Web」数据层（零 DOM / 零网络）。
 *
 * 数据源：kandipatterns.com（老牌拼豆图纸库，数千张按分类整理的网格图纸）。
 * 该站国内直连可达，列表图即图纸原图（S3 直链），可直接导入像素化管线。
 * 历史上接过的 Reddit（出口 IP 风控 403）与 GitHub（内容是工具仓库而非图纸）
 * 已按设计裁撤；接口形态保留「HTML 入参 → 卡片列表」的中立解析设计。
 */

/** 一个可选中的图纸卡片 */
export interface PatternItem {
  /** 稳定 id（KandiPatterns 详情路径） */
  id: string;
  /** 来源标识（渲染标签用，如 "KandiPatterns · characters"） */
  source: string;
  /** 分类路径（characters / animals / food …） */
  subreddit: string;
  title: string;
  /** 原图直链（导入用；s3.amazonaws.com） */
  imageUrl: string;
  /** 缩略图直链（列表预览用） */
  thumbUrl: string;
  /** 原图宽高（像素，0=未知） */
  width: number;
  height: number;
  /** 图纸详情页绝对地址（"在浏览器打开"） */
  permalink: string;
  score: number;
  numComments: number;
}

/* ======================= KandiPatterns ======================= */

export const KANDI_CATEGORIES: Array<{ path: string; zh: string }> = [
  { path: 'popular', zh: '全站热门' },
  { path: 'newest', zh: '最新' },
  { path: 'characters', zh: '角色' },
  { path: 'animals', zh: '动物' },
  { path: 'food', zh: '食物' },
  { path: 'holidays', zh: '节日' },
  { path: 'simple', zh: '简易' },
];

/** 汇聚模式默认并行拉取的分类 */
export const KANDI_AGGREGATE_CATEGORIES = ['popular', 'newest', 'characters', 'animals', 'food', 'holidays', 'simple'];

/** 分类/排序页 URL（category: popular|newest|characters|animals|food|holidays|simple|misc） */
export function buildKandiListUrl(category: string): string {
  const cat = category.trim().replace(/^\/+/, '') || 'popular';
  return `https://kandipatterns.com/patterns/${encodeURIComponent(cat)}`;
}

/** 站内搜索 URL */
export function buildKandiSearchUrl(query: string): string {
  const params = new URLSearchParams({ searchword: query.trim(), type: 'patterns' });
  return `https://kandipatterns.com/search?${params.toString()}`;
}

const KANDI_CARD_RE = /<a[^>]+href="(\/patterns\/(?:characters|animals|misc|simple|food|holidays)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

/**
 * 解析 KandiPatterns 列表/搜索 HTML → 图纸卡片。
 * 只收录带 s3 图纸图的卡片（跳过分类导航与懒加载占位）；容错不抛。
 */
export function parseKandiListing(html: string): PatternItem[] {
  if (typeof html !== 'string' || html.length === 0) return [];
  const items: PatternItem[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  KANDI_CARD_RE.lastIndex = 0;
  while ((m = KANDI_CARD_RE.exec(html))) {
    const href = m[1];
    const inner = m[2];
    const img = inner.match(/src="(https:\/\/s3\.amazonaws\.com\/kandipatternspatterns\/[^"]+\.(?:png|jpe?g|gif|webp))"/i);
    if (!img) continue;
    const imageUrl = img[1];
    const alt = inner.match(/alt="([^"]*)"/);
    const title = (alt?.[1] ?? '').trim() || decodeURIComponent(href.split('/').pop() ?? 'pattern');
    if (seen.has(href)) continue;
    seen.add(href);
    const cat = href.split('/')[2] ?? '';
    items.push({
      id: href,
      source: `KandiPatterns · ${cat}`,
      subreddit: cat,
      title,
      imageUrl,
      thumbUrl: imageUrl,
      width: 0,
      height: 0,
      permalink: `https://kandipatterns.com${href}`,
      score: 0,
      numComments: 0,
    });
  }
  return items;
}

/**
 * 汇聚多个来源页面：并行解析、按卡片 href 去重、保持传入顺序。
 * results 与 sources 一一对应（失败页传 undefined 占位）。
 */
export function mergeKandiListings(results: Array<string | undefined>, sources: string[]): PatternItem[] {
  const items: PatternItem[] = [];
  const seen = new Set<string>();
  results.forEach((html, i) => {
    if (!html) return;
    const label = sources[i] ?? '';
    for (const item of parseKandiListing(html)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push({ ...item, source: label ? `KandiPatterns · ${label}` : item.source });
    }
  });
  return items;
}
