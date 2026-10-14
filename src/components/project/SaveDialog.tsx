/**
 * components/project/SaveDialog.tsx —— 保存对话框。
 *
 * 功能：
 *   1. 显示当前项目名称（可编辑）；
 *   2. 调用 persistence.saveProjectAs(name) 执行保存（经 io/bridge 走原生对话框）；
 *   3. 监听 'pdb:open-save' 事件打开（若存在），或由 AppShell 直接控制。
 */
import { useCallback, useEffect, useState } from 'react';
import { usePdbStore } from '@/store';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import {
  saveProjectAs,
  getCurrentProjectInfo,
  setProjectName,
} from '@/store/persistence';
import { openSaveDialog } from './dialogBus';
import './project.css';

export function SaveDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  /* 监听 'pdb:open-save' 事件 */
  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ handled?: boolean }>;
      if (ce.detail) ce.detail.handled = true;
      const info = getCurrentProjectInfo();
      setName(info.name);
      setOpen(true);
    };
    window.addEventListener('pdb:open-save', handler);
    return () => window.removeEventListener('pdb:open-save', handler);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const store = usePdbStore.getState();
    try {
      // 先更新项目名称
      if (name.trim()) {
        setProjectName(name.trim());
      }
      const outcome = await saveProjectAs(name.trim() || undefined);
      if (outcome.ok) {
        store.pushToast('success', `项目已保存：${outcome.name}`, 3000);
        setOpen(false);
      } else if (outcome.cancelled) {
        // 用户取消，静默关闭
        setOpen(false);
      } else if (outcome.error) {
        store.pushToast('danger', `保存失败：${outcome.error}`, 6000);
      }
    } catch (err) {
      store.pushToast('danger', `保存异常：${err instanceof Error ? err.message : String(err)}`, 6000);
    } finally {
      setSaving(false);
    }
  }, [name]);

  const info = open ? getCurrentProjectInfo() : null;

  return (
    <Modal open={open} onClose={() => !saving && setOpen(false)} title="保存项目">
      <div className="pdb-project-dialog">
        <div className="pdb-project-dialog__section">
          <div className="pdb-project-dialog__row">
            <span className="pdb-project-dialog__label">项目名称</span>
            <input
              className="pdb-project-dialog__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入项目名称"
              disabled={saving}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
              aria-label="项目名称"
            />
          </div>
          {info && (
            <div className="pdb-save-dialog__info">
              {info.path ? `当前路径：${info.path}` : '尚未保存到文件（将打开保存对话框）'}
              {info.dirty ? ' · 有未保存更改' : ''}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 供 AppShell 通过 ref 或事件打开 SaveDialog（实现移至 dialogBus，此处转发保持桶导出兼容） */
export { openSaveDialog };
