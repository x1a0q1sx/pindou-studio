/**
 * src/core/presets.ts —— 预设清单。
 *
 * 市售拼豆板规格（已联网核实）：
 *   104 钉 = 28×28cm 有效区，pitch = 280/104 ≈ 2.6923mm
 *   78 钉 = 21×21cm，pitch = 210/78 ≈ 2.6923mm
 *   52 钉 = 14×14cm，pitch = 140/52 ≈ 2.6923mm
 *   29 钉 = 14.5×14.5cm，pitch = 5mm（5mm 大豆系列）
 *   58 钉 = 29×29cm，pitch = 5mm
 *
 * 每个预设含完整 BoardConfig 必要字段 + 元信息。
 */
import type { BoardConfig } from './types';

export interface BoardPreset {
  id: string;
  label: string;
  cols: number;
  rows: number;
  pitchMm: number;
  /** 整板有效区尺寸 mm（cols × pitchMm） */
  boardSizeMm: number;
  /** 豆点直径 mm（≈ pitchMm × 0.90） */
  beadSizeMm: number;
  description: string;
}

export const BOARD_PRESETS: BoardPreset[] = [
  {
    id: 'p104',
    label: '104×104',
    cols: 104,
    rows: 104,
    pitchMm: 2.6923,
    boardSizeMm: 280,
    beadSizeMm: 2.6,
    description: '推荐·你的板（28×28cm 透明板）',
  },
  {
    id: 'p78',
    label: '78×78',
    cols: 78,
    rows: 78,
    pitchMm: 2.6923,
    boardSizeMm: 210,
    beadSizeMm: 2.6,
    description: '21×21cm 中号板',
  },
  {
    id: 'p52',
    label: '52×52',
    cols: 52,
    rows: 52,
    pitchMm: 2.6923,
    boardSizeMm: 140,
    beadSizeMm: 2.6,
    description: '14×14cm 小号板',
  },
  {
    id: 'p29',
    label: '29×29',
    cols: 29,
    rows: 29,
    pitchMm: 5,
    boardSizeMm: 145,
    beadSizeMm: 5,
    description: '5mm 大豆·14.5cm 板',
  },
  {
    id: 'p58',
    label: '58×58',
    cols: 58,
    rows: 58,
    pitchMm: 5,
    boardSizeMm: 290,
    beadSizeMm: 5,
    description: '5mm 大豆·29cm 板',
  },
];

/** 默认预设 ID */
export const DEFAULT_PRESET_ID = 'p104';

/**
 * 从预设生成 BoardConfig（保留当前 show* 开关设置，仅改 cols/rows/pitchMm）。
 */
export function presetToBoardConfig(
  preset: BoardPreset,
  current?: Partial<BoardConfig>,
): Partial<BoardConfig> {
  const base: Partial<BoardConfig> = {
    ...current,
    // 预设值始终覆盖
    cols: preset.cols,
    rows: preset.rows,
    pitchMm: preset.pitchMm,
    // marginMm 按板规格比例：2.6923mm 板默认 2mm，5mm 板默认 3mm
    marginMm: preset.pitchMm < 4 ? 2.0 : 3.0,
  };
  return base;
}

/**
 * 根据当前 board 参数匹配最接近的预设（用于 PresetChips 高亮）。
 * 若无匹配返回 null（自定义）。
 */
export function matchPreset(board: Pick<BoardConfig, 'cols' | 'rows' | 'pitchMm'>): BoardPreset | null {
  return (
    BOARD_PRESETS.find(
      (p) => p.cols === board.cols && p.rows === board.rows && Math.abs(p.pitchMm - board.pitchMm) < 0.001,
    ) ?? null
  );
}
