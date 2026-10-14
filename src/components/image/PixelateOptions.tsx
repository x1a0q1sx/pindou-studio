/**
 * src/components/image/PixelateOptions.tsx —— 像素化参数面板。
 * 目标格数、采样方式、亮度/对比度/饱和度预处理、透明处理开关。
 * 参数变化实时重算预览（防抖 150ms）。
 */
import { useCallback, useEffect, useRef } from 'react';
import { Slider } from '@/components/ui/Slider';
import { Switch } from '@/components/ui/Switch';
import { Segmented } from '@/components/ui/Segmented';
import { NumberField } from '@/components/ui/NumberField';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import type { ImportOptions } from '@/hooks/useImageImport';
import type { ReduceResult } from '@/imaging/pipeline';
import type { NormalizedCropRect } from '@/imaging/cropRect';
import { PerspectiveFrame } from './PerspectiveFrame';
import './image.css';

export interface PixelateOptionsProps {
  opts: ImportOptions;
  onOptsChange: (patch: Partial<ImportOptions>) => void;
  /** 预览结果（像素化+配色后的 beads） */
  previewResult: ReduceResult | null;
  /** 预览计算中 */
  previewing: boolean;
  /** 触发预览重算 */
  onPreview: () => void;
  /** palette colors hex 数组（用于预览渲染） */
  paletteHexes: string[];
  /** 源图预览 URL（逆向模式的对位图用；不传则不显示对位图） */
  sourceUrl?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  /** 裁剪选区（对位图网格/四角的坐标基准） */
  crop?: NormalizedCropRect | null;
}

