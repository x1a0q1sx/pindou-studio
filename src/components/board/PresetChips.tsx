/**
 * PresetChips.tsx —— 预设一键切换芯片组。
 * 104×104 / 78×78 / 52×52 / 29×29(5mm) / 58×58(5mm) / 自定义。
 */
import { usePdbStore } from '@/store';
import { BOARD_PRESETS, matchPreset } from '@/core/presets';
import type { BoardPreset } from '@/core/presets';
import { PdbIcon } from '@/components/icons';
import './board.css';

export function PresetChips() {
  const board = usePdbStore((s) => s.board);
  const setBoardConfig = usePdbStore((s) => s.setBoardConfig);
  const activePreset = matchPreset(board);

  const applyPreset = (preset: BoardPreset): void => {
    setBoardConfig({
      cols: preset.cols,
      rows: preset.rows,
      pitchMm: preset.pitchMm,
      marginMm: preset.pitchMm < 4 ? 2.0 : 3.0,
    });
  };

  return (
    <div className="pdb-preset-chips" role="radiogroup" aria-label="板预设">
      {BOARD_PRESETS.map((preset) => {
        const isActive = activePreset?.id === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            className="pdb-preset-chip pdb-pressable"
            data-active={isActive}
            role="radio"
            aria-checked={isActive}
            title={preset.description}
            onClick={() => applyPreset(preset)}
          >
            <PdbIcon name="grid" size={12} />
            {preset.label}
            {preset.id === 'p104' && (
              <span className="pdb-preset-chip__badge">推荐</span>
            )}
          </button>
        );
      })}
      {!activePreset && (
        <span className="pdb-preset-chip" data-active style={{ cursor: 'default' }}>
          <PdbIcon name="pencil" size={12} />
          自定义 {board.cols}×{board.rows}
        </span>
      )}
    </div>
  );
}
