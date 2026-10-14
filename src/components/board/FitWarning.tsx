/**
 * FitWarning.tsx —— 「屏幕放不下整板」的判定与处置 UI。
 *
 * 本机实况：104×104 板物理 28.4cm，而屏幕可视区仅 33.0×21.0cm，
 * 纵向 1:1 最多 78 格 → 整板放不下，分区拼豆是刚需而非可选项。
 *
 * 本组件职责：
 * 1. 用 fitsOnScreen() 判定，把结论翻译成用户一眼看懂的自然语言（含 cm 与格数）
 * 2. 用 autoSuggestSplits() 算出建议分区，并**自动写入 store 的 region.splitsX/splitsY**
 * 3. 提供两个互斥选择：「采用分区方案」/「仍然整板显示（超出屏幕，需滚动平移）」
 *
 * 注意：完整分区算法（Region 切块、逐块导航）属于 core/region.ts 的完整分区逻辑，
 * 这里只产出 splitsX/splitsY 建议值，此处不重复实现 region.ts。
 */
import { useEffect, useMemo, useState } from 'react';
import { usePdbStore } from '@/store';
import {
  autoSuggestSplits,
  boardPhysicalSizeMm,
  fitsOnScreen,
  sanitizeCalibration,
} from '@/core/geometry';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import './board.css';

export interface FitWarningProps {
  /** 紧凑模式：只显示一行结论，不展示两个选择按钮（用于窄栏） */
  compact?: boolean;
}

/** 用户对本屏 + 本板尺寸的显式处置选择 */
type FitChoice = 'split' | 'whole';

