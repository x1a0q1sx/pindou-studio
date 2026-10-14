/**
 * src/components/image/ImportDialog.tsx —— 图片导入多步向导。
 *
 * 步骤：① 选择/拖拽/粘贴图片 → ② CropFrame 裁剪（锁定 cols:rows 比例 + FitMode）
 *       → ③ PixelateOptions 像素化参数（格数/采样/亮度/对比度/饱和度/透明处理，实时预览）
 *       → ④ ColorReduceDialog 颜色数（2–64）+ 抖动 + 目标色板选择 → 应用到画板 beads。
 *
 * 数据流：全部参数汇聚为单一 ImportOptions（含 crop），像素化与配色直接调用
 * imaging 纯函数（pixelateFromRgba / reduceToPaletteGrid），与 useImageImport 主线程
 * 路径逐字段同构；应用时经 store.applyImportedBeads 落地（Uint16Array，索引+1，0=空；可撤销）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { PdbIcon } from '@/components/icons';
import { usePdbStore } from '@/store';
import { validateFile, toRgbaRegion, fileToDataUrl } from '@/imaging/loader';
import type { RgbaData } from '@/imaging/loader';
import { attachProjectSourceImage } from '@/store/persistence';
import {
  fromNormalized,
  isFullImage,
  type NormalizedCropRect,
} from '@/imaging/cropRect';
import {
  fitRect,
  pixelateFromRgba,
  reduceToPaletteGrid,
  type ReduceResult,
} from '@/imaging/pipeline';
import { listPalettes, getPalette } from '@/palettes';
import { CropFrame } from './CropFrame';
import { PixelateOptions } from './PixelateOptions';
import { ColorReduceDialog } from './ColorReduceDialog';
import { sampleGridCells } from '@/imaging/gridPattern';
import type { UseImageImportReturn, ImportOptions } from '@/hooks/useImageImport';
import { DEFAULT_IMPORT_OPTIONS } from '@/hooks/useImageImport';
import './image.css';

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  importer: UseImageImportReturn;
}

/** 向导步骤（pick 只在未选文件时出现，不参与步进条编号）；grid=色号图纸模式专属 */
type WizardStep = 'pick' | 'crop' | 'grid' | 'pixelate' | 'reduce';

/** 与 useImageImport.runMainThread 相同的采样上限 */
const SAMPLING_CAP = 60000;

