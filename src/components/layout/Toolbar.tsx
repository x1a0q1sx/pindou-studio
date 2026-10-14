/**
 * layout/Toolbar —— 顶部工具条（classic/split/focus 使用）与底部胶囊工具条（floating 使用）。
 *
 * 画笔/橡皮等工具按钮的归属：classic 由左侧 LeftRail 承担（顶栏 `showTools={false}`，
 * 左栏收起时传 true 补回），dual/split/胶囊仍由本组件显示，避免重复与失踪两种极端。
 *
 *  接线完成：所有按钮统一走 `runAppAction()` / `setPlacementMode()`，
 * 与 `useHotkeys` 的键盘路径**共用同一个动作执行器**，保证「点按钮」和「按键」的
 * 行为、Toast 文案、联动逻辑（全屏 / 1:1 / focus 布局 / glowDark 主题 / 防休眠）完全一致。
 *
 *  接线（关闭 Bill 报告的缺口 1）：
 *   「保存 / 打开」不再直连 `runAppAction('save'|'open')` 的原生对话框，而是派发
 *   `pdb:open-save` / `pdb:open-open`，由 AppShell 已挂载的  `SaveDialog` / `OpenDialog`
 *   接管 —— 于是「项目名编辑 + 最近项目列表」这两个应用自有对话框终于有了入口。
 *   对话框内部仍然调用 `saveProjectAs()` / `openProject()`，走的是同一套完整序列化
 *   （beads/placedMask base64 + 校准档 + 拼豆进度），数据链路一字未改，不会丢数据。
 *   Ctrl+S / Ctrl+O 的键盘路径由 AppShell 的捕获阶段拦截器统一改道到同两个事件。
 *   另新增「帮助」按钮 → 派发 `pdb:open-start` 打开开始/帮助面板（内含「重看新手引导」）。
 */
import { useEffect, useState } from 'react';
import { usePdbStore } from '@/store';
import { canRedo, canUndo, peekRedoInfo, peekUndoInfo } from '@/store/history';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { Tooltip } from '@/components/ui/Tooltip';
import { PdbIcon, TOOL_ICONS, TOOL_LABELS, TOOL_HINTS } from '@/components/icons';
import { ThemeSwitcher } from '@/components/theme/ThemeSwitcher';
import { LayoutSwitcher } from '@/components/theme/LayoutSwitcher';
import { openOpenDialog, openSaveDialog } from '@/components/project/dialogBus';
import { openStartPanel } from '@/components/onboarding/firstRun';
import { getBridge, isElectron } from '@/io/bridge';
import { runAppAction, setPlacementMode, usePanelsHidden } from '@/hooks/useHotkeys';
import { TOOL_HOTKEYS } from '@/hooks/hotkeyMap';
import type { AppMode, ToolId } from '@/core/types';

const TOOLS = Object.keys(TOOL_ICONS) as ToolId[];

/** 工具按钮组（LeftRail 与胶囊工具条共用） */
function ToolButtons({ vertical = false }: { vertical?: boolean }) {
  const tool = usePdbStore((s) => s.tool);
  const setTool = usePdbStore((s) => s.setTool);
  return (
    <>
      {TOOLS.map((t) => (
        <Tooltip key={t} label={`${TOOL_LABELS[t]} · ${TOOL_HINTS[t]} · ${TOOL_HOTKEYS[t]}`} side={vertical ? 'right' : 'top'}>
          <Button
            icon
            variant={tool === t ? 'soft' : 'ghost'}
            aria-label={TOOL_LABELS[t]}
            aria-pressed={tool === t}
            onClick={() => setTool(t)}
          >
            <PdbIcon name={TOOL_ICONS[t]!} size={17} />
          </Button>
        </Tooltip>
      ))}
    </>
  );
}

/**
 * 历史按钮 ——  接管：调用 `store/history.ts` 的真实撤销/重做（稀疏 diff 回写 beads）。
 * `canUndo()/canRedo()` 本身是同步读 store 的纯查询，订阅 `past.length/future.length`
 * 即可让按钮的 disabled 态随编辑反应式更新。
 */
