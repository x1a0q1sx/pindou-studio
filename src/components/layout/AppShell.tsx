/**
 * layout/AppShell —— 布局系统入口：按 store.layout 装配 4 套布局。
 *   classic  顶部工具条 + 左工具栏 + 中画布 + 右面板 + 底部状态栏（信息最全）
 *   floating 画布满屏 + 可拖拽可折叠悬浮面板 + 底部胶囊工具条（最沉浸）
 *   split    上大画布 + 下横向滚动调色板与进度条（小屏/竖屏/触屏）
 *   focus    只有画布 + 顶部极简色条 + 超大字号进度计数 + 区块导航（发光底板专用）
 *
 * 【 新增挂载（本文件是全应用唯一挂载点，既有挂载一律保留）】
 *   1. `<WelcomeWizard />`  首启 5 步引导，localStorage first-run 标志控制；
 *      之后可由「帮助」按钮 / 开始面板的「重看新手引导」重开（事件 `pdb:open-wizard`）。
 *   2. `<StartPanel />`     开始 / 帮助面板（快速开始 + 最近项目 + 快捷键速查），事件 `pdb:open-start`。
 *   3. `<EmptyStates />`    空白板 / 未保存 / 筛选无结果的友好空态层（fixed，z-index 70，不挡绘制）。
 *   4. Ctrl+S / Ctrl+O 捕获阶段拦截器：改道到  的 `SaveDialog` / `OpenDialog`，
 *      与 Toolbar 按钮走同一条事件链路（`pdb:open-save` / `pdb:open-open`）。
 *      拦截器复用 hotkeyMap 的纯函数做输入态/Modal 态豁免，`stopPropagation()` 阻断
 *      `useHotkeys` 的冒泡监听，因此绝不会「既弹自建对话框、又弹系统原生对话框」；
 *      对话框内部仍调 `saveProjectAs()` / `openProject()`，数据链路一字未改。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { usePdbStore } from '@/store';
import { getTheme } from '@/themes';
import { StageCanvas } from '@/components/canvas/StageCanvas';
import { Toolbar } from './Toolbar';
import { LeftRail } from './LeftRail';
import { RightPanel } from './RightPanel';
import { StatusBar } from './StatusBar';
import { PdbIcon, TOOL_ICONS, TOOL_LABELS, TOOL_HINTS } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { useImageImport } from '@/hooks/useImageImport';
/* 懒加载瘦身：对话框与引导层都拆进独立 chunk（事件驱动/低频使用），首屏主包只装工作台本体 */
const ImportDialog = lazy(() =>
  import('@/components/image/ImportDialog').then((m) => ({ default: m.ImportDialog })),
);
import { usePointerPaint } from '@/hooks/usePointerPaint';
import type { UsePointerPaintReturn } from '@/hooks/usePointerPaint';
import { isPlacementSessionActive, useHotkeys } from '@/hooks/useHotkeys';
import { regionLabel } from '@/core/region';
const ReplaceColorDialog = lazy(() =>
  import('@/components/tools/ReplaceColorDialog').then((m) => ({ default: m.ReplaceColorDialog })),
);
const BeadListDialog = lazy(() =>
  import('@/components/tools/BeadListDialog').then((m) => ({ default: m.BeadListDialog })),
);
const PatternWebDialog = lazy(() =>
  import('@/components/community/PatternWebDialog').then((m) => ({ default: m.PatternWebDialog })),
);
const SmartBoardDialog = lazy(() =>
  import('@/components/bluetooth/SmartBoardDialog').then((m) => ({ default: m.SmartBoardDialog })),
);
const CastDialog = lazy(() =>
  import('@/components/cast/CastDialog').then((m) => ({ default: m.CastDialog })),
);
const VirtualBoardDialog = lazy(() =>
  import('@/components/virtualboard/VirtualBoardDialog').then((m) => ({ default: m.VirtualBoardDialog })),
);
const VbMiniBoard = lazy(() =>
  import('@/components/virtualboard/VbMiniBoard').then((m) => ({ default: m.VbMiniBoard })),
);
import { useAutoSave } from '@/hooks/useAutoSave';
// 打开事件走轻量 dialogBus（不经桶文件，避免把对话框组件静态拉回首屏）
import { openOpenDialog, openSaveDialog } from '@/components/project/dialogBus';
import { RestorePrompt } from '@/components/project/RestorePrompt';
const ExportDialog = lazy(() =>
  import('@/components/project/ExportDialog').then((m) => ({ default: m.ExportDialog })),
);
const SaveDialog = lazy(() =>
  import('@/components/project/SaveDialog').then((m) => ({ default: m.SaveDialog })),
);
const OpenDialog = lazy(() =>
  import('@/components/project/OpenDialog').then((m) => ({ default: m.OpenDialog })),
);
import { matchHotkey, shouldPreventDefault, isTypingTarget } from '@/hooks/hotkeyMap';
const EmptyStates = lazy(() =>
  import('@/components/onboarding/EmptyStates').then((m) => ({ default: m.EmptyStates })),
);
const StartPanel = lazy(() =>
  import('@/components/onboarding/StartPanel').then((m) => ({ default: m.StartPanel })),
);
const WelcomeWizard = lazy(() =>
  import('@/components/onboarding/WelcomeWizard').then((m) => ({ default: m.WelcomeWizard })),
);
import { openStartPanel } from '@/components/onboarding/firstRun';
import { ThemeSwitcher } from '@/components/theme/ThemeSwitcher';
import { LayoutSwitcher } from '@/components/theme/LayoutSwitcher';
import { saveAppearance } from '@/components/theme/appearance';
import { DualPalette } from './DualPalette';
import { DualPaneBar } from './DualPaneBar';
import { clampDualSplit, loadDualSplit, saveDualSplit } from './dualSplit';
import type { ToolId } from '@/core/types';
import './tools.css';

