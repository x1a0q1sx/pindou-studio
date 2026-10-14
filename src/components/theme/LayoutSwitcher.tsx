/**
 * theme/LayoutSwitcher —— 四套布局预览卡片（线框示意图 + 描述），选择即时生效并持久化。
 * TODO: 进入拼豆模式自动切 focus 布局的联动（用户可关闭）在  实现。
 */
import { usePdbStore } from '@/store';
import { Modal } from '@/components/ui/Modal';
import { PdbIcon } from '@/components/icons';
import { isPlacementSessionActive } from '@/hooks/useHotkeys';
import { saveAppearance } from './appearance';
import type { LayoutId } from '@/core/types';
import './switchers.css';

export interface LayoutSwitcherProps {
  open: boolean;
  onClose: () => void;
}

interface LayoutCardDef {
  id: LayoutId;
  name: string;
  description: string;
}

const LAYOUTS: LayoutCardDef[] = [
  { id: 'classic', name: '经典三栏', description: '工具条 + 左工具栏 + 右面板 + 状态栏，信息最全，适合设计与精细编辑' },
  { id: 'floating', name: '悬浮面板', description: '画布满屏 + 可拖拽悬浮面板 + 底部胶囊工具条，最沉浸的中大屏创作' },
  { id: 'split', name: '上下分区', description: '上大画布 + 下横向滚动调色板与进度条，适合小屏/竖屏/触屏' },
  { id: 'focus', name: '专注拼豆', description: '只有画布 + 极简色条 + 超大进度计数 + 区块导航，配暗夜主题即发光底板' },
  { id: 'dual', name: '双板并排', description: '屏幕左右各一块画布，独立平移对位；宽幅作品双板同拼或左右对照' },
];

export function LayoutSwitcher({ open, onClose }: LayoutSwitcherProps) {
  const layout = usePdbStore((s) => s.layout);
  const setLayout = usePdbStore((s) => s.setLayout);
  const pushToast = usePdbStore((s) => s.pushToast);

  const choose = (id: LayoutId): void => {
    setLayout(id);
    // #25：拼豆会话激活期间只 setLayout 不 saveAppearance——临时选择会在退出拼豆时被
    // useHotkeys 的快照恢复（同样不持久化），与该出口行为一致，避免「重启后打开的是临时布局」。
    if (!isPlacementSessionActive()) saveAppearance({ layout: id });
    pushToast('success', `已切换到「${LAYOUTS.find((l) => l.id === id)?.name}」布局`);
  };

  return (
    <Modal open={open} title="选择布局" onClose={onClose}>
      <div className="pdb-switcher-grid">
        {LAYOUTS.map((l, idx) => {
          const active = l.id === layout;
          return (
            <button
              key={l.id}
              type="button"
              className={`pdb-layout-card pdb-pressable ${active ? 'is-active' : ''}`}
              style={{ animationDelay: `${idx * 60}ms` }}
              aria-pressed={active}
              onClick={() => choose(l.id)}
            >
              <span className="pdb-theme-card__head">
                <LayoutWireframe id={l.id} />
                <strong>{l.name}</strong>
                {active && (
                  <span className="pdb-theme-card__check">
                    <PdbIcon name="checkCircle" size={16} />
                  </span>
                )}
              </span>
              <span className="pdb-theme-card__desc">{l.description}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/** 线框示意图：纯 CSS 变量着色，跟随当前主题 */
function LayoutWireframe({ id }: { id: LayoutId }) {
  return (
    <svg className="pdb-layout-card__wire" viewBox="0 0 120 60" role="img" aria-label={`${id} 布局示意`}>
      <rect x="1" y="1" width="118" height="58" rx="5" fill="var(--surface-2)" stroke="var(--border-strong)" strokeWidth="1.4" />
      {id === 'classic' && (
        <>
          <rect x="5" y="5" width="110" height="8" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="16" width="12" height="32" rx="2" fill="var(--primary-soft)" />
          <rect x="20" y="16" width="72" height="32" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="95" y="16" width="20" height="32" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="51" width="110" height="5" rx="2" fill="var(--border)" />
        </>
      )}
      {id === 'floating' && (
        <>
          <rect x="5" y="5" width="110" height="44" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="10" y="10" width="30" height="18" rx="4" fill="var(--primary-soft)" stroke="var(--border-strong)" />
          <rect x="34" y="50" width="52" height="7" rx="3.5" fill="var(--primary)" />
        </>
      )}
      {id === 'split' && (
        <>
          <rect x="5" y="5" width="110" height="8" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="16" width="110" height="26" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="5" y="45" width="110" height="11" rx="2" fill="var(--primary-soft)" />
          <circle cx="14" cy="50.5" r="3.4" fill="var(--primary)" />
          <circle cx="24" cy="50.5" r="3.4" fill="var(--accent)" />
          <circle cx="34" cy="50.5" r="3.4" fill="var(--warning)" />
        </>
      )}
      {id === 'focus' && (
        <>
          <rect x="5" y="5" width="110" height="6" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="14" width="110" height="30" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="38" y="47" width="44" height="9" rx="4.5" fill="var(--primary)" />
          <text x="60" y="34" fontSize="15" fontWeight="700" textAnchor="middle" fill="var(--text)">7</text>
        </>
      )}
      {id === 'dual' && (
        <>
          <rect x="5" y="14" width="110" height="6" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="23" width="53" height="30" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="62" y="23" width="53" height="30" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <circle cx="24" cy="38" r="3.4" fill="var(--primary)" />
          <circle cx="89" cy="38" r="3.4" fill="var(--accent)" />
          <rect x="5" y="45" width="110" height="11" rx="2" fill="var(--primary-soft)" />
        </>
      )}
    </svg>
  );
}
