/**
 * CalibrationWizard.tsx —— 四种校准方式，用户任选，结果统一归一到 Calibration 并 setCalibration。
 *
 * 1. 自动检测（Electron 默认，浏览器置灰）
 * 2. 标尺拖拽法（最直观）：横向+纵向标尺，pitchMm 2.400–3.000 步进 0.001
 * 3. 实测跨度法（最精确）：输入第1钉到第K钉中心的毫米数
 * 4. PPI/对角线输入法：输入屏幕英寸数或已知 PPI 反推
 */
import { useMemo, useState } from 'react';
import { usePdbStore } from '@/store';
import { isElectron } from '@/io/bridge';
import {
  calibrationFromDisplay,
  displayKey,
  maxCellsAt1to1,
  pitchToDevicePx,
  sanitizeCalibration,
  boardPhysicalSizeMm,
} from '@/core/geometry';
import type { Calibration } from '@/core/types';
import { CalibrationRuler } from './CalibrationRuler';
import { DisplayPicker } from './DisplayPicker';
import { Button } from '@/components/ui/Button';
import { Slider } from '@/components/ui/Slider';
import { NumberField } from '@/components/ui/NumberField';
import { PdbIcon } from '@/components/icons';
import './board.css';

type CalMethod = 'auto' | 'ruler' | 'span' | 'ppi';