export function AppShell() {
  const layout = usePdbStore((s) => s.layout);
  /** 画布 ref（契约接入点： 渲染器直接取这个 HTMLCanvasElement 建四层缓存） */
  const stageRef = useRef<HTMLCanvasElement | null>(null);

  /* : 指针绘制编排（7 种工具）——回调引用恒定，不会导致 StageCanvas 重建 Renderer */
  const paint = usePointerPaint();
  /* 全局快捷键（全表），全应用只挂载一次 */
  useHotkeys({ stageRef });

  /* : 自动保存（3s 防抖 localStorage + Electron APPDATA 镜像 + 启动恢复检测） */
  const autoSave = useAutoSave({ promptOnStart: true, flushOnHide: true });

  /* : 图片导入对话框 */
  const importer = useImageImport();
  useEffect(() => {
    const handler = (): void => importer.setDialogOpen(true);
    window.addEventListener('pdb:open-import', handler);
    return () => window.removeEventListener('pdb:open-import', handler);
  }, [importer.setDialogOpen]);

  /* 图纸 Web：搜索对话框下载的 File 经事件送入导入管线（start 自带 loading→cropping 流程） */
  useEffect(() => {
    const handler = (e: Event): void => {
      const file = (e as CustomEvent<File>).detail;
      if (file instanceof File) void importer.start(file);
    };
    window.addEventListener('pdb:import-file', handler);
    return () => window.removeEventListener('pdb:import-file', handler);
  }, [importer.start]);

  /* 手机投图：接线主进程推送的收件箱（懒载，首屏不背 castInbox 及其依赖） */
  useEffect(() => {
    void import('@/core/castInbox').then((m) => m.startCastInbox());
  }, []);

  /* : Ctrl+S / Ctrl+O 捕获阶段拦截 —— 改道到应用自有的保存/打开对话框。
     必须用捕获阶段（第三个参数 true）：window 上的捕获监听先于 useHotkeys 的冒泡监听触发，
     stopPropagation 后 useHotkeys 就收不到这两个键，原生对话框不会被同时唤起。 */
  useEffect(() => {
    const onCaptureKey = (e: KeyboardEvent): void => {
      const ctx = {
        typing: isTypingTarget(document.activeElement as HTMLElement | null),
        modalOpen: document.querySelector('.pdb-modal-overlay') !== null,
      };
      const action = matchHotkey(e, ctx);
      if (action !== 'save' && action !== 'open') return;
      if (!shouldPreventDefault(e, ctx)) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'save') openSaveDialog();
      else openOpenDialog();
    };
    window.addEventListener('keydown', onCaptureKey, true);
    return () => window.removeEventListener('keydown', onCaptureKey, true);
  }, []);

  const renderLayout = (): ReactNode => {
    switch (layout) {
      case 'floating':
        return <FloatingLayout stageRef={stageRef} paint={paint} />;
      case 'split':
        return <SplitLayout stageRef={stageRef} paint={paint} />;
      case 'focus':
        return <FocusLayout stageRef={stageRef} paint={paint} />;
      case 'dual':
        return <DualLayout stageRef={stageRef} paint={paint} />;
      case 'classic':
      default:
        return <ClassicLayout stageRef={stageRef} paint={paint} />;
    }
  };

  return (
    <>
      {renderLayout()}
      {/* 懒加载对话框统一挂在一个 Suspense 下：打开瞬间才下载对应 chunk（fallback=null 无闪烁） */}
      <Suspense fallback={null}>
        <ImportDialog
          open={importer.dialogOpen}
          onClose={() => importer.setDialogOpen(false)}
          importer={importer}
        />
        {/* : 「同色替换」自选源色/目标色对话框（由 LeftRail 或 pdb:open-replace-color 事件打开） */}
        <ReplaceColorDialog />
        {/* 色号清单：粘贴外部图纸用料清单，对色号并算用量（LeftRail / pdb:open-beadlist 事件打开） */}
        <BeadListDialog />
        {/* 图纸 Web：从 Reddit 社区检索现成图纸一键导入（LeftRail / pdb:open-pattern-web 事件打开） */}
        <PatternWebDialog />
        {/* 智能拼豆板：蓝牙搜索 / 连接 / GATT 探测（实验；pdb:open-smartboard 事件打开） */}
        <SmartBoardDialog />
        {/* 手机投图：局域网上传服务 + 二维码 + 收件箱（pdb:open-cast 事件打开） */}
        <CastDialog />
        {/* PC 虚拟智能拼豆板：BLE 外设旁路管理（实验；pdb:open-virtualboard 事件打开） */}
        <VirtualBoardDialog />
        {/* 智能板小窗：设计模式右下角显示手机下发图案 + 连接状态（旁路在跑才出现，自隐于其他模式） */}
        <VbMiniBoard />
        {/* : 项目存取与导出对话框 */}
        <ExportDialog />
        <SaveDialog />
        <OpenDialog />
        {/* : 引导与体验打磨层（三者在 4 套布局下通用，均为 fixed / 事件驱动，互不遮挡） */}
        <EmptyStates />
        <StartPanel />
        <WelcomeWizard />
      </Suspense>
      <RestorePrompt autoSave={autoSave} />
    </>
  );
}

