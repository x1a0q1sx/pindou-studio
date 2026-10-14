/**
 * components/project/OpenDialog.tsx —— 打开项目对话框。
 *
 * 功能：
 *   1. 监听 'pdb:open-open' 事件打开；
 *   2. 显示最近项目列表（RecentList 组件），点击可直接打开；
 *   3. 「浏览文件…」按钮调用 persistence.openProject()（经 bridge 走原生文件对话框）。
 */
import { useCallback, useEffect, useState } from 'react';
import { usePdbStore } from '@/store';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { openProject } from '@/store/persistence';
import { RecentList } from './RecentList';
import { openOpenDialog } from './dialogBus';
import './project.css';

export function OpenDialog() {
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);

  /* 监听 'pdb:open-open' 事件 */
  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ handled?: boolean }>;
      if (ce.detail) ce.detail.handled = true;
      setOpen(true);
    };
    window.addEventListener('pdb:open-open', handler);
    return () => window.removeEventListener('pdb:open-open', handler);
  }, []);

  const handleBrowse = useCallback(async () => {
    setOpening(true);
    const store = usePdbStore.getState();
    try {
      const outcome = await openProject();
      if (outcome.ok) {
        store.pushToast('success', `已打开项目：${outcome.name}`, 3000);
        setOpen(false);
      } else if (outcome.cancelled) {
        // 用户取消
      } else if (outcome.error) {
        store.pushToast('danger', `打开失败：${outcome.error}`, 6000);
      }
    } catch (err) {
      store.pushToast('danger', `打开异常：${err instanceof Error ? err.message : String(err)}`, 6000);
    } finally {
      setOpening(false);
    }
  }, []);

  const handleRecentOpen = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <Modal open={open} onClose={() => !opening && setOpen(false)} title="打开项目">
      <div className="pdb-project-dialog">
        <div className="pdb-project-dialog__section">
          <span className="pdb-project-dialog__section-title">最近项目</span>
          <RecentList onOpened={handleRecentOpen} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={opening}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void handleBrowse()} disabled={opening}>
            {opening ? '打开中…' : '浏览文件…'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 供外部通过事件打开 OpenDialog（实现移至 dialogBus，此处转发保持桶导出兼容） */
export { openOpenDialog };
