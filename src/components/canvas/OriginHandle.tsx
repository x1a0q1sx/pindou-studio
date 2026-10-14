/**
 * OriginHandle.tsx —— 可拖拽十字光标，标定钉位(0,0)的物理落点。
 * 写入 calibration.originDevicePx；支持方向键微调（±1 设备像素，Shift 为 ±10）。
 *
 * 组件以 CSS px 定位（在画布容器内），内部换算为设备像素写入 store。
 */
import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { usePdbStore } from '@/store';
import { sanitizeCalibration } from '@/core/geometry';
import { getTheme } from '@/themes';
import '../board/board.css';

export interface OriginHandleProps {
  /** 画布容器的 CSS 尺寸（用于限制拖拽范围） */
  containerWidth: number;
  containerHeight: number;
  /** 当前 devicePixelRatio */
  dpr: number;
}

export function OriginHandle({ containerWidth, containerHeight, dpr }: OriginHandleProps) {
  const calibration = usePdbStore((s) => s.calibration);
  const setCalibration = usePdbStore((s) => s.setCalibration);
  const themeId = usePdbStore((s) => s.theme);
  const theme = getTheme(themeId);

  const safeCal = sanitizeCalibration(calibration);
  // originDevicePx → CSS px 用于定位
  const originCssX = safeCal.originDevicePx.x / dpr;
  const originCssY = safeCal.originDevicePx.y / dpr;

  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ dx: 0, dy: 0 });

  const updateOrigin = useCallback((cssX: number, cssY: number) => {
    const devX = Math.round(cssX * dpr);
    const devY = Math.round(cssY * dpr);
    const newCal = sanitizeCalibration({
      ...safeCal,
      originDevicePx: { x: devX, y: devY },
    });
    setCalibration(newCal);
  }, [dpr, safeCal, setCalibration]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败不视为错误 */
    }
    dragOffset.current = { dx: e.clientX - originCssX, dy: e.clientY - originCssY };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(containerWidth, e.clientX - dragOffset.current.dx));
    const y = Math.max(0, Math.min(containerHeight, e.clientY - dragOffset.current.dy));
    updateOrigin(x, y);
  };

  const onPointerUp = (): void => {
    setDragging(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case 'ArrowLeft': dx = -step; break;
      case 'ArrowRight': dx = step; break;
      case 'ArrowUp': dy = -step; break;
      case 'ArrowDown': dy = step; break;
      default: return;
    }
    e.preventDefault();
    const newDevX = Math.max(0, Math.min(containerWidth * dpr, safeCal.originDevicePx.x + dx));
    const newDevY = Math.max(0, Math.min(containerHeight * dpr, safeCal.originDevicePx.y + dy));
    const newCal = sanitizeCalibration({ ...safeCal, originDevicePx: { x: newDevX, y: newDevY } });
    setCalibration(newCal);
  };

  const strokeColor = theme.canvas.selectionStroke as string;

  return (
    <div
      className="pdb-origin-handle"
      style={{
        left: originCssX - 16,
        top: originCssY - 16,
        width: 32,
        height: 32,
      }}
      tabIndex={0}
      role="slider"
      aria-label="原点拖拽手柄"
      aria-valuenow={Math.round(originCssX)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {/* 十字光标 SVG */}
      <svg
        className="pdb-origin-handle__cross"
        width="28"
        height="28"
        viewBox="0 0 28 28"
        fill="none"
        aria-hidden
      >
        <circle cx="14" cy="14" r="8" stroke={strokeColor} strokeWidth="1.5" strokeDasharray="3 2" />
        <line x1="14" y1="2" x2="14" y2="26" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="2" y1="14" x2="26" y2="14" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="14" cy="14" r="2.5" fill={strokeColor} />
      </svg>
      <span className="pdb-origin-handle__label">
        ({safeCal.originDevicePx.x}, {safeCal.originDevicePx.y})
      </span>
    </div>
  );
}
