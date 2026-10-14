/**
 * core/castInbox.ts —— 手机投图落地路由（渲染进程，AppShell 启动即接线）。
 *
 * 主进程 HTTP 服务收到手机上传 → PDB_CAST_PUSH 推到这里：
 *  · pane='A'：转成 File 派发 `pdb:import-file`（AppShell 的 useImageImport.start
 *    接住 → 完整导入向导，可裁剪/调参后落地主画板）；
 *  · pane='B'：**免对话框自动落图**——按图 B 当前板尺寸像素化 + 默认智能配色
 *    （色度门控/高光保护等全开），reduce 后 setPatternB 直进对照屏。
 * 收件箱快照（最近 12 条）供 CastDialog 展示；订阅者列表变化即回调。
 */
import { getBridge, type CastPayload } from '@/io/bridge';
import { usePdbStore } from '@/store';
import { dataUrlToFile, CAST_B_REDUCE } from './castProto';

export interface CastInboxItem {
  id: string;
  name: string;
  pane: 'A' | 'B';
  at: number;
  status: 'wizard' | 'applying' | 'applied' | 'error';
  error?: string;
}

let started = false;
let seq = 0;
let items: CastInboxItem[] = [];
const subs = new Set<() => void>();

function emit(): void {
  for (const fn of subs) {
    try { fn(); } catch { /* 单个订阅者异常不断链 */ }
  }
}

function addItem(patch: Omit<CastInboxItem, 'id'>): CastInboxItem {
  const item: CastInboxItem = { id: `c${++seq}`, ...patch };
  items = [item, ...items].slice(0, 12);
  emit();
  return item;
}

function updateItem(id: string, patch: Partial<CastInboxItem>): void {
  items = items.map((it) => (it.id === id ? { ...it, ...patch } : it));
  emit();
}

/** 订阅收件箱变化；返回取消函数 */
export function subscribeCastInbox(fn: () => void): () => void {
  startCastInbox();
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function getCastInboxItems(): CastInboxItem[] {
  return items;
}

export function clearCastInbox(): void {
  items = [];
  emit();
}

/** 接线主进程推送（幂等；AppShell mount 时调用一次） */
export function startCastInbox(): void {
  if (started) return;
  started = true;
  getBridge().onCastPush((p) => void handlePush(p));
}

async function handlePush(p: CastPayload): Promise<void> {
  const store = usePdbStore.getState();
  const file = dataUrlToFile(p.dataUrl, p.name, p.mime);
  if (!file) {
    addItem({ name: p.name || '(未命名)', pane: p.pane, at: Date.now(), status: 'error', error: '图片数据校验未通过' });
    store.pushToast('danger', `收到手机投图但数据无效：${p.name}`, 3600);
    return;
  }
  if (p.pane === 'B') {
    const item = addItem({ name: file.name, pane: 'B', at: Date.now(), status: 'applying' });
    try {
      await applyToB(file);
      updateItem(item.id, { status: 'applied' });
      store.pushToast('success', `手机图「${file.name}」已自动落进图 B`, 3200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateItem(item.id, { status: 'error', error: msg });
      store.pushToast('danger', `投图进 B 失败：${msg}`, 4200);
    }
    return;
  }
  addItem({ name: file.name, pane: 'A', at: Date.now(), status: 'wizard' });
  // 完整导入向导（与图纸 Web 同一事件契约，AppShell 监听接住）
  window.dispatchEvent(new CustomEvent<File>('pdb:import-file', { detail: file }));
  store.pushToast('info', '手机投来一张图，已在导入向导等你确认', 3200);
}

/** 图 B 免向导自动落图：解码 → 像素化（contain 留白）→ 默认智能配色 → setPatternB */
async function applyToB(file: File): Promise<void> {
  const s = usePdbStore.getState();
  const board = s.boardB;
  const { loadImageFromFile, toRgba } = await import('@/imaging/loader');
  const { pixelateFromRgba, reduceToPaletteGrid, fitRect } = await import('@/imaging/pipeline');

  const loaded = await loadImageFromFile(file);
  const rgba = toRgba(loaded.bitmap, loaded.width, loaded.height);
  const px = pixelateFromRgba(rgba, {
    cols: board.cols,
    rows: board.rows,
    sampling: 'area-average',
    preprocess: { brightness: 0, contrast: 0, saturation: 0 },
    transparentAsEmpty: true,
    samplingCap: 60000,
    highlightProtect: true,
    fit: fitRect(rgba.width, rgba.height, board.cols, board.rows, 'contain'),
  });
  const red = reduceToPaletteGrid(px.cells, px.cols, px.rows, s.palette.colors, { ...CAST_B_REDUCE });
  usePdbStore.getState().setPatternB(board, red.beads);
}
