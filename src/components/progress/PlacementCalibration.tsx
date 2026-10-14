/**
 * progress/PlacementCalibration.tsx —— 拼豆面板里的「尺子核对」快速校准（用户反馈 #3）。
 *
 * 背景：拼豆模式格子是否 1:1，完全取决于「屏幕物理尺寸假设」（mmPerDevicePx）。
 * 自动检测（EDID）对多数屏是准的，但外接屏/电视/特殊屏可能报错——格子偏小、
 * 28cm 拼豆盘"本该放不下却放下了"都是这个假设偏大的症状。
 *
 * 用法：拿一把真实直尺贴在屏幕上，拖动「屏宽/屏高假设」滑杆，直到屏幕上
 * 这把 100mm 的尺与真尺等长——校准即时生效并按显示器存档，格子立刻变准。
 * 常见显示器尺寸预设一键带入；「恢复自动检测」回退 EDID 值。
 */
import { useMemo, useState } from 'react';
import { usePdbStore } from '@/store';
import { Button } from '@/components/ui/Button';
import { Slider } from '@/components/ui/Slider';
import { PdbIcon } from '@/components/icons';
import { boardAlignCalibration } from '@/core/geometry';
import { getActiveRegionOffset } from '@/core/region';
import './progress.css';

/** 常见 16:9 显示器预设（对角线英寸 → 宽×高 mm，按 16:9 计算） */
const PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: '21.5″', w: 476, h: 268 },
  { label: '24″', w: 527, h: 296 },
  { label: '27″', w: 597, h: 336 },
  { label: '32″', w: 698, h: 392 },
];

const RULER_MM = 100;

