/**
 * onboarding/WelcomeWizard.tsx —— 首次启动引导（5 步，可跳过、可重开）。
 *
 * 步骤：
 *   1 欢迎        一句话「把屏幕变成发光底板」+ 4 主题预览
 *   2 选板规格    复用 PresetChips（高亮 104×104 / 2.6923mm / 28cm 推荐并预选）+ 自定义 BoardParamsForm
 *   3 屏幕检测    复用 useDisplayList/DisplayPicker，展示分辨率/物理 cm/缩放/PPI/每格像素/1:1 最多可容格数，
 *                 并明确提示「你的板(28cm)高于屏幕可视区，已启用分块模式，建议 2×2 = 52×52」
 *   4 校准        默认 WMI 自动填好，提供「用标尺拖拽微调」入口（复用 CalibrationRuler / CalibrationWizard）
 *   5 主题与布局  4×4 组合实时预览卡片（复用 switchers.css 的卡片类 + ThemeSwitcher / LayoutSwitcher）
 *
 * 【契约边界】只调用 store 既有 action 与 core 纯函数，不新增任何类型、不改 store 形状。
 * 【重开机制】挂载在 AppShell；首启由 firstRun.ts 的 localStorage 标志决定，
 *            之后任何地方派发 `pdb:open-wizard` 都能重新打开（Toolbar 帮助按钮 / 开始面板 / 空状态卡）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { usePdbStore } from '@/store';
import { getBridge } from '@/io/bridge';
import {
  autoSuggestSplits,
  boardPhysicalSizeMm,
  calibrationFromDisplay,
  displayKey,
  fitsOnScreen,
  maxCellsAt1to1,
  pitchToDevicePx,
  ppiOf,
  refineDevicePx,
  sanitizeCalibration,
} from '@/core/geometry';
import { BOARD_PRESETS, DEFAULT_PRESET_ID, matchPreset, presetToBoardConfig } from '@/core/presets';
import { THEMES, THEME_ORDER, applyThemeById } from '@/themes';
import { saveAppearance } from '@/components/theme/appearance';
import { ThemeSwitcher } from '@/components/theme/ThemeSwitcher';
import { LayoutSwitcher } from '@/components/theme/LayoutSwitcher';
import { PresetChips } from '@/components/board/PresetChips';
import { BoardParamsForm } from '@/components/board/BoardParamsForm';
import { DisplayPicker } from '@/components/board/DisplayPicker';
import { CalibrationRuler } from '@/components/board/CalibrationRuler';
import { CalibrationWizard } from '@/components/board/CalibrationWizard';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Slider } from '@/components/ui/Slider';
import { PdbIcon } from '@/components/icons';
import type { IconName } from '@/components/icons';
import { useDisplayList } from '@/hooks/useDisplayInfo';
import type { Calibration, LayoutId, ThemeDefinition, ThemeId } from '@/core/types';
import { EV_OPEN_WIZARD, isFirstRunDone, markFirstRunDone } from './firstRun';
import './onboarding.css';

/* ==================== 步骤定义 ==================== */

interface StepDef {
  title: string;
  icon: IconName;
  hint: string;
}

const STEPS: StepDef[] = [
  { title: '欢迎', icon: 'bead', hint: '先花 30 秒认识这块「发光底板」' },
  { title: '选择板规格', icon: 'grid', hint: '按你手上真实的板子选，钉距决定 1:1 精度' },
  { title: '屏幕检测', icon: 'monitor', hint: '实测屏幕物理尺寸，算出每格多少像素' },
  { title: '物理校准', icon: 'ruler', hint: '默认已自动填好，可用标尺对着实物板微调' },
  { title: '主题与布局', icon: 'theme', hint: '4 主题 × 4 布局，挑一套顺眼的开工' },
];

/** 布局卡片文案（与 theme/LayoutSwitcher 的 LAYOUTS 保持一致） */
const LAYOUT_CARDS: { id: LayoutId; name: string; short: string }[] = [
  { id: 'classic', name: '经典三栏', short: '信息最全' },
  { id: 'floating', name: '悬浮面板', short: '最沉浸' },
  { id: 'split', name: '上下分区', short: '小屏友好' },
  { id: 'focus', name: '专注拼豆', short: '发光底板' },
];

/** 校准来源中文说明 */
const SOURCE_LABELS: Record<Calibration['source'], string> = {
  'auto-wmi': '自动检测（读取屏幕物理尺寸）',
  'manual-ruler': '标尺拖拽法',
  'manual-span': '实测跨度法',
  'manual-ppi': 'PPI / 对角线输入法',
  'browser-fallback': '浏览器降级默认值（需手动校准）',
};

