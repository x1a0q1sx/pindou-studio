/**
 * src/components/image/CropFrame.tsx —— 裁剪框拖拽选区组件。
 *
 * 功能：
 *  - 8 个手柄（四角 + 四边）等比/自由缩放
 *  - 框内整体平移
 *  - 框外重新框选（自动吸附目标比例）
 *  - 方向键微调 1px / Shift 10px
 *  - 「自由比例」开关 + 三分构图辅助线开关
 *  - 「重置选区」与「最大化选区」按钮
 *  - 实时显示选区信息
 *  - requestAnimationFrame 节流 + setPointerCapture
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Segmented } from '@/components/ui/Segmented';
import type { FitMode } from '@/core/types';
import {
  type CropRect as CropRectPx,
  type NormalizedCropRect,
  type CropHandle,
  aspectOf,
  toNormalized,
  fromNormalized,
  makeAspectLockedRect,
  resizeWithAspectLock,
  resizeFree,
  rectFromTwoPoints,
  nudge,
  clampCropRect,
  DEFAULT_MIN_CROP_SIZE,
} from '@/imaging/cropRect';
import './image.css';

/* ==================== Props ==================== */

export interface CropFrameProps {
  /** 图片预览 URL */
  src: string;
  /** 图片原始宽度（源像素） */
  imgWidth: number;
  /** 图片原始高度（源像素） */
  imgHeight: number;
  /** 目标板 cols */
  cols: number;
  /** 目标板 rows */
  rows: number;
  /** FitMode */
  fitMode: FitMode;
  onFitModeChange: (mode: FitMode) => void;
  /** 裁剪框变化回调（归一化 0..1） */
  onCropChange: (rect: NormalizedCropRect) => void;
  /** 受控值（可选） */
  value?: NormalizedCropRect | null;
  /** 是否显示三分构图辅助线 */
  showGrid?: boolean;
}

/* ==================== 辅助 ==================== */