type StageRef = MutableRefObject<HTMLCanvasElement | null>;

/** 4 套布局共用的 props：画布 ref +  指针绘制回调 */
interface LayoutProps {
  stageRef: StageRef;
  paint: UsePointerPaintReturn;
}

/** : 把指针绘制回调接到 StageCanvas（4 套布局共用同一份回调实例） */
function StageWithPaint({ stageRef, paint }: LayoutProps) {
  return (
    <StageCanvas
      stageRef={stageRef}
      onCellHit={paint.onCellHit}
      onCellHover={paint.onCellHover}
      onCellLeave={paint.onCellLeave}
    />
  );
}

/**
 * 双板并排布局：屏幕左右各一块独立画布，渲染**同一份图纸**、
 * 各自独立的平移/缩放视图（左 = view，右 = viewB）。适合宽幅作品左右各放一块板
 * 同时拼，或一边对照原图一边核对。拼豆模式下两块画布都锁 1:1，拖拽平移、单击标记
 * 在各自半区独立生效。
 *
 * 体验优化：① 分割线可拖拽（比例持久化 localStorage，键盘 ←/→ 微调）；
 * ② 右下角浮动调色板按钮（可拖动），dual 布局里不用切布局就能选色/换色板。
 */
function DualLayout({ stageRef, paint }: LayoutProps) {
  const rightStageRef = useRef<HTMLCanvasElement | null>(null);
  const [split, setSplit] = useState(loadDualSplit);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ rect: DOMRect } | null>(null);

  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !containerRef.current) return;
    e.preventDefault();
    dragRef.current = { rect: containerRef.current.getBoundingClientRect() };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败不视为错误 */
    }
  };
  const onDividerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    const pct = (e.clientX - d.rect.left) / d.rect.width;
    setSplit(clampDualSplit(pct));
  };
  const onDividerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    // 无效/合成 pointerId 会抛 NotFoundError：先落比例再释放，且释放失败不阻断持久化
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 捕获失败不视为错误 */
    }
    setSplit((v) => {
      saveDualSplit(v);
      return v;
    });
  };
  const onDividerKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = (e.key === 'ArrowLeft' ? -0.05 : 0.05) * (e.shiftKey ? 2 : 1);
    setSplit((v) => {
      const next = clampDualSplit(v + delta);
      saveDualSplit(next);
      return next;
    });
  };

  return (
    <div className="pdb-shell pdb-shell--dual">
      <Toolbar />
      <div
        className="pdb-dual"
        ref={containerRef}
        style={{ gridTemplateColumns: `${split}fr 6px ${(1 - split).toFixed(4)}fr` }}
      >
        <div className="pdb-dual__pane">
          <StageCanvas
            stageRef={stageRef}
            viewKey="view"
            onCellHit={paint.onCellHit}
            onCellHover={paint.onCellHover}
            onCellLeave={paint.onCellLeave}
          />
          <DualPaneBar pane="A" />
        </div>
        <div
          className="pdb-dual__divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整左右画布宽度（←/→ 微调）"
          tabIndex={0}
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerUp}
          onPointerCancel={onDividerUp}
          onKeyDown={onDividerKey}
        />
        <div className="pdb-dual__pane">
          <StageCanvas
            stageRef={rightStageRef}
            viewKey="viewB"
            dataKey="B"
            onCellHover={paint.onCellHover}
            onCellLeave={paint.onCellLeave}
          />
          <DualPaneBar pane="B" />
        </div>
      </div>
      <StatusBar />
      <DualPalette />
    </div>
  );
}

