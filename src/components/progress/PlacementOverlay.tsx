/**
 * progress/PlacementOverlay.tsx —— 拼豆模式的独立 React root 宿主。
 *
 * 【为什么独立 root】
 *   AppShell.tsx 是  独占、禁止编辑。5 套布局（classic/focus/floating/split/dual）全部 INLINE 在
 *   AppShell 内。placement 模式自动切 focus 布局后 RightPanel 会卸载，导致 PlacementBar /
 *   FilterControls 消失。因此用 createRoot 在 body 上挂一个 overlay div，独立于主 React 树、
 *   跨布局切换存活。
 *
 * 【：内容换成顶部常驻控制条】
 *   旧实现是「可拖动 FAB + 弹出面板」，主操作要两次点击才能触达，且面板盖住板子一角。
 *   现在 overlay 只负责挂载 PlacementTopBar（顶部常驻条，一屏内一步操作），
 *   主条上的「更多操作」再展开原高级面板（区块导航 / 校准 / 逐色列表 / 筛选档位）。
 *
 *   本文件保留的独有职责：**区块切换引导 toast**（换区时提示把物理板移动到位），
 *   它与 overlay 的「跨布局存活」特性绑在一起，放回 AppShell 会随布局切换丢失。
 */
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { usePdbStore } from '@/store';
import { selectActiveRegion, selectRegionList } from '@/store/selectors';
import { PlacementTopBar } from './PlacementTopBar';
import './progress.css';

/* ═══ Overlay 内部组件（订阅 mode，仅 placement 时渲染） ═══ */

function OverlayContent() {
  const mode = usePdbStore((s) => s.mode);
  const activeIndex = usePdbStore((s) => s.region.activeIndex);
  const splitsX = usePdbStore((s) => s.region.splitsX);
  const splitsY = usePdbStore((s) => s.region.splitsY);
  const prevIndex = useRef(activeIndex);

  /* 区块切换引导 toast（换区后物理板要跟着挪） */
  useEffect(() => {
    if (mode !== 'placement') {
      prevIndex.current = activeIndex;
      return;
    }
    if (prevIndex.current === activeIndex) return;
    prevIndex.current = activeIndex;
    const state = usePdbStore.getState();
    const list = selectRegionList(state);
    const region = list[Math.min(activeIndex, list.length - 1)] ?? selectActiveRegion(state);
    state.pushToast(
      'info',
      `请把板子移动，使 ${region.label} 区左上角对准屏幕左上括标`,
      4000,
    );
  }, [mode, activeIndex, splitsX, splitsY]);

  if (mode !== 'placement') return null;
  return <PlacementTopBar />;
}

/* ═══ 独立 React root 单例管理 ═══ */

let rootInstance: Root | null = null;
let containerEl: HTMLDivElement | null = null;

/** 挂载 overlay（幂等：已挂载时直接返回） */
export function mountPlacementOverlay(): void {
  if (rootInstance) return;
  containerEl = document.createElement('div');
  containerEl.id = 'pdb-placement-overlay-root';
  containerEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(containerEl);
  rootInstance = createRoot(containerEl);
  rootInstance.render(<OverlayContent />);
}

/** 卸载 overlay（StrictMode 双挂载安全） */
export function unmountPlacementOverlay(): void {
  if (!rootInstance) return;
  rootInstance.unmount();
  rootInstance = null;
  if (containerEl && containerEl.parentNode) {
    containerEl.parentNode.removeChild(containerEl);
  }
  containerEl = null;
}
