/**
 * community/PatternWebDialog.tsx —— 图纸 Web：成熟拼豆图纸库（kandipatterns.com）。
 *
 * 数据流：本组件经 bridge.webFetch（Electron 主进程受限 https 代理）拉取图纸库
 * HTML → parseKandiListing → 缩略图网格；点「导入」再经 webFetch 下载原图字节
 * → 拼成 File → 派发 `pdb:import-file`（AppShell 的 useImageImport 接住，走既有像素化管线）。
 *
 * 行为：打开时**并行请求全部分类并汇聚去重显示**（mergeKandiListings）；
 * 分类 chips 单独浏览；搜索框走站内搜索。该站国内直连可达，无需代理。
 * 入口：LeftRail / `pdb:open-pattern-web`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { getBridge } from '@/io/bridge';
import { usePdbStore } from '@/store';
import {
  buildKandiListUrl,
  buildKandiSearchUrl,
  mergeKandiListings,
  parseKandiListing,
  KANDI_AGGREGATE_CATEGORIES,
  KANDI_CATEGORIES,
  type PatternItem,
} from '@/core/patternSource';
import {
  parsePindouClubList,
  pindouBeanToBeads,
  type PindouClubBean,
} from '@/core/pindouclub';
import './community.css';

/** 把下载到的图片字节 + 源 URL 拼成一个 File（喂给导入管线的契约入参） */
function bytesToFile(data: Uint8Array, url: string): File {
  const clean = url.split('?')[0];
  const ext = (clean.match(/\.(png|jpe?g|webp|gif|bmp)$/i)?.[1] ?? 'png').toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : `image/${ext}`;
  const name = clean.split('/').pop() ?? `pattern.${ext}`;
  const copy = data.slice();
  return new File([copy], name, { type: mime });
}

/** 失败原因 → 用户可读文案 */
function fetchErrorHint(error?: string, status?: number): string {
  if (status === 403 || status === 429) return '请求被对端拒绝（403/429，风控或限流）——稍等片刻再试。';
  if (status === 404) return '没找到该内容（404）。';
  switch (error) {
    case 'cors-or-offline': return '无法连接图纸库：浏览器模式受跨域限制，请改用桌面版应用。';
    case 'no-ipc': return '当前环境不支持联网取图（浏览器模式），请在桌面应用中打开。';
    case 'host-not-allowed': case 'https-only': case 'bad-url': return '内部错误：请求地址不在白名单内。';
    case 'too-large': return '内容超出大小上限（>15MB）。';
    case 'abort': return '已取消。';
    default: return '连接 kandipatterns.com 失败——请检查网络后重试。';
  }
}