/* ================= L1 经典三栏 ================= */

function ClassicLayout({ stageRef, paint }: LayoutProps) {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  return (
    <div
      className="pdb-shell pdb-shell--classic"
      data-left-collapsed={leftCollapsed}
      data-right-collapsed={rightCollapsed}
    >
      {/* 画笔/橡皮工具归 LeftRail；左栏收起时顶栏补回工具按钮，保证随时可切 */}
      <Toolbar showTools={leftCollapsed} />
      <div className="pdb-classic__middle">
        <LeftRail collapsed={leftCollapsed} onToggle={() => setLeftCollapsed((v) => !v)} />
        <main className="pdb-canvas-area">
          <StageWithPaint stageRef={stageRef} paint={paint} />
        </main>
        <RightPanel collapsed={rightCollapsed} onToggle={() => setRightCollapsed((v) => !v)} />
      </div>
      <StatusBar />
    </div>
  );
}

/* ================= L2 悬浮面板 ================= */

function FloatingLayout({ stageRef, paint }: LayoutProps) {
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [pos, setPos] = useState({ x: 24, y: 76 });
  const dragState = useRef<{ dx: number; dy: number } | null>(null);

  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragState.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败不视为错误 */
    }
  };
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragState.current;
    if (!d) return;
    setPos({
      x: Math.min(window.innerWidth - 120, Math.max(0, e.clientX - d.dx)),
      y: Math.min(window.innerHeight - 60, Math.max(0, e.clientY - d.dy)),
    });
  };
  const onDragEnd = (): void => {
    dragState.current = null;
  };

  return (
    <div className="pdb-shell pdb-shell--floating">
      <main className="pdb-canvas-area pdb-canvas-area--full">
        <StageWithPaint stageRef={stageRef} paint={paint} />
      </main>

      {/* 可拖拽可折叠悬浮面板 */}
      <div
        className={`pdb-float-panel ${panelCollapsed ? 'is-collapsed' : ''}`}
        style={{ left: pos.x, top: pos.y }}
      >
        <div className="pdb-float-panel__handle" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}>
          <PdbIcon name="drag" size={14} />
          <span className="pdb-label">面板</span>
          <span className="pdb-toolbar__spacer" />
          <Tooltip label={panelCollapsed ? '展开悬浮面板' : '折叠悬浮面板（只留画布）'} side="left">
            <Button icon size="sm" aria-label={panelCollapsed ? '展开面板' : '折叠面板'} onClick={() => setPanelCollapsed((v) => !v)}>
              <PdbIcon name={panelCollapsed ? 'plus' : 'minus'} size={13} />
            </Button>
          </Tooltip>
        </div>
        {!panelCollapsed && (
          <div className="pdb-float-panel__body">
            <FloatingColors />
          </div>
        )}
      </div>

      {/* 底部胶囊工具条 */}
      <Toolbar capsule />
    </div>
  );
}

function FloatingColors() {
  const palette = usePdbStore((s) => s.palette);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  const setActiveColorIndex = usePdbStore((s) => s.setActiveColorIndex);
  return (
    <div className="pdb-swatch-row">
      {palette.colors.map((c, i) => (
        <button
          key={c.id}
          type="button"
          className={`pdb-swatch pdb-pressable pdb-lift ${i === activeColorIndex ? 'is-active' : ''}`}
          style={{ background: c.hex }}
          title={`${c.code} ${c.nameZh ?? c.name}`}
          aria-label={`${c.code} ${c.nameZh ?? c.name}`}
          onClick={() => setActiveColorIndex(i)}
        />
      ))}
    </div>
  );
}