export function ImportDialog({ open, onClose, importer }: ImportDialogProps) {
  const { stage, progress, error, importFile, openFileDialog, start, cancel, reset } = importer;
  const pushToast = usePdbStore((s) => s.pushToast);
  const board = usePdbStore((s) => s.board);
  const palette = usePdbStore((s) => s.palette);
  const paletteId = usePdbStore((s) => s.paletteId);
  const setPaletteId = usePdbStore((s) => s.setPaletteId);

  /* ---- 向导状态 ---- */
  const [step, setStep] = useState<WizardStep>('pick');
  const [opts, setOpts] = useState<ImportOptions>(() => ({ ...DEFAULT_IMPORT_OPTIONS }));
  const [dragOver, setDragOver] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  /* ---- 色号图纸模式状态 ---- */
  const [gridMode, setGridMode] = useState(false);
  const [gridCols, setGridCols] = useState(101);
  const [gridRows, setGridRows] = useState(100);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const [gridZoom, setGridZoom] = useState(1);

  /* ---- 中间产物：像素化 cells + 配色预览/最终结果 ---- */
  const [cells, setCells] = useState<Uint32Array | null>(null);
  const [preview, setPreview] = useState<ReduceResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reduceResult, setReduceResult] = useState<ReduceResult | null>(null);
  const [reducing, setReducing] = useState(false);
  const [applying, setApplying] = useState(false);

  // computePixelPreview 的稳定引用（PixelateOptions 内部防抖依赖它）
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // 预览计算序号（异步解码回采时丢弃过期结果）
  const previewSeqRef = useRef(0);
  // 裁剪区域解码缓存（按 previewUrl 复用同一张 HTMLImageElement，与 hook 的 toRgbaRegion 路径同源）
  const cropImgRef = useRef<{ url: string; img: HTMLImageElement } | null>(null);

  /** 解码 previewUrl 为 HTMLImageElement（缓存，供裁剪区域 RGBA 提取） */
  const decodeCropImage = useCallback((url: string): Promise<HTMLImageElement> => {
    const cached = cropImgRef.current;
    if (cached && cached.url === url) return Promise.resolve(cached.img);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        cropImgRef.current = { url, img };
        resolve(img);
      };
      img.onerror = () => reject(new Error('预览图解码失败'));
      img.src = url;
    });
  }, []);

  /* ---- 打开时同步板尺寸为默认目标格数 ---- */
  useEffect(() => {
    if (open) setOpts((o) => ({ ...o, cols: board.cols, rows: board.rows }));
    // 仅在打开瞬间同步；board 后续变化由用户在第 ③ 步自行调整
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* ---- 新文件加载完成 → 进入裁剪步骤并清空中间产物 ---- */
  useEffect(() => {
    if (importFile) {
      setStep('crop');
      setCells(null);
      setPreview(null);
      setReduceResult(null);
    }
  }, [importFile]);

  /* ---- 关闭时重置（含 importer 状态机） ---- */
  const handleClose = useCallback(() => {
    reset();
    setStep('pick');
    setOpts({ ...DEFAULT_IMPORT_OPTIONS });
    setCells(null);
    setPreview(null);
    setReduceResult(null);
    setPreviewing(false);
    setReducing(false);
    setApplying(false);
    onClose();
  }, [reset, onClose]);

  /* ---- 粘贴图片支持 ---- */
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            void start(file);
            e.preventDefault();
          }
          return;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, start]);

  /* ---- 拖拽 ---- */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const v = validateFile(file);
    if (!v.valid) {
      pushToast('danger', v.error ?? '文件格式不支持');
      return;
    }
    void start(file);
  }, [start, pushToast]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleFileInput = useCallback(() => {
    openFileDialog();
  }, [openFileDialog]);

  /* ---- 裁剪 ---- */
  const handleCropChange = useCallback((rect: NormalizedCropRect) => {
    setOpts((o) => ({ ...o, crop: rect }));
  }, []);

  const handleFitModeChange = useCallback((mode: ImportOptions['fitMode']) => {
    setOpts((o) => ({ ...o, fitMode: mode }));
  }, []);

  /**
   * 像素化 + 配色预览（第 ③ 步实时预览 / 进入第 ③ 步时首算）。
   * 与 useImageImport 主线程路径逐字段同构：
   *   裁剪区域 RGBA → fitRect(fitMode) → pixelateFromRgba → reduceToPaletteGrid。
   */
  const computePixelPreview = useCallback(() => {
    const f = importFile;
    if (!f?.rgba) return;
    const fullRgba: RgbaData = f.rgba;
    const o = optsRef.current;
    const seq = ++previewSeqRef.current;

    // 1. 解析裁剪选区 → 工作 RGBA（null/全图 = 整幅）
    let working: RgbaData = fullRgba;
    let needAsyncCrop = false;
    if (o.crop) {
      const px = fromNormalized(o.crop, f.width, f.height);
      if (!isFullImage(px, f.width, f.height)) {
        const cached = cropImgRef.current;
        if (cached && cached.url === f.previewUrl) {
          working = toRgbaRegion(cached.img, px.x, px.y, px.w, px.h);
        } else {
          needAsyncCrop = true;
        }
      }
    }

    const run = (src: RgbaData): void => {
      if (seq !== previewSeqRef.current) return; // 已被更新的计算取代
      try {
        setPreviewing(true);
        // 2. 像素化（fitRect + 采样 + 预处理 + 透明处理，与 hook 同参数）
        const pixel = pixelateFromRgba(src, {
          cols: o.cols,
          rows: o.rows,
          sampling: o.sampling,
          preprocess: { brightness: o.brightness, contrast: o.contrast, saturation: o.saturation },
          transparentAsEmpty: o.transparentAsEmpty,
          beadGrid: o.beadReverse ? { angleDeg: o.gridAngle, offsetX: o.gridOffsetX, offsetY: o.gridOffsetY, radiusRatio: 0.32 } : undefined,
          perspective: o.perspectiveCorners ? { corners: o.perspectiveCorners } : undefined,
          samplingCap: SAMPLING_CAP,
          highlightProtect: o.highlightProtect,
          fit: fitRect(src.width, src.height, o.cols, o.rows, o.fitMode),
        });
        setCells(pixel.cells);
        // 3. 配色到当前色板（预览与第 ④ 步结果同源；选项与 useImageImport 逐字段一致）
        const r = reduceToPaletteGrid(pixel.cells, pixel.cols, pixel.rows, palette.colors, {
          colorCount: o.colorCount,
          dither: o.dither,
          fewColorExact: o.fewColorExact,
          despeckle: o.despeckle,
          mergeSimilarColors: o.mergeSimilarColors,
          chromaGate: o.chromaGate,
          highlightProtect: o.highlightProtect,
          paletteDedup: o.paletteDedup,
        });
        setPreview(r);
      } catch {
        setPreview(null);
      } finally {
        setPreviewing(false);
      }
    };

    if (!needAsyncCrop) {
      run(working);
      return;
    }
    // 首次需要裁剪区域：异步解码后重算（previewUrl 已由 hook 创建，与 hook 的 bitmap 同源）
    setPreviewing(true);
    void decodeCropImage(f.previewUrl)
      .then((img) => {
        const o2 = optsRef.current;
        const px = o2.crop ? fromNormalized(o2.crop, f.width, f.height) : null;
        const src = px && !isFullImage(px, f.width, f.height)
          ? toRgbaRegion(img, px.x, px.y, px.w, px.h)
          : fullRgba;
        run(src);
      })
      .catch(() => setPreviewing(false));
  }, [importFile, palette.colors, decodeCropImage]);

  /* ---- 步骤导航 ---- */
  const goToPixelate = useCallback(() => {
    setStep('pixelate');
    computePixelPreview();
  }, [computePixelPreview]);

  const goToGrid = useCallback(() => {
    setStep('grid');
  }, []);

  /** 色号图纸：按网格逐格采样 → 直接进入配色确认（跳过照片式像素化） */
  const runGridSample = useCallback(async (): Promise<void> => {
    const f = importFile;
    if (!f?.rgba) return;
    const W = Math.max(2, Math.min(200, Math.floor(gridCols)));
    const H = Math.max(2, Math.min(200, Math.floor(gridRows)));
    try {
      const px = opts.crop ? fromNormalized(opts.crop, f.width, f.height) : null;
      let src: RgbaData = f.rgba;
      if (px && !isFullImage(px, f.width, f.height)) {
        const img = await decodeCropImage(f.previewUrl);
        src = toRgbaRegion(img, px.x, px.y, px.w, px.h);
      }
      const sampled = sampleGridCells(src, W, H);
      // 图纸保真优先：关闭照片向导的一切「聪明」处理，逐格颜色直接匹配色板
      setOpts((o) => ({
        ...o,
        cols: W,
        rows: H,
        colorCount: 64,
        dither: false,
        despeckle: false,
        mergeSimilarColors: false,
        chromaGate: false,
        highlightProtect: false,
        fewColorExact: true,
        kmeansRefine: false,
      }));
      setCells(sampled.cells);
      setStep('reduce');
    } catch {
      pushToast('danger', '网格采样失败，请检查裁剪区域与行列数');
    }
  }, [importFile, gridCols, gridRows, opts.crop, decodeCropImage, pushToast]);

  const goToReduce = useCallback(() => {
    if (!cells) return;
    setStep('reduce');
  }, [cells]);

  const goToCrop = useCallback(() => {
    setStep('crop');
    setCells(null);
    setPreview(null);
    setReduceResult(null);
  }, []);

  const goToPixelateFromReduce = useCallback(() => {
    setStep('pixelate');
    setReduceResult(null);
  }, []);

  /* ---- 第 ③ 步：参数修改（PixelateOptions 内部防抖 150ms 后回调 onPreview） ---- */
  const handleOptsChange = useCallback((patch: Partial<ImportOptions>) => {
    setOpts((o) => ({ ...o, ...patch }));
  }, []);

  /* ---- 第 ④ 步：颜色数/抖动/去杂色/合并变化 → 重算配色（防抖） ---- */
  const reduceDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (step !== 'reduce' || !cells) return;
    setReducing(true);
    if (reduceDebounceRef.current) clearTimeout(reduceDebounceRef.current);
    reduceDebounceRef.current = setTimeout(() => {
      try {
        const r = reduceToPaletteGrid(cells, opts.cols, opts.rows, palette.colors, {
          colorCount: opts.colorCount,
          dither: opts.dither,
          fewColorExact: opts.fewColorExact,
          despeckle: opts.despeckle,
          mergeSimilarColors: opts.mergeSimilarColors,
          chromaGate: opts.chromaGate,
          highlightProtect: opts.highlightProtect,
          paletteDedup: opts.paletteDedup,
        });
        setReduceResult(r);
      } catch {
        setReduceResult(null);
      }
      setReducing(false);
    }, 120);
    return () => {
      if (reduceDebounceRef.current) clearTimeout(reduceDebounceRef.current);
    };
  }, [step, cells, opts.cols, opts.rows, opts.colorCount, opts.dither, opts.fewColorExact, opts.despeckle, opts.mergeSimilarColors, opts.chromaGate, opts.highlightProtect, opts.paletteDedup, palette.colors]);

  /* ---- 网格识别预览：裁剪区域 + W×H 网格线（红）---- */
  useEffect(() => {
    if (step !== 'grid' || !importFile) return;
    let cancelled = false;
    void (async () => {
      try {
        const img = await decodeCropImage(importFile.previewUrl);
        if (cancelled) return;
        const canvas = gridCanvasRef.current;
        if (!canvas) return;
        const px = optsRef.current.crop
          ? fromNormalized(optsRef.current.crop, importFile.width, importFile.height)
          : null;
        const sx = px ? px.x : 0;
        const sy = px ? px.y : 0;
        const sw = px ? px.w : importFile.width;
        const sh = px ? px.h : importFile.height;
        const fit = Math.min(880 / sw, 560 / sh);
        const scale = fit * gridZoom;
        canvas.width = Math.max(1, Math.round(sw * scale));
        canvas.height = Math.max(1, Math.round(sh * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        const W = Math.max(2, Math.floor(gridCols));
        const H = Math.max(2, Math.floor(gridRows));
        ctx.strokeStyle = 'rgba(255,64,64,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < W; i++) {
          const x = Math.round((canvas.width * i) / W) + 0.5;
          ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height);
        }
        for (let j = 1; j < H; j++) {
          const y = Math.round((canvas.height * j) / H) + 0.5;
          ctx.moveTo(0, y); ctx.lineTo(canvas.width, y);
        }
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,64,64,0.95)';
        ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
      } catch {
        /* 预览失败静默（识别时会再走一次解码并给出错误提示） */
      }
    })();
    return () => { cancelled = true; };
  }, [step, importFile, gridCols, gridRows, gridZoom, decodeCropImage]);

  /* ---- 第 ④ 步：应用到画板（beads 落地） ---- */
  const handleApply = useCallback(async () => {
    if (!reduceResult) return;
    setApplying(true);
    try {
      const store = usePdbStore.getState();
      // 统一走 applyImportedBeads：尺寸同步 + 整板替换 + 可撤销 BoardEdit（confirm 同款语义，
      // 落地后 Ctrl+Z 可回到导入前，且不会让旧撤销记录把失效索引写进新数组）
      if (!store.applyImportedBeads(reduceResult.beads, { cols: opts.cols, rows: opts.rows })) {
        return;
      }
      if (importFile) {
        try {
          const dataUrl = await fileToDataUrl(importFile.file);
          if (dataUrl) {
            const attached = await attachProjectSourceImage({ name: importFile.name, dataUrl });
            if (attached?.compressed) {
              pushToast('info', '源图超过 2MB，已自动压缩后随项目保存', 3600);
            }
          }
        } catch (err) {
          console.warn('[PinDou] 源图素材挂载失败，图案已正常生成:', err);
        }
      }
      const totalBeads = reduceResult.beads.reduce((s, v) => (v !== 0 ? s + 1 : s), 0);
      pushToast('success', `已生成 ${opts.cols}×${opts.rows} 图案，共 ${reduceResult.usedColorIndices.length} 色、${totalBeads} 颗豆${opts.beadReverse ? '（逆向自成品图）' : ''}。逐色清单与分块建议见「进度」页签`);
      handleClose();
    } finally {
      setApplying(false);
    }
  }, [reduceResult, opts.cols, opts.rows, importFile, pushToast, handleClose]);

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  /* ---- 渲染判定 ---- */
  const loading = stage === 'loading';
  const showPicker = !importFile && !loading;
  const showStepper = !!importFile && step !== 'pick';
  const paletteHexes = palette.colors.map((c) => c.hex);

  /** 步进条：图纸模式第②步是「网格识别」，照片模式是「像素化参数」 */
  const stepLabels = gridMode
    ? ['裁剪选区', '网格识别', '颜色与色板']
    : ['裁剪选区', '像素化参数', '颜色与色板'];
  const stepIndexOf = (s: WizardStep): number =>
    s === 'pick' ? -1 : s === 'crop' ? 0 : s === 'grid' || s === 'pixelate' ? 1 : 2;

  const renderStepper = () => (
    <ol className="pdb-wizard__steps">
      {stepLabels.map((label, i) => {
        const cur = stepIndexOf(step);
        const state = i < cur ? 'done' : i === cur ? 'active' : 'todo';
        const canJump =
          (i === 0 && cur > 0) ||
          (i === 1 && cur > 1) ||
          (i === 2 && cur < 2 && !!cells);
        return (
          <li key={label} className={`pdb-wizard__step is-${state}`}>
            {canJump ? (
              <button
                type="button"
                className="pdb-wizard__step-btn"
                onClick={() => {
                  if (i === 0) goToCrop();
                  else if (i === 1) { if (gridMode) goToGrid(); else goToPixelateFromReduce(); }
                  else goToReduce();
                }}
              >
                <span className="pdb-wizard__step-num">{i < cur ? '✓' : i + 1}</span>
                {label}
              </button>
            ) : (
              <span className="pdb-wizard__step-static">
                <span className="pdb-wizard__step-num">{i < cur ? '✓' : i + 1}</span>
                {label}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );

  return (
    <Modal open={open} title="导入图片" onClose={handleClose} wide={!!importFile}>
      <div className="pdb-import">
        {showStepper && renderStepper()}

        {/* Step ①: 选择文件（拖拽/点击/粘贴） */}
        {showPicker && (
          <div
            ref={dropRef}
            className={`pdb-import__dropzone ${dragOver ? 'is-dragover' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            role="button"
            tabIndex={0}
            onClick={handleFileInput}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleFileInput(); }}
          >
            <div className="pdb-import__dropzone-icon">
              <PdbIcon name="import" size={36} />
            </div>
            <p className="pdb-import__dropzone-text">
              拖拽图片到此处，或点击选择文件
            </p>
            <p className="pdb-import__dropzone-hint">
              支持 PNG / JPG / WebP / GIF / BMP，最大 32MB<br />
              也可以按 Ctrl+V 粘贴剪贴板中的图片
            </p>
          </div>
        )}

        {/* 加载进度 */}
        {loading && (
          <div className="pdb-import__progress">
            <div className="pdb-import__progress-bar">
              <div className="pdb-import__progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="pdb-import__progress-text">加载中 {progress}%</span>
            <Button variant="ghost" size="sm" onClick={cancel}>取消</Button>
          </div>
        )}

        {/* Step ②: 裁剪选区（CropFrame 锁定 cols:rows 比例 + FitMode） */}
        {step === 'crop' && importFile && (
          <>
            <div className="pdb-import__file-bar">
              <span className="pdb-import__name" title={importFile.name}>{importFile.name}</span>
              <span className="pdb-import__meta">
                {importFile.width} × {importFile.height} px · {formatSize(importFile.size)}
              </span>
              <Button variant="ghost" size="sm" onClick={handleFileInput}>
                <PdbIcon name="folderOpen" size={14} />
                换一张
              </Button>
            </div>
            <CropFrame
              src={importFile.previewUrl}
              imgWidth={importFile.width}
              imgHeight={importFile.height}
              cols={opts.cols}
              rows={opts.rows}
              fitMode={opts.fitMode}
              onFitModeChange={handleFitModeChange}
              onCropChange={handleCropChange}
            />
            <div className="pdb-import__gridmode">
              <Switch
                checked={gridMode}
                onChange={setGridMode}
                label="色号图纸模式"
                title="导入的是每格印着色号文字的图纸页（如社区导出图）时开启：按网格逐格取底色众数，跳过照片式量化，色号还原更准"
              />
              {gridMode && (
                <span className="pdb-import__gridmode-hint">
                  先用滚轮放大对齐图纸网格四边，下一步填入图纸标注的列×行（如 101×100）
                </span>
              )}
            </div>
            <div className="pdb-import__footer">
              <Button variant="ghost" size="sm" onClick={handleClose}>取消</Button>
              <Button variant="primary" size="sm" onClick={gridMode ? goToGrid : goToPixelate}>
                {gridMode ? '下一步：网格识别' : '下一步：像素化参数'}
                <PdbIcon name="chevronRight" size={14} />
              </Button>
            </div>
          </>
        )}

        {/* Step ②b: 色号图纸 · 网格识别（网格逐格取色，跳过像素化） */}
        {step === 'grid' && importFile && (
          <>
            <div className="pdb-import__gridbar">
              <label className="pdb-import__gridfield">
                <span className="pdb-label">列数（宽）</span>
                <input
                  className="pdb-input"
                  type="number"
                  min={2}
                  max={200}
                  value={gridCols}
                  onChange={(e) => setGridCols(Number(e.target.value) || 0)}
                />
              </label>
              <span className="pdb-import__gridx">×</span>
              <label className="pdb-import__gridfield">
                <span className="pdb-label">行数（高）</span>
                <input
                  className="pdb-input"
                  type="number"
                  min={2}
                  max={200}
                  value={gridRows}
                  onChange={(e) => setGridRows(Number(e.target.value) || 0)}
                />
              </label>
              <span className="pdb-crop__zoomctl">
                <Button variant="ghost" size="sm" onClick={() => setGridZoom((z) => Math.max(0.4, z / 1.25))}>－</Button>
                <span className="pdb-crop__zoomval">{Math.round(gridZoom * 100)}%</span>
                <Button variant="ghost" size="sm" onClick={() => setGridZoom((z) => Math.min(4, z * 1.25))}>＋</Button>
                <Button variant="ghost" size="sm" onClick={() => setGridZoom(1)}>适应</Button>
              </span>
              <span className="pdb-wizard__hint">红线=格子边界；对不上就微调裁剪或行列数</span>
            </div>
            <div className="pdb-import__gridwrap">
              <canvas ref={gridCanvasRef} className="pdb-import__gridcanvas" />
            </div>
            <div className="pdb-import__footer">
              <Button variant="ghost" size="sm" onClick={goToCrop}>
                <PdbIcon name="chevronLeft" size={14} />
                上一步：裁剪
              </Button>
              <Button variant="primary" size="sm" onClick={() => void runGridSample()} disabled={gridCols < 2 || gridRows < 2}>
                识别并生成图案（{Math.min(200, Math.max(2, Math.floor(gridCols)))}×{Math.min(200, Math.max(2, Math.floor(gridRows)))}）
                <PdbIcon name="chevronRight" size={14} />
              </Button>
            </div>
          </>
        )}

        {/* Step ③: 像素化参数（格数/采样/亮度/对比度/饱和度/透明处理 + 实时预览） */}
        {step === 'pixelate' && importFile && (
          <>
            <PixelateOptions
              opts={opts}
              onOptsChange={handleOptsChange}
              previewResult={preview}
              previewing={previewing}
              onPreview={computePixelPreview}
              paletteHexes={paletteHexes}
              sourceUrl={importFile.previewUrl}
              sourceWidth={importFile.width}
              sourceHeight={importFile.height}
              crop={opts.crop ?? null}
            />
            <div className="pdb-import__footer">
              <Button variant="ghost" size="sm" onClick={goToCrop}>
                <PdbIcon name="chevronLeft" size={14} />
                上一步：裁剪
              </Button>
              <Button variant="primary" size="sm" onClick={goToReduce} disabled={!preview}>
                下一步：颜色与色板
                <PdbIcon name="chevronRight" size={14} />
              </Button>
            </div>
          </>
        )}

        {/* Step ④: 颜色数 + 抖动 + 目标色板 → ColorReduceDialog 承载确认 */}
        {step === 'reduce' && importFile && (
          <>
            <div className="pdb-wizard__palette">
              <span className="pdb-wizard__palette-label">
                <PdbIcon name="color" size={14} />
                目标色板
              </span>
              <div className="pdb-wizard__palette-list">
                {listPalettes().map((p) => {
                  const active = p.id === paletteId;
                  const colors = getPalette(p.id).colors;
                  const stripStep = Math.max(1, Math.floor(colors.length / 12));
                  const strip: string[] = [];
                  for (let i = 0; i < colors.length && strip.length < 12; i += stripStep) strip.push(colors[i].hex);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`pdb-wizard__palette-item ${active ? 'is-active' : ''}`}
                      onClick={() => setPaletteId(p.id)}
                      aria-pressed={active}
                      title={p.source}
                    >
                      <span className="pdb-wizard__palette-name">
                        {p.brand} · {p.name}
                        {!p.builtin && <em className="pdb-wizard__palette-custom">自定义</em>}
                      </span>
                      <span className="pdb-wizard__palette-strip" aria-hidden>
                        {strip.map((hex, i) => <span key={i} style={{ background: hex }} />)}
                      </span>
                      <span className="pdb-wizard__palette-meta">{p.colorCount} 色 · 豆径 {p.beadSizeMm}mm</span>
                    </button>
                  );
                })}
              </div>
              <p className="pdb-crop__note">
                配色结果按所选色板匹配（CIEDE2000）；切换色板后自动重算。
              </p>
            </div>
            <div className="pdb-import__footer">
              <Button variant="ghost" size="sm" onClick={gridMode ? goToGrid : goToPixelateFromReduce}>
                <PdbIcon name="chevronLeft" size={14} />
                {gridMode ? '上一步：网格识别' : '上一步：像素化参数'}
              </Button>
              <span className="pdb-wizard__hint">颜色数与抖动在下方「自动配色」窗口中调整</span>
            </div>
            <ColorReduceDialog
              open
              onClose={goToPixelateFromReduce}
              onConfirm={handleApply}
              confirmLabel="生成图案"
              cells={cells}
              cols={opts.cols}
              rows={opts.rows}
              opts={opts}
              onOptsChange={handleOptsChange}
              result={reduceResult}
              processing={reducing || applying}
            />
          </>
        )}

        {/* 错误 */}
        {error && (
          <div className="pdb-import__error">
            <PdbIcon name="warning" size={15} />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
