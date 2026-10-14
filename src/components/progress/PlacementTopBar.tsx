/**
 * progress/PlacementTopBar.tsx —— 拼豆模式紧凑悬浮控制胶囊。
 *
 * 【为什么不占一整行】
 *   一稿是顶部通栏，用户反馈：太占地方，最上面一行格子被压掉。
 *   二稿改为**顶部居中的一颗小胶囊**，悬停才展开完整操作。
 *   三稿（2026-09-30）反馈：二稿的「▶ 下一色」是个抽象箭头，切色要瞄准小图标、
 *   也不知道下一色是谁 —— 改成**色卡直接可点**：
 *     [◀] [●A1 剩0] [●N 余240] [●M 余186] [▾] │ [✓拼完] [本区] [⚙] [✕]
 *   · 当前色读数（拼完变「已拼完」完成态）；
 *   · 后面跟**接下来要拼的色卡**（按剩余最多排序，最多 2 张，点击直接切色）；
 *   · `▾` 展开完整色卡队列（全部颜色按剩余排序，点谁切谁，含已完成的）。
 *   · 操作组**常显**：悬停展开曾让胶囊宽度突变、整体重新居中平移百余像素，
 *     鼠标移向色卡的瞬间瞄准点就漂了（时好时坏点不中），常显后零位移。
 *   画布只让出 ~46px，胶囊外区域完全透传给画布。
 *
 * 【「更多操作」是小浮窗】
 *   ⚙ 展开的不再是条内通栏面板，而是锚在胶囊正下方的小窗（360px），
 *   内含：区块导航 / 筛选档位 / 逐色列表 / 校准 / 「作为智能板」。
 *
 * 【「作为智能板」语义】
 *   本项目**扮演**智能拼豆板（BLE 外设），被手机 App 等工具连接——
 *   不是去连别人的板子；打开的是 VirtualBoardDialog（`pdb:open-virtualboard`）。
 *
 * 【二次确认】
 *   「拼完」是不可逆批量写入（标记不进撤销栈），必须弹确认；
 *   文案由 core/placementNav.buildColorDonePrompt 生成（与单测同源）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePdbStore } from '@/store';
import { selectActiveRegion, selectColorUsage, selectColorUsageInRegion } from '@/store/selectors';
import {
  stepColor,
  focusPlacementColor,
  markCurrentColorDone,
  currentColorDonePrompt,
  type PlacementScope,
} from '@/store/placementActions';
import { findUsage, pickUpcoming, sortForPlacement, type NavColorUsage } from '@/core/placementNav';
import { setPlacementMode } from '@/hooks/useHotkeys';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { PdbIcon } from '@/components/icons';
import { PlacementBar } from './PlacementBar';
import { FilterControls } from './FilterControls';
import { ColorProgressList } from './ColorProgressList';
import { PlacementCalibration } from './PlacementCalibration';
import './progress.css';

/** 主条上一色/下一色的方向 */
type Dir = 'next' | 'prev';