export function CalibrationWizard() {
  const [method, setMethod] = useState<CalMethod>('auto');
  const display = usePdbStore((s) => s.display);
  const calibration = usePdbStore((s) => s.calibration);
  const board = usePdbStore((s) => s.board);
  const setCalibration = usePdbStore((s) => s.setCalibration);
  const pushToast = usePdbStore((s) => s.pushToast);

  const electron = isElectron();
  const safeCal = sanitizeCalibration(calibration);
  const physical = boardPhysicalSizeMm(board);

  // 当前状态摘要
  const pitchDev = pitchToDevicePx(safeCal.pitchMm, safeCal);
  const maxCells = display ? maxCellsAt1to1(safeCal, display.devicePx) : null;

  const applyCalibration = (cal: Partial<Calibration>, source: Calibration['source']): void => {
    const newCal = sanitizeCalibration({
      ...safeCal,
      ...cal,
      source,
      displayKey: display ? displayKey(display) : safeCal.displayKey,
      verifiedAt: new Date().toISOString(),
    });
    setCalibration(newCal);
    pushToast('success', `校准已更新 · pitch ${newCal.pitchMm.toFixed(4)}mm · 来源: ${sourceLabel(source)}`);
  };

  const resetToDefault = (): void => {
    if (display) {
      const cal = sanitizeCalibration(calibrationFromDisplay(display));
      setCalibration(cal);
      pushToast('info', '已恢复为自动检测默认值');
    }
  };

  return (
    <div className="pdb-cal-wizard">
      {/* 当前状态摘要 */}
      <div className="pdb-cal-wizard__status">
        <div className="pdb-cal-wizard__status-row">
          <span className="pdb-cal-wizard__status-label">校准来源</span>
          <span className="pdb-cal-wizard__status-value">{sourceLabel(safeCal.source)}</span>
        </div>
        <div className="pdb-cal-wizard__status-row">
          <span className="pdb-cal-wizard__status-label">钉距 pitch</span>
          <span className="pdb-cal-wizard__status-value">{safeCal.pitchMm.toFixed(4)} mm</span>
        </div>
        <div className="pdb-cal-wizard__status-row">
          <span className="pdb-cal-wizard__status-label">每格设备像素</span>
          <span className="pdb-cal-wizard__status-value">
            横 {pitchDev.x.toFixed(2)} / 纵 {pitchDev.y.toFixed(2)} px
          </span>
        </div>
        <div className="pdb-cal-wizard__status-row">
          <span className="pdb-cal-wizard__status-label">mm/设备像素</span>
          <span className="pdb-cal-wizard__status-value">
            横 {safeCal.mmPerDevicePxX.toFixed(5)} / 纵 {safeCal.mmPerDevicePxY.toFixed(5)}
          </span>
        </div>
        {maxCells && (
          <div className="pdb-cal-wizard__status-row">
            <span className="pdb-cal-wizard__status-label">1:1 可容</span>
            <span className="pdb-cal-wizard__status-value">{maxCells.cols}×{maxCells.rows} 格</span>
          </div>
        )}
        <div className="pdb-cal-wizard__status-row">
          <span className="pdb-cal-wizard__status-label">整板物理尺寸</span>
          <span className="pdb-cal-wizard__status-value">
            {(physical.width / 10).toFixed(1)}×{(physical.height / 10).toFixed(1)} cm
          </span>
        </div>
      </div>

      {/* 方法选择 */}
      <div className="pdb-cal-wizard__methods" role="radiogroup" aria-label="校准方式">
        <MethodCard
          id="auto"
          icon="monitor"
          title="自动检测"
          desc={electron ? 'WMI 读取面板物理尺寸，零输入高精度' : '浏览器无法获取物理尺寸，请使用手动校准'}
          active={method === 'auto'}
          disabled={!electron}
          onSelect={() => setMethod('auto')}
        />
        <MethodCard
          id="ruler"
          icon="ruler"
          title="标尺拖拽法"
          desc="最直观：屏幕画标尺带，对着实物板拖滑块直到格距重合"
          active={method === 'ruler'}
          disabled={false}
          onSelect={() => setMethod('ruler')}
        />
        <MethodCard
          id="span"
          icon="search"
          title="实测跨度法"
          desc="最精确：量第1钉到第K钉中心的毫米数，算 pitch = mm/(K-1)"
          active={method === 'span'}
          disabled={false}
          onSelect={() => setMethod('span')}
        />
        <MethodCard
          id="ppi"
          icon="settings"
          title="PPI / 对角线法"
          desc="输入屏幕对角线英寸数或已知 PPI 反推 mm/px"
          active={method === 'ppi'}
          disabled={false}
          onSelect={() => setMethod('ppi')}
        />
      </div>

      {/* 方法面板 */}
      <div className="pdb-cal-wizard__panel">
        {method === 'auto' && <AutoPanel display={display} cal={safeCal} onApply={applyCalibration} electron={electron} />}
        {method === 'ruler' && <RulerPanel cal={safeCal} display={display} onApply={applyCalibration} />}
        {method === 'span' && <SpanPanel cal={safeCal} onApply={applyCalibration} />}
        {method === 'ppi' && <PpiPanel cal={safeCal} display={display} onApply={applyCalibration} />}
      </div>

      {/* 显示器选择 */}
      <details>
        <summary style={{ fontSize: 12, color: 'var(--text-mute)', cursor: 'pointer', fontWeight: 600 }}>
          显示器列表（点击展开）
        </summary>
        <div style={{ marginTop: 8 }}>
          <DisplayPicker />
        </div>
      </details>

      {/* 操作按钮 */}
      <div className="pdb-cal-wizard__actions">
        <Button size="sm" variant="outline" onClick={resetToDefault}>
          <PdbIcon name="undo" size={13} /> 恢复默认
        </Button>
        <Button size="sm" variant="soft" onClick={() => setMethod('ruler')}>
          <PdbIcon name="ruler" size={13} /> 重新校准
        </Button>
      </div>
    </div>
  );
}

/* ================= 方法卡片 ================= */

function MethodCard({
  icon,
  title,
  desc,
  active,
  disabled,
  onSelect,
}: {
  id: string;
  icon: Parameters<typeof PdbIcon>[0]['name'];
  title: string;
  desc: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`pdb-cal-method ${active ? '' : ''} ${disabled ? 'is-disabled' : ''}`}
      data-active={active}
      role="radio"
      aria-checked={active}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) onSelect(); }}
    >
      <div className="pdb-cal-method__icon">
        <PdbIcon name={icon} size={16} />
      </div>
      <div className="pdb-cal-method__text">
        <span className="pdb-cal-method__title">{title}</span>
        <span className="pdb-cal-method__desc">{desc}</span>
      </div>
    </div>
  );
}