export function PatternWebDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PatternItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [source, setSource] = useState<'club' | 'kandi'>('club');
  const reqSeq = useRef(0);
  const pushToast = usePdbStore((s) => s.pushToast);

  useEffect(() => {
    const handler = (): void => setOpen(true);
    window.addEventListener('pdb:open-pattern-web', handler);
    return () => window.removeEventListener('pdb:open-pattern-web', handler);
  }, []);

  /** 拉 HTML 原文（图纸库是 HTML 页）；失败返回 undefined */
  const fetchHtml = useCallback(async (url: string): Promise<string | undefined> => {
    const bridge = getBridge();
    const res = await bridge.webFetch(url);
    if (!res.ok || !res.data) return undefined;
    return new TextDecoder('utf-8').decode(res.data);
  }, []);

  /** 打开默认视图 / 点分类：全部（汇聚）或单分类 */
  const doBrowse = useCallback(async (category: 'all' | string): Promise<void> => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    setHint(null);
    if (category === 'all') {
      const cats = KANDI_AGGREGATE_CATEGORIES;
      const settled = await Promise.allSettled(cats.map((c) => fetchHtml(buildKandiListUrl(c))));
      if (seq !== reqSeq.current) return;
      const oks = settled.filter((r) => r.status === 'fulfilled' && r.value).length;
      const merged = mergeKandiListings(
        settled.map((r) => (r.status === 'fulfilled' ? r.value : undefined)),
        cats,
      );
      setItems(merged);
      if (merged.length === 0) {
        setError('图纸库全部分类都加载失败——请检查网络后点「搜索 / 刷新」重试。');
      } else if (oks < cats.length) {
        setHint(`已汇聚 ${merged.length} 张图纸（${cats.length - oks} 个分类加载失败被跳过）。`);
      } else {
        setHint(`已汇聚 ${merged.length} 张图纸。输入关键词可搜索全站。`);
      }
    } else {
      const html = await fetchHtml(buildKandiListUrl(category));
      if (seq !== reqSeq.current) return;
      const list = parseKandiListing(html ?? '');
      setItems(list);
      if (list.length === 0) setHint('该分类下暂无图纸，换一个试试。');
    }
    setLoading(false);
  }, [fetchHtml]);

  /** 站内搜索 */
  const doSearch = useCallback(async (): Promise<void> => {
    const q = query.trim();
    if (!q) { void doBrowse('all'); return; }
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    setHint(null);
    const html = await fetchHtml(buildKandiSearchUrl(q));
    if (seq !== reqSeq.current) return;
    const list = parseKandiListing(html ?? '');
    setItems(list);
    setLoading(false);
    if (list.length === 0) setHint(`「${q}」没有搜到图纸，换个关键词试试。`);
  }, [query, fetchHtml, doBrowse]);

  /** 拼豆社区：POST 请求（免登录公开接口） */
  const fetchClubPost = useCallback(async (path: string, body: Record<string, unknown>): Promise<unknown | null> => {
    const bridge = getBridge();
    const res = await bridge.webFetch({
      url: `https://beans-api.moss-art.cn/beans/v1/${path}`,
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.data) {
      throw new Error(fetchErrorHint(res.error, res.status));
    }
    return JSON.parse(new TextDecoder('utf-8').decode(res.data));
  }, []);

  /** 拼豆社区：今日推荐列表（打开默认） */
  const doBrowseClub = useCallback(async (): Promise<void> => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    setHint(null);
    try {
      const json = await fetchClubPost('dynamics/today_recommend/list', {});
      if (seq !== reqSeq.current) return;
      const list = parsePindouClubList(json);
      setItems(list);
      if (list.length === 0) setHint('推荐列表为空，稍后刷新试试。');
      else setHint(`已加载 ${list.length} 张精选图纸——导入为精确色号矩阵（非图片识别）。`);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setError(err instanceof Error ? err.message : '加载失败');
      setItems([]);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [fetchClubPost]);

  /** 拼豆社区：精确色号导入（下载色号矩阵 → 直接落板，跳过像素化） */
  const importClub = useCallback(async (item: PatternItem): Promise<void> => {
    const dynamicId = item.id.replace(/^club-/, '');
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const json = await fetchClubPost('dynamics/today_recommend/detail', { dynamic_id: Number(dynamicId) });
      if (seq !== reqSeq.current) return;
      const beans = (json as { data?: { recommend?: { bean_list?: unknown[] } } })?.data?.recommend?.bean_list;
      if (!Array.isArray(beans) || beans.length === 0) {
        pushToast('danger', '这张图纸的色号数据为空（可能需要登录该 App）', 4200);
        return;
      }
      const palette = usePdbStore.getState().palette;
      const codeToIndex = new Map<string, number>();
      palette.colors.forEach((c, i) => { if (c.code) codeToIndex.set(c.code, i + 1); });
      const pick = (beans as Array<Record<string, unknown>>)
        .map((b) => b as unknown as PindouClubBean)
        .find((b) => b.beadBrandKey === 'mard') ?? (beans as unknown as PindouClubBean[])[0];
      if (!pick?.pixelData) { pushToast('danger', '图纸数据缺失', 3200); return; }
      const r = pindouBeanToBeads(pick, codeToIndex);
      const store = usePdbStore.getState();
      if (!store.applyImportedBeads(r.beads, { cols: r.cols, rows: r.rows })) return;
      const note = r.unmatchedCodes.length ? `；${r.unmatchedCodes.length} 个色号（${r.unmatchedCodes.slice(0, 5).join(' ')}${r.unmatchedCodes.length > 5 ? '…' : ''}）不在当前色板已置空` : '';
      pushToast('success', `已导入 ${r.cols}×${r.rows} 精确图纸，匹配 ${r.matchedCells} 格${note}`, 5200);
      setOpen(false);
    } catch (err) {
      if (seq === reqSeq.current) pushToast('danger', err instanceof Error ? err.message : '导入失败', 3600);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [fetchClubPost, pushToast]);

  // 打开时自动汇聚全部分类
  useEffect(() => {
    if (open && items.length === 0 && !loading) void (source === 'club' ? doBrowseClub() : doBrowse('all'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  const onImport = useCallback(async (item: PatternItem): Promise<void> => {
    if (item.id.startsWith('club-')) { await importClub(item); return; }
    setImportingId(item.id);
    try {
      const bridge = getBridge();
      const res = await bridge.webFetch(item.imageUrl);
      if (!res.ok || !res.data) {
        pushToast('danger', fetchErrorHint(res.error, res.status), 4200);
        return;
      }
      const file = bytesToFile(res.data, item.imageUrl);
      window.dispatchEvent(new CustomEvent<File>('pdb:import-file', { detail: file }));
      setOpen(false);
    } catch (err) {
      pushToast('danger', err instanceof Error ? err.message : '下载失败', 3600);
    } finally {
      setImportingId(null);
    }
  }, [pushToast, importClub]);

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="图纸 Web · 成熟拼豆图纸库" wide>
      <div className="pdb-pweb">
        <p className="pdb-pweb__intro">
          来自 <b>kandipatterns.com</b> 的成熟拼豆图纸（数千张，按分类整理），打开即自动汇聚各分类。
          点「导入」进入像素化管线（自动匹配当前 MARD 色板）。<b>国内直连可用</b>。
        </p>

        {/* 源切换 */}
        <div className="pdb-pweb__sources" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={source === 'club'}
            className={`pdb-pweb__source ${source === 'club' ? 'is-active' : ''}`}
            onClick={() => { setSource('club'); if (items.length === 0 || items[0].id.startsWith('club-') === false) void doBrowseClub(); }}
          >
            拼豆社区（精确色号）
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'kandi'}
            className={`pdb-pweb__source ${source === 'kandi' ? 'is-active' : ''}`}
            onClick={() => { setSource('kandi'); if (items.length === 0 || items[0].id.startsWith('club-')) void doBrowse('all'); }}
          >
            图纸库（kandipatterns）
          </button>
        </div>

        {/* 搜索栏（kandi 源） */}
        <div className="pdb-pweb__bar" style={source === 'club' ? { display: 'none' } : undefined}>
          <label className="pdb-pweb__field pdb-pweb__field--grow">
            <span className="pdb-label">搜索图纸</span>
            <input
              className="pdb-pweb__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
              placeholder="如 pokemon / hello kitty / minecraft（留空=汇聚全部分类）"
              aria-label="搜索图纸"
            />
          </label>
          <Button variant="primary" onClick={() => void doSearch()} disabled={loading}>
            <PdbIcon name="search" size={15} />
            {loading ? '加载中…' : '搜索 / 刷新'}
          </Button>
        </div>

        {/* 分类快速入口（kandi 源） */}
        <div className="pdb-pweb__chips" style={source === 'club' ? { display: 'none' } : undefined}>
          <span className="pdb-label">分类</span>
          <button
            type="button"
            className="pdb-pweb__chip"
            onClick={() => void doBrowse('all')}
          >
            全部（汇聚）
          </button>
          {KANDI_CATEGORIES.map((c) => (
            <button
              key={c.path}
              type="button"
              className="pdb-pweb__chip"
              title={c.zh}
              onClick={() => void doBrowse(c.path)}
            >
              {c.zh}
            </button>
          ))}
        </div>

        {error && (
          <div className="pdb-pweb__alert" role="alert">
            <PdbIcon name="warning" size={15} />
            <span>{error}</span>
          </div>
        )}
        {hint && !error && <div className="pdb-pweb__hint">{hint}</div>}

        {/* 结果网格 */}
        <div className="pdb-pweb__grid">
          {items.map((item) => (
            <figure key={item.id} className="pdb-pweb__card">
              <div className="pdb-pweb__thumb">
                <img
                  src={item.thumbUrl}
                  alt={item.title}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                />
              </div>
              <figcaption>
                <span className="pdb-pweb__card-title" title={item.title}>{item.title}</span>
                <span className="pdb-pweb__card-meta">{item.source}</span>
                <span className="pdb-pweb__card-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void onImport(item)}
                    disabled={importingId === item.id}
                    title="下载并导入到画板（进入像素化 / 配色流程）"
                  >
                    <PdbIcon name="import" size={14} />
                    {importingId === item.id ? '下载中…' : '导入'}
                  </Button>
                  {item.permalink && (
                    <a
                      className="pdb-pweb__link"
                      href={item.permalink}
                      target="_blank"
                      rel="noreferrer noopener"
                      title="在系统浏览器打开图纸页"
                    >
                      来源
                    </a>
                  )}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
        {!loading && !error && items.length === 0 && (
          <div className="pdb-pweb__empty">
            <PdbIcon name="search" size={22} />
            <p>还没有结果。输入关键词搜索，或点上方分类浏览。</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
