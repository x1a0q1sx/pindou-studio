/**
 * progress/PlacementBar.tsx —— 拼豆常驻信息条。
 *
 * 常驻显示：当前区块 A2 · 第 3/4 块 · 本区剩余 N 颗 · 当前色号。
 * 数据流：region + beads/placedMask 经 selectors 派生（selectActiveRegion / selectProgressInRegion）→ 只读渲染。
 *
 * 两种形态：
 *   inline  —— 嵌在右侧「进度」页签内（设计态参考）
 *   overlay —— 由 PlacementOverlay 挂在 body 上、拼豆模式下常驻顶部（focus 布局无右面板时的主 HUD）
 *
 * 防休眠：显示当前防休眠状态，并提供手动开关（联动 placementPrefs.keepAwake + bridge.keepAwake）。
 */
import { useMemo } from 'react';
import { usePdbStore } from '@/store';
import { selectActiveRegion, selectProgressInRegion, selectRegionList } from '@/store/selectors';
import { usePlacementPrefs } from '@/store/placementPrefs';
import { getBridge } from '@/io/bridge';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { PdbIcon } from '@/components/icons';
import './progress.css';

export interface PlacementBarProps {
  variant?: 'inline' | 'overlay';
}

export function PlacementBar({ variant = 'inline' }: PlacementBarProps) {
  const beadsVersion = usePdbStore((s) => s.beadsVersion);
  const splitsX = usePdbStore((s) => s.region.splitsX);
  const splitsY = usePdbStore((s) => s.region.splitsY);
  const activeIndex = usePdbStore((s) => s.region.activeIndex);
  const setRegion = usePdbStore((s) => s.setRegion);
  const palette = usePdbStore((s) => s.palette);
  const filterColorIndex = usePdbStore((s) => s.filterColorIndex);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  const pitchMm = usePdbStore((s) => s.board.pitchMm);
  const cols = usePdbStore((s) => s.board.cols);
  const rows = usePdbStore((s) => s.board.rows);
  const calibration = usePdbStore((s) => s.calibration);
  const display = usePdbStore((s) => s.display);
  const showRuler = usePdbStore((s) => s.board.showRuler);
  const setBoardConfig = usePdbStore((s) => s.setBoardConfig);

  const keepAwake = usePlacementPrefs((s) => s.keepAwake);
  const updatePrefs = usePlacementPrefs((s) => s.update);

  const info = useMemo(() => {
    void beadsVersion;
    void splitsX;
    void splitsY;
    void activeIndex;
    const state = usePdbStore.getState();
    const list = selectRegionList(state);
    const region = selectActiveRegion(state);
    const progress = selectProgressInRegion(state, region);
    return { count: list.length, region, progress };
  }, [beadsVersion, splitsX, splitsY, activeIndex]);

  const curColorIndex = filterColorIndex >= 0 ? filterColorIndex : activeColorIndex;
  const curColor = palette.colors[curColorIndex] ?? null;

  const step = (delta: number): void => {
    const n = Math.max(1, info.count);
    const cur = Math.min(Math.max(0, activeIndex), n - 1);
    setRegion({ activeIndex: ((cur + delta) % n + n) % n });
  };

  const toggleKeepAwake = (): void => {
    const next = !keepAwake;
    updatePrefs({ keepAwake: next });
    void getBridge().keepAwake(next);
    usePdbStore.getState().pushToast('info', next ? '已开启防休眠' : '已关闭防休眠', 1800);
  };

  const toggleRuler = (): void => {
    const next = !showRuler;
    setBoardConfig({ showRuler: next });
  };

  /** 豆阵（网格）物理尺寸 cm —— 「28cm 板对不对得上」的直接读数 */
  const areaWcm = (cols * pitchMm) / 10;
  const areaHcm = (rows * pitchMm) / 10;

  /** 校准依据说明：让「格子为何是这个物理大小」一目了然，WMI 假设错了能当场发现 */
  const calTitle = (() => {
    const src = calibration?.source === 'auto-wmi'
      ? '自动检测（显示器 EDID）'
      : calibration?.source === 'browser-fallback'
        ? '浏览器兜底值（不可信，请标尺校准）'
        : '手动校准';
    const screen = display?.physicalMm ? `，屏宽按 ${(display.physicalMm.width / 10).toFixed(0)}cm 估算` : '';
    return `每格 = ${pitchMm}mm（真实豆距），整块豆阵 ${areaWcm.toFixed(1)}×${areaHcm.toFixed(1)}cm。依据：${src}${screen}。把实物板贴屏幕核对：若与屏上格子/豆阵对不上，去「校准」面板用尺子核对或整板对位`;
  })();

  return (
    <div className={`pdb-pbar pdb-pbar--${variant}`} aria-label="拼豆进度条">
      <div className="pdb-pbar__nav">
        <Tooltip label="上一区块 [">
          <Button icon size="sm" variant="outline" aria-label="上一区块" onClick={() => step(-1)}>
            <PdbIcon name="chevronLeft" size={14} />
          </Button>
        </Tooltip>
        <Tooltip label="下一区块 ]">
          <Button icon size="sm" variant="outline" aria-label="下一区块" onClick={() => step(1)}>
            <PdbIcon name="chevronRight" size={14} />
          </Button>
        </Tooltip>
      </div>

      <span className="pdb-pbar__region">
        <PdbIcon name="blocks" size={13} />
        <strong>{info.region.label}</strong>
        <span className="pdb-pbar__step">第 {Math.min(activeIndex, info.count - 1) + 1}/{info.count} 块</span>
      </span>

      <span className="pdb-pbar__sep" aria-hidden />

      <span className="pdb-pbar__remain" aria-live="polite">
        本区剩余 <strong>{info.progress.remainingCells}</strong> 颗
      </span>

      <span className="pdb-pbar__sep" aria-hidden />

      <span className="pdb-pbar__color">
        <span
          className="pdb-pbar__swatch"
          style={{ background: curColor ? curColor.hex : 'transparent' }}
          data-empty={curColor ? undefined : 'true'}
          aria-hidden
        />
        {curColor ? `当前色 ${curColor.code}` : '未选色'}
      </span>

      <span className="pdb-pbar__sep" aria-hidden />

      {/* 格距 = 真实豆距（1:1 的依据与自查入口，用户反馈 #1：格子大小必须可解释） */}
      <span className="pdb-pbar__pitch" title={calTitle}>
        <PdbIcon name="ruler" size={12} />
        每格 {pitchMm}mm · 豆阵 {areaWcm.toFixed(1)}×{areaHcm.toFixed(1)}cm
      </span>

      <span className="pdb-pbar__spacer" />

      <Tooltip label={showRuler ? '隐藏刻度尺（避免遮挡最左列）' : '显示刻度尺'}>
        <button
          type="button"
          className="pdb-pbar__awake"
          data-on={showRuler}
          onClick={toggleRuler}
          aria-pressed={showRuler}
          aria-label="刻度尺开关"
        >
          <PdbIcon name="ruler" size={12} />
          刻度尺{showRuler ? '开' : '关'}
        </button>
      </Tooltip>

      <Tooltip label={keepAwake ? '防休眠已开启，点击关闭' : '防休眠已关闭，点击开启'}>
        <button
          type="button"
          className="pdb-pbar__awake"
          data-on={keepAwake}
          onClick={toggleKeepAwake}
          aria-pressed={keepAwake}
          aria-label="防休眠开关"
        >
          <PdbIcon name="success" size={12} />
          防休眠{keepAwake ? '开' : '关'}
        </button>
      </Tooltip>
    </div>
  );
}