/* ================= 1. 自动检测面板 ================= */

function AutoPanel({
  display,
  cal,
  onApply,
  electron,
}: {
  display: ReturnType<typeof usePdbStore.getState>['display'];
  cal: Calibration;
  onApply: (patch: Partial<Calibration>, source: Calibration['source']) => void;
  electron: boolean;
}) {
  if (!electron || !display || !display.physicalMm) {
    return (
      <div>
        <p className="pdb-hint" style={{ color: 'var(--warning)' }}>
          <PdbIcon name="warning" size={12} /> 浏览器模式无法自动检测屏幕物理尺寸。
          请使用「标尺拖拽法」或「实测跨度法」手动校准。
        </p>
      </div>
    );
  }

  const mmX = display.physicalMm.width / display.devicePx.width;
  const mmY = display.physicalMm.height / display.devicePx.height;
  const ppiX = 25.4 / mmX;
  const ppiY = 25.4 / mmY;
  const pitchDevX = cal.pitchMm / mmX;
  const pitchDevY = cal.pitchMm / mmY;

  return (
    <div>
      <dl className="pdb-cal-info-grid">
        <dt>分辨率</dt>
        <dd>{display.devicePx.width}×{display.devicePx.height} 设备像素</dd>
        <dt>物理尺寸</dt>
        <dd>{(display.physicalMm.width / 10).toFixed(1)}×{(display.physicalMm.height / 10).toFixed(1)} cm</dd>
        <dt>缩放</dt>
        <dd>{(display.devicePixelRatio * 100).toFixed(0)}% (DPR={display.devicePixelRatio})</dd>
        <dt>PPI</dt>
        <dd>横 {ppiX.toFixed(1)} / 纵 {ppiY.toFixed(1)}</dd>
        <dt>mm/设备px</dt>
        <dd>横 {mmX.toFixed(5)} / 纵 {mmY.toFixed(5)}</dd>
        <dt>每格设备px</dt>
        <dd>横 {pitchDevX.toFixed(2)} / 纵 {pitchDevY.toFixed(2)}</dd>
      </dl>
      <div style={{ marginTop: 10 }}>
        <Button
          size="sm"
          variant="primary"
          onClick={() => onApply({ mmPerDevicePxX: mmX, mmPerDevicePxY: mmY }, 'auto-wmi')}
        >
          <PdbIcon name="success" size={13} /> 采用自动检测结果
        </Button>
      </div>
      <p className="pdb-hint" style={{ marginTop: 6 }}>
        注：Electron 报的 devicePx 可能因 DIP×scaleFactor 取整有 ±1px 偏差（0.04%），
        标尺校准可进一步精调。
      </p>
    </div>
  );
}

/* ================= 2. 标尺拖拽法面板 ================= */