export function PlacementCalibration() {
  const calibration = usePdbStore((s) => s.calibration);
  const display = usePdbStore((s) => s.display);
  const board = usePdbStore((s) => s.board);
  const region = usePdbStore((s) => s.region);
  const setCalibration = usePdbStore((s) => s.setCalibration);
  const pushToast = usePdbStore((s) => s.pushToast);
  /* 屏上实测宽高（cm，字符串输入；空 = 该轴不动） */
  const [measW, setMeasW] = useState('');
  const [measH, setMeasH] = useState('');

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  /** 每毫米的 CSS 像素数（横向）——尺子与格子的换算基准 */
  const cssPxPerMmX = useMemo(() => {
    if (!calibration) return 0;
    return 1 / calibration.mmPerDevicePxX / dpr;
  }, [calibration, dpr]);

  if (!calibration || !display) {
    return (
      <section className="pdb-pcal" aria-label="尺子核对">
        <p className="pdb-hint">当前环境拿不到屏幕物理尺寸（浏览器模式），请到「校准」页手动标尺校准。</p>
      </section>
    );
  }

  const widthMm = display.devicePx.width * calibration.mmPerDevicePxX;
  const heightMm = display.devicePx.height * calibration.mmPerDevicePxY;

  /** 校准目标 = 当前屏上实际渲染的网格区（分块时是活动块）的理论尺寸 */
  const off = getActiveRegionOffset(
    board.cols, board.rows, region.splitsX, region.splitsY, region.activeIndex,
    region.blockCols, region.blockRows,
  );
  const expCols = off ? off.cols : board.cols;
  const expRows = off ? off.rows : board.rows;
  const expWmm = expCols * board.pitchMm;
  const expHmm = expRows * board.pitchMm;
  const splitNote = off ? `当前区块（${expCols}×${expRows} 格）` : '整块豆阵';

  const parseCm = (s: string): number => {
    const v = Number.parseFloat(s);
    return Number.isFinite(v) && v > 0 ? v * 10 : 0;
  };
  const canMeasure = parseCm(measW) > 0 || parseCm(measH) > 0;

  /** 逐轴反算：mmPerPx ← mmPerPx × (屏上实测 ÷ 理论)，X/Y 分别修正（各向偏差的精确解） */
  const applyMeasure = (): void => {
    const res = boardAlignCalibration(calibration, expWmm, parseCm(measW), expHmm, parseCm(measH));
    if (!res) {
      pushToast('danger', '实测值无效：需大于 0 且在理论尺寸的 ±50% 以内', 3600);
      return;
    }
    setCalibration(res.cal);
    const f = (x: number | null): string => (x === null ? '未改' : `×${x.toFixed(3)}`);
    pushToast(
      'success',
      `已按实测校正（宽 ${f(res.factorX)} · 高 ${f(res.factorY)}），${splitNote}已与实物对齐（理论 ${expWmm.toFixed(1)}×${expHmm.toFixed(1)}mm）`,
      4200,
    );
  };

  const applySize = (wMm: number, hMm: number): void => {
    const devicePx = display.devicePx;
    setCalibration({
      ...calibration,
      mmPerDevicePxX: wMm / devicePx.width,
      mmPerDevicePxY: hMm / devicePx.height,
      source: 'manual-span',
      verifiedAt: new Date().toISOString(),
    });
  };

  /** 精细微调：把屏幕物理假设整体缩放 pct%（x/y 同向，保持像素比不失真），
   *  用于「实物板贴屏，格子差一点点」时的精修（±0.1% ≪ 1mm 步进）。 */
  const nudge = (pct: number): void => {
    applySize(widthMm * (1 + pct), heightMm * (1 + pct));
  };

  const resetAuto = (): void => {
    if (!display.physicalMm) {
      pushToast('warning', '该屏没有自动检测数据可恢复', 2400);
      return;
    }
    setCalibration({
      ...calibration,
      mmPerDevicePxX: display.physicalMm.width / display.devicePx.width,
      mmPerDevicePxY: display.physicalMm.height / display.devicePx.height,
      source: 'auto-wmi',
      verifiedAt: new Date().toISOString(),
    });
    pushToast('info', '已恢复自动检测的物理尺寸', 2200);
  };

  return (
    <section className="pdb-pcal" aria-label="尺子核对（快速校准）">
      <header className="pdb-pcal__head">
        <span className="pdb-label">
          <PdbIcon name="ruler" size={13} />
          尺子核对 · 校准格子大小
        </span>
        <Button size="sm" variant="ghost" onClick={resetAuto} title="恢复显示器自动检测的物理尺寸">
          恢复自动
        </Button>
      </header>

      <p className="pdb-pcal__hint">
        拿一把**真实直尺**贴在屏幕上，拖动下面的滑杆，直到屏幕上这把尺与真尺的
        100mm 等长——格子随即变准（每格 = {board.pitchMm}mm 真实豆距）。
      </p>

      {/* 屏上 100mm 尺：宽度完全由当前校准决定 */}
      <div className="pdb-pcal__ruler-box">
        <div
          className="pdb-pcal__ruler"
          style={{ width: RULER_MM * cssPxPerMmX }}
          role="img"
          aria-label={`屏幕上表示 ${RULER_MM} 毫米的刻度尺`}
        >
          {Array.from({ length: RULER_MM / 10 + 1 }, (_, i) => (
            <span
              key={i}
              className={`pdb-pcal__tick ${i % 5 === 0 ? 'is-major' : ''}`}
              style={{ left: i * 10 * cssPxPerMmX }}
            >
              {i % 5 === 0 && <em>{i * 10}</em>}
            </span>
          ))}
        </div>
      </div>

      <div className="pdb-pcal__sliders">
        <div className="pdb-psettings__row">
          <span className="pdb-psettings__name">屏宽假设</span>
          <Slider
            min={150}
            max={900}
            step={1}
            value={Math.round(widthMm)}
            onValueChange={(v) => applySize(v, heightMm)}
            format={(v) => `${v}mm`}
            aria-label="屏幕物理宽度假设"
          />
        </div>
        <div className="pdb-psettings__row">
          <span className="pdb-psettings__name">屏高假设</span>
          <Slider
            min={100}
            max={600}
            step={1}
            value={Math.round(heightMm)}
            onValueChange={(v) => applySize(widthMm, v)}
            format={(v) => `${v}mm`}
            aria-label="屏幕物理高度假设"
          />
        </div>
      </div>

      {/* 整板对位：以实物板/直尺为基准，精确校准格子 */}
      <div className="pdb-pcal__board-align">
        <div className="pdb-pcal__board-readout">
          <PdbIcon name="blocks" size={13} />
          <span>
            {splitNote}应显示为 <strong>{(expWmm / 10).toFixed(1)}×{(expHmm / 10).toFixed(1)}cm</strong>
          </span>
        </div>

        {/* 逐轴实测反算：专治「长 27.8 × 宽 27.6」两轴不一致的偏差 */}
        <div className="pdb-pcal__measure">
          <span className="pdb-label">屏上实测（cm）</span>
          <input
            className="pdb-pcal__measure-input"
            value={measW}
            onChange={(e) => setMeasW(e.target.value)}
            placeholder="宽"
            inputMode="decimal"
            aria-label="屏上实测宽厘米"
          />
          <span className="pdb-pcal__measure-x" aria-hidden>×</span>
          <input
            className="pdb-pcal__measure-input"
            value={measH}
            onChange={(e) => setMeasH(e.target.value)}
            placeholder="高"
            inputMode="decimal"
            aria-label="屏上实测高厘米"
          />
          <Button size="sm" variant="primary" onClick={applyMeasure} disabled={!canMeasure}>
            按实测校正
          </Button>
        </div>
        <p className="pdb-pcal__hint">
          拿直尺量<b>屏幕上网格区</b>的实际宽高填进来，程序按轴反算 mm/像素——
          X/Y 各偏各的（如长 27.8 宽 27.6）也能精确修平；只量一边就空着另一边。
        </p>
        <p className="pdb-pcal__hint">
          不想量尺也可以：把<b>实物拼豆板平贴屏幕</b>，点下面的同比例微调
          （缩小 0.5% / ±0.1% / 放大 0.5%），直到屏上网格与板上钉孔逐格对齐。
        </p>
        <div className="pdb-pcal__nudge">
          <Button size="sm" variant="outline" onClick={() => nudge(-0.005)} title="格子缩小 0.5%">缩小 0.5%</Button>
          <Button size="sm" variant="outline" onClick={() => nudge(-0.001)} title="格子缩小 0.1%">−0.1%</Button>
          <Button size="sm" variant="outline" onClick={() => nudge(0.001)} title="格子放大 0.1%">+0.1%</Button>
          <Button size="sm" variant="outline" onClick={() => nudge(0.005)} title="格子放大 0.5%">放大 0.5%</Button>
        </div>
      </div>

      <div className="pdb-pcal__presets">
        <span className="pdb-label">常见尺寸</span>
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant={Math.abs(widthMm - p.w) < 2 ? 'primary' : 'outline'}
            onClick={() => applySize(p.w, p.h)}
            title={`${p.label} 16:9 显示器 ≈ ${p.w}×${p.h}mm`}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <p className="pdb-pcal__note">
        当前假设：屏宽 {Math.round(widthMm)}mm × 屏高 {Math.round(heightMm)}mm
        （来源：{calibration.source === 'auto-wmi' ? '自动检测' : calibration.source === 'manual-span' ? '手动核对' : calibration.source}）。
        核对后按显示器自动存档。
      </p>
    </section>
  );
}