export function FitWarning({ compact = false }: FitWarningProps) {
  const board = usePdbStore((s) => s.board);
  const display = usePdbStore((s) => s.display);
  const calibration = usePdbStore((s) => s.calibration);
  const region = usePdbStore((s) => s.region);
  const setRegion = usePdbStore((s) => s.setRegion);
  const pushToast = usePdbStore((s) => s.pushToast);

  const cal = sanitizeCalibration(calibration);
  const [choice, setChoice] = useState<FitChoice | null>(null);

  // 显示器还没探测到时不渲染（避免闪现错误结论）
  const fit = useMemo(
    () => (display ? fitsOnScreen(board, cal, display) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [display, board.cols, board.rows, board.pitchMm, board.marginMm, cal.mmPerDevicePxX, cal.mmPerDevicePxY],
  );

  const suggestion = useMemo(
    () => (fit && !fit.fits ? autoSuggestSplits(board.cols, board.rows, fit.colsMax, fit.rowsMax) : null),
    [fit, board.cols, board.rows],
  );

  // 「板 + 屏」组合变化时重置用户选择，回到自动建议态
  const signature = display
    ? `${board.cols}x${board.rows}|${board.pitchMm}|${display.id}|${display.devicePx.width}x${display.devicePx.height}`
    : '';
  useEffect(() => {
    setChoice(null);
  }, [signature]);

  // 【契约要求】放不下时自动把建议分区写入 store（用户尚未显式选「整板显示」前）
  useEffect(() => {
    if (!fit || fit.fits || !suggestion) return;
    if (choice === 'whole') return;
    if (region.splitsX === suggestion.splitsX && region.splitsY === suggestion.splitsY) return;
    setRegion({ splitsX: suggestion.splitsX, splitsY: suggestion.splitsY, blockCols: suggestion.blockCols, blockRows: suggestion.blockRows, activeIndex: 0, autoSized: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit?.fits, suggestion?.splitsX, suggestion?.splitsY, choice]);

  if (!display || !fit) return null;

  /* ---------- 放得下：给一个安静的正向确认 ---------- */
  if (fit.fits) {
    return (
      <div className="pdb-fit-warning pdb-fit-warning--ok" role="status">
        <span className="pdb-fit-warning__title">
          <PdbIcon name="success" size={13} /> 本屏可 1:1 完整显示整板
        </span>
        {!compact && (
          <span className="pdb-fit-warning__body">
            {board.cols}×{board.rows} 格 ≤ 本屏 1:1 上限 {fit.colsMax}×{fit.rowsMax} 格，无需分区。
          </span>
        )}
      </div>
    );
  }

  /* ---------- 放不下：把数字翻译成人话 ---------- */
  const boardMm = boardPhysicalSizeMm(board);
  const boardCmW = boardMm.width / 10;
  const boardCmH = boardMm.height / 10;

  // 屏幕可视物理尺寸（浏览器降级时 physicalMm 为 null，退化为纯格数表述）
  const screenCmW = display.physicalMm ? display.physicalMm.width / 10 : null;
  const screenCmH = display.physicalMm ? display.physicalMm.height / 10 : null;

  const overflowDesc = (): string => {
    const parts: string[] = [];
    if (fit.overflowY && screenCmH !== null) {
      parts.push(`板高 ${boardCmH.toFixed(1)}cm 大于本屏可视高 ${screenCmH.toFixed(1)}cm`);
    }
    if (fit.overflowX && screenCmW !== null) {
      parts.push(`板宽 ${boardCmW.toFixed(1)}cm 大于本屏可视宽 ${screenCmW.toFixed(1)}cm`);
    }
    if (parts.length === 0) {
      parts.push(`板 ${board.cols}×${board.rows} 格超出本屏 1:1 可视区`);
    }
    return parts.join('，');
  };

  const adoptSplit = (): void => {
    if (!suggestion) return;
    setRegion({ splitsX: suggestion.splitsX, splitsY: suggestion.splitsY, blockCols: suggestion.blockCols, blockRows: suggestion.blockRows, activeIndex: 0, autoSized: true });
    setChoice('split');
    pushToast(
      'success',
      `已采用分区方案 ${suggestion.splitsX}×${suggestion.splitsY}（每块 ${suggestion.regionCols}×${suggestion.regionRows} 格）`,
    );
  };

  const keepWhole = (): void => {
    // 用户显式选择「整板显示」：标记手动（autoSized:false）——本屏放得下时永远保持单块；
    // 若之后的屏放不下，进拼豆仍会被动扩块（格子绝不缩小，与原行为一致）
    setRegion({ splitsX: 1, splitsY: 1, blockCols: undefined, blockRows: undefined, activeIndex: 0, autoSized: false });
    setChoice('whole');
    pushToast(
      'warning',
      '已切换为整板显示：1:1 下会超出屏幕，需用平移工具（或方向键）滚动查看',
      5000,
    );
  };

  const totalBlocks = suggestion ? suggestion.splitsX * suggestion.splitsY : 1;

  return (
    <div className="pdb-fit-warning" role="alert">
      <span className="pdb-fit-warning__title">
        <PdbIcon name="warning" size={13} /> 整板放不下本屏（1:1 模式）
      </span>

      <span className="pdb-fit-warning__body">
        {overflowDesc()}，1:1 模式最多显示 <strong>{fit.colsMax}×{fit.rowsMax}</strong> 格。
      </span>

      {suggestion && (
        <dl className="pdb-cal-info-grid pdb-fit-warning__suggest">
          <dt>建议分区</dt>
          <dd>
            {suggestion.splitsX}×{suggestion.splitsY} = {totalBlocks} 块
          </dd>
          <dt>每块格数</dt>
          <dd>
            {suggestion.regionCols}×{suggestion.regionRows}
          </dd>
          <dt>每块物理</dt>
          <dd>
            {((suggestion.regionCols * board.pitchMm) / 10).toFixed(1)}×
            {((suggestion.regionRows * board.pitchMm) / 10).toFixed(1)} cm
          </dd>
          <dt>当前生效</dt>
          <dd>
            {region.splitsX}×{region.splitsY}
            {choice === 'whole' && <span className="pdb-fit-warning__tag">整板</span>}
            {choice === 'split' && <span className="pdb-fit-warning__tag pdb-fit-warning__tag--ok">分区</span>}
          </dd>
        </dl>
      )}

      {!compact && (
        <div className="pdb-fit-warning__actions">
          <Button size="sm" variant="primary" onClick={adoptSplit} disabled={!suggestion}>
            <PdbIcon name="blocks" size={13} />
            采用分区方案{suggestion ? ` ${suggestion.splitsX}×${suggestion.splitsY}` : ''}
          </Button>
          <Button size="sm" variant="outline" onClick={keepWhole}>
            <PdbIcon name="drag" size={13} /> 仍然整板显示
          </Button>
        </div>
      )}

      {!compact && choice === 'whole' && (
        <span className="pdb-fit-warning__body" style={{ color: 'var(--warning)' }}>
          <PdbIcon name="info" size={11} /> 整板 1:1 会超出屏幕边界，请切换到「平移」工具拖动查看；
          拼豆时建议改用分区方案，逐块对照更不易错位。
        </span>
      )}
    </div>
  );
}
