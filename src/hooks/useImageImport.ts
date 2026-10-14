/**
 * src/hooks/useImageImport.ts —— 图片导入流水线状态机。
 *
 * 编排 idle → loading → cropping → pixelating → reducing → applying → done | error | cancelled
 * 支持 Worker 加速与主线程无缝回退、进度回调、可取消。
 */
import { useCallback, useRef, useState } from 'react';
import { usePdbStore } from '@/store';
import { validateFile, loadImageFromFile, toRgba, toRgbaRegion, fileToDataUrl } from '@/imaging/loader';
import type { LoadedSource } from '@/imaging/loader';
// 懒加载瘦身：pipeline（像素化+量化数学）只走动态 import，随 ImportDialog 拆进懒 chunk，
// 首屏主包不再包含这套量化算法（Worker 路径本来就在独立 chunk 里）
import type { PixelateOpts, ReduceOpts, PixelateResult, ReduceResult } from '@/imaging/pipeline';
import type { FitMode } from '@/core/types';
import type { WorkerMessage, WorkerResult } from '@/imaging/worker';
import { attachProjectSourceImage } from '@/store/persistence';
import {
  type NormalizedCropRect,
  type SourcePixelRect,
  cropRectToSourcePixels,
  fromNormalized,
  isFullImage,
} from '@/imaging/cropRect';

/* ==================== 类型 ==================== */

export type ImportStage =
  | 'idle'
  | 'loading'
  | 'cropping'
  | 'pixelating'
  | 'reducing'
  | 'applying'
  | 'done'
  | 'error'
  | 'cancelled';

export interface ImportFile {
  file: File;
  width: number;
  height: number;
  size: number;
  name: string;
  /** 预览用 Object URL */
  previewUrl: string;
  /** 已解码的 RGBA（loading 阶段填充） */
  rgba: { data: Uint8ClampedArray; width: number; height: number } | null;
}

export interface ImportOptions {
  cols: number;
  rows: number;
  fitMode: FitMode;
  sampling: 'area-average' | 'center';
  brightness: number;
  contrast: number;
  saturation: number;
  transparentAsEmpty: boolean;
  /** 去背景：识别边缘背景色并把连通相似区域清为空格 */
  bgRemove: boolean;
  /** 去背景容差 0–100（越大吞得越多） */
  bgTolerance: number;
  colorCount: number;
  dither: boolean;
  /** 少量色精确保留：唯一色 ≤ 目标色数时跳过量化，原图色零损失 */
  fewColorExact: boolean;
  /** 去杂色：清理孤立点（无同色邻居的豆子），默认开；抖动开启时自动跳过 */
  despeckle: boolean;
  /** 合并近似色：量化后先按 ΔE2000<6 合并再匹配色板，减少碎杂色，默认开 */
  mergeSimilarColors: boolean;
  /** K-means 精修：Median Cut 后在 Lab 空间跑 Lloyd 迭代降低整体 ΔE，默认开 */
  kmeansRefine: boolean;
  /** 色度门控：低饱和暗部（黑发等）按灰阶匹配，不再放大微弱色偏成棕色号，默认开 */
  chromaGate: boolean;
  /** 高光保护：瞳孔反光等小面积近白高光不被均值模糊，默认开 */
  highlightProtect: boolean;
  /** 近似色号合并：色板上 ΔE<2.8 的已用色号并入格数多者（一片黑只剩一个色号），默认开 */
  paletteDedup: boolean;
  /** 成品拼豆逆向：输入是已完成的实物拼豆照片，按豆网格逐豆取色 */
  beadReverse: boolean;
  /** 逆向网格旋转角（度，顺时针） */
  gridAngle: number;
  /** 逆向网格起点微调（豆距比例 -0.5~0.5） */
  gridOffsetX: number;
  gridOffsetY: number;
  /** 四角透视校正（逆向对位增强）：拼豆区域四角在工作图（已裁剪）上的归一化坐标；null = 关闭 */
  perspectiveCorners?: Array<{ x: number; y: number }> | null;
  /** 裁剪选区（归一化 0..1），null/undefined 表示全图 */
  crop?: NormalizedCropRect | null;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  cols: 104,
  rows: 104,
  // 缺陷 #35：默认「内嵌（contain）」保证导入的图**完整**出现在板上（非正方形图两侧留空格）。
  // 旧的默认 cover 会把非正方形图居中裁剪——用户看到的就是「图不完整」。想要铺满整板时
  // 在裁剪步骤手动切「裁满」。
  fitMode: 'contain',
  sampling: 'area-average',
  brightness: 0,
  contrast: 0,
  saturation: 0,
  transparentAsEmpty: true,
  bgRemove: false,
  bgTolerance: 30,
  // 缺陷 #39：24 色对照片级图片偏少（细节糊），配合智能去杂色与近似色合并提到 32
  colorCount: 32,
  dither: false,
  fewColorExact: true,
  despeckle: true,
  mergeSimilarColors: true,
  kmeansRefine: true,
  chromaGate: true,
  highlightProtect: true,
  paletteDedup: true,
  beadReverse: false,
  gridAngle: 0,
  gridOffsetX: 0,
  gridOffsetY: 0,
  perspectiveCorners: null,
  crop: null,
};