function gcd(a: number, b: number): number {
  a = Math.round(a); b = Math.round(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

const HANDLE_CURSORS: Record<CropHandle, string> = {
  nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize',
  e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize',
  sw: 'nesw-resize', w: 'ew-resize', move: 'move',
};

const ALL_HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/* ==================== 组件 ==================== */

export function CropFrame({
  src, imgWidth, imgHeight, cols, rows,
  fitMode, onFitModeChange, onCropChange,
  value, showGrid: showGridProp,
}: CropFrameProps) {
  /* --- refs --- */
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const pendingEvent = useRef<PointerEvent | null>(null);

  /* --- state --- */
  const [rect, setRect] = useState<CropRectPx>(() =>
    makeAspectLockedRect(imgWidth, imgHeight, aspectOf(cols, rows), fitMode),
  );
  const [freeAspect, setFreeAspect] = useState(false);
  const [showGrid, setShowGrid] = useState(showGridProp ?? false);
  const [imgBox, setImgBox] = useState({ left: 0, top: 0, width: 1, height: 1 });
  /** 视图缩放（1=适应容器）与平移（容器 px）——大图逐格对位用 */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panDragRef = useRef<{ startClientX: number; startClientY: number; startPan: { x: number; y: number } } | null>(null);
  const spaceHeldRef = useRef(false);

  // 拖拽状态用 ref 避免频繁 rerender
  const dragRef = useRef<{
    handle: CropHandle | 'new';
    startClientX: number;
    startClientY: number;
    startRect: CropRectPx;
    /** 框选起点（源像素） */
    originSrcX?: number;
    originSrcY?: number;
  } | null>(null);

  const aspect = aspectOf(cols, rows);
  const onCropChangeRef = useRef(onCropChange);
  onCropChangeRef.current = onCropChange;

  /* --- 图片渲染盒测量 --- */
  const measure = useCallback(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return;
    const cRect = container.getBoundingClientRect();
    const iRect = img.getBoundingClientRect();
    setImgBox({
      left: iRect.left - cRect.left,
      top: iRect.top - cRect.top,
      width: Math.max(1, iRect.width),
      height: Math.max(1, iRect.height),
    });
  }, []);

  useLayoutEffect(() => { measure(); }, [measure, src, zoom, pan]);

  /* --- 滚轮缩放（以光标为中心）；原生监听避免 passive 拦截 --- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const cRect = container.getBoundingClientRect();
      const cx = e.clientX - cRect.left;
      const cy = e.clientY - cRect.top;
      setZoom((z) => {
        const next = Math.min(12, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (Math.abs(next - z) < 1e-6) return z;
        setPan((p) => {
          if (next <= 1) return { x: 0, y: 0 };
          const k = next / z;
          return { x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k };
        });
        return next;
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  /* --- 平移：中键 / Ctrl+左键 / 按住空格 拖拽 --- */
  const handlePanPointerDown = useCallback((e: React.PointerEvent): boolean => {
    const panIntent = e.button === 1 || e.ctrlKey || spaceHeldRef.current;
    if (!panIntent) return false;
    e.preventDefault();
    e.stopPropagation();
    panDragRef.current = { startClientX: e.clientX, startClientY: e.clientY, startPan: { ...pan } };
    const overlay = overlayRef.current;
    if (overlay) {
      try { overlay.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    return true;
  }, [pan]);

  const processPanMove = useCallback((e: PointerEvent): void => {
    const drag = panDragRef.current;
    if (!drag) return;
    setPan({ x: drag.startPan.x + (e.clientX - drag.startClientX), y: drag.startPan.y + (e.clientY - drag.startClientY) });
  }, []);

  const handlePanMove = useCallback((e: React.PointerEvent) => {
    if (!panDragRef.current) return;
    processPanMove(e.nativeEvent);
  }, [processPanMove]);

  /* --- 空格键按住 = 平移模式（不干扰方向键微调） --- */
  useEffect(() => {
    const down = (e: KeyboardEvent): void => { if (e.code === 'Space') spaceHeldRef.current = true; };
    const up = (e: KeyboardEvent): void => { if (e.code === 'Space') spaceHeldRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      spaceHeldRef.current = false;
    };
  }, []);

  /* --- 缩放控制按钮 --- */
  const zoomBy = useCallback((f: number): void => {
    setZoom((z) => {
      const next = Math.min(12, Math.max(1, z * f));
      if (next <= 1) { setPan({ x: 0, y: 0 }); return 1; }
      return next;
    });
  }, []);
  const zoomFit = useCallback((): void => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    return () => ro.disconnect();
  }, [measure]);

  /* --- 当外部 props 变化时重算初始矩形 --- */
  const lastKeyRef = useRef('');
  useEffect(() => {
    const key = `${imgWidth}x${imgHeight}|${cols}x${rows}|${fitMode}`;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    const initial = makeAspectLockedRect(imgWidth, imgHeight, aspect, fitMode);
    setRect(initial);
  }, [imgWidth, imgHeight, cols, rows, fitMode, aspect]);

  /* --- 受控 value 同步 --- */
  useEffect(() => {
    if (value && imgWidth > 0 && imgHeight > 0) {
      setRect(fromNormalized(value, imgWidth, imgHeight));
    }
  }, [value, imgWidth, imgHeight]);

  /* --- emit onCropChange --- */
  useEffect(() => {
    if (imgWidth > 0 && imgHeight > 0) {
      onCropChangeRef.current(toNormalized(rect, imgWidth, imgHeight));
    }
  }, [rect, imgWidth, imgHeight]);

  /* --- 坐标换算：屏幕位移 → 源像素位移 --- */
  const toSrcDelta = useCallback((clientDx: number, clientDy: number): [number, number] => {
    const scaleX = imgWidth / imgBox.width;
    const scaleY = imgHeight / imgBox.height;
    return [clientDx * scaleX, clientDy * scaleY];
  }, [imgWidth, imgHeight, imgBox.width, imgBox.height]);

  const toSrcPoint = useCallback((clientX: number, clientY: number): [number, number] => {
    const container = containerRef.current;
    if (!container) return [0, 0];
    const cRect = container.getBoundingClientRect();
    const relX = clientX - cRect.left - imgBox.left;
    const relY = clientY - cRect.top - imgBox.top;
    return [relX * (imgWidth / imgBox.width), relY * (imgHeight / imgBox.height)];
  }, [imgBox, imgWidth, imgHeight]);

  /* --- pointerdown --- */
  const handlePointerDown = useCallback((e: React.PointerEvent, handle: CropHandle | 'new') => {
    // 平移意图（中键 / Ctrl / 空格）优先于裁剪手势
    if (handlePanPointerDown(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const overlay = overlayRef.current;
    if (overlay) {
      try {
        overlay.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败不视为错误 */
      }
    }

    const startRect = { ...rect };
    if (handle === 'new') {
      const [sx, sy] = toSrcPoint(e.clientX, e.clientY);
      dragRef.current = { handle: 'new', startClientX: e.clientX, startClientY: e.clientY, startRect, originSrcX: sx, originSrcY: sy };
      // 初始化为极小矩形（会在 move 时展开）
      setRect(clampCropRect({ x: sx, y: sy, w: DEFAULT_MIN_CROP_SIZE, h: freeAspect ? DEFAULT_MIN_CROP_SIZE : DEFAULT_MIN_CROP_SIZE / aspect }, imgWidth, imgHeight, 1));
    } else {
      dragRef.current = { handle, startClientX: e.clientX, startClientY: e.clientY, startRect };
    }
  }, [rect, toSrcPoint, aspect, freeAspect, imgWidth, imgHeight, handlePanPointerDown]);

  /* --- pointermove (rAF throttled) --- */
  const processPointerMove = useCallback(() => {
    rafRef.current = 0;
    const ev = pendingEvent.current;
    const drag = dragRef.current;
    if (!ev || !drag) return;
    pendingEvent.current = null;

    const clientDx = ev.clientX - drag.startClientX;
    const clientDy = ev.clientY - drag.startClientY;
    const [dxSrc, dySrc] = toSrcDelta(clientDx, clientDy);
    const minSize = Math.max(DEFAULT_MIN_CROP_SIZE, Math.round(12 * (imgWidth / imgBox.width)));

    if (drag.handle === 'new') {
      const [curX, curY] = toSrcPoint(ev.clientX, ev.clientY);
      const a = freeAspect ? null : aspect;
      const newRect = rectFromTwoPoints(drag.originSrcX!, drag.originSrcY!, curX, curY, a, imgWidth, imgHeight, minSize);
      setRect(newRect);
    } else if (drag.handle === 'move') {
      const moved = freeAspect
        ? resizeFree(drag.startRect, 'move', dxSrc, dySrc, imgWidth, imgHeight, minSize)
        : resizeWithAspectLock(drag.startRect, 'move', dxSrc, dySrc, aspect, imgWidth, imgHeight, minSize);
      setRect(moved);
    } else {
      const resized = freeAspect
        ? resizeFree(drag.startRect, drag.handle, dxSrc, dySrc, imgWidth, imgHeight, minSize)
        : resizeWithAspectLock(drag.startRect, drag.handle, dxSrc, dySrc, aspect, imgWidth, imgHeight, minSize);
      setRect(resized);
    }
  }, [toSrcDelta, toSrcPoint, aspect, freeAspect, imgWidth, imgHeight, imgBox.width]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    pendingEvent.current = e.nativeEvent;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(processPointerMove);
    }
  }, [processPointerMove]);

  /* --- pointerup / pointercancel --- */
  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
    panDragRef.current = null;
    pendingEvent.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
  }, []);

  /* --- 键盘微调 --- */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 焦点在 input/textarea 时不劫持
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;

    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    switch (e.key) {
      case 'ArrowLeft': dx = -step; break;
      case 'ArrowRight': dx = step; break;
      case 'ArrowUp': dy = -step; break;
      case 'ArrowDown': dy = step; break;
      default: return;
    }
    e.preventDefault();
    setRect((prev) => nudge(prev, dx, dy, imgWidth, imgHeight));
  }, [imgWidth, imgHeight]);

  /* --- 框外 pointerdown（重新框选） --- */
  const handleOverlayPointerDown = useCallback((e: React.PointerEvent) => {
    // 只有点在遮罩/overlay 空白区域才触发
    const target = e.target as HTMLElement;
    if (target.dataset.cropHandle || target.dataset.cropFrame) return;
    handlePointerDown(e, 'new');
  }, [handlePointerDown]);

  /* --- 按钮回调 --- */
  const handleReset = useCallback(() => {
    setRect(makeAspectLockedRect(imgWidth, imgHeight, aspect, fitMode));
  }, [imgWidth, imgHeight, aspect, fitMode]);

  const handleMaximize = useCallback(() => {
    if (freeAspect) {
      setRect({ x: 0, y: 0, w: imgWidth, h: imgHeight });
    } else {
      setRect(makeAspectLockedRect(imgWidth, imgHeight, aspect, 'cover'));
    }
  }, [freeAspect, imgWidth, imgHeight, aspect]);

  /* --- 选区信息 --- */
  const wPx = Math.round(rect.w);
  const hPx = Math.round(rect.h);
  const xPx = Math.round(rect.x);
  const yPx = Math.round(rect.y);
  const g = gcd(wPx, hPx);
  const ratioText = freeAspect
    ? (rect.h > 0 ? (rect.w / rect.h).toFixed(2) : '—')
    : `${wPx / g}:${hPx / g}`;

  /* --- 渲染位置百分比（相对于 imgBox） --- */
  const pctX = imgWidth > 0 ? (rect.x / imgWidth) * 100 : 0;
  const pctY = imgHeight > 0 ? (rect.y / imgHeight) * 100 : 0;
  const pctW = imgWidth > 0 ? (rect.w / imgWidth) * 100 : 0;
  const pctH = imgHeight > 0 ? (rect.h / imgHeight) * 100 : 0;

  return (
    <div className="pdb-crop">
      {/* 工具栏 */}
      <div className="pdb-crop__toolbar">
        <Segmented<FitMode>
          ariaLabel="适配模式"
          value={fitMode}
          options={[
            { value: 'cover', label: '裁满', title: '铺满整板：图片按比例放大到填满 104×104，超出板外的部分会被裁掉（非正方形图不完整，适合照片主体居中的情况）' },
            { value: 'contain', label: '完整', title: '完整放入（推荐）：整张图都出现在板上，非正方形图两侧留空格' },
            { value: 'stretch', label: '拉伸', title: '拉伸变形填满整板，图片比例会失真，一般不推荐' },
          ]}
          onChange={onFitModeChange}
        />
        <Switch checked={freeAspect} onChange={setFreeAspect} label="自由比例" />
        <Switch checked={showGrid} onChange={setShowGrid} label="三分线" />
        <span className="pdb-crop__zoomctl">
          <Button variant="ghost" size="sm" onClick={() => zoomBy(1 / 1.25)} disabled={zoom <= 1} title="缩小">－</Button>
          <span className="pdb-crop__zoomval">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="sm" onClick={() => zoomBy(1.25)} disabled={zoom >= 12} title="放大">＋</Button>
          <Button variant="ghost" size="sm" onClick={zoomFit} disabled={zoom <= 1} title="适应容器">适应</Button>
        </span>
      </div>

      {/* 裁剪画布 */}
      <div
        ref={containerRef}
        className="pdb-crop__canvas"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        title="滚轮缩放 · 空格/Ctrl+拖拽或中键拖拽平移"
      >
        <img
          ref={imgRef}
          src={src}
          alt="裁剪预览"
          className="pdb-crop__img"
          draggable={false}
          onLoad={measure}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
        />
        {/* overlay 精确覆盖图片渲染盒（含缩放平移后的位置） */}
        <div
          ref={overlayRef}
          className={`pdb-crop__overlay ${panDragRef.current ? 'is-panning' : ''}`}
          style={{ left: imgBox.left, top: imgBox.top, width: imgBox.width, height: imgBox.height }}
          onPointerDown={handleOverlayPointerDown}
          onPointerMove={(e) => { handlePanMove(e); handlePointerMove(e); }}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* 4 块遮罩 */}
          <div className="pdb-crop__mask pdb-crop__mask--top" style={{ height: `${pctY}%` }} />
          <div className="pdb-crop__mask pdb-crop__mask--bottom" style={{ top: `${pctY + pctH}%` }} />
          <div className="pdb-crop__mask pdb-crop__mask--left" style={{ top: `${pctY}%`, height: `${pctH}%`, width: `${pctX}%` }} />
          <div className="pdb-crop__mask pdb-crop__mask--right" style={{ top: `${pctY}%`, height: `${pctH}%`, left: `${pctX + pctW}%` }} />

          {/* 三分构图辅助线 */}
          {showGrid && (
            <div className="pdb-crop__grid" style={{ left: `${pctX}%`, top: `${pctY}%`, width: `${pctW}%`, height: `${pctH}%` }}>
              <div className="pdb-crop__grid-v pdb-crop__grid-v--1" />
              <div className="pdb-crop__grid-v pdb-crop__grid-v--2" />
              <div className="pdb-crop__grid-h pdb-crop__grid-h--1" />
              <div className="pdb-crop__grid-h pdb-crop__grid-h--2" />
            </div>
          )}

          {/* 裁剪框 */}
          <div
            className="pdb-crop__frame"
            data-crop-frame="1"
            style={{ left: `${pctX}%`, top: `${pctY}%`, width: `${pctW}%`, height: `${pctH}%` }}
            onPointerDown={(e) => handlePointerDown(e, 'move')}
            role="presentation"
          >
            {/* 8 个手柄 */}
            {ALL_HANDLES.map((h) => (
              <div
                key={h}
                className={`pdb-crop__handle pdb-crop__handle--${h}`}
                data-crop-handle={h}
                style={{ cursor: HANDLE_CURSORS[h] }}
                onPointerDown={(e) => handlePointerDown(e, h)}
                role="presentation"
              />
            ))}
          </div>
        </div>
      </div>

      {/* 信息 + 操作 */}
      <div className="pdb-crop__info">
        <span className="pdb-crop__selection-info">
          选区 {wPx}×{hPx} px · 位置 ({xPx}, {yPx}) · 比例 {ratioText} · 输出 {cols}×{rows} 格
        </span>
      </div>
      <div className="pdb-crop__actions">
        <Button variant="ghost" size="sm" onClick={handleReset}>重置选区</Button>
        <Button variant="ghost" size="sm" onClick={handleMaximize}>最大化选区</Button>
        <span className="pdb-crop__hint">滚轮缩放 · 空格/Ctrl+拖拽平移 · 方向键微调 1px（Shift 10px）</span>
      </div>
      <p className="pdb-crop__note">
        适配模式只决定初始裁剪框；手动拖动后即为自定义选区，最终像素化仍按 {cols}×{rows} 格输出。
      </p>
    </div>
  );
}
