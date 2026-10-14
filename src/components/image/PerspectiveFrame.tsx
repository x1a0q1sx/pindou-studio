/**
 * image/PerspectiveFrame.tsx —— 逆向模式的「对位图」：源照片 + 采样网格叠加 + 四角透视手柄。
 *
 * 两层能力（可叠加）：
 *  1. **网格叠加**（始终显示）：把 sampleBeadGrid 的预测采样网格直接画在照片上，
 *     旋转角/水平/垂直微调的效果一眼可见，不再靠预览结果试错对齐。
 *     ・无透视：网格线用与 sampleBeadGrid 完全相同的旋转/偏移公式计算；
 *     ・有透视：网格线用 homographyFromUnitQuad 的同一个 H 投影（与拉正采样严格一致）。
 *  2. **四角校正手柄**（开启透视后）：拖动 4 个圆点框住拼豆区域四角，
 *     采样前先把该四边形拉正成矩形（warpPerspective），拍歪的照片也能对齐。
 *
 * 坐标系约定：corners 是**裁剪区域**内的归一化坐标（0..1），与 ImportOptions.perspectiveCorners
 * 一致——裁剪变化后四角语义不变。
 */
import { useEffect, useRef, useState } from 'react';
import { applyHomography, homographyFromUnitQuad } from '@/imaging/pixelate';
import { fromNormalized, isFullImage } from '@/imaging/cropRect';
import type { NormalizedCropRect } from '@/imaging/cropRect';

export interface PerspectiveFrameProps {
  /** 源图预览 URL */
  src: string;
  imgWidth: number;
  imgHeight: number;
  /** 裁剪选区（归一化全图坐标）；null = 全图 */
  crop: NormalizedCropRect | null;
  cols: number;
  rows: number;
  angleDeg: number;
  offsetX: number;
  offsetY: number;
  /** 四角（裁剪区域归一化坐标，左上→右上→右下→左下）；null = 未启用透视 */
  corners: Array<{ x: number; y: number }> | null;
  onCornersChange: (c: Array<{ x: number; y: number }> | null) => void;
}

/** 手柄命中半径（显示像素） */
const HANDLE_HIT = 16;

