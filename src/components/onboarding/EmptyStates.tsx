/**
 * onboarding/EmptyStates.tsx —— 空状态与轻量引导条。
 *
 * 覆盖四类空状态中的三类（「最近列表为空」在 StartPanel 里，因为它属于开始面板的一节）：
 *   A 空白板    画布上一颗豆都没有 → 中央引导卡（导入图片 / 打开项目 / 重看引导 / 知道了）
 *   B 无项目    板上已有内容但项目从未保存过 → 顶部提醒条（保存项目 / 稍后）
 *   C 筛选无结果 按色筛选后该色在板上 0 格 → 顶部提示条（清除筛选）
 *
 * 【挂载方式】在 AppShell 里以固定定位层挂一份，`pointer-events: none` 只让卡片本体接收点击，
 *   因此四套布局都能用、不遮挡画布绘制、不与拼豆模式全屏覆盖层（z-index 9000）抢层级。
 *   z-index 取 70：低于 canvas overlay(80) / 标尺(90–100) / 模态(1000) / Toast(1200)。
 *
 * 【响应式】beads 是 typed array，内容变更 zustand 感知不到，一律订阅 beadsVersion；
 *   项目信息（getCurrentProjectInfo）是模块级 getter，非响应式，
 *   这里用 toasts.length 作为「刚刚发生过保存/打开」的重读信号（保存与打开都会推 Toast）。
 */
import { useMemo, useState } from 'react';
import { usePdbStore } from '@/store';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { runAppAction } from '@/hooks/useHotkeys';
import { openOpenDialog, openSaveDialog } from '@/components/project/dialogBus';
import { getCurrentProjectInfo } from '@/store/persistence';
import { TOOL_HOTKEYS } from '@/hooks/hotkeyMap';
import { dismissEmptyHint, isEmptyHintDismissed, openWelcomeWizard } from './firstRun';
import './onboarding.css';

export function EmptyStates() {
  const beads = usePdbStore((s) => s.beads);
  const beadsVersion = usePdbStore((s) => s.beadsVersion);
  const mode = usePdbStore((s) => s.mode);
  const board = usePdbStore((s) => s.board);
  const palette = usePdbStore((s) => s.palette);
  const filterColorIndex = usePdbStore((s) => s.filterColorIndex);
  const filterMode = usePdbStore((s) => s.filterMode);
  const setFilter = usePdbStore((s) => s.setFilter);
  /** 仅作重读信号：保存/打开/导入都会推 Toast，此时项目信息可能已变 */
  const toastSignal = usePdbStore((s) => s.toasts.length);

  const [hintHidden, setHintHidden] = useState<boolean>(() => isEmptyHintDismissed());
  const [unsavedHidden, setUnsavedHidden] = useState(false);

  /* ---- 统计：已填格数 + 每色格数（beads 存调色板索引+1） ---- */
  const stats = useMemo(() => {
    const perColor = new Map<number, number>();
    let filled = 0;
    for (let i = 0; i < beads.length; i++) {
      const v = beads[i]!;
      if (v === 0) continue;
      filled++;
      perColor.set(v, (perColor.get(v) ?? 0) + 1);
    }
    return { filled, perColor };
    // beadsVersion 是 typed array 内容变更的唯一可靠信号
  }, [beads, beadsVersion]);

  const project = useMemo(() => getCurrentProjectInfo(), [toastSignal, beadsVersion, board]);

  const neverSaved = project.path === null && project.name === '未命名项目';
  const showBoardEmpty = mode === 'design' && stats.filled === 0 && !hintHidden;
  const showUnsaved = mode === 'design' && stats.filled > 0 && neverSaved && !unsavedHidden;

  const filteredColor = filterColorIndex >= 0 ? palette.colors[filterColorIndex] ?? null : null;
  const filteredCount = filterColorIndex >= 0 ? stats.perColor.get(filterColorIndex + 1) ?? 0 : 0;
  const showFilterEmpty = filterColorIndex >= 0 && filterMode !== 'off' && filteredCount === 0 && stats.filled > 0;

  if (!showBoardEmpty && !showUnsaved && !showFilterEmpty) return null;

  const hideForever = (): void => {
    dismissEmptyHint();
    setHintHidden(true);
  };

  return (
    <div className="pdb-empty-layer" aria-live="polite">
      {(showFilterEmpty || showUnsaved) && (
        <div className="pdb-empty-layer__top">
          {showFilterEmpty && (
            <div className="pdb-empty-pill pdb-empty-pill--warn">
              <PdbIcon name="search" size={14} />
              <span>
                当前筛选「{filteredColor ? `${filteredColor.code} ${filteredColor.nameZh ?? filteredColor.name}` : '未知颜色'}
                」在这块板上是 0 格 —— 可能选错了颜色，或该色只出现在别的区块。
              </span>
              <Button
                size="sm"
                variant="soft"
                onClick={() => setFilter(-1, 'off')}
                aria-label="清除筛选"
              >
                清除筛选
              </Button>
            </div>
          )}
          {showUnsaved && (
            <div className="pdb-empty-pill">
              <PdbIcon name="save" size={14} />
              <span>
                这块板已经有 {stats.filled} 颗豆，但项目还没起名字、没存过盘。
                自动保存只兜底崩溃，正式图纸请存一份文件。
              </span>
              <Button size="sm" variant="primary" onClick={openSaveDialog} aria-label="保存项目">
                保存项目
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setUnsavedHidden(true)} aria-label="稍后再说">
                稍后
              </Button>
            </div>
          )}
        </div>
      )}

      {showBoardEmpty && (
        <div className="pdb-empty-layer__center">
          <div className="pdb-empty pdb-empty--card">
            <span className="pdb-empty__icon" aria-hidden>
              <PdbIcon name="grid" size={26} />
            </span>
            <strong className="pdb-empty__title">这块板还是空的</strong>
            <p className="pdb-empty__desc">
              当前 {board.cols}×{board.rows} 格 · 钉距 {board.pitchMm} mm。三种方式开始：
            </p>
            <ol className="pdb-empty__list">
              <li>
                <PdbIcon name="import" size={13} />
                <span>
                  <strong>从图片生成</strong>：导入一张图，自动裁剪成 {board.cols}:{board.rows}、像素化并匹配到拼豆色号
                </span>
              </li>
              <li>
                <PdbIcon name="folderOpen" size={13} />
                <span>
                  <strong>打开已有项目</strong>：接着上次没拼完的图纸继续（最近项目也会列出来）
                </span>
              </li>
              <li>
                <PdbIcon name="pencil" size={13} />
                <span>
                  <strong>直接手绘</strong>：选画笔（{TOOL_HOTKEYS.pen}），点下方色板挑颜色，在格子上点或拖
                </span>
              </li>
            </ol>
            <div className="pdb-empty__actions">
              <Button variant="primary" onClick={() => runAppAction('importImage')}>
                <PdbIcon name="import" size={15} />
                导入图片
              </Button>
              <Button variant="outline" onClick={openOpenDialog}>
                <PdbIcon name="folderOpen" size={15} />
                打开项目
              </Button>
              <Button variant="ghost" onClick={openWelcomeWizard}>
                <PdbIcon name="bead" size={15} />
                重看引导
              </Button>
            </div>
            <p className="pdb-empty__foot">
              项目「{project.name}」尚未保存 · 随时 Ctrl+S
            </p>
            <Button size="sm" variant="ghost" className="pdb-empty__dismiss" onClick={hideForever}>
              知道了，不再提示
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default EmptyStates;
