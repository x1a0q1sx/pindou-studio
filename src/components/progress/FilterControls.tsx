/**
 * progress/FilterControls.tsx —— 按色筛选档位控件（含「发光板」档）。
 *
 * FilterMode 语义（渲染由 render/renderer.ts 的 L2 层实现）：
 *   off   正常显示全部豆点
 *   panel 发光板：只亮「当前色 ∩ 未拼」的格，已拼熄灭、其他色纯黑（拼豆模式默认档）
 *   only  只显示当前筛选色，其余格子画极淡轮廓
 *   dim   当前筛选色高亮发光，其余压暗 65%
 *   hide  当前筛选色以外完全隐藏（已拼格仍显示）
 *
 * 数据源：store.filterMode / store.filterColorIndex（契约字段，只读消费 + setFilter/setFilterMode 写入）。
 */
import { usePdbStore } from '@/store';
import { Segmented } from '@/components/ui/Segmented';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import type { FilterMode } from '@/core/types';
import './progress.css';

const MODE_OPTIONS: { value: FilterMode; label: string; title: string }[] = [
  { value: 'off', label: '正常', title: '正常显示全部豆点' },
  { value: 'panel', label: '发光板', title: '只亮当前色的**未拼**格，已拼熄灭、其他色纯黑 —— 与真实发光底板一致' },
  { value: 'only', label: '仅本色', title: '只显示当前色，其余画极淡轮廓' },
  { value: 'dim', label: '压暗', title: '当前色高亮发光，其余压暗 65%' },
  { value: 'hide', label: '隐藏', title: '当前色以外完全隐藏（已拼格仍显示），最省杂光' },
];

export function FilterControls() {
  const filterMode = usePdbStore((s) => s.filterMode);
  const filterColorIndex = usePdbStore((s) => s.filterColorIndex);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  const palette = usePdbStore((s) => s.palette);
  const setFilter = usePdbStore((s) => s.setFilter);
  const setFilterMode = usePdbStore((s) => s.setFilterMode);

  const filterColor = filterColorIndex >= 0 ? palette.colors[filterColorIndex] ?? null : null;
  const activeColor = palette.colors[activeColorIndex] ?? null;
  const filtering = filterMode !== 'off' && filterColor !== null;

  /** 选中某档：若尚未选定筛选色，则默认取当前色 */
  const chooseMode = (mode: FilterMode): void => {
    if (mode === 'off') {
      setFilterMode('off');
      return;
    }
    const idx = filterColorIndex >= 0 ? filterColorIndex : activeColorIndex;
    setFilter(idx, mode);
  };

  /** 把当前色设为筛选色（保持当前档位；off 时自动切到 only） */
  const filterActiveColor = (): void => {
    if (!activeColor) return;
    setFilter(activeColorIndex, filterMode === 'off' ? 'only' : filterMode);
  };

  return (
    <section className="pdb-filter" aria-label="按色筛选">
      <header className="pdb-filter__head">
        <span className="pdb-label">
          <PdbIcon name="search" size={13} />
          按色筛选
        </span>
        <span
          className="pdb-filter__swatch"
          style={{ background: filterColor ? filterColor.hex : 'transparent' }}
          data-empty={filterColor ? undefined : 'true'}
          aria-hidden
        />
        <span className="pdb-filter__colorname">
          {filterColor ? `${filterColor.code} ${filterColor.nameZh ?? filterColor.name}` : '未选定筛选色'}
        </span>
      </header>

      <Segmented<FilterMode>
        ariaLabel="筛选模式"
        options={MODE_OPTIONS}
        value={filterMode}
        onChange={chooseMode}
      />

      <div className="pdb-filter__actions">
        <Button size="sm" variant="outline" onClick={filterActiveColor} disabled={!activeColor}>
          <PdbIcon name="color" size={13} />
          筛选当前色
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setFilterMode('off')} disabled={!filtering}>
          <PdbIcon name="close" size={13} />
          清除筛选
        </Button>
      </div>

      <p className="pdb-hint">
        提示：在下方逐色进度列表点击任意颜色，即可把它设为筛选色并联动高亮。
      </p>
    </section>
  );
}