export function PlacementTopBar() {
  const mode = usePdbStore((s) => s.mode);
  const beadsVersion = usePdbStore((s) => s.beadsVersion);
  const palette = usePdbStore((s) => s.palette);
  const filterColorIndex = usePdbStore((s) => s.filterColorIndex);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  const vbLight = usePdbStore((s) => s.vbLight);
  const splitsX = usePdbStore((s) => s.region.splitsX);
  const splitsY = usePdbStore((s) => s.region.splitsY);
  const activeIndex = usePdbStore((s) => s.region.activeIndex);
  const [scope, setScope] = useState<PlacementScope>('region');
  const [advOpen, setAdvOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);

  const colorIndex = filterColorIndex >= 0 ? filterColorIndex : activeColorIndex;
  const color = palette.colors[colorIndex] ?? null;

  /* 当前色在统计范围内的剩余量（胶囊读数） */
  const usage = useMemo<NavColorUsage[]>(() => {
    // 显式依赖会改变统计结果的信号（selectors 内部按 beadsVersion 记忆化）
    void beadsVersion;
    void splitsX;
    void splitsY;
    void activeIndex;
    const s = usePdbStore.getState();
    return scope === 'board'
      ? selectColorUsage(s)
      : selectColorUsageInRegion(s, selectActiveRegion(s));
  }, [beadsVersion, splitsX, splitsY, activeIndex, scope]);

  const cur = findUsage(usage, colorIndex);
  const remaining = cur ? cur.remaining : 0;
  /** 当前色在本范围有格子且已全部拼完 → 读数进完成态（剩0 显示成「已拼完」） */
  const readoutDone = !!color && !!cur && cur.total > 0 && remaining === 0;

  /** 色卡队列（含已完成，队列弹层用）与接下来的前两张色卡 */
  const queue = useMemo(() => sortForPlacement(usage, colorIndex), [usage, colorIndex]);
  const upcoming = useMemo(() => pickUpcoming(usage, colorIndex, 2), [usage, colorIndex]);

  const onStep = useCallback((dir: Dir): void => {
    stepColor(dir, scope);
  }, [scope]);

  /** 点色卡直接切色 */
  const onPick = useCallback((index: number): void => {
    focusPlacementColor(index, scope);
  }, [scope]);

  const onDone = useCallback((): void => setConfirmOpen(true), []);

  /* 键盘 Enter 与点击按钮走同一条确认路径 */
  useEffect(() => {
    const h = (): void => setConfirmOpen(true);
    window.addEventListener('pdb:placement-confirm-done', h);
    return () => window.removeEventListener('pdb:placement-confirm-done', h);
  }, []);

  /* 退出拼豆模式时收起所有临时界面 */
  useEffect(() => {
    if (mode !== 'placement') {
      setAdvOpen(false);
      setConfirmOpen(false);
      setQueueOpen(false);
    }
  }, [mode]);

  /* 色卡队列开着时，点胶囊与队列之外的地方收起 */
  useEffect(() => {
    if (!queueOpen) return;
    const h = (e: PointerEvent): void => {
      const t = e.target;
      if (t instanceof Element && t.closest('.pdb-ptb__queue, .pdb-ptb__qtoggle')) return;
      setQueueOpen(false);
    };
    window.addEventListener('pointerdown', h);
    return () => window.removeEventListener('pointerdown', h);
  }, [queueOpen]);

  const confirmPrompt = useMemo(() => currentColorDonePrompt(scope), [scope, colorIndex, remaining]);
  // 依赖 remaining 让文案随标记进度刷新；colorIndex 变化时也要重取

  const doDone = useCallback((): void => {
    markCurrentColorDone(scope);
    setConfirmOpen(false);
  }, [scope]);

  /** 打开「本机当作智能板」对话框：本项目是被连的一方 */
  const openAsBoard = useCallback((): void => {
    setAdvOpen(false);
    window.dispatchEvent(new CustomEvent('pdb:open-virtualboard'));
  }, []);

  /** 清除手机点亮图案（只影响本地显示） */
  const clearVbLight = useCallback((): void => {
    usePdbStore.getState().setVbLight(null);
  }, []);

  return (
    <>
      <div className="pdb-ptb-wrap">
        <div className="pdb-ptb" role="toolbar" aria-label="拼豆模式控制条">
          <Tooltip label="上一色 · Shift+N">
            <Button size="sm" variant="outline" aria-label="上一色" onClick={() => onStep('prev')}>
              <PdbIcon name="chevronLeft" size={15} />
            </Button>
          </Tooltip>

          {/* 读数：色块 + 色号 + 剩余颗数（换色时读屏播报；拼完进完成态） */}
          <div className="pdb-ptb__readout" data-done={readoutDone || undefined} aria-live="polite">
            <span
              className="pdb-ptb__swatch"
              style={{ background: color ? color.hex : 'transparent' }}
              data-empty={color ? undefined : 'true'}
              aria-hidden
            />
            <span className="pdb-ptb__code">{color ? color.code : '未选色'}</span>
            <span className="pdb-ptb__remain">
              {readoutDone ? (
                '已拼完'
              ) : (
                <>
                  剩<strong>{remaining}</strong>
                </>
              )}
            </span>
          </div>

          {/* 接下来要拼的色卡：按剩余最多排序，点击直接切色（不再用抽象箭头猜下一色是谁） */}
          <div className="pdb-ptb__nexts" role="group" aria-label="接下来要拼的颜色，点击直接切换">
            {upcoming.map((idx, n) => {
              const u = findUsage(usage, idx);
              const c = palette.colors[idx];
              if (!u || !c) return null;
              return (
                <Tooltip
                  key={c.id}
                  label={`下一色：${c.code}（剩余 ${u.remaining} 颗）· 点击直接切换${n === 0 ? '，热键 N' : ''}`}
                >
                  <button
                    type="button"
                    className="pdb-ptb__next pdb-pressable"
                    aria-label={`切到 ${c.code}，剩余 ${u.remaining} 颗`}
                    onClick={() => onPick(idx)}
                  >
                    <span className="pdb-ptb__swatch" style={{ background: c.hex }} aria-hidden />
                    <span className="pdb-ptb__code">{c.code}</span>
                    <span className="pdb-ptb__remain">
                      余<strong>{u.remaining}</strong>
                    </span>
                  </button>
                </Tooltip>
              );
            })}
            <Tooltip label="完整色卡队列（按剩余排序，点谁切谁）">
              <button
                type="button"
                className="pdb-ptb__qtoggle pdb-pressable"
                aria-label="展开色卡队列"
                aria-expanded={queueOpen}
                onClick={() => setQueueOpen((v) => !v)}
              >
                <PdbIcon name="chevronDown" size={14} />
              </button>
            </Tooltip>
          </div>

          {/* 手机点亮徽标：虚拟板收到 App 节目后主画布发光板显示的图案（手机=遥控器） */}
          {vbLight && (
            <span className="pdb-ptb__vbchip" role="status" title="手机 App 经虚拟板下发的点亮图案，主画布发光板显示中">
              手机点亮 <strong>{vbLight.count}</strong> 格
              <button
                type="button"
                className="pdb-ptb__vbchip__x pdb-pressable"
                onClick={clearVbLight}
                aria-label="清除手机点亮图案"
              >
                ✕
              </button>
            </span>
          )}

          {/* 操作组常显（2026-09-30）：悬停展开曾让胶囊重新居中平移，色卡点哪都漂 */}
          <div className="pdb-ptb__more">
            <Tooltip label="把当前色剩余全部标记为已拼 · Enter">
              <Button size="sm" variant="soft" aria-label="本色拼完" onClick={onDone} disabled={remaining === 0}>
                <PdbIcon name="success" size={13} />
                拼完
              </Button>
            </Tooltip>
            <Tooltip label={scope === 'region' ? '统计范围：本区块（点击切到全板）' : '统计范围：全板（点击切到本区块）'}>
              <button
                type="button"
                className="pdb-ptb__scopeToggle pdb-pressable"
                onClick={() => setScope((v) => (v === 'region' ? 'board' : 'region'))}
                aria-label="切换统计范围"
              >
                {scope === 'region' ? '本区' : '全板'}
              </button>
            </Tooltip>
            <Tooltip label="更多操作（小窗：区块导航 / 筛选 / 逐色 / 校准 / 作为智能板）">
              <Button
                size="sm"
                variant="outline"
                aria-label="更多操作"
                aria-expanded={advOpen}
                onClick={() => setAdvOpen((v) => !v)}
              >
                <PdbIcon name="settings" size={14} />
              </Button>
            </Tooltip>
            <Tooltip label="退出拼豆模式 · Esc">
              <Button size="sm" variant="outline" aria-label="退出拼豆模式" onClick={() => setPlacementMode(false)}>
                <PdbIcon name="close" size={13} />
              </Button>
            </Tooltip>
          </div>
        </div>

        {/* 色卡队列：全部颜色按「剩余最多」排序，点谁切谁；已完成的置灰不可点 */}
        {queueOpen && (
          <div className="pdb-ptb__queue" role="dialog" aria-label="色卡队列">
            <header className="pdb-ptb__qHead">
              <span className="pdb-label">接下来拼什么</span>
              <span className="pdb-ptb__qScope">{scope === 'region' ? '本区块' : '全板'}</span>
            </header>
            {queue.length === 0 ? (
              <p className="pdb-hint pdb-ptb__qEmpty">本范围暂无内容</p>
            ) : (
              <ul className="pdb-ptb__qlist">
                {queue.map((u) => {
                  const c = palette.colors[u.index];
                  if (!c) return null;
                  const isCur = u.index === colorIndex;
                  const isDone = u.remaining <= 0;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`pdb-ptb__qrow pdb-pressable ${isCur ? 'is-active' : ''} ${isDone ? 'is-done' : ''}`}
                        disabled={isDone}
                        aria-label={`${c.code} ${c.nameZh ?? c.name}，${isDone ? '已完成' : `剩余 ${u.remaining} 颗`}${isCur ? '，当前色' : ''}`}
                        onClick={() => {
                          onPick(u.index);
                          setQueueOpen(false);
                        }}
                      >
                        <span className="pdb-ptb__swatch" style={{ background: c.hex }} aria-hidden />
                        <span className="pdb-ptb__qcode">{c.code}</span>
                        <span className="pdb-ptb__qname">{c.nameZh ?? c.name}</span>
                        <span className="pdb-ptb__qremain">{isDone ? '✓ 完成' : `余 ${u.remaining}`}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <footer className="pdb-ptb__qHint">按剩余最多排序 · N / Shift+N 切色 · Enter 本色拼完</footer>
          </div>
        )}

        {advOpen && (
          <div className="pdb-ptb__pop" role="dialog" aria-label="拼豆更多操作">
            <header className="pdb-ptb__popHead">
              <span className="pdb-label">
                <PdbIcon name="bead" size={13} />
                更多操作
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={openAsBoard}
                title="把本机广播成一块智能拼豆板，供手机 App 等工具连接（本项目扮演板子，不是去连板子）"
              >
                <PdbIcon name="monitor" size={13} />
                作为智能板
              </Button>
              <Button size="sm" variant="ghost" aria-label="收起更多操作" onClick={() => setAdvOpen(false)}>
                <PdbIcon name="close" size={13} />
              </Button>
            </header>
            <div className="pdb-ptb__popBody">
              <PlacementBar variant="inline" />
              <FilterControls />
              <ColorProgressList />
              <PlacementCalibration />
            </div>
          </div>
        )}
      </div>

      {confirmOpen && (
        <div className="pdb-ptb-confirm" role="dialog" aria-modal="true" aria-label={confirmPrompt.title}>
          <div className="pdb-ptb-confirm__box">
            <h3 className="pdb-ptb-confirm__title">{confirmPrompt.title}</h3>
            <p className="pdb-ptb-confirm__body">{confirmPrompt.body}</p>
            <div className="pdb-ptb-confirm__acts">
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>取消</Button>
              <Button variant="primary" onClick={doDone}>
                <PdbIcon name="success" size={14} />
                {confirmPrompt.confirm}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
