/**
 * src/imaging/worker.ts —— Web Worker：图片解码 + 像素化 + 配色。
 *
 * 接收主线程 postMessage 的 ArrayBuffer/File → 解码 RGBA → 调 pipeline.ts → 回传结果。
 * 结果中的 Uint16Array 使用 Transferable 零拷贝传输。
 */
import { pixelateFromRgba, reduceToPaletteGrid, fitRect } from './pipeline';
import type { PixelateOpts, ReduceOpts } from './pipeline';

/* ==================== 消息协议 ==================== */

export interface WorkerRequest {
  id: number;
  type: 'process';
  /** 图片文件数据（ArrayBuffer，Transferable 传入） */
  buffer: ArrayBuffer;
  /** 图片 MIME（用于 createImageBitmap 提示） */
  mime: string;
  /** 像素化参数 */
  pixelateOpts: PixelateOpts;
  /** 配色参数 */
  reduceOpts: ReduceOpts;
  /** palette colors 的序列化（rgb + hex + id 数组） */
  paletteColors: Array<{ id: string; hex: string; rgb: [number, number, number] }>;
  /** FitMode */
  fitMode: 'cover' | 'contain' | 'stretch';
}

export interface WorkerProgress {
  id: number;
  type: 'progress';
  /** 0-100 */
  percent: number;
  stage: string;
}

export interface WorkerResult {
  id: number;
  type: 'result';
  beads: Uint16Array;
  cols: number;
  rows: number;
  usedColorIndices: number[];
  quantized: { hex: string; count: number }[];
  maxDeltaE: number;
  mapping: Array<{ fromHex: string; toColorIndex: number; deltaE: number }>;
  sampledPixels: number;
  elapsed: number;
}

export interface WorkerError {
  id: number;
  type: 'error';
  message: string;
}

export type WorkerMessage = WorkerProgress | WorkerResult | WorkerError;

/* ==================== Worker 主体 ==================== */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = self as any;

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type !== 'process') return;

  try {
    const t0 = performance.now();

    // 进度 10%：解码
    ctx.postMessage({ id: req.id, type: 'progress', percent: 10, stage: '解码图片' } satisfies WorkerProgress);

    // 使用 createImageBitmap 解码
    const blob = new Blob([req.buffer], { type: req.mime });
    const bitmap = await createImageBitmap(blob);
    const srcW = bitmap.width;
    const srcH = bitmap.height;

    // 进度 20%：提取 RGBA
    ctx.postMessage({ id: req.id, type: 'progress', percent: 20, stage: '提取像素数据' } satisfies WorkerProgress);

    const offscreen = new OffscreenCanvas(srcW, srcH);
    const offCtx = offscreen.getContext('2d')!;
    offCtx.drawImage(bitmap, 0, 0);
    const imageData = offCtx.getImageData(0, 0, srcW, srcH);
    bitmap.close();

    // 平滑进度：把各阶段的 0..1 分数映射到全局 20%–98%，60ms 节流避免 postMessage 风暴
    const STAGES: Array<[number, number, string]> = [
      [20, 62, '像素化采样'],
      [62, 86, '颜色量化'],
      [86, 98, '色板匹配'],
    ];
    let lastPost = 0;
    let lastPct = 20;
    const makeReporter = (idx: 0 | 1 | 2) => (fraction: number): void => {
      const [lo, hi, label] = STAGES[idx];
      const pct = Math.round(lo + Math.min(1, Math.max(0, fraction)) * (hi - lo));
      if (pct < lastPct) return; // 阶段回退（如抖动路径跳过中间段）时不再倒退
      const now = performance.now();
      if (pct === lastPct || (now - lastPost < 60 && pct - lastPct < 5)) return;
      lastPost = now;
      lastPct = pct;
      ctx.postMessage({ id: req.id, type: 'progress', percent: pct, stage: label } satisfies WorkerProgress);
    };

    // 计算 fitRect
    const opts = { ...req.pixelateOpts };
    const fit = fitRect(srcW, srcH, opts.cols, opts.rows, req.fitMode);
    opts.fit = fit;

    const pixelResult = pixelateFromRgba(
      { data: imageData.data, width: srcW, height: srcH },
      opts,
      makeReporter(0),
    );

    // 构造 palette colors（worker 内无法用完整 BeadColor；reduceToPaletteGrid 只需要 rgb/hex/id，
    // lab 由 buildPaletteIndex 从 rgb 重算，但字段按契约如实填充）
    const paletteColors = req.paletteColors.map((c) => ({
      ...c,
      code: '',
      name: '',
      lab: [0, 0, 0] as [number, number, number],
      builtin: true,
    }));

    const reduceResult = reduceToPaletteGrid(
      pixelResult.cells,
      pixelResult.cols,
      pixelResult.rows,
      paletteColors,
      req.reduceOpts,
      makeReporter(1),
    );

    const elapsed = performance.now() - t0;

    // 进度 100%：完成
    ctx.postMessage({ id: req.id, type: 'progress', percent: 100, stage: '完成' } satisfies WorkerProgress);

    // 回传结果（Transferable 零拷贝）
    const result: WorkerResult = {
      id: req.id,
      type: 'result',
      beads: reduceResult.beads,
      cols: pixelResult.cols,
      rows: pixelResult.rows,
      usedColorIndices: reduceResult.usedColorIndices,
      quantized: reduceResult.quantized,
      maxDeltaE: reduceResult.maxDeltaE,
      mapping: reduceResult.mapping,
      sampledPixels: pixelResult.sampledPixels,
      elapsed,
    };
    ctx.postMessage(result, [reduceResult.beads.buffer]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ id: req.id, type: 'error', message: msg } satisfies WorkerError);
  }
};
