/**
 * DisplayPicker.tsx —— 列出所有显示器，显示名称/分辨率/缩放/物理尺寸/PPI/1:1可容纳格数/能否整板1:1显示。
 * isVirtual 或 physicalMm=null 的显示器置灰并告警「虚拟显示器，无法进行 1:1 物理校准」。
 */
import { useCallback, useEffect, useState } from 'react';
import { getBridge } from '@/io/bridge';
import { usePdbStore } from '@/store';
import { displayKey, fitsOnScreen, maxCellsAt1to1, sanitizeCalibration } from '@/core/geometry';
import { getCalibrationForKey } from '@/core/calibrationProfiles';
import type { DisplayMetrics } from '@/core/types';
import { PdbIcon } from '@/components/icons';
import './board.css';

export function DisplayPicker() {
  const [displays, setDisplays] = useState<DisplayMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const currentDisplay = usePdbStore((s) => s.display);
  const calibration = usePdbStore((s) => s.calibration);
  const board = usePdbStore((s) => s.board);
  const setDisplay = usePdbStore((s) => s.setDisplay);
  const setCalibration = usePdbStore((s) => s.setCalibration);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const bridge = getBridge();
      const list = await bridge.getDisplays();
      setDisplays(list);
    } catch (err) {
      console.warn('[DisplayPicker] 获取显示器列表失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSelect = (display: DisplayMetrics): void => {
    if (display.isVirtual) return;
    setDisplay(display);
    // 【#25/#54】切屏先查档位库：该屏有过手动校准（标尺/整板对位）就恢复精调档，
    // 不是一律用 WMI 自动值覆盖；随后按新屏容量重估分块（大屏整板放得下自动合回单块）。
    const saved = getCalibrationForKey(displayKey(display));
    if (saved) {
      setCalibration(sanitizeCalibration(saved));
    } else if (display.physicalMm && display.devicePx.width > 0) {
      const cal = sanitizeCalibration({
        pitchMm: calibration?.pitchMm ?? board.pitchMm,
        mmPerDevicePxX: display.physicalMm.width / display.devicePx.width,
        mmPerDevicePxY: display.physicalMm.height / display.devicePx.height,
        originDevicePx: { x: 0, y: 0 },
        source: 'auto-wmi',
        displayKey: `${display.id}|${display.devicePx.width}x${display.devicePx.height}|${display.devicePixelRatio}`,
        verifiedAt: new Date().toISOString(),
      });
      setCalibration(cal);
    }
    usePdbStore.getState().reconcileRegionWithDisplay();
  };

  if (loading) {
    return <p className="pdb-hint">正在检测显示器…</p>;
  }

  return (
    <div className="pdb-display-picker">
      {displays.map((d) => {
        const isActive = currentDisplay?.id === d.id;
        const isDisabled = d.isVirtual || !d.physicalMm;

        // 计算 1:1 可容纳格数
        let maxCells: { cols: number; rows: number } | null = null;
        let boardFits: { fits: boolean; overflowX: boolean; overflowY: boolean } | null = null;
        if (!isDisabled && calibration) {
          const cal = sanitizeCalibration({
            ...calibration,
            mmPerDevicePxX: d.physicalMm!.width / d.devicePx.width,
            mmPerDevicePxY: d.physicalMm!.height / d.devicePx.height,
          });
          maxCells = maxCellsAt1to1(cal, d.devicePx);
          const fitResult = fitsOnScreen(board, cal, d);
          boardFits = fitResult;
        }

        return (
          <div
            key={d.id}
            className={`pdb-display-card ${isDisabled ? 'is-disabled' : ''} ${isActive ? 'pdb-pressable' : ''}`}
            data-active={isActive}
            role="button"
            tabIndex={isDisabled ? -1 : 0}
            aria-disabled={isDisabled}
            onClick={() => handleSelect(d)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelect(d); }}
          >
            <div className="pdb-display-card__name">
              <PdbIcon name="monitor" size={14} />
              {d.label}
              {d.isPrimary && <span className="pdb-chip" style={{ fontSize: 10 }}>主屏</span>}
            </div>

            <div className="pdb-display-card__meta">
              {d.devicePx.width}×{d.devicePx.height} px
              {' · '}缩放 {(d.devicePixelRatio * 100).toFixed(0)}%
              {d.physicalMm && (
                <>
                  {' · '}物理 {(d.physicalMm.width / 10).toFixed(1)}×{(d.physicalMm.height / 10).toFixed(1)} cm
                </>
              )}
              {d.ppi && (
                <>
                  {' · '}PPI {d.ppi.x.toFixed(0)}×{d.ppi.y.toFixed(0)}
                </>
              )}
            </div>

            {maxCells && (
              <div className="pdb-display-card__meta">
                1:1 可容纳 <strong>{maxCells.cols}×{maxCells.rows}</strong> 格
              </div>
            )}

            {/* 物理尺寸匹配可信度低：提示用户复核（多屏/特殊比例屏下 WMI 按宽高比配对可能错位） */}
            {d.physicalMm && d.matchConfidence === 'low' && (
              <div className="pdb-display-card__meta" style={{ color: '#e8930c' }}>
                ⚠ 物理尺寸为自动匹配（宽高比差异较大），建议用「标尺/实测」校准复核
              </div>
            )}

            {boardFits && (
              <div className={`pdb-display-card__fits ${boardFits.fits ? 'pdb-display-card__fits--yes' : 'pdb-display-card__fits--no'}`}>
                <PdbIcon name={boardFits.fits ? 'success' : 'warning'} size={12} />
                {boardFits.fits
                  ? `✓ 可整板 1:1 显示 ${board.cols}×${board.rows}`
                  : `✗ 无法整板 1:1（${boardFits.overflowX ? '横向溢出 ' : ''}${boardFits.overflowY ? '纵向溢出' : ''}）`
                }
              </div>
            )}

            {isDisabled && (
              <div className="pdb-display-card__warning">
                <PdbIcon name="warning" size={12} />
                虚拟显示器，无法进行 1:1 物理校准
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