function HistoryButtons() {
  const pastLen = usePdbStore((s) => s.past.length);
  const futureLen = usePdbStore((s) => s.future.length);

  const undoInfo = pastLen > 0 ? peekUndoInfo() : null;
  const redoInfo = futureLen > 0 ? peekRedoInfo() : null;
  const undoTip = undoInfo
    ? `撤销「${undoInfo.label}」${undoInfo.cells} 格${undoInfo.isSnapshot ? '（快照）' : ''} · Ctrl+Z`
    : '撤销 · Ctrl+Z（暂无可撤销的操作）';
  const redoTip = redoInfo
    ? `重做「${redoInfo.label}」${redoInfo.cells} 格${redoInfo.isSnapshot ? '（快照）' : ''} · Ctrl+Shift+Z`
    : '重做 · Ctrl+Shift+Z / Ctrl+Y（暂无可重做的操作）';

  return (
    <>
      <Tooltip label={undoTip}>
        <Button icon aria-label="撤销" disabled={!canUndo()} onClick={() => runAppAction('undo')}>
          <PdbIcon name="undo" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label={redoTip}>
        <Button icon aria-label="重做" disabled={!canRedo()} onClick={() => runAppAction('redo')}>
          <PdbIcon name="redo" size={17} />
        </Button>
      </Tooltip>
    </>
  );
}

/**
 * 文件按钮： 改接 `store/persistence.ts` 的完整项目序列化（beads/placedMask base64 + 校准档）。
 * 原  骨架保存只写板参数、不含 beads（真实缺陷），已由 `saveProjectAs/openProject` 取代；
 * 这两个函数内部自带成功/失败/取消的中文 Toast，此处不再重复提示。
 * 「导入图片」按钮的 `pdb:open-import` 事件链路完整保留（ImportDialog 由 AppShell 监听）。
 *
 * ：「打开」「保存」改走  自建对话框（派发事件），保留项目名编辑与最近项目列表；
 * 真正的读写仍由对话框内部调用 `openProject()/saveProjectAs()` 完成，快速保存能力不受影响。
 */
function FileButtons() {
  return (
    <>
      <Tooltip label="导入图片 · Ctrl+Shift+I（像素化 + 自动配色）">
        <Button icon aria-label="导入图片" onClick={() => runAppAction('importImage')}>
          <PdbIcon name="import" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label="打开项目 · Ctrl+O（含最近项目列表）">
        <Button icon aria-label="打开项目" onClick={openOpenDialog}>
          <PdbIcon name="folderOpen" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label="保存项目 · Ctrl+S（可编辑项目名）">
        <Button icon aria-label="保存项目" onClick={openSaveDialog}>
          <PdbIcon name="save" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label="导出施工图 · Ctrl+E">
        <Button icon aria-label="导出施工图" onClick={() => runAppAction('export')}>
          <PdbIcon name="export" size={17} />
        </Button>
      </Tooltip>
    </>
  );
}

