/**
 * ui/Modal —— 轻量模态（无 portal 依赖，overlay 固定定位即可）。Esc/点击遮罩关闭。
 * TODO(/): ImportDialog、SaveDialog、ExportDialog 基于它实现。
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { PdbIcon } from '@/components/icons';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /** 宽版模态（多步向导/多栏面板用），上限 880px */
  wide?: boolean;
}

export function Modal({ open, title, onClose, children, footer, wide = false }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="pdb-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div className={`pdb-modal${wide ? ' pdb-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="pdb-modal__head">
          <h2 className="pdb-modal__title">{title}</h2>
          <Button icon size="sm" onClick={onClose} aria-label="关闭">
            <PdbIcon name="close" size={15} />
          </Button>
        </div>
        <div className="pdb-modal__body">{children}</div>
        {footer ? <div className="pdb-modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