export function PerspectiveFrame({
  src, imgWidth, imgHeight, crop, cols, rows, angleDeg, offsetX, offsetY, corners, onCornersChange,
}: PerspectiveFrameProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgOk, setImgOk] = useState(false);
  /** 容器 CSS 宽度（ResizeObserver 同步，画布按它重绘） */
  const [dispW, setDispW] = useState(0);

  /* 加载图片（画像素用） */
  useEffect(() => {
    setImgOk(false);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgOk(true);
    };
    img.src = src;
  }, [src]);

  /* 容器宽度跟随可用空间：挂载时同步量一次（隐藏标签页中 RO 回调可能被推迟），
     之后交给 ResizeObserver 增量更新 */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    if (r0.width > 0) setDispW(Math.round(r0.width));
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setDispW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dispH = dispW > 0 ? Math.max(1, Math.round((dispW * imgHeight) / imgWidth)) : 0;

  /** 正在拖拽的手柄序号（-1 = 无；画进 canvas 让被拖手柄变色） */
  const dragCornerRef = useRef<number>(-1);

  /* ---- 绘制 ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dispW <= 0 || dispH <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = dispW * dpr;
    canvas.height = dispH * dpr;
    canvas.style.width = `${dispW}px`;
    canvas.style.height = `${dispH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dispW, dispH);

    /* 照片打底 */
    const img = imgRef.current;
    if (img) {
      ctx.globalAlpha = 0.96;
      ctx.drawImage(img, 0, 0, dispW, dispH);
      ctx.globalAlpha = 1;
    }

    /* 裁剪区域（显示坐标） */
    const px = crop && !isFullImage(fromNormalized(crop, imgWidth, imgHeight), imgWidth, imgHeight)
      ? fromNormalized(crop, imgWidth, imgHeight)
      : { x: 0, y: 0, w: imgWidth, h: imgHeight };
    const sc = dispW / imgWidth; // 显示/源 像素比
    const cx0 = px.x * sc;
    const cy0 = px.y * sc;
    const cw = px.w * sc;
    const chh = px.h * sc;

    /* 裁剪区外压暗，突出工作区 */
    ctx.fillStyle = 'rgba(15,15,20,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, dispW, dispH);
    ctx.rect(cx0 + cw, cy0, -cw, chh); // 反向子路径挖洞
    ctx.fill('evenodd');

    /* 网格叠加（裁剪区内） */
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx0, cy0, cw, chh);
    ctx.clip();
    ctx.lineWidth = 1;
    if (corners && corners.length === 4) {
      // 透视：与 warpPerspective 用同一个 H（单位方 → 裁剪区像素四边形，显示比例）
      const quadDisp = corners.map((c) => ({ x: cx0 + c.x * cw, y: cy0 + c.y * chh }));
      const H = homographyFromUnitQuad(quadDisp);
      ctx.strokeStyle = 'rgba(0,200,255,0.85)';
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) {
        const u = c / cols;
        let first = true;
        for (let r = 0; r <= 24; r++) {
          const [x, y] = applyHomography(H, u, r / 24);
          if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
        }
      }
      for (let r = 0; r <= rows; r++) {
        const v = r / rows;
        let first = true;
        for (let c = 0; c <= 24; c++) {
          const [x, y] = applyHomography(H, c / 24, v);
          if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    } else {
      // 无透视：与 sampleBeadGrid 相同的旋转/偏移公式（豆心连线）
      const theta = (angleDeg * Math.PI) / 180;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const point = (u: number, v: number): [number, number] => [
        cx0 + cw / 2 + (u * cosT - v * sinT) * cw,
        cy0 + chh / 2 + (u * sinT + v * cosT) * chh,
      ];
      ctx.strokeStyle = 'rgba(0,200,255,0.8)';
      ctx.beginPath();
      for (let r = 0; r < rows; r++) {
        const v = (r + 0.5) / rows - 0.5 + offsetY;
        const [ax, ay] = point(-0.55, v);
        const [bx, by] = point(0.55, v);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      for (let c = 0; c < cols; c++) {
        const u = (c + 0.5) / cols - 0.5 + offsetX;
        const [ax, ay] = point(u, -0.55);
        const [bx, by] = point(u, 0.55);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }
    ctx.restore();

    /* 四边形与手柄 */
    if (corners && corners.length === 4) {
      const pts = corners.map((c) => ({ x: cx0 + c.x * cw, y: cy0 + c.y * chh }));
      ctx.strokeStyle = '#ffcf3f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < 4; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.closePath();
      ctx.stroke();
      pts.forEach((p, i) => {
        ctx.fillStyle = i === dragCornerRef.current ? '#ff6b6b' : '#ffcf3f';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }
  }, [src, imgOk, dispW, dispH, crop, imgWidth, imgHeight, cols, rows, angleDeg, offsetX, offsetY, corners]);

  /* ---- 手柄拖拽 ---- */

  const cornerDisp = (k: number): { x: number; y: number } => {
    const px = crop && !isFullImage(fromNormalized(crop, imgWidth, imgHeight), imgWidth, imgHeight)
      ? fromNormalized(crop, imgWidth, imgHeight)
      : { x: 0, y: 0, w: imgWidth, h: imgHeight };
    const sc = dispW / imgWidth;
    const c = corners?.[k] ?? { x: 0, y: 0 };
    return { x: px.x * sc + c.x * px.w * sc, y: px.y * sc + c.y * px.h * sc };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!corners || corners.length !== 4) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = -1;
    let bestD = HANDLE_HIT;
    for (let k = 0; k < 4; k++) {
      const p = cornerDisp(k);
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) return;
    e.preventDefault();
    // 先记下手柄序号再尝试捕获：无效/合成 pointerId 会抛 NotFoundError，不能让它阻断拖拽
    dragCornerRef.current = best;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败不视为错误 */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const k = dragCornerRef.current;
    if (k < 0 || !corners || corners.length !== 4) return;
    const px = crop && !isFullImage(fromNormalized(crop, imgWidth, imgHeight), imgWidth, imgHeight)
      ? fromNormalized(crop, imgWidth, imgHeight)
      : { x: 0, y: 0, w: imgWidth, h: imgHeight };
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left - px.x * (dispW / imgWidth)) / (px.w * (dispW / imgWidth));
    const ny = (e.clientY - rect.top - px.y * (dispW / imgWidth)) / (px.h * (dispW / imgWidth));
    const next = corners.map((c, i) => (i === k
      ? { x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) }
      : c));
    onCornersChange(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (dragCornerRef.current < 0) return;
    dragCornerRef.current = -1;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 无效/合成 pointerId：忽略 */
    }
  };

  return (
    <div className="pdb-persp">
      <div ref={wrapRef} className="pdb-persp__wrap" style={{ aspectRatio: `${imgWidth} / ${imgHeight}` }}>
        <img src={src} alt="对位图" className="pdb-persp__img" draggable={false} />
        <canvas
          ref={canvasRef}
          className="pdb-persp__canvas"
          style={{ cursor: corners ? 'crosshair' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="网格对位图（拖动黄色手柄框住拼豆区域四角）"
        />
      </div>
    </div>
  );
}