const mm2cm = (mm: number): string => (mm / 10).toFixed(1);

/* ==================== 主组件 ==================== */

export function WelcomeWizard() {
  const [open, setOpen] = useState<boolean>(() => !isFirstRunDone());
  const [step, setStep] = useState(0);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [layoutPickerOpen, setLayoutPickerOpen] = useState(false);
  const pushToast = usePdbStore((s) => s.pushToast);

  /* 重开入口：任何地方派发 pdb:open-wizard 都从第 1 步重新开始 */
  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ handled?: boolean }>;
      if (ce.detail) ce.detail.handled = true;
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(EV_OPEN_WIZARD, handler);
    return () => window.removeEventListener(EV_OPEN_WIZARD, handler);
  }, []);

  /** 走完 5 步 */
  const finish = useCallback((): void => {
    markFirstRunDone();
    setOpen(false);
    pushToast('success', '引导完成，祝拼豆愉快！按 Ctrl+S 随时保存项目', 3600);
  }, [pushToast]);

  /** 跳过 / 直接关闭（同样算首启结束，不再自动弹） */
  const skip = useCallback((): void => {
    markFirstRunDone();
    setOpen(false);
    pushToast('info', '已跳过引导，可随时点工具条右侧的「帮助」按钮重新打开', 4200);
  }, [pushToast]);

  const last = STEPS.length - 1;

  const footer = (
    <div className="pdb-wiz-foot">
      <Button variant="ghost" onClick={skip} aria-label="跳过引导">
        跳过引导
      </Button>
      <span className="pdb-wiz-foot__spacer" />
      {step > 0 && (
        <Button variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))}>
          <PdbIcon name="chevronLeft" size={15} />
          上一步
        </Button>
      )}
      {step < last ? (
        <Button variant="primary" onClick={() => setStep((s) => Math.min(last, s + 1))}>
          下一步
          <PdbIcon name="chevronRight" size={15} />
        </Button>
      ) : (
        <Button variant="primary" onClick={finish}>
          进入工作台
          <PdbIcon name="chevronRight" size={15} />
        </Button>
      )}
    </div>
  );

  if (!open) return null;

  return (
    <>
      <Modal
        open={open}
        wide
        title={`欢迎使用 PinDou Studio · 第 ${step + 1}/${STEPS.length} 步 · ${STEPS[step]!.title}`}
        onClose={skip}
        footer={footer}
      >
        <StepRail step={step} onJump={setStep} />
        <div className="pdb-wiz-body" key={step}>
          {step === 0 && <StepWelcome />}
          {step === 1 && <StepBoard />}
          {step === 2 && <StepScreen />}
          {step === 3 && <StepCalibration />}
          {step === 4 && <StepAppearance onOpenTheme={() => setThemePickerOpen(true)} onOpenLayout={() => setLayoutPickerOpen(true)} />}
        </div>
      </Modal>
      {/* 第 5 步可选：打开完整版主题 / 布局选择器（复用  既有 Modal 组件） */}
      <ThemeSwitcher open={themePickerOpen} onClose={() => setThemePickerOpen(false)} />
      <LayoutSwitcher open={layoutPickerOpen} onClose={() => setLayoutPickerOpen(false)} />
    </>
  );
}

export default WelcomeWizard;

/* ==================== 步骤条 ==================== */

