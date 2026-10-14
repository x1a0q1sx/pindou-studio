/**
 * src/components/canvas/MiniMap.tsx —— 完整板缩略图。
 * 用低分辨率离屏 canvas 画色块，叠加当前视口/区块高亮框，点击可跳转。
 */
import { useCallback, useEffect, useRef } from 'react';
import { usePdbStore } from '@/store';
import { getTheme } from '@/themes';
import { buildRegions } from '@/core/region';
import './canvas.css';

const MINIMAP_SIZE = 140; // CSS px

export function MiniMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const board = usePdbStore((s) => s.board);
  const beads = usePdbStore((s) => s.beads);
  const beadsVersion = usePdbStore((s) => s.beadsVersion);
  const palette = usePdbStore((s) => s.palette);
  const themeId = usePdbStore((s) => s.theme);
  const region = usePdbStore((s) => s.region);
  const setRegion = usePdbStore((s) => s.setRegion);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = MINIMAP_SIZE;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const tokens = getTheme(themeId).canvas;
    const { cols, rows } = board;

    // 背景
    ctx.fillStyle = tokens.canvasBg;
    ctx.fillRect(0, 0, size, size);

    // 每格尺寸
    const cellW = size / cols;
    const cellH = size / rows;

    // 画色块（采样：格子太小时每 N 格画一次）
    const step = Math.max(1, Math.floor(Math.max(cols, rows) / size));

    for (let r = 0; r < rows; r += step) {
      for (let c = 0; c < cols; c += step) {
        const i = r * cols + c;
        const v = beads[i];
        if (v === 0) continue;
        const color = palette.colors[v - 1];
        if (!color) continue;
        ctx.fillStyle = color.hex;
        ctx.fillRect(c * cellW, r * cellH, cellW * step, cellH * step);
      }
    }

    // 区块高亮框
    const regions = buildRegions(cols, rows, region.splitsX, region.splitsY, region.blockCols, region.blockRows);
    const activeRegion = regions[Math.min(region.activeIndex, regions.length - 1)];

    if (activeRegion && regions.length > 1) {
      // 当前区块高亮
      ctx.strokeStyle = tokens.selectionStroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        activeRegion.col0 * cellW,
        activeRegion.row0 * cellH,
        activeRegion.cols * cellW,
        activeRegion.rows * cellH,
      );

      // 其他区块分隔线
      ctx.strokeStyle = tokens.gridLine;
      ctx.lineWidth = 0.5;
      for (const r of regions) {
        if (r === activeRegion) continue;
        ctx.strokeRect(r.col0 * cellW, r.row0 * cellH, r.cols * cellW, r.rows * cellH);
      }
    }

    // 边框
    ctx.strokeStyle = tokens.gridLineMajor;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }, [board, beads, beadsVersion, palette, themeId, region]);

  useEffect(() => { draw(); }, [draw]);

  // 点击跳转
  const onClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const col = Math.floor((x / MINIMAP_SIZE) * board.cols);
    const row = Math.floor((y / MINIMAP_SIZE) * board.rows);

    const regions = buildRegions(board.cols, board.rows, region.splitsX, region.splitsY, region.blockCols, region.blockRows);
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i]!;
      if (row >= r.row0 && row < r.row0 + r.rows && col >= r.col0 && col < r.col0 + r.cols) {
        setRegion({ activeIndex: i });
        break;
      }
    }
  }, [board, region, setRegion]);

  return (
    <div className="pdb-minimap">
      <canvas
        ref={canvasRef}
        className="pdb-minimap__canvas"
        onClick={onClick}
        aria-label="板缩略图"
      />
      <span className="pdb-minimap__label">{board.cols}×{board.rows}</span>
    </div>
  );
}
