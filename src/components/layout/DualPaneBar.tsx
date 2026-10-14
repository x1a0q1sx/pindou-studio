/**
 * layout/DualPaneBar.tsx —— 双画布局部（dual）每个画布顶部的独立控制条。
 *
 * 两个画布各一条：显示图 A / 图 B、当前区块、左右翻页；图 B 额外有「拷贝 A→B」「清空 B」。
 * 数据通道由 pane 决定：A 读 region，B 读 regionB（各自独立分页，互不干扰）。
 * 点击画布空白即切 activePane（远程指令 / 快捷键作用于激活通道）。
 */
import { useMemo } from 'react';
import { usePdbStore } from '@/store';
import { buildRegions } from '@/core/region';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import './layout.css';

export interface DualPaneBarProps {
  pane: 'A' | 'B';
}

export function DualPaneBar({ pane }: DualPaneBarProps) {
  const isB = pane === 'B';
  const board = usePdbStore((s) => (isB ? s.boardB : s.board));
  const region = usePdbStore((s) => (isB ? s.regionB : s.region));
  const setRegion = usePdbStore((s) => (isB ? s.setRegionB : s.setRegion));
  const setActivePane = usePdbStore((s) => s.setActivePane);
  const activePane = usePdbStore((s) => s.activePane);
  const copyAtoB = usePdbStore((s) => s.copyAtoB);
  const clearPatternB = usePdbStore((s) => s.clearPatternB);

  const regions = useMemo(
    () => buildRegions(board.cols, board.rows, region.splitsX, region.splitsY, region.blockCols, region.blockRows),
    [board.cols, board.rows, region.splitsX, region.splitsY, region.blockCols, region.blockRows],
  );
  const total = Math.max(1, regions.length);
  const cur = Math.min(region.activeIndex, total - 1);
  const label = regions[cur]?.label ?? 'A1';
  const isActive = activePane === pane;

  const step = (delta: number): void => {
    setActivePane(pane);
    setRegion({ activeIndex: ((cur + delta) % total + total) % total });
  };

  return (
    <div
      className={`pdb-pane-bar ${isActive ? 'is-active' : ''}`}
      onPointerDown={() => setActivePane(pane)}
      data-pane={pane}
    >
      <span className="pdb-pane-bar__tag">图 {pane}</span>
      <span className="pdb-pane-bar__hint">{board.cols}×{board.rows}</span>
      <span className="pdb-pane-bar__sep" aria-hidden />
      <span className="pdb-pane-bar__region">
        区块 <strong>{label}</strong> {cur + 1}/{total}
      </span>
      <div className="pdb-pane-bar__nav">
        <Button icon size="sm" variant="ghost" aria-label="上一区块" onClick={() => step(-1)}>
          <PdbIcon name="chevronLeft" size={14} />
        </Button>
        <Button icon size="sm" variant="ghost" aria-label="下一区块" onClick={() => step(1)}>
          <PdbIcon name="chevronRight" size={14} />
        </Button>
      </div>
      {isB && (
        <div className="pdb-pane-bar__acts">
          <Button size="sm" variant="ghost" onClick={() => { setActivePane('B'); copyAtoB(); }} title="把图 A 当前图案拷贝到图 B">
            拷贝 A→B
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setActivePane('B'); clearPatternB(); }} title="清空图 B（保留板尺寸）">
            清空
          </Button>
        </div>
      )}
    </div>
  );
}