/** 视图/环境按钮组（全屏、网格、面板显隐、防休眠、主题、布局） */
function ViewButtons() {
  const mode = usePdbStore((s) => s.mode);
  const showGrid = usePdbStore((s) => s.board.showGrid);
  const showRuler = usePdbStore((s) => s.board.showRuler);
  const setBoardConfig = usePdbStore((s) => s.setBoardConfig);
  const pushToast = usePdbStore((s) => s.pushToast);
  const panelsHidden = usePanelsHidden();
  const [awake, setAwake] = useState(mode === 'placement');
  const [themeOpen, setThemeOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);

  // 拼豆模式联动会自己开/关防休眠（setPlacementMode 内调 keepAwake），
  // 这里跟随 mode 同步本地读数，避免按钮状态与真实 wakeLock 脱节。
  useEffect(() => {
    setAwake(mode === 'placement');
  }, [mode]);

  const toggleAwake = async (): Promise<void> => {
    const next = !awake;
    await getBridge().keepAwake(next);
    setAwake(next);
    pushToast('info', next ? '防休眠已开启（长时间拼豆不怕黑屏）' : '防休眠已关闭');
  };

  return (
    <>
      <Tooltip label="全屏切换 · F（Electron 下可指定显示器）">
        <Button icon aria-label="全屏" onClick={() => runAppAction('fullscreen')}>
          <PdbIcon name="fullscreen" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label={showGrid ? '隐藏网格 · H' : '显示网格 · H'}>
        <Button
          icon
          aria-label="网格显隐"
          aria-pressed={showGrid}
          variant={showGrid ? 'ghost' : 'soft'}
          onClick={() => runAppAction('toggleGrid')}
        >
          <PdbIcon name="grid" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label={showRuler ? '隐藏刻度尺（拼豆下会遮挡最左列）' : '显示刻度尺'}>
        <Button
          icon
          aria-label="刻度尺显隐"
          aria-pressed={showRuler}
          variant={showRuler ? 'ghost' : 'soft'}
          onClick={() => setBoardConfig({ showRuler: !showRuler })}
        >
          <PdbIcon name="ruler" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label={panelsHidden ? '显示面板 · M' : '隐藏面板 · M（只留画布）'}>
        <Button
          icon
          aria-label="面板显隐"
          aria-pressed={!panelsHidden}
          variant={panelsHidden ? 'soft' : 'ghost'}
          onClick={() => runAppAction('togglePanels')}
        >
          <PdbIcon name="monitor" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label="防休眠（拼豆模式自动开启）">
        <Button icon aria-label="防休眠" variant={awake ? 'soft' : 'ghost'} onClick={() => void toggleAwake()}>
          <PdbIcon name="bead" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label="主题 · T 循环切换">
        <Button icon aria-label="切换主题" onClick={() => setThemeOpen(true)}>
          <PdbIcon name="theme" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label="布局">
        <Button icon aria-label="切换布局" onClick={() => setLayoutOpen(true)}>
          <PdbIcon name="layout" size={17} />
        </Button>
      </Tooltip>
      <Tooltip label="帮助 · 开始面板（快速开始 / 最近项目 / 快捷键 / 重看引导）">
        <Button icon aria-label="帮助与开始面板" onClick={openStartPanel}>
          <PdbIcon name="info" size={17} />
        </Button>
      </Tooltip>
      <ThemeSwitcher open={themeOpen} onClose={() => setThemeOpen(false)} />
      <LayoutSwitcher open={layoutOpen} onClose={() => setLayoutOpen(false)} />
    </>
  );
}

/**
 * 笔刷大小：画笔/橡皮选中时显示的 N×N 步进器（1–9）。
 * 顶栏横排形态与 LeftRail 竖排形态（vertical，52px 窄栏放不下横排）共用。
 */
export function BrushSizeControl({ vertical = false }: { vertical?: boolean }) {
  const tool = usePdbStore((s) => s.tool);
  const brushSize = usePdbStore((s) => s.brushSize);
  const setBrushSize = usePdbStore((s) => s.setBrushSize);
  if (tool !== 'pen' && tool !== 'eraser') return null;
  return (
    <div
      className={'pdb-brush-size' + (vertical ? ' pdb-brush-size--vert' : '')}
      role="group"
      aria-label="笔刷大小"
    >
      <Tooltip label={'笔刷大小：当前 ' + brushSize + '×' + brushSize + '（画笔/橡皮通用）'}>
        {vertical ? (
          <span className="pdb-brush-size__label">{brushSize}×{brushSize}</span>
        ) : (
          <span className="pdb-brush-size__label">笔刷 {brushSize}×{brushSize}</span>
        )}
      </Tooltip>
      <Button icon size="sm" variant="outline" aria-label="减小笔刷" disabled={brushSize <= 1} onClick={() => setBrushSize(brushSize - 1)}>
        <PdbIcon name="minus" size={13} />
      </Button>
      <Button icon size="sm" variant="outline" aria-label="增大笔刷" disabled={brushSize >= 9} onClick={() => setBrushSize(brushSize + 1)}>
        <PdbIcon name="plus" size={13} />
      </Button>
    </div>
  );
}
/**
 * 窗口控制：无边框窗口的最小化/最大化/关闭三颗按钮，
 * 仅 Electron 环境渲染（浏览器模式返回 null）。close 常规红悬停。
 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  if (!isElectron()) return null;
  const bridge = getBridge();
  return (
    <div className="pdb-window-controls" role="group" aria-label="窗口控制">
      <Tooltip label="最小化">
        <Button icon aria-label="最小化窗口" onClick={() => void bridge.windowMinimize()}>
          <PdbIcon name="minus" size={15} />
        </Button>
      </Tooltip>
      <Tooltip label={maximized ? '还原窗口' : '最大化窗口'}>
        <Button
          icon
          aria-label="最大化或还原窗口"
          onClick={() => {
            void bridge.windowMaximizeToggle().then((m) => setMaximized(m));
          }}
        >
          <PdbIcon name={maximized ? 'windowRestore' : 'windowMax'} size={14} />
        </Button>
      </Tooltip>
      <Tooltip label="关闭窗口">
        <Button icon aria-label="关闭窗口" className="pdb-win-close" onClick={() => void bridge.windowClose()}>
          <PdbIcon name="close" size={15} />
        </Button>
      </Tooltip>
    </div>
  );
}

/**
 * 模式切换（design/placement）——  已接入完整联动：
 * 走与 `P` 键、Esc 完全相同的 `setPlacementMode()`，自动处理
 * 1:1 锁尺 + focus 布局 + glowDark 主题 + 全屏 + 防休眠，并在退出时逐项反向恢复。
 */