function StepRail({ step, onJump }: { step: number; onJump: (i: number) => void }) {
  return (
    <ol className="pdb-wiz-rail" aria-label="引导步骤">
      {STEPS.map((s, i) => {
        const state = i < step ? 'done' : i === step ? 'current' : 'todo';
        return (
          <li key={s.title} className="pdb-wiz-rail__item" data-state={state}>
            <button
              type="button"
              className="pdb-wiz-rail__btn pdb-pressable"
              onClick={() => onJump(i)}
              aria-current={i === step ? 'step' : undefined}
              title={s.hint}
            >
              <span className="pdb-wiz-rail__dot" aria-hidden>
                {i < step ? <PdbIcon name="checkCircle" size={13} /> : <PdbIcon name={s.icon} size={13} />}
              </span>
              <span className="pdb-wiz-rail__label">{s.title}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ==================== 第 1 步：欢迎 ==================== */

function StepWelcome() {
  const theme = usePdbStore((s) => s.theme);
  const setTheme = usePdbStore((s) => s.setTheme);

  const choose = (id: ThemeId): void => {
    setTheme(id);
    applyThemeById(id);
    saveAppearance({ theme: id });
  };

  return (
    <div className="pdb-wiz-step">
      <div className="pdb-wiz-hero">
        <span className="pdb-wiz-hero__logo" aria-hidden>
          <PdbIcon name="bead" size={26} />
        </span>
        <h3 className="pdb-wiz-hero__title">把屏幕变成发光底板</h3>
        <p className="pdb-wiz-hero__lead">
          PinDou Studio 按你手上那块透明拼豆板的真实钉距，在屏幕上 1:1 画出每一颗豆的位置。
          把板子贴到屏幕上，照着格子逐颗放就行。
        </p>
        <ul className="pdb-wiz-hero__points">
          <li>
            <PdbIcon name="ruler" size={14} />
            <span>
              <strong>物理级 1:1</strong>：读取屏幕真实物理尺寸（毫米），格距误差控制在半个像素内
            </span>
          </li>
          <li>
            <PdbIcon name="blocks" size={14} />
            <span>
              <strong>自动分块</strong>：整板放不进屏幕时，自动切成 A1 / A2 / B1 / B2 逐块拼
            </span>
          </li>
          <li>
            <PdbIcon name="chart" size={14} />
            <span>
              <strong>按色计数</strong>：一次只显示一种颜色，剩余颗数实时递减，不重复不漏颗
            </span>
          </li>
        </ul>
      </div>

      <p className="pdb-wiz-section__title">四套主题，随时可换（点一下立即生效）</p>
      <div className="pdb-switcher-grid pdb-wiz-themes">
        {THEME_ORDER.map((id, idx) => {
          const t = THEMES[id]!;
          const active = id === theme;
          return (
            <button
              key={id}
              type="button"
              className={`pdb-theme-card pdb-pressable ${active ? 'is-active' : ''}`}
              style={{
                background: t.tokens['--surface'],
                borderColor: active ? t.tokens['--primary'] : t.tokens['--border'],
                animationDelay: `${idx * 60}ms`,
              }}
              aria-pressed={active}
              onClick={() => choose(id)}
            >
              <span className="pdb-theme-card__head">
                <span aria-hidden>{t.emoji}</span>
                <strong>{t.name}</strong>
                <em>{t.nameEn}</em>
                {active && (
                  <span className="pdb-theme-card__check" style={{ color: t.tokens['--primary'] }}>
                    <PdbIcon name="checkCircle" size={16} />
                  </span>
                )}
              </span>
              <ThemeMiniPreview def={t} />
              <span className="pdb-theme-card__swatches">
                {t.previewSwatches.map((hex) => (
                  <span key={hex} className="pdb-theme-card__swatch" style={{ background: hex }} />
                ))}
              </span>
              <span className="pdb-theme-card__desc" style={{ color: t.tokens['--text-soft'] }}>
                {t.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 迷你画布缩略：颜色全部取自该主题自己的 canvas 令牌（所见即所得） */
function ThemeMiniPreview({ def }: { def: ThemeDefinition }) {
  const c = def.canvas;
  const beadHexes = def.previewSwatches.slice(0, 4);
  const glow = c.highlightGlow === true;
  return (
    <svg className="pdb-theme-card__mini" viewBox="0 0 120 56" role="img" aria-label={`${def.name} 画布预览`}>
      <rect width="120" height="56" rx="6" fill={c.canvasBg} />
      {[1, 2, 3, 4, 5].map((i) => (
        <line key={`v${i}`} x1={i * 20} y1="0" x2={i * 20} y2="56" stroke={c.gridLine} strokeWidth="1" />
      ))}
      {[1, 2].map((i) => (
        <line key={`h${i}`} x1="0" y1={i * 18.7} x2="120" y2={i * 18.7} stroke={c.gridLine} strokeWidth="1" />
      ))}
      <line x1="60" y1="0" x2="60" y2="56" stroke={c.gridLineMajor} strokeWidth="1.4" />
      <circle cx="10" cy="10" r="6.5" fill={c.emptyCell} stroke={c.emptyCellStroke} strokeWidth="1" />
      {[0, 1, 2, 3].map((i) => {
        const cx = 30 + (i % 2) * 40;
        const cy = 10 + Math.floor(i / 2) * 28;
        return (
          <g key={i}>
            {glow && <circle cx={cx} cy={cy} r="9" fill={beadHexes[i]} opacity="0.35" />}
            <circle cx={cx} cy={cy} r="6.5" fill={beadHexes[i]} stroke={c.beadStroke} strokeWidth="1" />
          </g>
        );
      })}
      <text x="112" y="52" fontSize="7" textAnchor="end" fill={c.numberText}>
        104
      </text>
    </svg>
  );
}

/* ==================== 第 2 步：选板规格 ==================== */

function StepBoard() {
  const board = usePdbStore((s) => s.board);
  const calibration = usePdbStore((s) => s.calibration);
  const applyBoardPreset = usePdbStore((s) => s.applyBoardPreset);
  const setCalibration = usePdbStore((s) => s.setCalibration);
  const pushToast = usePdbStore((s) => s.pushToast);
  const [customOpen, setCustomOpen] = useState(false);

  const recommended = BOARD_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ?? BOARD_PRESETS[0]!;
  const active = matchPreset(board);
  const physical = boardPhysicalSizeMm(board);

  const applyRecommended = (): void => {
    applyBoardPreset(presetToBoardConfig(recommended, board));
    // 板钉距变了，校准档里的 pitchMm 也要跟着走，否则 1:1 容量算的是旧钉距
    setCalibration(sanitizeCalibration({ ...sanitizeCalibration(calibration), pitchMm: recommended.pitchMm }));
    pushToast('success', `已选用推荐规格 ${recommended.label} · 钉距 ${recommended.pitchMm}mm · ${mm2cm(recommended.boardSizeMm)}cm 板`);
  };

  const applyPreset = (id: string): void => {
    const preset = BOARD_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    applyBoardPreset(presetToBoardConfig(preset, board));
    setCalibration(sanitizeCalibration({ ...sanitizeCalibration(calibration), pitchMm: preset.pitchMm }));
  };

  return (
    <div className="pdb-wiz-step">
      <div className="pdb-wiz-reco">
        <span className="pdb-wiz-reco__badge">
          <PdbIcon name="success" size={14} />
          推荐 · 已为你预选
        </span>
        <div className="pdb-wiz-reco__main">
          <strong>
            {recommended.cols}×{recommended.rows} 钉
          </strong>
          <span>
            钉距 {recommended.pitchMm} mm · 有效区 {mm2cm(recommended.boardSizeMm)}×
            {mm2cm(recommended.boardSizeMm)} cm · 豆径约 {recommended.beadSizeMm} mm
          </span>
        </div>
        <p className="pdb-wiz-reco__desc">
          对应市售 28×28cm 透明拼豆板（2.6mm 迷你豆 104 钉）。这是最常用的规格，也是本工作台的默认板。
        </p>
        <Button
          variant={active?.id === recommended.id ? 'soft' : 'primary'}
          disabled={active?.id === recommended.id}
          onClick={applyRecommended}
        >
          {active?.id === recommended.id ? '当前已是推荐规格' : '使用推荐规格'}
        </Button>
      </div>

      <p className="pdb-wiz-section__title">其它常见规格（点一下即切换）</p>
      <div className="pdb-wiz-presets">
        <PresetChips />
      </div>
      <div className="pdb-wiz-preset-list">
        {BOARD_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`pdb-wiz-preset-row pdb-pressable ${active?.id === p.id ? 'is-active' : ''}`}
            aria-pressed={active?.id === p.id}
            onClick={() => applyPreset(p.id)}
          >
            <span className="pdb-wiz-preset-row__label">{p.label}</span>
            <span className="pdb-wiz-preset-row__meta">
              钉距 {p.pitchMm} mm · {mm2cm(p.boardSizeMm)}×{mm2cm(p.boardSizeMm)} cm
            </span>
            <span className="pdb-wiz-preset-row__desc">{p.description}</span>
          </button>
        ))}
      </div>

      <p className="pdb-wiz-section__title">
        当前板参数
        <span className="pdb-wiz-section__aside">
          {board.cols}×{board.rows} 格 · 钉距 {board.pitchMm} mm · 整板含边距 {mm2cm(physical.width)}×
          {mm2cm(physical.height)} cm
        </span>
      </p>
      <Button variant="outline" size="sm" onClick={() => setCustomOpen((v) => !v)} aria-expanded={customOpen}>
        <PdbIcon name="settings" size={14} />
        {customOpen ? '收起自定义板参数' : '自定义板参数（行列 / 钉距 / 边距 / 网格编号）'}
      </Button>
      {customOpen && (
        <div className="pdb-wiz-embed pdb-wiz-embed--form">
          <BoardParamsForm />
        </div>
      )}
      <p className="pdb-wiz-note">
        <PdbIcon name="info" size={13} />
        拿不准就保持推荐规格。之后随时能在右侧「板参数」页签或这里改，改了会自动重算分块方案。
      </p>
    </div>
  );
}

/* ==================== 第 3 步：屏幕检测 ==================== */

function StepScreen() {
  const display = usePdbStore((s) => s.display);
  const calibration = usePdbStore((s) => s.calibration);
  const board = usePdbStore((s) => s.board);
  const region = usePdbStore((s) => s.region);
  const setRegion = usePdbStore((s) => s.setRegion);
  const autoSuggestRegion = usePdbStore((s) => s.autoSuggestRegion);
  const pushToast = usePdbStore((s) => s.pushToast);
  const { displays, loading, refresh } = useDisplayList();

  const browser = getBridge().env === 'browser';

  const info = useMemo(() => {
    if (!display) return null;
    const cal = sanitizeCalibration(calibration);
    const refined = refineDevicePx(display);
    const ppi = ppiOf(display);
    const pitchDev = pitchToDevicePx(board.pitchMm, cal);
    const max = maxCellsAt1to1(cal, { width: refined.width, height: refined.height });
    const fit = fitsOnScreen(board, cal, display);
    const suggestion = fit.fits ? null : autoSuggestSplits(board.cols, board.rows, fit.colsMax, fit.rowsMax);
    const boardMm = boardPhysicalSizeMm(board);
    return { refined, ppi, pitchDev, max, fit, suggestion, boardMm };
  }, [display, board, calibration]);

  if (!display || !info) {
    return (
      <div className="pdb-wiz-step">
        <div className="pdb-wiz-banner pdb-wiz-banner--warn">
          <PdbIcon name="warning" size={15} />
          <span>{loading ? '正在检测显示器…' : '暂时读不到显示器信息，可直接跳过这一步，稍后在右侧「校准」页签重试。'}</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          重新检测
        </Button>
      </div>
    );
  }

  const dprPct = Math.round(display.devicePixelRatio * 100);
  const pitchCssX = info.pitchDev.x / display.devicePixelRatio;
  const pitchCssY = info.pitchDev.y / display.devicePixelRatio;

  const adoptSuggestion = (): void => {
    const s = info.suggestion;
    if (!s) return;
    setRegion({ splitsX: s.splitsX, splitsY: s.splitsY, blockCols: s.blockCols, blockRows: s.blockRows, activeIndex: 0 });
    pushToast('success', `已启用分块模式 ${s.splitsX}×${s.splitsY}：首块 ${s.blockCols ?? s.regionCols}×${s.blockRows ?? s.regionRows} 尽量占满，余量归末块`);
  };

  return (
    <div className="pdb-wiz-step">
      <div className="pdb-wiz-banner pdb-wiz-banner--ok">
        <PdbIcon name="monitor" size={15} />
        <span>
          检测到{display.label} {info.refined.width}×{info.refined.height}
          {display.physicalMm
            ? `，物理 ${mm2cm(display.physicalMm.width)}×${mm2cm(display.physicalMm.height)} cm`
            : '，物理尺寸未知'}
          ，缩放 {dprPct}%
          {info.ppi ? `，约 ${info.ppi.x.toFixed(0)} PPI` : ''}；按 {board.pitchMm.toFixed(4)} mm 钉距，1:1 每格{' '}
          {info.pitchDev.x.toFixed(1)} 像素，本屏 1:1 最多显示 {info.max.cols}×{info.max.rows} 格。
        </span>
      </div>
      {info.refined.adjusted && (
        <p className="pdb-wiz-note">
          <PdbIcon name="info" size={13} />
          系统上报的分辨率带 0.5 像素取整偏差，已自动修正为面板真实帧缓冲 {info.refined.width}×{info.refined.height}。
        </p>
      )}

      <dl className="pdb-wiz-facts">
        <div className="pdb-wiz-fact">
          <dt>显示器</dt>
          <dd>
            {display.label}
            {display.isPrimary ? ' · 主屏' : ''}
            {display.isVirtual ? ' · 虚拟屏' : ''}
          </dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>分辨率</dt>
          <dd>
            {info.refined.width}×{info.refined.height} 设备像素
          </dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>物理尺寸</dt>
          <dd>
            {display.physicalMm
              ? `${mm2cm(display.physicalMm.width)}×${mm2cm(display.physicalMm.height)} cm`
              : '未知（需手动校准）'}
          </dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>系统缩放</dt>
          <dd>{dprPct}%（DPR {display.devicePixelRatio.toFixed(2)}）</dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>PPI</dt>
          <dd>{info.ppi ? `${info.ppi.x.toFixed(0)} × ${info.ppi.y.toFixed(0)}` : '未知'}</dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>每格像素</dt>
          <dd>
            {info.pitchDev.x.toFixed(2)} × {info.pitchDev.y.toFixed(2)} 设备像素（{pitchCssX.toFixed(2)} ×{' '}
            {pitchCssY.toFixed(2)} CSS 像素）
          </dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>1:1 最多可容</dt>
          <dd>
            {info.max.cols}×{info.max.rows} 格
          </dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>你的板</dt>
          <dd>
            {board.cols}×{board.rows} 格 · {mm2cm(info.boardMm.width)}×{mm2cm(info.boardMm.height)} cm
          </dd>
        </div>
      </dl>

      {info.fit.fits ? (
        <div className="pdb-wiz-banner pdb-wiz-banner--ok">
          <PdbIcon name="success" size={15} />
          <span>
            好消息：整板 {board.cols}×{board.rows} 能在本屏 1:1 完整显示，无需分块。
            当前分区 {region.splitsX}×{region.splitsY}。
          </span>
        </div>
      ) : (
        <div className="pdb-wiz-banner pdb-wiz-banner--warn">
          <PdbIcon name="warning" size={15} />
          <span>
            你的板（{mm2cm(info.boardMm.height)} cm）
            {display.physicalMm ? `高于屏幕可视区（${mm2cm(display.physicalMm.height)} cm）` : '超出屏幕 1:1 可视区'}
            ，已启用分块模式，建议 {info.suggestion?.splitsX}×{info.suggestion?.splitsY} ={' '}
            {info.suggestion?.regionCols}×{info.suggestion?.regionRows}。拼的时候用 <code>[</code> <code>]</code>{' '}
            在区块间切换。
          </span>
        </div>
      )}

      <div className="pdb-wiz-actions">
        {info.suggestion && (
          <Button variant="primary" size="sm" onClick={adoptSuggestion}>
            <PdbIcon name="blocks" size={14} />
            采用建议分块 {info.suggestion.splitsX}×{info.suggestion.splitsY}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => autoSuggestRegion()}>
          重新自动评估分区
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          重新检测显示器
        </Button>
      </div>

      {browser && (
        <div className="pdb-wiz-banner pdb-wiz-banner--warn">
          <PdbIcon name="warning" size={15} />
          <span>
            当前是浏览器模式：网页拿不到屏幕的物理毫米尺寸，上面的物理尺寸与 PPI 为估算值。
            下一步请用「标尺拖拽」对着实物板校准；完整精度请运行桌面版（<code>npm run dev</code>）。
          </span>
        </div>
      )}

      {display.isVirtual && (
        <div className="pdb-wiz-banner pdb-wiz-banner--danger">
          <PdbIcon name="warning" size={15} />
          <span>当前选中的是虚拟显示器，无法进行 1:1 物理校准，请在下面换成真实屏幕。</span>
        </div>
      )}

      {(displays.length > 1 || displays.some((d) => d.isVirtual)) && (
        <>
          <p className="pdb-wiz-section__title">
            检测到 {displays.length} 个显示器
            <span className="pdb-wiz-section__aside">虚拟屏已置灰并告警，选真实屏幕才能 1:1</span>
          </p>
          <div className="pdb-wiz-embed">
            <DisplayPicker />
          </div>
        </>
      )}
    </div>
  );
}

/* ==================== 第 4 步：校准 ==================== */

function StepCalibration() {
  const display = usePdbStore((s) => s.display);
  const calibration = usePdbStore((s) => s.calibration);
  const setCalibration = usePdbStore((s) => s.setCalibration);
  const resetCalibration = usePdbStore((s) => s.resetCalibration);
  const pushToast = usePdbStore((s) => s.pushToast);
  const [rulerOpen, setRulerOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);

  const cal = sanitizeCalibration(calibration);
  const autoCal = display ? sanitizeCalibration(calibrationFromDisplay(display)) : null;
  const pitchDev = pitchToDevicePx(cal.pitchMm, cal);
  const deviation = autoCal ? ((cal.pitchMm - autoCal.pitchMm) / autoCal.pitchMm) * 100 : 0;

  const applyPitch = (v: number): void => {
    setCalibration(
      sanitizeCalibration({
        ...cal,
        pitchMm: v,
        source: 'manual-ruler',
        displayKey: display ? displayKey(display) : cal.displayKey,
        verifiedAt: new Date().toISOString(),
      }),
    );
  };

  const restoreAuto = (): void => {
    if (!display) {
      pushToast('warning', '读不到显示器信息，无法恢复自动检测值');
      return;
    }
    resetCalibration();
    pushToast('info', '已恢复为自动检测值');
  };

  return (
    <div className="pdb-wiz-step">
      <div className={`pdb-wiz-banner ${cal.source === 'browser-fallback' ? 'pdb-wiz-banner--warn' : 'pdb-wiz-banner--ok'}`}>
        <PdbIcon name={cal.source === 'browser-fallback' ? 'warning' : 'success'} size={15} />
        <span>
          {cal.source === 'browser-fallback'
            ? '浏览器模式下无法自动读取屏幕物理尺寸，当前用的是默认占位值，请用下面的标尺对着实物板微调。'
            : `已用${SOURCE_LABELS[cal.source]}自动填好，通常不需要再动。想更保险可以用标尺对着实物板核对一次。`}
        </span>
      </div>

      <dl className="pdb-wiz-facts">
        <div className="pdb-wiz-fact">
          <dt>校准来源</dt>
          <dd>{SOURCE_LABELS[cal.source]}</dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>钉距 pitch</dt>
          <dd>{cal.pitchMm.toFixed(4)} mm</dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>每毫米设备像素</dt>
          <dd>
            横 {(1 / cal.mmPerDevicePxX).toFixed(2)} · 纵 {(1 / cal.mmPerDevicePxY).toFixed(2)}
          </dd>
        </div>
        <div className="pdb-wiz-fact">
          <dt>每格设备像素</dt>
          <dd>
            {pitchDev.x.toFixed(2)} × {pitchDev.y.toFixed(2)}
          </dd>
        </div>
        {autoCal && (
          <div className="pdb-wiz-fact">
            <dt>与自动值偏差</dt>
            <dd>
              {deviation >= 0 ? '+' : ''}
              {deviation.toFixed(2)}%
            </dd>
          </div>
        )}
      </dl>

      <div className="pdb-wiz-actions">
        <Button variant={rulerOpen ? 'soft' : 'primary'} size="sm" onClick={() => setRulerOpen((v) => !v)} aria-expanded={rulerOpen}>
          <PdbIcon name="ruler" size={14} />
          {rulerOpen ? '收起标尺微调' : '用标尺拖拽微调'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setFullOpen((v) => !v)} aria-expanded={fullOpen}>
          <PdbIcon name="settings" size={14} />
          {fullOpen ? '收起完整校准向导' : '完整校准向导（四种方法）'}
        </Button>
        <Button variant="ghost" size="sm" onClick={restoreAuto}>
          恢复自动检测值
        </Button>
      </div>

      {rulerOpen && (
        <div className="pdb-wiz-embed pdb-wiz-ruler">
          <p className="pdb-wiz-note">
            <PdbIcon name="info" size={13} />
            把透明板贴到下面这条 20 格标尺带上，拖动滑块，直到屏幕上的格线与板子上的钉距完全重合。
          </p>
          <div className="pdb-wiz-ruler__slider">
            <span className="pdb-label">钉距 pitch（mm）</span>
            <Slider
              min={2.4}
              max={3.0}
              step={0.001}
              value={cal.pitchMm}
              onValueChange={applyPitch}
              format={(v) => `${v.toFixed(3)} mm`}
              aria-label="钉距微调"
            />
          </div>
          <CalibrationRuler direction="horizontal" cells={20} calibration={cal} />
          <CalibrationRuler direction="vertical" cells={20} calibration={cal} />
          <p className="pdb-wiz-note">
            微调后每格 {pitchDev.x.toFixed(2)} × {pitchDev.y.toFixed(2)} 设备像素
            {autoCal ? `，与自动值相差 ${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)}%` : ''}。
          </p>
        </div>
      )}

      {fullOpen && (
        <div className="pdb-wiz-embed pdb-wiz-embed--tall">
          <CalibrationWizard />
        </div>
      )}
    </div>
  );
}

/* ==================== 第 5 步：主题与布局 ==================== */

interface StepAppearanceProps {
  onOpenTheme: () => void;
  onOpenLayout: () => void;
}

function StepAppearance({ onOpenTheme, onOpenLayout }: StepAppearanceProps) {
  const theme = usePdbStore((s) => s.theme);
  const layout = usePdbStore((s) => s.layout);
  const setTheme = usePdbStore((s) => s.setTheme);
  const setLayout = usePdbStore((s) => s.setLayout);
  const pushToast = usePdbStore((s) => s.pushToast);

  const choose = (themeId: ThemeId, layoutId: LayoutId): void => {
    setTheme(themeId);
    applyThemeById(themeId);
    setLayout(layoutId);
    saveAppearance({ theme: themeId, layout: layoutId });
  };

  const currentTheme = THEMES[theme]!;
  const currentLayout = LAYOUT_CARDS.find((l) => l.id === layout) ?? LAYOUT_CARDS[0]!;

  return (
    <div className="pdb-wiz-step">
      <p className="pdb-wiz-section__title">
        当前组合
        <span className="pdb-wiz-section__aside">
          {currentTheme.emoji} {currentTheme.name} × {currentLayout.name}
        </span>
      </p>

      <div className="pdb-wiz-matrix" role="group" aria-label="主题与布局组合预览">
        <div className="pdb-wiz-matrix__corner">主题 ＼ 布局</div>
        {LAYOUT_CARDS.map((l) => (
          <div key={l.id} className="pdb-wiz-matrix__colhead">
            <strong>{l.name}</strong>
            <span>{l.short}</span>
          </div>
        ))}

        {THEME_ORDER.map((tid) => {
          const t = THEMES[tid]!;
          return (
            <div key={tid} className="pdb-wiz-matrix__row" style={{ display: 'contents' }}>
              <div className="pdb-wiz-matrix__rowhead" style={{ background: t.tokens['--surface-2'], color: t.tokens['--text'] }}>
                <span aria-hidden>{t.emoji}</span>
                <strong style={{ color: t.tokens['--text'] }}>{t.name}</strong>
                <em style={{ color: t.tokens['--text-mute'] }}>{t.nameEn}</em>
              </div>
              {LAYOUT_CARDS.map((l) => {
                const active = tid === theme && l.id === layout;
                return (
                  <button
                    key={`${tid}-${l.id}`}
                    type="button"
                    className={`pdb-wiz-combo pdb-pressable ${active ? 'is-active' : ''}`}
                    style={t.tokens as unknown as CSSProperties}
                    aria-pressed={active}
                    title={`${t.name} × ${l.name}`}
                    onClick={() => choose(tid, l.id)}
                  >
                    <ComboWireframe id={l.id} />
                    <span className="pdb-wiz-combo__name" style={{ color: t.tokens['--text'] }}>
                      {t.name} · {l.name}
                    </span>
                    <span className="pdb-wiz-combo__swatches">
                      {t.previewSwatches.slice(0, 4).map((hex) => (
                        <i key={hex} style={{ background: hex }} />
                      ))}
                    </span>
                    {active && (
                      <span className="pdb-wiz-combo__check" style={{ color: t.tokens['--primary'] }}>
                        <PdbIcon name="checkCircle" size={15} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="pdb-wiz-actions">
        <Button variant="outline" size="sm" onClick={onOpenTheme}>
          <PdbIcon name="theme" size={14} />
          打开完整主题选择器
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenLayout}>
          <PdbIcon name="layout" size={14} />
          打开完整布局选择器
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            choose('macaron', 'classic');
            pushToast('info', '已恢复默认组合：马卡龙 × 经典三栏');
          }}
        >
          恢复默认组合
        </Button>
      </div>

      <p className="pdb-wiz-note">
        <PdbIcon name="info" size={13} />
        进入拼豆模式（<code>P</code>）时会自动切到「专注拼豆 + 暗夜发光」组合，退出后原样恢复；
        这个联动可以在右侧「拼豆」页签里关掉。
      </p>
    </div>
  );
}

/** 组合卡里的布局线框：用 var(--*) 着色，外层内联注入了目标主题的令牌，所以是「实时预览」 */
function ComboWireframe({ id }: { id: LayoutId }) {
  return (
    <svg className="pdb-wiz-combo__wire" viewBox="0 0 120 60" role="img" aria-label={`${id} 布局示意`}>
      <rect x="1" y="1" width="118" height="58" rx="5" fill="var(--surface-2)" stroke="var(--border-strong)" strokeWidth="1.4" />
      {id === 'classic' && (
        <>
          <rect x="5" y="5" width="110" height="8" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="16" width="12" height="32" rx="2" fill="var(--primary-soft)" />
          <rect x="20" y="16" width="72" height="32" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="95" y="16" width="20" height="32" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="51" width="110" height="5" rx="2" fill="var(--border)" />
        </>
      )}
      {id === 'floating' && (
        <>
          <rect x="5" y="5" width="110" height="44" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="10" y="10" width="30" height="18" rx="4" fill="var(--primary-soft)" stroke="var(--border-strong)" />
          <rect x="34" y="50" width="52" height="7" rx="3.5" fill="var(--primary)" />
        </>
      )}
      {id === 'split' && (
        <>
          <rect x="5" y="5" width="110" height="8" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="16" width="110" height="26" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="5" y="45" width="110" height="11" rx="2" fill="var(--primary-soft)" />
          <circle cx="14" cy="50.5" r="3.4" fill="var(--primary)" />
          <circle cx="24" cy="50.5" r="3.4" fill="var(--accent)" />
          <circle cx="34" cy="50.5" r="3.4" fill="var(--warning)" />
        </>
      )}
      {id === 'focus' && (
        <>
          <rect x="5" y="5" width="110" height="6" rx="2" fill="var(--primary-soft)" />
          <rect x="5" y="14" width="110" height="30" rx="2" fill="var(--surface)" stroke="var(--border)" />
          <rect x="38" y="47" width="44" height="9" rx="4.5" fill="var(--primary)" />
          <text x="60" y="34" fontSize="15" fontWeight="700" textAnchor="middle" fill="var(--text)">
            7
          </text>
        </>
      )}
    </svg>
  );
}
