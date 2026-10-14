/**
 * layout/PanelToggle —— 面板折叠/展开开关（左/右两侧通用）。
 */
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';

export interface PanelToggleProps {
  side: 'left' | 'right';
  collapsed: boolean;
  onToggle: () => void;
}

export function PanelToggle({ side, collapsed, onToggle }: PanelToggleProps) {
  // 展开态：箭头指向「收起方向」；折叠态：指向「展开方向」
  const icon =
    side === 'left'
      ? collapsed ? 'chevronRight' : 'chevronLeft'
      : collapsed ? 'chevronLeft' : 'chevronRight';
  const label =
    side === 'left'
      ? collapsed ? '展开工具栏（M）' : '收起工具栏（M）'
      : collapsed ? '展开面板（M）' : '收起面板（M）';
  return (
    <Button icon size="sm" className="pdb-panel-toggle" aria-label={label} title={label} onClick={onToggle}>
      <PdbIcon name={icon} size={14} />
    </Button>
  );
}
