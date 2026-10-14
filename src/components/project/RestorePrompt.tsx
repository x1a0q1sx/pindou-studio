/**
 * components/project/RestorePrompt.tsx —— 自动保存恢复提示对话框。
 *
 * 启动时若 hasUnsavedSession()，弹 Modal 询问用户「恢复上次会话」或「丢弃」。
 * 依赖 useAutoSave hook 暴露的 pending/restore/discard/summary。
 */
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { UseAutoSaveResult } from '@/hooks/useAutoSave';
import './project.css';

export interface RestorePromptProps {
  autoSave: UseAutoSaveResult;
}

export function RestorePrompt({ autoSave }: RestorePromptProps) {
  const { pending, summary, restore, discard } = autoSave;

  if (!pending) return null;

  return (
    <Modal
      open={true}
      onClose={discard}
      title="恢复上次会话"
    >
      <div className="pdb-restore-prompt">
        <p className="pdb-restore-prompt__desc">
          检测到上次未保存的工作进度。您可以恢复到上次离开时的状态，或丢弃它从空白开始。
        </p>
        <div className="pdb-restore-prompt__summary">
          {summary || '（无详细信息）'}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={discard}>
            丢弃
          </Button>
          <Button variant="primary" onClick={restore}>
            恢复上次会话
          </Button>
        </div>
      </div>
    </Modal>
  );
}