function ModeSegment() {
  const mode = usePdbStore((s) => s.mode);
  return (
    <Segmented<AppMode>
      ariaLabel="应用模式"
      value={mode}
      options={[
        { value: 'design', label: '设计' },
        { value: 'placement', label: '拼豆' },
      ]}
      onChange={(m) => setPlacementMode(m === 'placement')}
    />
  );
}

export interface ToolbarProps {
  /** floating 布局：胶囊形态（底部居中） */
  capsule?: boolean;
  /** 是否在顶栏显示画笔/橡皮等工具按钮。classic 布局左侧已有 LeftRail 工具栏，
   *  顶栏重复展示已移除；左栏收起时由 AppShell 传 true 在顶栏补回，保证工具随时可见。
   *  dual/split（无 LeftRail）与 floating 胶囊保持默认 true。 */
  showTools?: boolean;
}

export function Toolbar({ capsule = false, showTools = true }: ToolbarProps) {
  const view = usePdbStore((s) => s.view);
  const isOneToOne = Math.abs(view.scale - 1) < 1e-6 && view.offsetX === 0 && view.offsetY === 0;

  return (
    <div className={capsule ? 'pdb-toolbar pdb-toolbar--capsule' : 'pdb-toolbar'} data-capsule={capsule}>
      <div className="pdb-toolbar__brand">
        <span className="pdb-toolbar__logo" aria-hidden>
          <PdbIcon name="bead" size={19} />
        </span>
        <span className="pdb-toolbar__title">拼豆工作台</span>
      </div>
      <div className="pdb-divider" />
      <div className="pdb-toolbar__group">
        <FileButtons />
      </div>
      <div className="pdb-divider" />
      <div className="pdb-toolbar__group">
        <HistoryButtons />
      </div>
      {showTools && (
        <>
          <div className="pdb-divider" />
          <div className="pdb-toolbar__group pdb-toolbar__tools">
            <ToolButtons />
          </div>
          <BrushSizeControl />
        </>
      )}
      <div className="pdb-toolbar__spacer" />
      <div className="pdb-toolbar__group">
        <Tooltip label="缩小 · Ctrl+-">
          <Button icon aria-label="缩小" onClick={() => runAppAction('zoomOut')}>
            <PdbIcon name="zoomOut" size={17} />
          </Button>
        </Tooltip>
        <Tooltip label="1:1 物理尺寸（一豆一毫米标定）· Ctrl+1">
          <Button
            aria-label="1:1 物理尺寸"
            variant={isOneToOne ? 'soft' : 'ghost'}
            aria-pressed={isOneToOne}
            className="pdb-toolbar__one-to-one"
            onClick={() => runAppAction('zoom1to1')}
          >
            1:1
          </Button>
        </Tooltip>
        <span className="pdb-toolbar__zoom" title="设计视图缩放（拼豆模式锁 1:1）">
          {Math.round(view.scale * 100)}%
        </span>
        <Tooltip label="放大 · Ctrl+=">
          <Button icon aria-label="放大" onClick={() => runAppAction('zoomIn')}>
            <PdbIcon name="zoomIn" size={17} />
          </Button>
        </Tooltip>
        <Tooltip label="缩放适配（整板进视口）· 0">
          <Button icon aria-label="缩放适配" onClick={() => runAppAction('zoomFit')}>
            <PdbIcon name="search" size={17} />
          </Button>
        </Tooltip>
      </div>
      <div className="pdb-divider" />
      <ModeSegment />
      <div className="pdb-divider" />
      <div className="pdb-toolbar__group">
        <ViewButtons />
      </div>
      <WindowControls />
    </div>
  );
}
