/**
 * src/components/tools/ReplaceColorDialog.tsx —— 「同色替换」工具的自选 from/to 对话框。
 *
 * 为什么要它：`replaceColor` 工具点击画布时默认 from=点击格当前色、to=当前色，覆盖了 90% 场景；
 * 但「把 A 色整批换成 B 色，而当前色不是 B」这种批量整理必须能自选两端，故补这个轻量对话框。
 *
 * 【边界】刻意**不修改** `src/components/palette/**`（ColorSwatchList 属于 / 的资产），
 *   这里自建一个只读的小色卡网格；复用 `ui/Modal` + `ui/Button` + CSS 令牌，不写死任何颜色值。
 *
 * 打开方式（沿用既有 `pdb:open-import` 的 CustomEvent 解耦模式）：
 *   `window.dispatchEvent(new CustomEvent('pdb:open-replace-color', { detail: { from?: number } }))`
 *   或直接 `import { openReplaceColorDialog } from '@/hooks/usePointerPaint'`。
 */
import { useEffect, useMemo, useState } from 'react';
import { usePdbStore } from '@/store';
import { countValues } from '@/core/editOps';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { applyReplaceColor, closeReplaceColorDialog, usePaintUi } from '@/hooks/usePointerPaint';

interface SwatchGridProps {
  title: string;
  hint: string;
  value: number;
  allowEmpty: boolean;
  onChange: (v: number) => void;
}

function SwatchGrid({ title, hint, value, allowEmpty, onChange }: SwatchGridProps) {
  const palette = usePdbStore((s) => s.palette);
  return (
    <div className="pdb-replace__col">
      <div className="pdb-replace__col-head">
        <strong>{title}</strong>
        <span className="pdb-hint">{hint}</span>
      </div>
      <div className="pdb-replace__grid" role="radiogroup" aria-label={title}>
        {allowEmpty && (
          <button
            type="button"
            role="radio"
            aria-checked={value === 0}
            className={`pdb-replace__swatch pdb-replace__swatch--empty pdb-pressable ${value === 0 ? 'is-active' : ''}`}
            title="空格（擦除该色）"
            aria-label="空格（擦除该色）"
            onClick={() => onChange(0)}
          >
            <PdbIcon name="trash" size={13} />
          </button>
        )}
        {palette.colors.map((c, i) => {
          const v = i + 1;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={value === v}
              className={`pdb-replace__swatch pdb-pressable pdb-lift ${value === v ? 'is-active' : ''}`}
              style={{ background: c.hex }}
              title={`${c.code} ${c.nameZh ?? c.name}`}
              aria-label={`${c.code} ${c.nameZh ?? c.name}`}
              onClick={() => onChange(v)}
            />
          );
        })}
      </div>
    </div>
  );
}

export function ReplaceColorDialog() {
  const { replaceOpen, replaceFrom } = usePaintUi();
  const palette = usePdbStore((s) => s.palette);
  const beads = usePdbStore((s) => s.beads);
  const beadsVersion = usePdbStore((s) => s.beadsVersion);

  const [from, setFrom] = useState(-1);
  const [to, setTo] = useState(0);

  // 每次打开时用「当前悬停格的颜色」预选 from，用「当前色」预选 to
  useEffect(() => {
    if (!replaceOpen) return;
    setFrom(replaceFrom >= 0 ? replaceFrom : -1);
    setTo(usePdbStore.getState().activeColorIndex + 1);
  }, [replaceOpen, replaceFrom]);

  /** 各色的用量（beadsVersion 变化即自动重算；selectors 的缓存 key 也含版本号） */
  const usage = useMemo(() => countValues(beads), [beads, beadsVersion]);

  const fromCount = from >= 0 ? (usage.get(from) ?? 0) : 0;
  const toCount = to >= 0 ? (usage.get(to) ?? 0) : 0;
  const canApply = from >= 0 && to >= 0 && from !== to && fromCount > 0;

  const label = (v: number): string => {
    if (v === 0) return '空格';
    const c = palette.colors[v - 1];
    return c ? `${c.code} ${c.nameZh ?? c.name}` : `未知色号(${v})`;
  };

  const onApply = (): void => {
    if (!canApply) return;
    const changed = applyReplaceColor(from, to);
    if (changed > 0) closeReplaceColorDialog();
  };

  return (
    <Modal
      open={replaceOpen}
      title="同色替换（全图）"
      onClose={closeReplaceColorDialog}
      footer={
        <div className="pdb-replace__foot">
          <Button variant="ghost" onClick={closeReplaceColorDialog}>
            取消
          </Button>
          <Button variant="primary" disabled={!canApply} onClick={onApply}>
            <PdbIcon name="replaceColor" size={15} />
            替换{fromCount > 0 ? ` ${fromCount} 格` : ''}
          </Button>
        </div>
      }
    >
      <div className="pdb-replace">
        <p className="pdb-hint pdb-replace__lead">
          把图案里所有「源色」格子一次性换成「目标色」，作为<strong>一条</strong>可撤销的历史记录。
          直接在画布上用同色替换工具（R）点击，则以点击格的颜色为源色、当前色为目标色。
        </p>
        <div className="pdb-replace__cols">
          <SwatchGrid
            title="源色"
            hint={from >= 0 ? `当前用量 ${fromCount} 格` : '请先选择源色'}
            value={from}
            allowEmpty
            onChange={setFrom}
          />
          <div className="pdb-replace__arrow" aria-hidden>
            <PdbIcon name="chevronRight" size={18} />
          </div>
          <SwatchGrid
            title="目标色"
            hint={to >= 0 ? `现有 ${toCount} 格` : '请选择目标色'}
            value={to}
            allowEmpty
            onChange={setTo}
          />
        </div>
        <div className="pdb-replace__summary" aria-live="polite">
          {from < 0 || to < 0 ? (
            <span className="pdb-hint">尚未选择源色或目标色</span>
          ) : from === to ? (
            <span className="pdb-hint">源色与目标色相同，无需替换</span>
          ) : (
            <>
              <span className="pdb-chip">{label(from)}</span>
              <PdbIcon name="chevronRight" size={12} />
              <span className="pdb-chip pdb-chip--active">{label(to)}</span>
              <span className="pdb-hint">
                {fromCount > 0 ? `影响 ${fromCount} 格` : '图案里没有源色的格子'}
              </span>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
