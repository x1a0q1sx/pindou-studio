/**
 * tests/patternSource.test.ts —— 图纸 Web 数据层用例（Vitest）。
 * 数据源为 kandipatterns.com（Kandi 图纸库）：URL 拼接、HTML 卡片解析、汇聚去重。
 */
import { describe, expect, it } from 'vitest';
import {
  buildKandiListUrl,
  buildKandiSearchUrl,
  parseKandiListing,
  mergeKandiListings,
  KANDI_CATEGORIES,
  KANDI_AGGREGATE_CATEGORIES,
} from '@/core/patternSource';

const KANDI_FIXTURE = `
<a href="/patterns/characters"><img src="/themes/hk_circle.svg"></a>
<a href="/patterns/characters/twisty-the-clown-16701"><img src="https://s3.amazonaws.com/kandipatternspatterns/characters/16701_Twisty.png" alt="Twisty The Clown"></a>
<a href="/patterns/misc/hello-kitty-perler-3240"><img src="https://s3.amazonaws.com/kandipatternspatterns/misc/3240-Hello_Kitty_Perler.png" alt="Hello Kitty Perler"></a>
<a href="/patterns/misc/hello-kitty-perler-3240"><img src="https://s3.amazonaws.com/kandipatternspatterns/misc/3240-Hello_Kitty_Perler.png" alt="dup"></a>
<a href="/patterns/food/empty-card"><img src="https://s3.amazonaws.com/kandipatternspatterns/food/placeholder.svg"></a>
`;

describe('patternSource · KandiPatterns', () => {
  it('分类与搜索 URL 拼接', () => {
    expect(buildKandiListUrl('popular')).toBe('https://kandipatterns.com/patterns/popular');
    expect(buildKandiListUrl('/characters')).toBe('https://kandipatterns.com/patterns/characters');
    expect(buildKandiSearchUrl('hello kitty')).toBe('https://kandipatterns.com/search?searchword=hello+kitty&type=patterns');
    expect(KANDI_CATEGORIES.length).toBeGreaterThanOrEqual(5);
    expect(KANDI_AGGREGATE_CATEGORIES).toContain('popular');
  });

  it('parseKandiListing：只收 s3 图纸卡、去重、字段齐全；容错不抛', () => {
    expect(parseKandiListing('')).toEqual([]);
    expect(parseKandiListing('<a href="/patterns/characters/x"><img src="/x.png"></a>')).toEqual([]);
    const items = parseKandiListing(KANDI_FIXTURE);
    expect(items.length).toBe(2);
    expect(items[0].title).toBe('Twisty The Clown');
    expect(items[0].imageUrl).toBe('https://s3.amazonaws.com/kandipatternspatterns/characters/16701_Twisty.png');
    expect(items[0].source).toBe('KandiPatterns · characters');
    expect(items[0].permalink).toBe('https://kandipatterns.com/patterns/characters/twisty-the-clown-16701');
    expect(items[1].title).toBe('Hello Kitty Perler');
  });

  it('mergeKandiListings：跨页汇聚 + 去重 + 失败页跳过 + 覆盖来源标签', () => {
    const pageA = KANDI_FIXTURE;
    const pageB = `<a href="/patterns/animals/cat-77"><img src="https://s3.amazonaws.com/kandipatternspatterns/animals/cat.png" alt="Cat"></a>
<a href="/patterns/misc/hello-kitty-perler-3240"><img src="https://s3.amazonaws.com/kandipatternspatterns/misc/3240-Hello_Kitty_Perler.png" alt="dup"></a>`;
    const merged = mergeKandiListings([pageA, pageB, undefined], ['characters', 'animals', 'food']);
    // A 2 张 + B 1 张新卡（dup 被去重；food 页失败跳过）
    expect(merged.length).toBe(3);
    expect(merged.map((i) => i.subreddit)).toEqual(['characters', 'misc', 'animals']);
    expect(merged[2].source).toBe('KandiPatterns · animals');
    expect(mergeKandiListings([undefined, undefined], ['a', 'b'])).toEqual([]);
  });
});
