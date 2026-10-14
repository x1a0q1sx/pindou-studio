/**
 * src/components/canvas/RulerOverlay.tsx —— 画布上方与左侧的 mm + 格号双刻度标尺。
 * 随缩放平移同步；1:1 模式下刻度反映真实物理毫米。
 */
import { useCallback, useEffect, useRef } from 'react';
import { usePdbStore } from '@/store';
import { getTheme } from '@/themes';
import { sanitizeCalibration, pitchToDevicePx } from '@/core/geometry';
import { getActiveRegionOffset } from '@/core/region';
import './canvas.css';

const RULER_W = 28; // CSS px 标尺宽度

export interface RulerOverlayProps {
  /** 画布容器 CSS 宽 */
  width: number;
  /** 画布容器 CSS 高 */
  height: number;
  /** 视图通道（dual 右画布用 viewB）：标尺跟随该画布自己的缩放平移 */
  viewKey?: 'view' | 'viewB';
  /** 数据通道（B 画布标尺读 boardB/regionB） */
  dataKey?: 'A' | 'B';
}

export function RulerOverlay({ width, height, viewKey = 'view', dataKey = 'A' }: RulerOverlayProps) {
  const topRef = useRef<HTMLCanvasElement>(null);
  const leftRef = useRef<HTMLCanvasElement>(null);

  const board = usePdbStore((s) => (dataKey === 'B' ? s.boardB : s.board));
  const themeId = usePdbStore((s) => s.theme);
  const calibration = usePdbStore((s) => s.calibration);
  const view = usePdbStore((s) => (viewKey === 'viewB' ? s.viewB : s.view));
  const mode = usePdbStore((s) => s.mode);
  const region = usePdbStore((s) => (dataKey === 'B' ? s.regionB : s.region));
  const beadsVersion = usePdbStore((s) => (dataKey === 'B' ? s.beadsBVersion : s.beadsVersion));

  const draw = useCallback(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cal = sanitizeCalibration(calibration);
    const tokens = getTheme(themeId).canvas;
    const scale = mode === 'placement' ? 1.0 : view.scale;
    const pitch = pitchToDevicePx(board.pitchMm, cal);
    const pitchCssX = (pitch.x * scale) / dpr;
    const pitchCssY = (pitch.y * scale) / dpr;

    // 设计模式显示整板（编号绝对值）；拼豆模式按活动区块偏移。
    // B 通道不受拼豆模式约束：regionB 就是它的分页开关（对照浏览用）。
    const regionOff = (dataKey === 'B' || mode === 'placement')
      ? getActiveRegionOffset(board.cols, board.rows, region.splitsX, region.splitsY, region.activeIndex, region.blockCols, region.blockRows)
      : null;
    const baseCol = regionOff ? regionOff.col0 : 0;
    const baseRow = regionOff ? regionOff.row0 : 0;
    const visCols = regionOff ? regionOff.cols : board.cols;
    const visRows = regionOff ? regionOff.rows : board.rows;

    const originCssX = cal.originDevicePx.x / dpr + view.offsetX;
    const originCssY = cal.originDevicePx.y / dpr + view.offsetY;
    const fontSize = Math.max(8, Math.min(10, pitchCssX * 0.5));

    // --- 顶部标尺 ---
    const topCanvas = topRef.current;
    if (topCanvas) {
      topCanvas.width = Math.round(width * dpr);
      topCanvas.height = Math.round(RULER_W * dpr);
      topCanvas.style.width = `${width}px`;
      topCanvas.style.height = `${RULER_W}px`;
      const ctx = topCanvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = tokens.rulerBg;
      ctx.fillRect(0, 0, width, RULER_W);

      // 刻度
      ctx.strokeStyle = tokens.gridLineMajor;
      ctx.fillStyle = tokens.rulerText;
      ctx.lineWidth = 1;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = `${fontSize}px sans-serif`;

      const numberEvery = board.numberEvery || 10;
      for (let c = 0; c <= visCols; c++) {
        const x = originCssX + c * pitchCssX;
        if (x < 0 || x > width) continue;
        const isMajor = c % numberEvery === 0;
        const tickH = isMajor ? RULER_W * 0.5 : RULER_W * 0.3;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_W);
        ctx.lineTo(Math.round(x) + 0.5, RULER_W - tickH);
        ctx.stroke();

        if (isMajor && c < visCols) {
          const labelX = x + pitchCssX * numberEvery / 2;
          if (labelX > 0 && labelX < width) {
            // 格号 + mm
            const mm = ((baseCol + c) * board.pitchMm).toFixed(0);
            ctx.fillText(`${baseCol + c}`, labelX, RULER_W - tickH - 2);
            if (pitchCssX * numberEvery > 40) {
              ctx.font = `${fontSize - 1}px sans-serif`;
              ctx.fillText(`${mm}mm`, labelX, RULER_W - 2);
              ctx.font = `${fontSize}px sans-serif`;
            }
          }
        }
      }

      // 底线
      ctx.strokeStyle = tokens.gridLineMajor;
      ctx.beginPath();
      ctx.moveTo(0, RULER_W - 0.5);
      ctx.lineTo(width, RULER_W - 0.5);
      ctx.stroke();
    }

    // --- 左侧标尺 ---
    const leftCanvas = leftRef.current;
    if (leftCanvas) {
      leftCanvas.width = Math.round(RULER_W * dpr);
      leftCanvas.height = Math.round(height * dpr);
      leftCanvas.style.width = `${RULER_W}px`;
      leftCanvas.style.height = `${height}px`;
      const ctx = leftCanvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = tokens.rulerBg;
      ctx.fillRect(0, 0, RULER_W, height);

      ctx.strokeStyle = tokens.gridLineMajor;
      ctx.fillStyle = tokens.rulerText;
      ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = `${fontSize}px sans-serif`;

      const numberEvery = board.numberEvery || 10;
      for (let r = 0; r <= visRows; r++) {
        const y = originCssY + r * pitchCssY;
        if (y < 0 || y > height) continue;
        const isMajor = r % numberEvery === 0;
        const tickW = isMajor ? RULER_W * 0.5 : RULER_W * 0.3;
        ctx.beginPath();
        ctx.moveTo(RULER_W, Math.round(y) + 0.5);
        ctx.lineTo(RULER_W - tickW, Math.round(y) + 0.5);
        ctx.stroke();

        if (isMajor && r < visRows) {
          const labelY = y + pitchCssY * numberEvery / 2;
          if (labelY > 0 && labelY < height) {
            ctx.save();
            ctx.translate(RULER_W - tickW - 3, labelY);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillText(`${baseRow + r}`, 0, 0);
            ctx.restore();
          }
        }
      }

      // 右边线
      ctx.strokeStyle = tokens.gridLineMajor;
      ctx.beginPath();
      ctx.moveTo(RULER_W - 0.5, 0);
      ctx.lineTo(RULER_W - 0.5, height);
      ctx.stroke();
    }
  }, [board, themeId, calibration, view, mode, region, width, height, beadsVersion]);

  useEffect(() => { draw(); }, [draw]);

  if (!board.showRuler) return null;

  return (
    <div className="pdb-ruler-overlay" aria-hidden>
      {/* 左上角方块 */}
      <div className="pdb-ruler-overlay__corner" style={{ width: RULER_W, height: RULER_W }} />
      {/* 顶部 */}
      <canvas
        ref={topRef}
        className="pdb-ruler-overlay__top"
        style={{ left: RULER_W, top: 0 }}
      />
      {/* 左侧 */}
      <canvas
        ref={leftRef}
        className="pdb-ruler-overlay__left"
        style={{ left: 0, top: RULER_W }}
      />
    </div>
  );
}