function RulerPanel({
  cal,
  display,
  onApply,
}: {
  cal: Calibration;
  display: ReturnType<typeof usePdbStore.getState>['display'];
  onApply: (patch: Partial<Calibration>, source: Calibration['source']) => void;
}) {
  const [pitch, setPitch] = useState(cal.pitchMm);
  const previewCal = useMemo(() => ({ ...cal, pitchMm: pitch }), [cal, pitch]);
  const pitchDev = pitchToDevicePx(pitch, cal);
  const maxCells = display ? maxCellsAt1to1(previewCal, display.devicePx) : null;

  // 与自动检测值偏差
  const autoCal = display?.physicalMm ? calibrationFromDisplay(display) : null;
  const deviation = autoCal
    ? ((pitch - autoCal.pitchMm) / autoCal.pitchMm * 100)
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="pdb-hint">
        把透明拼豆板放在屏幕上，拖动滑块调整 pitch 直到屏幕格线与板上钉位完全重合。
        横向与纵向需分别对齐（面板各向异性）。
      </p>

      {/* 横向标尺 */}
      <CalibrationRuler direction="horizontal" cells={20} calibration={previewCal} />
      {/* 纵向标尺 */}
      <CalibrationRuler direction="vertical" cells={20} calibration={previewCal} />

      {/* pitch 滑块 */}
      <div className="pdb-cal-slider-row">
        <span className="pdb-label" style={{ minWidth: 60 }}>pitch mm</span>
        <Slider
          value={pitch}
          min={2.4}
          max={3.0}
          step={0.001}
          format={(v) => v.toFixed(3)}
          onValueChange={setPitch}
        />
      </div>

      {/* 实时信息 */}
      <dl className="pdb-cal-info-grid">
        <dt>当前 pitch</dt>
        <dd>{pitch.toFixed(4)} mm</dd>
        <dt>每格设备像素</dt>
        <dd>横 {pitchDev.x.toFixed(2)} / 纵 {pitchDev.y.toFixed(2)} px</dd>
        {maxCells && (
          <>
            <dt>1:1 可容格数</dt>
            <dd>{maxCells.cols}×{maxCells.rows}</dd>
          </>
        )}
        {display && (
          <>
            <dt>整板屏上尺寸</dt>
            <dd>
              {(() => {
                const bSize = { ...usePdbStore.getState().board, pitchMm: pitch };
                const p = boardPhysicalSizeMm(bSize);
                const wPx = p.width / cal.mmPerDevicePxX;
                const hPx = p.height / cal.mmPerDevicePxY;
                const dpr = display.devicePixelRatio;
                return `${p.width.toFixed(1)}×${p.height.toFixed(1)} mm (${(wPx / dpr).toFixed(0)}×${(hPx / dpr).toFixed(0)} CSS px)`;
              })()}
            </dd>
          </>
        )}
        {deviation !== null && (
          <>
            <dt>与自动值偏差</dt>
            <dd style={{ color: Math.abs(deviation) > 1 ? 'var(--warning)' : 'var(--success)' }}>
              {deviation >= 0 ? '+' : ''}{deviation.toFixed(3)}%
            </dd>
          </>
        )}
      </dl>

      <Button
        size="sm"
        variant="primary"
        onClick={() => onApply({ pitchMm: pitch }, 'manual-ruler')}
      >
        <PdbIcon name="success" size={13} /> 确认采用 pitch = {pitch.toFixed(4)} mm
      </Button>
    </div>
  );
}

/* ================= 3. 实测跨度法面板 ================= */

function SpanPanel({
  cal,
  onApply,
}: {
  cal: Calibration;
  onApply: (patch: Partial<Calibration>, source: Calibration['source']) => void;
}) {
  const [spanMm, setSpanMm] = useState(280);
  const [pinCount, setPinCount] = useState(104);

  // pitchMm = spanMm / (pinCount - 1)（中心到中心）
  const computedPitch = pinCount > 1 ? spanMm / (pinCount - 1) : cal.pitchMm;
  const deviation = ((computedPitch - cal.pitchMm) / cal.pitchMm) * 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="pdb-hint">
        用尺量「第 1 钉中心到第 K 钉中心」的毫米数。例如量整板有效区（第 1 钉到第 104 钉）= 280mm → pitch = 280/103 ≈ 2.7184mm。
        也可量任意跨度（如 10 钉间 = 26.923mm → pitch = 26.923/9）。
      </p>

      <div className="pdb-cal-input-row">
        <label>实测跨度 mm</label>
        <NumberField value={spanMm} min={1} max={1000} step={0.1} onValueChange={setSpanMm} />
      </div>
      <div className="pdb-cal-input-row">
        <label>钉数 K（含首末）</label>
        <NumberField value={pinCount} min={2} max={500} step={1} onValueChange={setPinCount} />
      </div>

      <div className="pdb-cal-result">
        计算结果：pitch = {spanMm.toFixed(2)} / ({pinCount} − 1) = <strong>{computedPitch.toFixed(5)} mm</strong>
        {Math.abs(deviation) > 0.01 && (
          <span style={{ marginLeft: 8, color: Math.abs(deviation) > 1 ? 'var(--warning)' : 'var(--text-mute)' }}>
            (与当前值偏差 {deviation >= 0 ? '+' : ''}{deviation.toFixed(3)}%)
          </span>
        )}
      </div>

      <Button
        size="sm"
        variant="primary"
        onClick={() => onApply({ pitchMm: computedPitch }, 'manual-span')}
        disabled={pinCount < 2 || spanMm <= 0}
      >
        <PdbIcon name="success" size={13} /> 采用 pitch = {computedPitch.toFixed(4)} mm
      </Button>
    </div>
  );
}

