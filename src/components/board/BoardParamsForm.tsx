/**
 * BoardParamsForm.tsx —— 板参数完整表单。
 * 行数/列数、钉距(mm)、豆点直径占比(0.5–1.0 滑杆)、板边留白(mm)、
 * 豆点样式（圆形/方形/圆环 分段控件）、网格线显隐、主线每N格加粗、
 * 行列编号显隐与间隔、标尺显隐。所有改动实时 setBoardConfig。
 * 附加「整板尺寸」区：实时显示豆阵/整板物理 cm，并可录入实测豆阵宽反算钉距
 *   —— 解决「板子标称 28×28cm 但拼豆模式对不上」（钉距/列数与实际不符）。
 */
import { useMemo, useEffect, useState } from 'react';
import { usePdbStore } from '@/store';
import { beadAreaSizeMm, boardPhysicalSizeMm } from '@/core/geometry';
import { NumberField } from '@/components/ui/NumberField';
import { Slider } from '@/components/ui/Slider';
import { Switch } from '@/components/ui/Switch';
import { Segmented } from '@/components/ui/Segmented';
import { Button } from '@/components/ui/Button';
import { PresetChips } from './PresetChips';
import { PdbIcon } from '@/components/icons';
import './board.css';

export function BoardParamsForm() {
  const board = usePdbStore((s) => s.board);
  const setBoardConfig = usePdbStore((s) => s.setBoardConfig);

  /* 实测豆阵宽（mm）录入 → 反算钉距；默认跟随当前豆阵宽 */
  const areaMm = useMemo(() => beadAreaSizeMm(board), [board]);
  const totalMm = useMemo(() => boardPhysicalSizeMm(board), [board]);
  const [measuredW, setMeasuredW] = useState<number>(Math.round(areaMm.width));
  const [touched, setTouched] = useState(false);
  // 未手动录入时，跟随列数/钉距变化刷新默认值
  useEffect(() => {
    if (!touched) setMeasuredW(Math.round(areaMm.width));
  }, [areaMm.width, touched]);
  const applyMeasuredPitch = (): void => {
    if (measuredW <= 0 || board.cols <= 0) return;
    setBoardConfig({ pitchMm: Math.min(10, Math.max(1, measuredW / board.cols)) });
  };

  return (
    <div className="pdb-board-form">
      {/* 预设芯片 */}
      <div className="pdb-board-form__section">
        <span className="pdb-board-form__title">
          <PdbIcon name="blocks" size={11} /> 预设
        </span>
        <PresetChips />
      </div>

      {/* 尺寸参数 */}
      <div className="pdb-board-form__section">
        <span className="pdb-board-form__title">
          <PdbIcon name="grid" size={11} /> 尺寸
        </span>
        <div className="pdb-field-row">
          <span className="pdb-label">列数</span>
          <NumberField
            value={board.cols}
            min={4}
            max={400}
            onValueChange={(v) => setBoardConfig({ cols: v })}
          />
        </div>
        <div className="pdb-field-row">
          <span className="pdb-label">行数</span>
          <NumberField
            value={board.rows}
            min={4}
            max={400}
            onValueChange={(v) => setBoardConfig({ rows: v })}
          />
        </div>
        <div className="pdb-field-row">
          <span className="pdb-label">钉距 mm</span>
          <NumberField
            value={board.pitchMm}
            min={1}
            max={10}
            step={0.0001}
            onValueChange={(v) => setBoardConfig({ pitchMm: v })}
          />
        </div>
        <div className="pdb-field-row">
          <span className="pdb-label">板边留白 mm</span>
          <NumberField
            value={board.marginMm}
            min={0}
            max={20}
            step={0.5}
            onValueChange={(v) => setBoardConfig({ marginMm: v })}
          />
        </div>

        {/* 整板物理尺寸核对 + 实测反算钉距（拼豆模式 1:1 对不上的自助修正） */}
        <div className="pdb-board-form__sizecheck">
          <div className="pdb-board-form__size-readout">
            <PdbIcon name="ruler" size={12} />
            <span>
              豆阵 <strong>{(areaMm.width / 10).toFixed(1)}×{(areaMm.height / 10).toFixed(1)}cm</strong>
              {' · '}整板 {(totalMm.width / 10).toFixed(1)}cm
            </span>
          </div>
          <div className="pdb-field-row">
            <span className="pdb-label">实测豆阵宽 mm</span>
            <NumberField
              value={measuredW}
              min={10}
              max={1000}
              step={1}
              onValueChange={(v) => { setMeasuredW(v); setTouched(true); }}
            />
            <Button size="sm" variant="outline" onClick={applyMeasuredPitch} title="按「实测豆阵宽 ÷ 列数」反算钉距并写入">
              反算钉距
            </Button>
          </div>
          <span className="pdb-board-form__hint">
            拿尺量你实物板的**豆心网格**宽度（不含板边），填进来反算钉距。
            例：104 钉板量得 280mm → 钉距 2.6923mm，拼豆模式即按 28.0cm 排布。
          </span>
        </div>
      </div>

      {/* 豆点外观 */}
      <div className="pdb-board-form__section">
        <span className="pdb-board-form__title">
          <PdbIcon name="bead" size={11} /> 豆点
        </span>
        <div className="pdb-field-row">
          <span className="pdb-label">直径占比</span>
          <Slider
            value={board.beadFillRatio}
            min={0.5}
            max={1.0}
            step={0.01}
            format={(v) => `${(v * 100).toFixed(0)}%`}
            onValueChange={(v) => setBoardConfig({ beadFillRatio: v })}
          />
        </div>
        <div className="pdb-field-row">
          <span className="pdb-label">形状</span>
          <Segmented
            options={[
              { value: 'circle', label: '圆形' },
              { value: 'square', label: '方形' },
              { value: 'ring', label: '圆环' },
            ]}
            value={board.cellShape}
            onChange={(v) => setBoardConfig({ cellShape: v })}
            ariaLabel="豆点样式"
          />
        </div>
      </div>

      {/* 网格与标注 */}
      <div className="pdb-board-form__section">
        <span className="pdb-board-form__title">
          <PdbIcon name="ruler" size={11} /> 网格与标注
        </span>
        <div className="pdb-field-row">
          <Switch
            label="网格线"
            checked={board.showGrid}
            onChange={(v) => setBoardConfig({ showGrid: v })}
          />
        </div>
        <div className="pdb-field-row">
          <Switch
            label="主线加粗"
            checked={board.showMajorGrid}
            onChange={(v) => setBoardConfig({ showMajorGrid: v })}
          />
          <NumberField
            value={board.majorEvery}
            min={2}
            max={50}
            onValueChange={(v) => setBoardConfig({ majorEvery: v })}
          />
        </div>
        <div className="pdb-field-row">
          <Switch
            label="行列编号"
            checked={board.showNumbers}
            onChange={(v) => setBoardConfig({ showNumbers: v })}
          />
          <NumberField
            value={board.numberEvery}
            min={1}
            max={50}
            onValueChange={(v) => setBoardConfig({ numberEvery: v })}
          />
        </div>
        <div className="pdb-field-row">
          <Switch
            label="豆上色号"
            checked={board.showColorCodes === true}
            onChange={(v) => setBoardConfig({ showColorCodes: v })}
            title="在每颗豆子上叠加显示色号（格子足够大时绘制；文字颜色按豆色自动取黑/白）"
          />
        </div>
        <div className="pdb-field-row">
          <Switch
            label="暗色描边"
            checked={board.darkBeadEdge !== false}
            onChange={(v) => setBoardConfig({ darkBeadEdge: v })}
            title="黑/深色豆与底色对比不足时自动补一圈浅色边线——发光底板（黑底）上黑豆不再隐形；关闭则豆面更纯净"
          />
        </div>
        <div className="pdb-field-row">
          <Switch
            label="标尺"
            checked={board.showRuler}
            onChange={(v) => setBoardConfig({ showRuler: v })}
          />
          <Switch
            label="空格棋盘格"
            checked={board.emptyCheckerboard !== false}
            onChange={(v) => setBoardConfig({ emptyCheckerboard: v })}
            title="空格子画成灰白棋盘格（马赛克），去背景/留空区域一眼可辨"
          />
        </div>
      </div>

      {/* 包边 */}
      <BorderSection />
    </div>
  );
}