export interface UseImageImportReturn {
  stage: ImportStage;
  progress: number;
  error: string | null;
  importFile: ImportFile | null;
  result: ReduceResult | null;
  /** 打开文件选择 */
  openFileDialog: () => void;
  /** 从 File 开始（拖拽/粘贴调用） */
  start: (file: File) => Promise<void>;
  /** 取消当前操作 */
  cancel: () => void;
  /** 确认并应用到画板 */
  confirm: (opts: ImportOptions) => Promise<void>;
  /** 快速预览（像素化 + 配色，不写入 store） */
  preview: (opts: ImportOptions) => Promise<ReduceResult | null>;
  /** 重置为 idle */
  reset: () => void;
  /** 对话框是否打开 */
  dialogOpen: boolean;
  setDialogOpen: (v: boolean) => void;
}

/* ==================== Hook ==================== */

let requestSeq = 0;

export function useImageImport(): UseImageImportReturn {
  const [stage, setStage] = useState<ImportStage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<ImportFile | null>(null);
  const [result, setResult] = useState<ReduceResult | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const cancelledRef = useRef(false);
  const fileRef = useRef<File | null>(null);
  const sourceRef = useRef<LoadedSource | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const pushToast = usePdbStore((s) => s.pushToast);

  /** 供 toast 文案用的 MB 格式化 */
  const formatMb = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

  /** 打开文件选择对话框 */
  const openFileDialog = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,.webp,.gif,.bmp,image/png,image/jpeg,image/webp,image/gif,image/bmp';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void start(f);
    };
    input.click();
  }, []);

  /** 取消 */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setStage('cancelled');
    setProgress(0);
  }, []);

  /** 重置 */
  const reset = useCallback(() => {
    cancelledRef.current = false;
    setStage('idle');
    setProgress(0);
    setError(null);
    setImportFile(null);
    setResult(null);
    fileRef.current = null;
    if (previewUrlRef.current) {
      try {
        URL.revokeObjectURL(previewUrlRef.current);
      } catch {
        /* 非 blob URL 或环境不支持时忽略 */
      }
      previewUrlRef.current = null;
    }
    if (sourceRef.current) {
      const bmp = sourceRef.current.bitmap;
      if ('close' in bmp && typeof bmp.close === 'function') bmp.close();
      sourceRef.current = null;
    }
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, []);

  /** 从 File 开始加载 */
  const start = useCallback(async (file: File) => {
    cancelledRef.current = false;
    setError(null);
    setResult(null);
    setStage('loading');
    setProgress(5);
    setDialogOpen(true);

    // 校验
    const validation = validateFile(file);
    if (!validation.valid) {
      setError(validation.error ?? '文件校验失败');
      setStage('error');
      pushToast('danger', validation.error ?? '文件校验失败');
      return;
    }

    fileRef.current = file;
    if (previewUrlRef.current) {
      try {
        URL.revokeObjectURL(previewUrlRef.current);
      } catch {
        /* 重复导入时释放上一张预览 URL */
      }
      previewUrlRef.current = null;
    }
    setProgress(10);

    try {
      // 加载图片获取尺寸
      const loaded = await loadImageFromFile(file);
      if (cancelledRef.current) { setStage('cancelled'); return; }

      setProgress(20);

      // 保存源引用以便后续裁剪
      sourceRef.current = loaded;

      // 提取 RGBA
      const rgba = toRgba(loaded.bitmap, loaded.width, loaded.height);
      if (cancelledRef.current) { setStage('cancelled'); return; }

      setProgress(30);

      const previewUrl = URL.createObjectURL(file);
      previewUrlRef.current = previewUrl;
      const imgFile: ImportFile = {
        file,
        width: loaded.width,
        height: loaded.height,
        size: file.size,
        name: file.name,
        previewUrl,
        rgba,
      };
      setImportFile(imgFile);
      setStage('cropping');
      setProgress(100);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '图片加载失败';
      setError(msg);
      setStage('error');
      pushToast('danger', msg);
    }
  }, [pushToast]);

  /** 主线程执行流水线（回退路径） */
  const runMainThread = useCallback(async (
    rgba: { data: Uint8ClampedArray; width: number; height: number },
    opts: ImportOptions,
    onProgress: (pct: number, stage: string) => void,
  ): Promise<{ pixelResult: PixelateResult; reduceResult: ReduceResult }> => {
    const store = usePdbStore.getState();
    const paletteColors = store.palette.colors;

    onProgress(40, '像素化采样');
    // 让出主线程
    await new Promise((r) => setTimeout(r, 0));
    if (cancelledRef.current) throw new Error('cancelled');

    // 动态加载像素化/量化模块（懒 chunk；Worker 不可用时的回退路径才会走到这里）
    const { pixelateFromRgba, reduceToPaletteGrid, fitRect } = await import('@/imaging/pipeline');

    const pixelOpts: PixelateOpts = {
      cols: opts.cols,
      rows: opts.rows,
      sampling: opts.sampling,
      preprocess: { brightness: opts.brightness, contrast: opts.contrast, saturation: opts.saturation },
      transparentAsEmpty: opts.transparentAsEmpty,
      beadGrid: opts.beadReverse ? { angleDeg: opts.gridAngle, offsetX: opts.gridOffsetX, offsetY: opts.gridOffsetY, radiusRatio: 0.32 } : undefined,
      perspective: opts.perspectiveCorners ? { corners: opts.perspectiveCorners } : undefined,
      samplingCap: 60000,
      fit: fitRect(rgba.width, rgba.height, opts.cols, opts.rows, opts.fitMode),
      bgRemove: opts.bgRemove ? { tolerance: opts.bgTolerance } : undefined,
      highlightProtect: opts.highlightProtect,
    };
    const pixelResult = pixelateFromRgba(rgba, pixelOpts);

    onProgress(70, '颜色量化');
    await new Promise((r) => setTimeout(r, 0));
    if (cancelledRef.current) throw new Error('cancelled');

    const reduceOpts: ReduceOpts = {
      colorCount: opts.colorCount,
      dither: opts.dither,
      fewColorExact: opts.fewColorExact,
      despeckle: opts.despeckle,
      mergeSimilarColors: opts.mergeSimilarColors,
      kmeansRefine: opts.kmeansRefine,
      chromaGate: opts.chromaGate,
      highlightProtect: opts.highlightProtect,
      paletteDedup: opts.paletteDedup,
    };
    const reduceResult = reduceToPaletteGrid(
      pixelResult.cells,
      pixelResult.cols,
      pixelResult.rows,
      paletteColors,
      reduceOpts,
    );

    onProgress(100, '完成');
    return { pixelResult, reduceResult };
  }, []);

  /** 尝试用 Worker 执行 */
  const runWorker = useCallback((
    payload: { buffer: ArrayBuffer; mime: string },
    opts: ImportOptions,
    onProgress: (pct: number, stage: string) => void,
  ): Promise<{ reduceResult: ReduceResult }> => {
    return new Promise((resolve, reject) => {
      const id = ++requestSeq;
      const store = usePdbStore.getState();
      const paletteColors = store.palette.colors.map((c) => ({
        id: c.id,
        hex: c.hex,
        rgb: c.rgb,
      }));

      let worker: Worker;
      try {
        worker = new Worker(new URL('../imaging/worker.ts', import.meta.url), { type: 'module' });
      } catch {
        reject(new Error('Worker 不可用'));
        return;
      }
      workerRef.current = worker;

      worker.onerror = () => {
        worker.terminate();
        workerRef.current = null;
        reject(new Error('Worker 执行出错'));
      };

      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (msg.id !== id) return;

        if (msg.type === 'progress') {
          onProgress(msg.percent, msg.stage);
        } else if (msg.type === 'result') {
          worker.terminate();
          workerRef.current = null;
          const r = msg as WorkerResult;
          resolve({
            reduceResult: {
              beads: r.beads,
              usedColorIndices: r.usedColorIndices,
              quantized: r.quantized,
              maxDeltaE: r.maxDeltaE,
              mapping: r.mapping,
            },
          });
        } else if (msg.type === 'error') {
          worker.terminate();
          workerRef.current = null;
          reject(new Error(msg.message));
        }
      };

      const { buffer, mime } = payload;
      if (cancelledRef.current) {
        worker.terminate();
        workerRef.current = null;
        reject(new Error('cancelled'));
        return;
      }
      const pixelOpts: PixelateOpts = {
        cols: opts.cols,
        rows: opts.rows,
        sampling: opts.sampling,
        preprocess: { brightness: opts.brightness, contrast: opts.contrast, saturation: opts.saturation },
        transparentAsEmpty: opts.transparentAsEmpty,
        beadGrid: opts.beadReverse ? { angleDeg: opts.gridAngle, offsetX: opts.gridOffsetX, offsetY: opts.gridOffsetY, radiusRatio: 0.32 } : undefined,
      perspective: opts.perspectiveCorners ? { corners: opts.perspectiveCorners } : undefined,
        samplingCap: 60000,
        bgRemove: opts.bgRemove ? { tolerance: opts.bgTolerance } : undefined,
        highlightProtect: opts.highlightProtect,
      };
      worker.postMessage(
        {
          id,
          type: 'process',
          buffer,
          mime,
          pixelateOpts: pixelOpts,
          reduceOpts: {
            colorCount: opts.colorCount,
            dither: opts.dither,
            fewColorExact: opts.fewColorExact,
            despeckle: opts.despeckle,
            mergeSimilarColors: opts.mergeSimilarColors,
            kmeansRefine: opts.kmeansRefine,
            chromaGate: opts.chromaGate,
            highlightProtect: opts.highlightProtect,
            paletteDedup: opts.paletteDedup,
          },
          paletteColors,
          fitMode: opts.fitMode,
        },
        [buffer],
      );
    });
  }, []);

  /** 解析裁剪选区 → 源像素矩形（null = 全图） */
  const resolveCropPixels = useCallback((crop: NormalizedCropRect | null | undefined, w: number, h: number): SourcePixelRect | null => {
    if (!crop) return null;
    const px = fromNormalized(crop, w, h);
    if (isFullImage(px, w, h)) return null;
    return cropRectToSourcePixels(crop, w, h);
  }, []);

  /** 构建 Worker payload：无裁剪时直接读文件，有裁剪时先裁再编码 PNG */
  const buildWorkerPayload = useCallback(async (
    file: File,
    cropPx: SourcePixelRect | null,
    onProgress: (pct: number, stage: string) => void,
  ): Promise<{ buffer: ArrayBuffer; mime: string }> => {
    if (!cropPx) {
      // 全图：直接传原始文件 buffer
      return { buffer: await file.arrayBuffer(), mime: file.type || 'image/png' };
    }
    // 有裁剪：先提取区域 RGBA → OffscreenCanvas → PNG blob → ArrayBuffer
    onProgress(32, '裁剪选区');
    const source = sourceRef.current;
    if (!source) throw new Error('图片源不可用');
    const cropped = toRgbaRegion(source.bitmap, cropPx.srcX, cropPx.srcY, cropPx.srcW, cropPx.srcH);
    if (cancelledRef.current) throw new Error('cancelled');

    const canvas = new OffscreenCanvas(cropped.width, cropped.height);
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(cropped.width, cropped.height);
    imgData.data.set(cropped.data);
    ctx.putImageData(imgData, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (cancelledRef.current) throw new Error('cancelled');
    return { buffer: await blob.arrayBuffer(), mime: 'image/png' };
  }, []);

  /** 执行流水线（Worker 优先，回退主线程） */
  const execute = useCallback(async (opts: ImportOptions): Promise<ReduceResult | null> => {
    if (!importFile?.rgba || !fileRef.current) return null;
    cancelledRef.current = false;
    setStage('cropping');
    setProgress(30);
    setError(null);

    const onProgress = (pct: number, _s: string): void => {
      setProgress(pct);
      if (pct >= 70) setStage('reducing');
      else if (pct >= 40) setStage('pixelating');
    };

    try {
      // 解析裁剪选区
      const cropPx = resolveCropPixels(opts.crop, importFile.width, importFile.height);

      // 如果有裁剪，主线程路径需要提取裁剪区域的 RGBA
      let workingRgba = importFile.rgba;
      if (cropPx && sourceRef.current) {
        onProgress(32, '裁剪选区');
        workingRgba = toRgbaRegion(sourceRef.current.bitmap, cropPx.srcX, cropPx.srcY, cropPx.srcW, cropPx.srcH);
        if (cancelledRef.current) { setStage('cancelled'); return null; }
      }

      setStage('pixelating');
      setProgress(35);

      let reduceResult: ReduceResult;

      // 尝试 Worker
      const canWorker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
      if (canWorker) {
        try {
          const payload = await buildWorkerPayload(fileRef.current, cropPx, onProgress);
          if (cancelledRef.current) { setStage('cancelled'); return null; }
          const wr = await runWorker(payload, opts, onProgress);
          reduceResult = wr.reduceResult;
        } catch (workerErr) {
          if (cancelledRef.current) { setStage('cancelled'); return null; }
          const errMsg = workerErr instanceof Error ? workerErr.message : '';
          if (errMsg === 'cancelled') { setStage('cancelled'); return null; }
          // Worker 失败，回退主线程
          console.warn('[PinDou] Worker 回退到主线程:', workerErr);
          const mr = await runMainThread(workingRgba, opts, onProgress);
          reduceResult = mr.reduceResult;
        }
      } else {
        const mr = await runMainThread(workingRgba, opts, onProgress);
        reduceResult = mr.reduceResult;
      }

      if (cancelledRef.current) { setStage('cancelled'); return null; }
      setResult(reduceResult);
      setStage('done');
      setProgress(100);
      return reduceResult;
    } catch (err) {
      if (cancelledRef.current) { setStage('cancelled'); return null; }
      const msg = err instanceof Error ? err.message : '处理失败';
      if (msg === 'cancelled') { setStage('cancelled'); return null; }
      setError(msg);
      setStage('error');
      pushToast('danger', msg);
      return null;
    }
  }, [importFile, runWorker, runMainThread, pushToast, resolveCropPixels, buildWorkerPayload]);

  /** 预览（不写入 store） */
  const preview = useCallback(async (opts: ImportOptions): Promise<ReduceResult | null> => {
    return execute(opts);
  }, [execute]);

  /** 确认并应用 */
  const confirm = useCallback(async (opts: ImportOptions) => {
    setStage('applying');
    const r = await execute(opts);
    if (!r) return;

    // 统一走 applyImportedBeads：尺寸同步 + 整板替换 + 可撤销 BoardEdit——
    // 导入落地后 Ctrl+Z 可完整回到导入前（旧实现不接历史，撤销会把旧索引写进新数组）
    const store = usePdbStore.getState();
    if (!store.applyImportedBeads(r.beads, { cols: opts.cols, rows: opts.rows })) {
      setStage('error');
      return;
    }

    // 把源图挂到项目素材中：超过 2MB 内嵌上限时自动压缩到上限内，保证随项目保存
    if (fileRef.current) {
      try {
        const dataUrl = await fileToDataUrl(fileRef.current);
        if (dataUrl) {
          const attached = await attachProjectSourceImage({ name: fileRef.current.name, dataUrl });
          if (attached?.compressed) {
            pushToast('info', `源图超过 2MB，已自动压缩（${formatMb(attached.bytes)}）后随项目保存`, 3600);
          }
        }
      } catch (err) {
        console.warn('[PinDou] 源图素材挂载失败，图案已正常生成:', err);
      }
    }

    setStage('done');
    setDialogOpen(false);
    pushToast('success', `已生成 ${opts.cols}×${opts.rows} 图案，共 ${r.usedColorIndices.length} 色（Ctrl+Z 可撤销导入）`);
  }, [execute, pushToast]);

  return {
    stage,
    progress,
    error,
    importFile,
    result,
    openFileDialog,
    start,
    cancel,
    confirm,
    preview,
    reset,
    dialogOpen,
    setDialogOpen,
  };
}