export function PixelateOptions({
  opts, onOptsChange, previewResult, previewing, onPreview, paletteHexes,
  sourceUrl, sourceWidth, sourceHeight, crop,
}: PixelateOptionsProps) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 防抖 150ms 触发预览
  const schedulePreview = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onPreview();
    }, 150);
  }, [onPreview]);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const update = useCallback((patch: Partial<ImportOptions>) => {
    onOptsChange(patch);
    schedulePreview();
  }, [onOptsChange, schedulePreview]);

  // 渲染预览网格
  const renderPreview = () => {
    if (!previewResult) return null;
    const { beads } = previewResult;
    const cols = opts.cols;
    const rows = opts.rows;
    const cellSize = Math.max(2, Math.min(6, Math.floor(240 / Math.max(cols, rows))));

    return (
      <canvas
        ref={(canvas) => {
          if (!canvas) return;
          canvas.width = cols * cellSize;
          canvas.height = rows * cellSize;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const v = beads[r * cols + c];
              if (v === 0) {
                // 空格棋盘格（马赛克）：去背景/留空一眼可辨
                const half = cellSize / 2;
                ctx.fillStyle = '#f2f2f2';
                ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
                ctx.fillStyle = '#c9c9c9';
                ctx.fillRect(c * cellSize, r * cellSize, half, half);
                ctx.fillRect(c * cellSize + half, r * cellSize + half, half, half);
                continue;
              }
              const hex = paletteHexes[v - 1];
              if (!hex) continue;
              ctx.fillStyle = hex;
              ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
            }
          }
        }}
        className="pdb-pixelate__preview-canvas"
        aria-label="像素化预览"
      />
    );
  };

  return (
    <div className="pdb-pixelate">
      <div className="pdb-pixelate__controls">
        <div className="pdb-pixelate__row">
          <label className="pdb-pixelate__label">目标格数</label>
          <div className="pdb-pixelate__grid-inputs">
            <NumberField
              value={opts.cols}
              onValueChange={(v) => update({ cols: Math.max(1, Math.min(300, v)) })}
              min={1}
              max={300}
            />
            <span className="pdb-pixelate__x">×</span>
            <NumberField
              value={opts.rows}
              onValueChange={(v) => update({ rows: Math.max(1, Math.min(300, v)) })}
              min={1}
              max={300}
            />
          </div>
        </div>

        <div className="pdb-pixelate__row">
          <label className="pdb-pixelate__label">采样方式</label>
          <Segmented<'area-average' | 'center'>
            ariaLabel="采样方式"
            value={opts.sampling}
            options={[
              { value: 'area-average', label: '区域平均' },
              { value: 'center', label: '中心取样' },
            ]}
            onChange={(v) => update({ sampling: v })}
          />
        </div>

        <div className="pdb-pixelate__row">
          <label className="pdb-pixelate__label">亮度</label>
          <Slider
            min={-100}
            max={100}
            step={1}
            value={opts.brightness}
            onValueChange={(v) => update({ brightness: v })}
            format={(v) => `${v > 0 ? '+' : ''}${v}`}
          />
        </div>

        <div className="pdb-pixelate__row">
          <label className="pdb-pixelate__label">对比度</label>
          <Slider
            min={-100}
            max={100}
            step={1}
            value={opts.contrast}
            onValueChange={(v) => update({ contrast: v })}
            format={(v) => `${v > 0 ? '+' : ''}${v}`}
          />
        </div>

        <div className="pdb-pixelate__row">
          <label className="pdb-pixelate__label">饱和度</label>
          <Slider
            min={-100}
            max={100}
            step={1}
            value={opts.saturation}
            onValueChange={(v) => update({ saturation: v })}
            format={(v) => `${v > 0 ? '+' : ''}${v}`}
          />
        </div>

        {/* 成品拼豆逆向 */}
        <div className="pdb-pixelate__row">
          <Switch
            checked={opts.beadReverse}
            onChange={(v) => update({ beadReverse: v, fitMode: v ? 'stretch' : opts.fitMode })}
            label="成品拼豆逆向（导入的是已完成的实物拼豆照片/图纸：按豆心逐颗取色，避开豆间缝隙；适配模式自动切为拉伸，用裁剪框框住拼豆区域）"
          />
        </div>
        {opts.beadReverse && (
          <>
            <div className="pdb-pixelate__row pdb-pixelate__row--indent">
              <label className="pdb-pixelate__label">旋转角</label>
              <Slider
                min={-20}
                max={20}
                step={0.5}
                value={opts.gridAngle}
                onValueChange={(v) => update({ gridAngle: v })}
                format={(v) => `${v}°`}
                aria-label="网格旋转角"
                title="拍歪了的角度：调到网格竖线与预览格子对齐"
              />
            </div>
            <div className="pdb-pixelate__row pdb-pixelate__row--indent">
              <label className="pdb-pixelate__label">水平微调</label>
              <Slider
                min={-0.5}
                max={0.5}
                step={0.05}
                value={opts.gridOffsetX}
                onValueChange={(v) => update({ gridOffsetX: v })}
                format={(v) => `${Math.round(v * 100)}%`}
                aria-label="网格水平微调"
                title="以豆距为单位左右挪网格，让每格套住一颗豆"
              />
            </div>
            <div className="pdb-pixelate__row pdb-pixelate__row--indent">
              <label className="pdb-pixelate__label">垂直微调</label>
              <Slider
                min={-0.5}
                max={0.5}
                step={0.05}
                value={opts.gridOffsetY}
                onValueChange={(v) => update({ gridOffsetY: v })}
                format={(v) => `${Math.round(v * 100)}%`}
                aria-label="网格垂直微调"
                title="以豆距为单位上下挪网格"
              />
            </div>
            <p className="pdb-pixelate__hint">调法：先调旋转角 → 再调水平/垂直微调，直到对位图里每条网格线都从豆心穿过。</p>

            {/* 四角透视校正 + 对位图（体验优化 #6） */}
            {sourceUrl && sourceWidth && sourceHeight && (
              <>
                <div className="pdb-pixelate__row pdb-pixelate__row--indent">
                  <Switch
                    checked={!!opts.perspectiveCorners}
                    onChange={(v) => update({
                      perspectiveCorners: v
                        ? [{ x: 0.04, y: 0.04 }, { x: 0.96, y: 0.04 }, { x: 0.96, y: 0.96 }, { x: 0.04, y: 0.96 }]
                        : null,
                    })}
                    label="四角透视校正（照片拍歪/斜拍时开启：拖动对位图上的 4 个黄色手柄框住拼豆区域四角，采样前自动拉正）"
                  />
                </div>
                <PerspectiveFrame
                  src={sourceUrl}
                  imgWidth={sourceWidth}
                  imgHeight={sourceHeight}
                  crop={crop ?? null}
                  cols={opts.cols}
                  rows={opts.rows}
                  angleDeg={opts.gridAngle}
                  offsetX={opts.gridOffsetX}
                  offsetY={opts.gridOffsetY}
                  corners={opts.perspectiveCorners ?? null}
                  onCornersChange={(c) => update({ perspectiveCorners: c })}
                />
              </>
            )}
          </>
        )}
        <div className="pdb-pixelate__row">
          <Switch
            checked={opts.transparentAsEmpty}
            onChange={(v) => update({ transparentAsEmpty: v })}
            label="透明像素视为空格"
          />
        </div>

        {/* 去背景：边缘取色 + 连通洪泛，背景变空格 */}
        <div className="pdb-pixelate__row">
          <Switch
            checked={opts.bgRemove}
            onChange={(v) => update({ bgRemove: v })}
            label="去背景（自动识别图片边缘的背景色，与边缘连通的相似区域变空格；主体内部同色不受影响）"
          />
        </div>
        {opts.bgRemove && (
          <div className="pdb-pixelate__row pdb-pixelate__row--indent">
            <label className="pdb-pixelate__label">容差</label>
            <Slider
              min={0}
              max={100}
              step={1}
              value={opts.bgTolerance}
              onValueChange={(v) => update({ bgTolerance: v })}
              format={(v) => `${v}`}
              aria-label="去背景容差"
              title="越小要求颜色越接近背景色才被去除；背景有渐变/光影时调大，主体被误吞时调小"
            />
          </div>
        )}

        {(opts.brightness !== 0 || opts.contrast !== 0 || opts.saturation !== 0) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => update({ brightness: 0, contrast: 0, saturation: 0 })}
          >
            <PdbIcon name="undo" size={13} />
            重置调色
          </Button>
        )}
      </div>

      <div className="pdb-pixelate__preview">
        <div className="pdb-pixelate__preview-header">
          <span className="pdb-pixelate__label">预览</span>
          {previewing && <span className="pdb-pixelate__computing">计算中…</span>}
        </div>
        <div className="pdb-pixelate__preview-box">
          {renderPreview()}
          {!previewResult && !previewing && (
            <span className="pdb-pixelate__placeholder">调整参数后自动生成预览</span>
          )}
        </div>
      </div>
    </div>
  );
}