/**
 * 包边：沿**图案轮廓**加一圈豆子（8 邻域膨胀描边，不是外接矩形）。
 * 默认色自动取色板里的黑色（名称含「黑」/ Black，否则取明度最低色）；
 * 下拉可换任意色号。板内放不下时自动扩板并居中迁移内容。
 */
function BorderSection() {
  const palette = usePdbStore((s) => s.palette);
  const applyBorderRing = usePdbStore((s) => s.applyBorderRing);

  // 默认包边色：优先名称含「黑/Black」的色号，否则取明度最低的颜色
  const defaultBlackIndex = useMemo(() => {
    let best = -1;
    let bestLum = Infinity;
    palette.colors.forEach((c, i) => {
      const isNamedBlack = /黑/.test(c.nameZh ?? '') || /black/i.test(c.name) || /black/i.test(c.code);
      const lum = 0.299 * c.rgb[0] + 0.587 * c.rgb[1] + 0.114 * c.rgb[2];
      if (isNamedBlack) {
        if (best < 0 || lum < bestLum) {
          best = i;
          bestLum = lum;
        }
      } else if (best < 0 && lum < bestLum) {
        best = i;
        bestLum = lum;
      }
    });
    return Math.max(0, best);
  }, [palette.colors]);

  const [colorIndex, setColorIndex] = useState<number>(defaultBlackIndex);
  // 色板切换/编辑后默认色失效时，回到自动检测
  useEffect(() => {
    if (colorIndex < 0 || colorIndex >= palette.colors.length) setColorIndex(defaultBlackIndex);
  }, [palette.colors, colorIndex, defaultBlackIndex]);

  const cur = palette.colors[Math.min(colorIndex, palette.colors.length - 1)];

  return (
    <div className="pdb-board-form__section">
      <span className="pdb-board-form__title">
        <PdbIcon name="grid" size={11} /> 包边
      </span>
      <div className="pdb-field-row">
        <span className="pdb-label">包边色</span>
        <select
          className="pdb-board-form__select"
          value={colorIndex}
          onChange={(e) => setColorIndex(Number(e.target.value))}
          aria-label="包边颜色"
        >
          {palette.colors.map((c, i) => (
            <option key={c.id} value={i}>
              {c.code} {c.nameZh ? `${c.nameZh} · ` : ''}{c.name}
            </option>
          ))}
        </select>
        {cur && (
          <span
            className="pdb-board-form__swatch"
            style={{ background: cur.hex }}
            title={cur.hex}
            aria-hidden
          />
        )}
      </div>
      <div className="pdb-field-row">
        <button
          type="button"
          className="pdb-board-form__border-btn"
          onClick={() => applyBorderRing(colorIndex)}
          title="沿图案轮廓加一圈包边豆（贴边缘描边，非外接方框）；图案贴边时自动扩板"
        >
          <PdbIcon name="blocks" size={13} />
          加一圈包边
        </button>
      </div>
      <span className="pdb-board-form__hint">
        沿图案外接矩形加一圈；颜色默认取色板中的黑色。
      </span>
    </div>
  );
}
