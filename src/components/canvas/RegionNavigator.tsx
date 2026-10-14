/**
 * src/components/canvas/RegionNavigator.tsx —— 区块导航条。
 * 显示当前区块标签、第 N/M 块、上一块/下一块按钮、splitsX×splitsY 选择器、
 * 点击区块网格直接跳转。
 */
import { useMemo } from 'react';
import { usePdbStore } from '@/store';
import { buildRegions } from '@/core/region';
import { PdbIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import './canvas.css';

/** 每轴分块数上限（够用且防止格子小到不可操作） */
const MAX_SPLITS_PER_AXIS = 8;

export function RegionNavigator() {
  const board = usePdbStore((s) => s.board);
  const region = usePdbStore((s) => s.region);
  const setRegion = usePdbStore((s) => s.setRegion);

  const regions = useMemo(
    () => buildRegions(board.cols, board.rows, region.splitsX, region.splitsY, region.blockCols, region.blockRows),
    [board.cols, board.rows, region.splitsX, region.splitsY],
  );

  const total = regions.length;
  const activeIdx = Math.min(region.activeIndex, total - 1);
  const activeRegion = regions[activeIdx];

  const step = (delta: number) => {
    const next = (activeIdx + delta + total) % total;
    setRegion({ activeIndex: next });
  };

  const setSplits = (x: number, y: number) => {
    const splitsX = Math.min(MAX_SPLITS_PER_AXIS, Math.max(1, x));
    const splitsY = Math.min(MAX_SPLITS_PER_AXIS, Math.max(1, y));
    // 用户手动设定的分块视为「分页」：标记 autoSized:false，屏幕容量重估只增不减
    setRegion({ splitsX, splitsY, activeIndex: 0, autoSized: false });
  };

  return (
    <div className="pdb-region-nav">
      {/* 导航按钮 */}
      <div className="pdb-region-nav__controls">
        <Tooltip label="上一区块 [">
          <Button icon size="sm" variant="outline" aria-label="上一区块" onClick={() => step(-1)}>
            <PdbIcon name="chevronLeft" size={14} />
          </Button>
        </Tooltip>

        <span className="pdb-region-nav__label">
          <PdbIcon name="blocks" size={13} />
          <strong>{activeRegion?.label ?? 'A1'}</strong>
          <span className="pdb-region-nav__step">第 {activeIdx + 1}/{total} 块</span>
        </span>

        <Tooltip label="下一区块 ]">
          <Button icon size="sm" variant="outline" aria-label="下一区块" onClick={() => step(1)}>
            <PdbIcon name="chevronRight" size={14} />
          </Button>
        </Tooltip>
      </div>

      {/* 分块设置：横向 × 纵向各一套步进器（支持 1×2 / 2×1 等非对称分块） */}
      <div className="pdb-region-nav__splits" role="group" aria-label="分块设置">
        <span className="pdb-region-nav__split-axis">
          <span
            className="pdb-region-nav__split-axis-label"
            title={`横向切 ${region.splitsX} 列（屏幕宽度够就减少）`}
          >
            横 {region.splitsX}
          </span>
          <Button
            icon
            size="sm"
            variant="outline"
            aria-label="减少横向分块"
            disabled={region.splitsX <= 1}
            onClick={() => setSplits(region.splitsX - 1, region.splitsY)}
          >
            <PdbIcon name="minus" size={12} />
          </Button>
          <Button
            icon
            size="sm"
            variant="outline"
            aria-label="增加横向分块"
            disabled={region.splitsX >= MAX_SPLITS_PER_AXIS}
            onClick={() => setSplits(region.splitsX + 1, region.splitsY)}
          >
            <PdbIcon name="plus" size={12} />
          </Button>
        </span>
        <span className="pdb-region-nav__split-times" aria-hidden>×</span>
        <span className="pdb-region-nav__split-axis">
          <span
            className="pdb-region-nav__split-axis-label"
            title={`纵向切 ${region.splitsY} 行（屏幕高度够就减少）`}
          >
            纵 {region.splitsY}
          </span>
          <Button
            icon
            size="sm"
            variant="outline"
            aria-label="减少纵向分块"
            disabled={region.splitsY <= 1}
            onClick={() => setSplits(region.splitsX, region.splitsY - 1)}
          >
            <PdbIcon name="minus" size={12} />
          </Button>
          <Button
            icon
            size="sm"
            variant="outline"
            aria-label="增加纵向分块"
            disabled={region.splitsY >= MAX_SPLITS_PER_AXIS}
            onClick={() => setSplits(region.splitsX, region.splitsY + 1)}
          >
            <PdbIcon name="plus" size={12} />
          </Button>
        </span>
      </div>

      {/* 区块网格（点击跳转） */}
      {total > 1 && (
        <div
          className="pdb-region-nav__grid"
          style={{ gridTemplateColumns: `repeat(${region.splitsX}, 1fr)` }}
        >
          {regions.map((r, i) => (
            <button
              key={r.id}
              type="button"
              className={`pdb-region-nav__cell ${i === activeIdx ? 'is-active' : ''}`}
              onClick={() => setRegion({ activeIndex: i })}
              aria-label={`跳转到区块 ${r.label}`}
              title={`${r.label} (${r.cols}×${r.rows})`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
