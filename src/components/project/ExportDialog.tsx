/**
 * components/project/ExportDialog.tsx —— 导出对话框。
 *
 * 功能：
 *   1. 认领 'pdb:open-export' 事件（设 detail.handled=true 以取消 useHotkeys 的 TXT 兜底）；
 *   2. 7 种产物勾选组合 + DPI 选择 + 分块 splits 选择 + 预览图水印/主题选项；
 *   3. 批量导出调用 io/exporters.batchExport；
 *   4. James 失败语义处理：!ok → danger Toast + code==='too-large' 且有 suggestDpi → 「改用 XXX DPI 重试」按钮。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePdbStore } from '@/store';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { NumberField } from '@/components/ui/NumberField';
import { Switch } from '@/components/ui/Switch';
import {
  ALL_EXPORT_KINDS,
  EXPORT_LABELS,
  batchExport,
  type AllExportKind,
  type BatchExportProgress,
  type ExportOutcome,
  type PngExportOptions,
} from '@/io/exporters';
import type { ThemeId } from '@/core/types';
import './project.css';

/* ---- DPI 档位 ---- */
const DPI_OPTIONS = [
  { value: '150', label: '150' },
  { value: '200', label: '200' },
  { value: '300', label: '300' },
  { value: '600', label: '600' },
] as const;

type DpiValue = (typeof DPI_OPTIONS)[number]['value'] | 'custom';

const THEME_OPTIONS: { value: ThemeId | ''; label: string }[] = [
  { value: '', label: '跟随当前' },
  { value: 'macaron', label: '马卡龙' },
  { value: 'glowDark', label: '暗夜' },
  { value: 'journal', label: '手账' },
  { value: 'minimal', label: '极简' },
];