/* ================= L3 上下分区 ================= */

function SplitLayout({ stageRef, paint }: LayoutProps) {
  const beads = usePdbStore((s) => s.beads);
  // 进度读 store 增量统计：统计在每次 beads/placed 变更入口重算一次（computeStats），
  // 渲染期 O(1)——原实现渲染期全板扫描，拖拽笔画每帧扫一遍
  const placed = usePdbStore((s) => s.placedCount);
  const pct = beads.length > 0 ? Math.round((placed / beads.length) * 100) : 0;

  return (
    <div className="pdb-shell pdb-shell--split">
      <Toolbar />
      <main className="pdb-canvas-area">
        <StageWithPaint stageRef={stageRef} paint={paint} />
      </main>
      <div className="pdb-split-bottom">
        <div className="pdb-split-bottom__scroll">
          <FloatingColors />
        </div>
        <div className="pdb-split-bottom__progress">
          <div className="pdb-progress-track" aria-label={`拼豆进度 ${pct}%`}>
            <div className="pdb-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="pdb-chip">{pct}% · 已放 {placed}</span>
        </div>
      </div>
    </div>
  );
}

/* ================= L4 专注拼豆 ================= */

function FocusLayout({ stageRef, paint }: LayoutProps) {
  const palette = usePdbStore((s) => s.palette);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  const setActiveColorIndex = usePdbStore((s) => s.setActiveColorIndex);
  const filterColorIndex = usePdbStore((s) => s.filterColorIndex);
  const setFilter = usePdbStore((s) => s.setFilter);
  const filterMode = usePdbStore((s) => s.filterMode);
  const beads = usePdbStore((s) => s.beads);
  // 每色进度读 store 增量统计（computeStats 在变更入口重算），渲染期 O(1)——原实现
  // 渲染期全板扫描，拖拽笔画每帧扫一遍
  const colorStats = usePdbStore((s) => s.colorStats);
  const placedAll = usePdbStore((s) => s.placedCount);
  const region = usePdbStore((s) => s.region);
  const setRegion = usePdbStore((s) => s.setRegion);
  const themeId = usePdbStore((s) => s.theme);
  const setLayout = usePdbStore((s) => s.setLayout);
  const pushToast = usePdbStore((s) => s.pushToast);
  /** #25 高危B：拼豆会话激活中 → 快捷条加 --placement 类，让出 PlacementOverlay 的覆盖区（CSS 双保险之一） */
  const placementActive = usePdbStore((s) => s.mode === 'placement');
  const [themeOpen, setThemeOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);

  const activeColor = palette.colors[activeColorIndex] ?? null;
  const tokens = getTheme(themeId).canvas;

  /** 缺陷#3：focus 布局的「切回出口」——返回经典三栏并持久化，用户永远不会被困在极简壳里。
   *  #25：拼豆会话激活期间只 setLayout 不 saveAppearance——临时选择由 useHotkeys 退出快照
   *  恢复（同样不持久化），两出口行为一致，避免「重启后打开的是临时布局」的语义漂移。 */
  const backToClassic = (): void => {
    setLayout('classic');
    if (!isPlacementSessionActive()) saveAppearance({ layout: 'classic' });
    pushToast('info', '已返回经典三栏布局');
  };

  // 当前筛选色的 已放/总量（filterColorIndex<0 时统计全板）——store 增量统计 O(1) 读取
  const target = filterColorIndex >= 0 ? filterColorIndex + 1 : -1;
  const total = target === -1 ? beads.length : (colorStats.total[target] ?? 0);
  const placed = target === -1 ? placedAll : (colorStats.placed[target] ?? 0);
  const remain = Math.max(0, total - placed);

  const regionCount = region.splitsX * region.splitsY;
  // #25：区块标签统一走 core/region.ts 的 regionLabel（字母=列 ix + 数字=行 iy+1，与画布括标一致），
  // 删除此处「字母(iy)+数字(ix+1)」的手写拼接（与画布口径相反的旧缺陷）
  const regionLabelText = regionLabel(
    region.activeIndex % Math.max(1, region.splitsX),
    Math.floor(region.activeIndex / Math.max(1, region.splitsX)),
  );
  const stepRegion = (delta: number): void =>
    setRegion({ activeIndex: (region.activeIndex + delta + regionCount) % regionCount });

  const colorStrip: ReactNode = (
    <div className="pdb-focus-strip">
      {palette.colors.map((c, i) => {
        const selected = i === (filterColorIndex >= 0 ? filterColorIndex : activeColorIndex);
        return (
          <button
            key={c.id}
            type="button"
            className={`pdb-focus-strip__swatch pdb-pressable ${selected ? 'is-active' : ''}`}
            style={{ background: c.hex }}
            title={`${c.code} ${c.nameZh ?? c.name}`}
            aria-label={c.nameZh ?? c.name}
            onClick={() => {
              setActiveColorIndex(i);
              setFilter(i, filterMode === 'off' ? 'only' : filterMode);
            }}
          />
        );
      })}
    </div>
  );

  return (
    <div className="pdb-shell pdb-shell--focus" style={{ background: tokens.canvasBg }}>
      {colorStrip}
      <main className="pdb-canvas-area pdb-canvas-area--full">
        <StageWithPaint stageRef={stageRef} paint={paint} />
      </main>
      <div className="pdb-focus-hud">
        <div className="pdb-focus-hud__count" aria-live="polite">
          <strong>{remain}</strong>
          <span>剩余颗数{activeColor ? ` · ${activeColor.code} ${activeColor.nameZh ?? activeColor.name}` : ''}</span>
        </div>
        <div className="pdb-focus-hud__nav">
          <Tooltip label="上一区块 [">
            <Button icon variant="outline" aria-label="上一区块" onClick={() => stepRegion(-1)}>
              <PdbIcon name="chevronLeft" size={17} />
            </Button>
          </Tooltip>
          <span className="pdb-chip pdb-chip--active">
            <PdbIcon name="blocks" size={12} />
            区块 {regionLabelText} · {region.activeIndex + 1}/{regionCount}
          </span>
          <Tooltip label="下一区块 ]">
            <Button icon variant="outline" aria-label="下一区块" onClick={() => stepRegion(1)}>
              <PdbIcon name="chevronRight" size={17} />
            </Button>
          </Tooltip>
        </div>
        <div className="pdb-focus-hud__tools">
          {(['markPlaced', 'pan'] as ToolId[]).map((t) => (
            <FocusToolButton key={t} tool={t} />
          ))}
        </div>
      </div>
      {/* 缺陷#3：右上角浮动快捷入口——返回经典 / 布局 / 主题 / 帮助，极简壳里永远切得回去；
          #25：拼豆会话期追加 --placement 类（配 layout.css 抬升 z-index 并左移出 overlay 区） */}
      <div
        className={`pdb-focus-quickbar ${placementActive ? 'pdb-focus-quickbar--placement' : ''}`}
        role="toolbar"
        aria-label="布局快捷入口"
      >
        <Tooltip label="返回经典三栏布局" side="left">
          <Button icon variant="outline" aria-label="返回经典三栏布局" onClick={backToClassic}>
            <PdbIcon name="grid" size={17} />
          </Button>
        </Tooltip>
        <Tooltip label="切换布局" side="left">
          <Button icon variant="outline" aria-label="切换布局" onClick={() => setLayoutOpen(true)}>
            <PdbIcon name="layout" size={17} />
          </Button>
        </Tooltip>
        <Tooltip label="切换主题" side="left">
          <Button icon variant="outline" aria-label="切换主题" onClick={() => setThemeOpen(true)}>
            <PdbIcon name="theme" size={17} />
          </Button>
        </Tooltip>
        <Tooltip label="帮助 · 开始面板" side="left">
          <Button icon variant="outline" aria-label="帮助与开始面板" onClick={openStartPanel}>
            <PdbIcon name="info" size={17} />
          </Button>
        </Tooltip>
      </div>
      <ThemeSwitcher open={themeOpen} onClose={() => setThemeOpen(false)} />
      <LayoutSwitcher open={layoutOpen} onClose={() => setLayoutOpen(false)} />
    </div>
  );
}

function FocusToolButton({ tool }: { tool: ToolId }) {
  const current = usePdbStore((s) => s.tool);
  const setTool = usePdbStore((s) => s.setTool);
  return (
    <Tooltip label={`${TOOL_LABELS[tool]} · ${TOOL_HINTS[tool]}`} side="top">
      <Button icon variant={current === tool ? 'primary' : 'outline'} aria-label={TOOL_LABELS[tool]} onClick={() => setTool(tool)}>
        <PdbIcon name={TOOL_ICONS[tool]!} size={18} />
      </Button>
    </Tooltip>
  );
}