/* ================= 4. PPI / 对角线输入法面板 ================= */

function PpiPanel({
  cal: _cal,
  display,
  onApply,
}: {
  cal: Calibration;
  display: ReturnType<typeof usePdbStore.getState>['display'];
  onApply: (patch: Partial<Calibration>, source: Calibration['source']) => void;
}) {
  const [diagonalInch, setDiagonalInch] = useState(15.4);
  const [knownPpi, setKnownPpi] = useState(0);

  // 从对角线英寸反推 mmPerDevicePx
  const computed = useMemo(() => {
    if (!display) return null;
    const { width: dw, height: dh } = display.devicePx;
    const diagPx = Math.sqrt(dw * dw + dh * dh);

    if (knownPpi > 0) {
      // 已知 PPI → mmPerDevicePx = 25.4 / ppi（各向同性近似）
      const mmPx = 25.4 / knownPpi;
      return { mmX: mmPx, mmY: mmPx, ppiX: knownPpi, ppiY: knownPpi, diagPx };
    }

    if (diagonalInch > 0) {
      // 对角线英寸 → PPI = diagPx / diagonalInch → mmPerDevicePx = 25.4 / PPI
      const ppi = diagPx / diagonalInch;
      const mmPx = 25.4 / ppi;
      // 分轴：按宽高比分配（近似，假设像素正方形）
      return { mmX: mmPx, mmY: mmPx, ppiX: ppi, ppiY: ppi, diagPx };
    }
    return null;
  }, [display, diagonalInch, knownPpi]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="pdb-hint">
        输入屏幕对角线英寸数（如 15.4"）或直接输入已知 PPI，程序根据设备像素分辨率反推 mm/px。
        注意：此方法假设像素为正方形（各向同性），精度略低于 WMI 或实测跨度法。
      </p>

      <div className="pdb-cal-input-row">
        <label>对角线 英寸</label>
        <NumberField value={diagonalInch} min={5} max={100} step={0.1} onValueChange={(v) => { setDiagonalInch(v); setKnownPpi(0); }} />
      </div>
      <div className="pdb-cal-input-row">
        <label>或直接输入 PPI</label>
        <NumberField value={knownPpi} min={0} max={500} step={1} onValueChange={(v) => { setKnownPpi(v); if (v > 0) setDiagonalInch(0); }} />
      </div>

      {computed && (
        <div className="pdb-cal-result">
          计算结果：PPI ≈ {computed.ppiX.toFixed(1)} · mm/设备px ≈ {computed.mmX.toFixed(5)}
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-mute)' }}>
            （对角 {computed.diagPx.toFixed(0)} 设备px{knownPpi > 0 ? ` / 已知PPI ${knownPpi}` : `/ ${diagonalInch.toFixed(1)}"`}）
          </span>
        </div>
      )}

      {computed && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => onApply({ mmPerDevicePxX: computed.mmX, mmPerDevicePxY: computed.mmY }, 'manual-ppi')}
        >
          <PdbIcon name="success" size={13} /> 采用 PPI = {computed.ppiX.toFixed(1)}
        </Button>
      )}
    </div>
  );
}

/* ================= 辅助 ================= */

function sourceLabel(source: Calibration['source']): string {
  switch (source) {
    case 'auto-wmi': return '自动检测 (WMI)';
    case 'manual-ruler': return '标尺拖拽';
    case 'manual-span': return '实测跨度';
    case 'manual-ppi': return 'PPI/对角线';
    case 'browser-fallback': return '浏览器降级（需手动校准）';
    default: return String(source);
  }
}
