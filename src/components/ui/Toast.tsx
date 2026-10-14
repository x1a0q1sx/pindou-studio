/**
 * ui/Toast —— 全局提示容器。数据来自 store.toasts（pushToast/dismissToast），
 * 右上角滑入（animations.css pdb-toast-in），到期自动消失由 store.pushToast 内部定时。
 */
import { usePdbStore } from '@/store';
import { PdbIcon, type IconName } from '@/components/icons';
import type { ToastKind } from '@/core/types';

const KIND_ICON: Record<ToastKind, IconName> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'warning',
};

export function ToastContainer() {
  const toasts = usePdbStore((s) => s.toasts);
  const dismissToast = usePdbStore((s) => s.dismissToast);

  return (
    <div className="pdb-toast-container" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`pdb-toast pdb-toast--${t.kind}`} role="status">
          <span className="pdb-toast__icon">
            <PdbIcon name={KIND_ICON[t.kind]} size={16} />
          </span>
          <span>{t.message}</span>
          <button type="button" className="pdb-toast__close" onClick={() => dismissToast(t.id)} aria-label="关闭提示">
            <PdbIcon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
