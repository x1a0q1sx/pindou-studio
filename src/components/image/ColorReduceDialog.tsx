/**
 * src/components/image/ColorReduceDialog.tsx —— 颜色缩减对话框。
 * 目标颜色数 2–64 滑杆、多档实时预览对比、抖动开关、映射表展示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Slider } from '@/components/ui/Slider';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { usePdbStore } from '@/store';
import { buildPreview, type ReduceResult, type PreviewResult } from '@/imaging/pipeline';
import type { ImportOptions } from '@/hooks/useImageImport';
import './image.css';

export interface ColorReduceDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** 像素化后的 cells（Uint32Array） */
  cells: Uint32Array | null;
  cols: number;
  rows: number;
  /** 当前选项 */
  opts: ImportOptions;
  onOptsChange: (patch: Partial<ImportOptions>) => void;
  /** 最终 reduce 结果 */
  result: ReduceResult | null;
  /** 正在处理 */
  processing: boolean;
  /** 确认按钮文案（默认「应用到画板」；导入向导中为「生成图案」） */
  confirmLabel?: string;
}

/** 多档对比的颜色数 */
const COMPARE_LEVELS = [8, 16, 24, 32];

export function ColorReduceDialog({
  open, onClose, onConfirm, cells, cols, rows, opts, onOptsChange, result, processing,
  confirmLabel = '应用到画板',
}: ColorReduceDialogProps) {
  const palette = usePdbStore((s) => s.palette);
  const [previews, setPreviews] = useState<Map<number, PreviewResult>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 多档预览计算
  useEffect(() => {
    if (!open || !cells) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const map = new Map<number, PreviewResult>();
      for (const k of COMPARE_LEVELS) {
        try {
          const p = buildPreview(cells, cols, rows, palette.colors, k, opts.dither, opts.fewColorExact, {
            despeckle: opts.despeckle,
            mergeSimilarColors: opts.mergeSimilarColors,
            chromaGate: opts.chromaGate,
            highlightProtect: opts.highlightProtect,
            paletteDedup: opts.paletteDedup,
          });
          map.set(k, p);
        } catch {
          // 忽略单档失败
        }
      }
      setPreviews(map);
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [open, cells, cols, rows, palette.colors, opts.dither, opts.fewColorExact, opts.despeckle, opts.mergeSimilarColors, opts.chromaGate, opts.highlightProtect, opts.paletteDedup]);

  const renderMiniPreview = useCallback((preview: PreviewResult, size: number) => {
    const cellSize = Math.max(1, Math.floor(size / Math.max(preview.cols, preview.rows)));
    return (
      <canvas
        width={preview.cols * cellSize}
        height={preview.rows * cellSize}
        ref={(canvas) => {
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          for (let i = 0; i < preview.grid.length; i++) {
            const hex = preview.grid[i];
            if (!hex) continue;
            const r = Math.floor(i / preview.cols);
            const c = i % preview.cols;
            ctx.fillStyle = hex;
            ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
          }
        }}
        className="pdb-reduce__mini-canvas"
        style={{ width: size, height: size * (preview.rows / preview.cols) }}
        aria-label={`${preview.colorCount} 色预览`}
      />
    );
  }, []);

  if (!open) return null;

  return (
    <Modal
      open={open}
      title="自动配色"
      onClose={onClose}
      footer={
        <div className="pdb-reduce__footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={onConfirm} disabled={processing || !result}>
            <PdbIcon name="checkCircle" size={15} />
            {processing ? '处理中…' : confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="pdb-reduce">
        {/* 颜色数滑杆 */}
        <div className="pdb-reduce__slider-row">
          <label className="pdb-reduce__label">目标颜色数</label>
          <Slider
            min={2}
            max={64}
            step={1}
            value={opts.colorCount}
            onValueChange={(v) => onOptsChange({ colorCount: v })}
            format={(v) => `${v} 色`}
          />
        </div>

        {/* 抖动开关 */}
        <div className="pdb-reduce__switch-row">
          <Switch
            checked={opts.dither}
            onChange={(v) => onOptsChange({ dither: v })}
            label="Floyd-Steinberg 抖动（增加色彩过渡，但颗粒感更强）"
          />
        </div>

        {/* 少量色优化：像素画/线稿唯一色不超过目标色数时，精确保留原图色 */}
        <div className="pdb-reduce__switch-row">
          <Switch
            checked={opts.fewColorExact}
            onChange={(v) => onOptsChange({ fewColorExact: v })}
            label="少量色精确保留（原图颜色数 ≤ 目标色数时跳过量化和抖动，原图色零损失）"
          />
        </div>

        {/* 去杂色 + 近似色合并（缺陷 #34）：抗锯齿/JPEG 噪点导致的碎杂色 */}
        <div className="pdb-reduce__switch-row">
          <Switch
            checked={opts.despeckle}
            onChange={(v) => onOptsChange({ despeckle: v })}
            label="去杂色（清理与邻域接近的孤立点；高对比的单像素细节会保留，开启抖动时自动跳过）"
          />
        </div>
        <div className="pdb-reduce__switch-row">
          <Switch
            checked={opts.mergeSimilarColors}
            onChange={(v) => onOptsChange({ mergeSimilarColors: v })}
            label="合并近似色（ΔE<8 的量化碎色先合并再匹配色板，颜色更整、杂色更少）"
          />
        </div>
        {/* 色度门控 + 高光保护 + 近似色号合并：色彩还原三大增强 */}
        <div className="pdb-reduce__switch-row">
          <Switch
            checked={opts.chromaGate}
            onChange={(v) => onOptsChange({ chromaGate: v })}
            label="色度门控（低饱和暗部按灰阶匹配：黑发不再识别成棕色，纯色区域色号更统一）"
          />
        </div>
        <div className="pdb-reduce__switch-row">
          <Switch
            checked={opts.highlightProtect}
            onChange={(v) => onOptsChange({ highlightProtect: v })}
            label="高光保护（瞳孔反光等小面积白色高光强制保留，不再被平均成糊色）"
          />
        </div>
        <div className="pdb-reduce__switch-row">
          <Switch
            checked={opts.paletteDedup}
            onChange={(v) => onOptsChange({ paletteDedup: v })}
            label="近似色号合并（色板上 ΔE<2.8 的色号肉眼难分，自动用格数多的那个，色号更精简）"
          />
        </div>

        {/* 多档对比 */}
        <div className="pdb-reduce__compare">
          <span className="pdb-reduce__label">多档对比</span>
          <div className="pdb-reduce__compare-grid">
            {COMPARE_LEVELS.map((k) => {
              const p = previews.get(k);
              const isActive = opts.colorCount === k;
              return (
                <button
                  key={k}
                  type="button"
                  className={`pdb-reduce__compare-item ${isActive ? 'is-active' : ''}`}
                  onClick={() => onOptsChange({ colorCount: k })}
                >
                  {p ? renderMiniPreview(p, 80) : <div className="pdb-reduce__compare-placeholder" />}
                  <span className="pdb-reduce__compare-label">{k} 色</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 结果摘要 */}
        {result && (
          <div className="pdb-reduce__summary">
            <div className="pdb-reduce__summary-head">
              <PdbIcon name="success" size={16} />
              <span>
                识别出 {result.usedColorIndices.length} 色，已匹配到
                {palette.brand}「{palette.name}」色号，
                最大色差 ΔE={result.maxDeltaE.toFixed(1)}
                {result.mapping.length > 0 && (() => {
                  const worst = result.mapping.reduce((a, b) => a.deltaE > b.deltaE ? a : b);
                  const c = palette.colors[worst.toColorIndex];
                  return c ? `（${c.code} ${c.nameZh ?? c.name}）` : '';
                })()}
              </span>
            </div>
            <div className="pdb-reduce__mapping-table">
              <div className="pdb-reduce__mapping-header">
                <span>原色</span>
                <span>→</span>
                <span>匹配色</span>
                <span>ΔE</span>
              </div>
              <div className="pdb-reduce__mapping-scroll">
                {result.mapping.map((m, i) => {
                  const c = palette.colors[m.toColorIndex];
                  return (
                    <div key={i} className="pdb-reduce__mapping-row">
                      <span className="pdb-reduce__swatch" style={{ background: m.fromHex }} title={m.fromHex} />
                      <span className="pdb-reduce__arrow">→</span>
                      <span className="pdb-reduce__swatch" style={{ background: c?.hex ?? '#000' }} title={c?.hex} />
                      <span className="pdb-reduce__color-name">{c ? `${c.code} ${c.nameZh ?? c.name}` : '?'}</span>
                      <span className={`pdb-reduce__delta ${m.deltaE > 10 ? 'is-warn' : ''}`}>
                        {m.deltaE.toFixed(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {processing && (
          <div className="pdb-reduce__processing">
            <span className="pdb-reduce__spinner" />
            正在计算配色方案…
          </div>
        )}
      </div>
    </Modal>
  );
}
