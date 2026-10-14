/**
 * AlignGuide.tsx —— 四角 L 形对齐括标 + 中心十字 + 可选板边轮廓。
 * 帮助用户把透明板的角对准屏幕。
 * 括标颜色取自 getTheme(id).canvas.selectionStroke。
 */
import type { CSSProperties } from 'react';
import { usePdbStore } from '@/store';
import { getTheme } from '@/themes';
import { sanitizeCalibration, pitchToDevicePx } from '@/core/geometry';
import '../board/board.css';

export interface AlignGuideProps {
  /** 容器 CSS 宽度 */
  width: number;
  /** 容器 CSS 高度 */
  height: number;
  /** 是否显示板边轮廓 */
  showBoardOutline?: boolean;
}

export function AlignGuide({ width, height, showBoardOutline = true }: AlignGuideProps) {
  const themeId = usePdbStore((s) => s.theme);
  const calibration = usePdbStore((s) => s.calibration);
  const board = usePdbStore((s) => s.board);
  const theme = getTheme(themeId);

  const safeCal = sanitizeCalibration(calibration);
  const strokeColor = theme.canvas.selectionStroke as string;

  // 板在屏幕上的 CSS px 尺寸（用于板边轮廓）
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const pitch = pitchToDevicePx(board.pitchMm, safeCal);
  const boardW = (board.cols * pitch.x + 2 * (board.marginMm / safeCal.mmPerDevicePxX)) / dpr;
  const boardH = (board.rows * pitch.y + 2 * (board.marginMm / safeCal.mmPerDevicePxY)) / dpr;

  // 括标尺寸
  const armLen = 20;
  const armWidth = 2.5;

  // 板边轮廓位置（居中于容器，从 origin 开始）
  const originCssX = safeCal.originDevicePx.x / dpr;
  const originCssY = safeCal.originDevicePx.y / dpr;

  const cornerStyle = (pos: 'tl' | 'tr' | 'bl' | 'br'): CSSProperties => {
    switch (pos) {
      case 'tl': return { position: 'absolute', top: 0, left: 0 };
      case 'tr': return { position: 'absolute', top: 0, right: 0 };
      case 'bl': return { position: 'absolute', bottom: 0, left: 0 };
      case 'br': return { position: 'absolute', bottom: 0, right: 0 };
    }
  };

  return (
    <div className="pdb-align-guide" style={{ width, height }} aria-hidden>
      {/* 四角 L 形括标 */}
      {(['tl', 'tr', 'bl', 'br'] as const).map((pos) => (
        <svg
          key={pos}
          className={`pdb-align-guide__corner pdb-align-guide__corner--${pos}`}
          style={cornerStyle(pos)}
          width={armLen}
          height={armLen}
          viewBox={`0 0 ${armLen} ${armLen}`}
          fill="none"
        >
          <CornerPath pos={pos} armLen={armLen} armWidth={armWidth} color={strokeColor} />
        </svg>
      ))}

      {/* 中心十字 */}
      <svg
        className="pdb-align-guide__center"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
      >
        <line x1="12" y1="4" x2="12" y2="20" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="4" y1="12" x2="20" y2="12" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" />
      </svg>

      {/* 板边轮廓 */}
      {showBoardOutline && boardW > 0 && boardH > 0 && (
        <div
          style={{
            position: 'absolute',
            left: originCssX - (board.marginMm / safeCal.mmPerDevicePxX) / dpr,
            top: originCssY - (board.marginMm / safeCal.mmPerDevicePxY) / dpr,
            width: boardW,
            height: boardH,
            border: `1.5px dashed ${strokeColor}`,
            borderRadius: 4,
            pointerEvents: 'none',
            opacity: 0.6,
          }}
        />
      )}
    </div>
  );
}

function CornerPath({
  pos,
  armLen,
  armWidth,
  color,
}: {
  pos: 'tl' | 'tr' | 'bl' | 'br';
  armLen: number;
  armWidth: number;
  color: string;
}) {
  const l = armLen;
  const w = armWidth;
  switch (pos) {
    case 'tl':
      return (
        <>
          <line x1={w / 2} y1={w / 2} x2={l} y2={w / 2} stroke={color} strokeWidth={w} strokeLinecap="round" />
          <line x1={w / 2} y1={w / 2} x2={w / 2} y2={l} stroke={color} strokeWidth={w} strokeLinecap="round" />
        </>
      );
    case 'tr':
      return (
        <>
          <line x1={l - w / 2} y1={w / 2} x2={0} y2={w / 2} stroke={color} strokeWidth={w} strokeLinecap="round" />
          <line x1={l - w / 2} y1={w / 2} x2={l - w / 2} y2={l} stroke={color} strokeWidth={w} strokeLinecap="round" />
        </>
      );
    case 'bl':
      return (
        <>
          <line x1={w / 2} y1={l - w / 2} x2={l} y2={l - w / 2} stroke={color} strokeWidth={w} strokeLinecap="round" />
          <line x1={w / 2} y1={l - w / 2} x2={w / 2} y2={0} stroke={color} strokeWidth={w} strokeLinecap="round" />
        </>
      );
    case 'br':
      return (
        <>
          <line x1={l - w / 2} y1={l - w / 2} x2={0} y2={l - w / 2} stroke={color} strokeWidth={w} strokeLinecap="round" />
          <line x1={l - w / 2} y1={l - w / 2} x2={l - w / 2} y2={0} stroke={color} strokeWidth={w} strokeLinecap="round" />
        </>
      );
  }
}