export function ExportDialog() {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [errors, setErrors] = useState<Array<ExportOutcome & { ok: false }>>([]);
  const [retryDpi, setRetryDpi] = useState<number | null>(null);

  /* 勾选状态：默认全选文本 + 1:1 图纸 */
  const [checked, setChecked] = useState<Set<AllExportKind>>(
    () => new Set<AllExportKind>(['sheet1to1', 'colorListCsv', 'placementTxt']),
  );

  /* PNG 选项 */
  const [dpiStr, setDpiStr] = useState<DpiValue>('300');
  const [customDpi, setCustomDpi] = useState(300);
  /**
   * 分块数模式：默认「自动」——不传 splits，由导出管线按 屏幕1:1容量建议 → 当前分区 →
   * 板宽兜底 解析（exportRaster.resolveSplits）。旧实现恒传 2×2，小板也被强制切成 4 张纸。
   */
  const [splitMode, setSplitMode] = useState<'auto' | 'manual'>('auto');
  const [splitsX, setSplitsX] = useState(2);
  const [splitsY, setSplitsY] = useState(2);
  const [watermark, setWatermark] = useState('PinDou Studio');
  const [previewTheme, setPreviewTheme] = useState<ThemeId | ''>('');
  const [showPlacedMarks, setShowPlacedMarks] = useState(false);
  /* 真实导出进度（文件级计数，来自 batchExport 的 onBatchProgress） */
  const [progressInfo, setProgressInfo] = useState<BatchExportProgress | null>(null);

  const openRef = useRef(open);
  openRef.current = open;

  /* 自动分块的提示文案：反映导出管线的解析顺序（屏幕容量建议 → 跟随当前分区） */
  const region = usePdbStore((s) => s.region);
  const stateRegionSplitHint =
    region.splitsX > 1 || region.splitsY > 1
      ? `，屏幕放不下时跟随当前分区 ${region.splitsX}×${region.splitsY}`
      : '';

  /* ---- 事件认领：pdb:open-export ---- */
  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ handled: boolean }>;
      if (ce.detail) ce.detail.handled = true;
      setOpen(true);
      setErrors([]);
      setRetryDpi(null);
    };
    window.addEventListener('pdb:open-export', handler);
    return () => window.removeEventListener('pdb:open-export', handler);
  }, []);

  const toggleKind = useCallback((kind: AllExportKind) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setChecked(new Set(ALL_EXPORT_KINDS));
  }, []);

  const selectNone = useCallback(() => {
    setChecked(new Set());
  }, []);

  const resolvedDpi = dpiStr === 'custom' ? customDpi : Number(dpiStr);

  const needsPngOptions = checked.has('sheet1to1') || checked.has('regionSheets');
  const needsRegionOptions = checked.has('regionSheets');
  const needsPreviewOptions = checked.has('previewPng');

  /* ---- 执行导出 ---- */
  const doExport = useCallback(async (overrideDpi?: number) => {
    if (checked.size === 0) return;
    setExporting(true);
    setErrors([]);
    setRetryDpi(null);
    setProgressInfo({ done: 0, total: 1, label: '准备导出…' });

    const state = usePdbStore.getState();
    const kinds = ALL_EXPORT_KINDS.filter((k) => checked.has(k));
    const opts: PngExportOptions = {
      dpi: overrideDpi ?? resolvedDpi,
      // 自动模式不传 splits：resolveSplits 按屏幕容量/当前分区/板宽自动解析
      splitsX: splitMode === 'manual' ? splitsX : undefined,
      splitsY: splitMode === 'manual' ? splitsY : undefined,
      watermark: watermark || null,
      previewTheme: previewTheme || undefined,
      showPlacedMarks,
      onBatchProgress: (p) => setProgressInfo(p),
    };

    try {
      const result = await batchExport(state, kinds, opts);
      setProgressInfo(null);

      const failed = result.outcomes.filter(
        (o): o is ExportOutcome & { ok: false } => !o.ok && o.cancelled !== true,
      );
      if (failed.length > 0) {
        setErrors(failed);
        // 检查是否有 suggestDpi
        const suggestItem = failed.find((f) => f.code === 'too-large' && f.suggestDpi != null);
        if (suggestItem && suggestItem.suggestDpi != null) {
          setRetryDpi(suggestItem.suggestDpi);
        }
        // 弹 danger Toast
        for (const f of failed) {
          state.pushToast('danger', f.error, 6000);
        }
      }

      if (result.successCount > 0) {
        const cancelled = result.cancelledCount;
        const failedCount = result.failCount - cancelled;
        state.pushToast(
          'success',
          `已导出 ${result.successCount} 个文件` +
            `${failedCount > 0 ? `，${failedCount} 个失败` : ''}` +
            `${cancelled > 0 ? `，${cancelled} 个取消` : ''}`,
          3000,
        );
      }

      // 全部成功时关闭对话框
      if (result.failCount === 0) {
        setOpen(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.pushToast('danger', `导出异常：${msg}`, 6000);
      setErrors([{ ok: false, kind: 'sheet1to1', error: msg }]);
    } finally {
      setExporting(false);
      setProgressInfo(null);
    }
  }, [checked, resolvedDpi, splitMode, splitsX, splitsY, watermark, previewTheme, showPlacedMarks]);

  const handleRetry = useCallback(() => {
    if (retryDpi != null) {
      void doExport(retryDpi);
    }
  }, [retryDpi, doExport]);

  /* ---- DPI segmented 处理 ---- */
  const handleDpiChange = useCallback((v: string) => {
    setDpiStr(v as DpiValue);
  }, []);

  return (
    <Modal open={open} onClose={() => !exporting && setOpen(false)} title="导出产物" wide>
      <div className="pdb-project-dialog">
        {/* 产物勾选 */}
        <div className="pdb-project-dialog__section">
          <div className="pdb-project-dialog__row">
            <span className="pdb-project-dialog__section-title">选择导出产物</span>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={selectAll}>全选</Button>
            <Button size="sm" variant="ghost" onClick={selectNone}>全不选</Button>
          </div>
          <div className="pdb-export-checklist">
            {ALL_EXPORT_KINDS.map((kind) => (
              <label key={kind} className="pdb-export-check-item">
                <input
                  type="checkbox"
                  checked={checked.has(kind)}
                  onChange={() => toggleKind(kind)}
                  disabled={exporting}
                />
                <span className="pdb-export-check-item__label">{EXPORT_LABELS[kind]}</span>
              </label>
            ))}
          </div>
        </div>

        {/* PNG 选项 */}
        {needsPngOptions && (
          <div className="pdb-export-options">
            <div className="pdb-export-options__group">
              <span className="pdb-export-options__group-label">DPI</span>
              <Segmented
                options={[...DPI_OPTIONS.map((d) => ({ value: d.value, label: d.label })), { value: 'custom', label: '自定义' }]}
                value={DPI_OPTIONS.some((d) => d.value === dpiStr) ? dpiStr : 'custom'}
                onChange={handleDpiChange}
                ariaLabel="导出 DPI"
              />
              {!DPI_OPTIONS.some((d) => d.value === dpiStr) && (
                <NumberField value={customDpi} onValueChange={setCustomDpi} min={72} max={1200} step={10} />
              )}
            </div>

            {needsRegionOptions && (
              <div className="pdb-export-options__group">
                <span className="pdb-export-options__group-label">分块</span>
                <Segmented
                  options={[
                    { value: 'auto', label: '自动' },
                    { value: 'manual', label: '自定义' },
                  ]}
                  value={splitMode}
                  onChange={(v) => setSplitMode(v as 'auto' | 'manual')}
                  ariaLabel="分块模式"
                />
                {splitMode === 'manual' ? (
                  <>
                    <span className="pdb-project-dialog__label">横向</span>
                    <NumberField value={splitsX} onValueChange={setSplitsX} min={1} max={8} step={1} />
                    <span className="pdb-project-dialog__label">纵向</span>
                    <NumberField value={splitsY} onValueChange={setSplitsY} min={1} max={8} step={1} />
                    <span className="pdb-export-check-item__hint">共 {splitsX * splitsY} 块</span>
                  </>
                ) : (
                  <span className="pdb-export-check-item__hint">
                    按屏幕 1:1 容量自动建议{stateRegionSplitHint}
                  </span>
                )}
              </div>
            )}

            <div className="pdb-export-options__group">
              <Switch
                checked={showPlacedMarks}
                onChange={setShowPlacedMarks}
                label="标记已放置"
                disabled={exporting}
              />
            </div>
          </div>
        )}

        {/* 预览图选项 */}
        {needsPreviewOptions && (
          <div className="pdb-export-options">
            <div className="pdb-export-options__group">
              <span className="pdb-export-options__group-label">水印</span>
              <input
                className="pdb-project-dialog__input"
                value={watermark}
                onChange={(e) => setWatermark(e.target.value)}
                placeholder="留空则无水印"
                disabled={exporting}
                style={{ maxWidth: 200 }}
              />
            </div>
            <div className="pdb-export-options__group">
              <span className="pdb-export-options__group-label">主题</span>
              <select
                className="pdb-project-dialog__input"
                value={previewTheme}
                onChange={(e) => setPreviewTheme(e.target.value as ThemeId | '')}
                disabled={exporting}
                style={{ maxWidth: 140 }}
                aria-label="预览图主题"
              >
                {THEME_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* 导出进度（真实文件级计数：done/total 来自 batchExport 的逐产物回报） */}
        {exporting && progressInfo && (
          <div className="pdb-export-progress">
            <div className="pdb-export-progress__bar">
              <div
                className="pdb-export-progress__fill"
                style={{ width: `${Math.round((progressInfo.done / Math.max(1, progressInfo.total)) * 100)}%` }}
              />
            </div>
            <span className="pdb-export-progress__text">
              {progressInfo.total > 1
                ? `导出中 ${progressInfo.done}/${progressInfo.total}：${progressInfo.label}`
                : `导出中：${progressInfo.label}`}
            </span>
          </div>
        )}

        {/* 错误与重试 */}
        {errors.length > 0 && (
          <div className="pdb-export-error">
            <span className="pdb-export-error__msg">
              {errors.map((e) => e.error).join('；')}
            </span>
            {retryDpi != null && (
              <Button
                className="pdb-export-error__retry"
                size="sm"
                variant="outline"
                onClick={handleRetry}
                disabled={exporting}
              >
                改用 {retryDpi} DPI 重试
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={exporting}>
          取消
        </Button>
        <Button
          variant="primary"
          onClick={() => void doExport()}
          disabled={exporting || checked.size === 0}
        >
          {exporting ? '导出中…' : `导出 (${checked.size})`}
        </Button>
      </div>
    </Modal>
  );
}
