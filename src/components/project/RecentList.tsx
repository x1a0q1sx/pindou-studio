/**
 * components/project/RecentList.tsx —— 最近项目列表。
 *
 * Electron：记录路径，直接重开文件；
 * 浏览器：降级 IndexedDB 存整份项目（由 io/recent.ts 处理）。
 */
import { useCallback, useEffect, useState } from 'react';
import { usePdbStore } from '@/store';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { openRecentProject } from '@/store/persistence';
import { listRecent, removeRecent, type RecentEntry } from '@/io/recent';
import './project.css';

export interface RecentListProps {
  /** 成功打开某项目后的回调 */
  onOpened?: (entry: RecentEntry) => void;
}

export function RecentList({ onOpened }: RecentListProps) {
  const [entries, setEntries] = useState<RecentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listRecent();
      setEntries(list);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpen = useCallback(async (entry: RecentEntry) => {
    setOpeningId(entry.id);
    const store = usePdbStore.getState();
    try {
      const outcome = await openRecentProject(entry.id);
      if (outcome.ok) {
        store.pushToast('success', `已打开项目：${outcome.name}`, 3000);
        onOpened?.(entry);
      } else if (outcome.error) {
        store.pushToast('danger', `打开失败：${outcome.error}`, 6000);
      }
    } catch (err) {
      store.pushToast('danger', `打开异常：${err instanceof Error ? err.message : String(err)}`, 6000);
    } finally {
      setOpeningId(null);
    }
  }, [onOpened]);

  const handleRemove = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await removeRecent(id);
      setEntries((prev) => prev.filter((item) => item.id !== id));
    } catch {
      // 静默
    }
  }, []);

  if (loading) {
    return <div className="pdb-recent-empty">加载中…</div>;
  }

  if (entries.length === 0) {
    return <div className="pdb-recent-empty">暂无最近项目</div>;
  }

  return (
    <div className="pdb-recent-list" role="list" aria-label="最近项目">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="pdb-recent-item"
          role="listitem"
          onClick={() => void handleOpen(entry)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleOpen(entry); }}
          tabIndex={0}
          aria-label={`打开项目 ${entry.name}`}
        >
          <span style={{ color: 'var(--primary)', flexShrink: 0 }}>
            <PdbIcon name="blocks" size={16} />
          </span>
          <div className="pdb-recent-item__info">
            <div className="pdb-recent-item__name">{entry.name}</div>
            <div className="pdb-recent-item__meta">
              {entry.path || '浏览器存储'} · {formatTime(entry.updatedAt)}
            </div>
          </div>
          {openingId === entry.id && (
            <span className="pdb-export-check-item__hint">打开中…</span>
          )}
          <Button
            icon
            size="sm"
            variant="ghost"
            className="pdb-recent-item__remove"
            onClick={(e) => void handleRemove(e, entry.id)}
            aria-label={`移除 ${entry.name}`}
          >
            <PdbIcon name="close" size={12} />
          </Button>
        </div>
      ))}
    </div>
  );
}

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} 小时前`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay} 天前`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}
