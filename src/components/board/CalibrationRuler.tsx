/**
 * CalibrationRuler.tsx —— 标尺带组件（横向 + 纵向），设备像素级精确绘制。
 *
 * 【精度铁律】格边界用 `round(origin + i * pitch)` 独立取整，
 * 禁止累加固定整数步长（会产生系统性漂移）。
 *
 * 在 Canvas 上绘制 N 格标尺带 + mm 刻度 + 数字标注，
 * 用户把透明板放上去对比，拖滑块调整 pitchMm 直到屏幕格距与物理钉距重合。
 */
import { useCallback, useEffect, useRef } from 'react';
import { usePdbStore } from '@/store';
import { getTheme } from '@/themes';
import { pitchToDevicePx } from '@/core/geometry';
import type { Calibration } from '@/core/types';
import './board.css';

export interface CalibrationRulerProps {
  /** 'horizontal' | 'vertical' */
  direction: 'horizontal' | 'vertical';
  /** 显示的格数（默认 20） */
  cells?: number;
  /** 校准参数（外部传入用于实时预览） */
  calibration: Calibration;
  /** CSS 像素长度（组件容器的可用长度） */
  lengthCss?: number;
}

/**
 * 标尺带 Canvas 组件：在设备像素域精确绘制格线。
 */
export function CalibrationRuler({
  direction,
  cells = 20,
  calibration,
  lengthCss,
}: CalibrationRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeId = usePdbStore((s) => s.theme);
  const theme = getTheme(themeId);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const pitch = pitchToDevicePx(calibration.pitchMm, calibration);
    const pitchPx = direction === 'horizontal' ? pitch.x : pitch.y;

    // 计算标尺总设备像素长度
    const totalDevPx = Math.ceil(cells * pitchPx);
    const totalCssPx = totalDevPx / dpr;

    // 设置 canvas 尺寸
    if (direction === 'horizontal') {
      const w = lengthCss ? Math.min(lengthCss, totalCssPx + 20) : totalCssPx + 20;
      canvas.style.width = `${w}px`;
      canvas.style.height = '44px';
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(44 * dpr);
    } else {
      const h = lengthCss ? Math.min(lengthCss, totalCssPx + 20) : totalCssPx + 20;
      canvas.style.width = '44px';
      canvas.style.height = `${h}px`;
      canvas.width = Math.round(44 * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 颜色来自主题 Canvas 令牌
    const gridColor = theme.canvas.gridLine as string;
    const majorColor = theme.canvas.gridLineMajor as string;
    const textColor = theme.canvas.rulerText as string;
    const bgColor = theme.canvas.rulerBg as string;

    // 背景
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const origin = direction === 'horizontal' ? 10 * dpr : 10 * dpr;
    const thickness = direction === 'horizontal' ? canvas.height : canvas.width;

    // 绘制格线：每格边界独立取整 round(origin + i * pitchPx)
    for (let i = 0; i <= cells; i++) {
      const pos = Math.round(origin + i * pitchPx);
      const isMajor = i % 5 === 0;

      ctx.beginPath();
      ctx.strokeStyle = isMajor ? majorColor : gridColor;
      ctx.lineWidth = isMajor ? 2 * dpr : 1 * dpr;

      if (direction === 'horizontal') {
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, thickness);
      } else {
        ctx.moveTo(0, pos);
        ctx.lineTo(thickness, pos);
      }
      ctx.stroke();

      // mm 刻度标注（每 5 格）
      if (isMajor && i > 0) {
        const mm = (i * calibration.pitchMm).toFixed(1);
        ctx.font = `${10 * dpr}px system-ui, sans-serif`;
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = direction === 'horizontal' ? 'top' : 'middle';

        if (direction === 'horizontal') {
          ctx.fillText(`${mm}`, pos, thickness - 14 * dpr);
          // 格号
          ctx.font = `bold ${9 * dpr}px system-ui, sans-serif`;
          ctx.fillText(`${i}`, pos, 2 * dpr);
        } else {
          ctx.save();
          ctx.translate(thickness - 14 * dpr, pos);
          ctx.fillText(`${mm}`, 0, 0);
          ctx.restore();
        }
      }
    }

    // 填充格内淡色（交替，方便数格）
    for (let i = 0; i < cells; i++) {
      if (i % 2 === 0) continue;
      const p0 = Math.round(origin + i * pitchPx);
      const p1 = Math.round(origin + (i + 1) * pitchPx);
      ctx.fillStyle = `${gridColor.replace(')', ', 0.3)').replace('rgb(', 'rgba(')}`;
      // 简化：用半透明 surface
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = majorColor;
      if (direction === 'horizontal') {
        ctx.fillRect(p0, 0, p1 - p0, thickness);
      } else {
        ctx.fillRect(0, p0, thickness, p1 - p0);
      }
      ctx.globalAlpha = 1;
    }
  }, [calibration, cells, direction, lengthCss, theme]);

  useEffect(() => {
    draw();
  }, [draw]);

  // 窗口 DPR 变化时重绘
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const handler = (): void => draw();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [draw]);

  return (
    <div className="pdb-cal-ruler">
      <span className="pdb-cal-ruler__label">
        {direction === 'horizontal' ? '横向' : '纵向'} · {cells} 格 · pitch {calibration.pitchMm.toFixed(4)} mm
      </span>
      <canvas ref={canvasRef} />
    </div>
  );
}
