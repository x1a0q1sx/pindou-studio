/**
 * ui/Tooltip —— Portal 悬停提示。
 *
 * 【为什么用 Portal 而不是纯 CSS】
 * 旧实现把气泡绝对定位在触发器内部（z-index:1100），但 z-index 只在最近的层叠
 * 上下文内有效：工具栏（z-600）、悬浮面板（z-500）、拼豆 HUD（z-9000/9100）各自
 * 创建上下文，气泡被各自的上下文天花板压住 → 面板/画布盖住提示（缺陷 #31）。
 * 改为 hover 时把气泡传送到 document.body 末尾（z-index:12000，高于一切 UI），
 * 用触发器的 getBoundingClientRect 做固定定位，并按视口边界自动翻转/收拢：
 *  - 上方放不下 → 翻到下方；下方放不下 → 翻回上方（左右侧同理）
 *  - 交叉轴贴边时向内收拢，绝不出屏
 * 滚动/缩放/失焦时立即隐藏（与原生 title 行为一致，避免悬空错位）。
 *
 * API 与旧版完全兼容：label / side / children，另有 disabled 可选关闭。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  label: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
  /** true 时不显示气泡（如面板折叠态） */
  disabled?: boolean;
}

/** 气泡与触发器的间距、视口安全边距 */
const GAP = 8;
const MARGIN = 8;
/** 层叠天花板：高于拼豆 HUD(9000)/快捷条(9100)/Modal(1000) */
const PORTAL_Z = 12000;
/** 悬停多少毫秒后才出现（快速扫过工具栏不闪气泡） */
const SHOW_DELAY_MS = 120;

interface TipPosition {
  left: number;
  top: number;
  transform: string;
}

export function Tooltip({ label, side = 'bottom', children, disabled = false }: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | null>(null);
  /** 点击后置位：focus 不再重开气泡（避免「点完按钮提示又弹出来赖着不走」），mouseleave 复位 */
  const suppressFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<TipPosition | null>(null);

  const clearTimer = useCallback((): void => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  }, []);

  const openAt = useCallback((): void => {
    if (disabled || suppressFocusRef.current) return;
    clearTimer();
    showTimer.current = window.setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      setTriggerRect(el.getBoundingClientRect());
      setOpen(true);
    }, SHOW_DELAY_MS);
  }, [clearTimer, disabled]);

  const close = useCallback((): void => {
    clearTimer();
    setOpen(false);
    setPos(null);
    setTriggerRect(null);
  }, [clearTimer]);

  // 滚动/视口变化/窗口失焦 → 立即隐藏（气泡是固定定位，不跟随触发器）
  useEffect(() => {
    if (!open) return;
    const hide = (): void => close();
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [open, close]);

  useEffect(() => clearTimer, [clearTimer]);

  // 两段式定位：先按首选 side 渲染（visibility:hidden 仅供测量），再按气泡实际尺寸翻转/收拢
  useLayoutEffect(() => {
    if (!open || !triggerRect) return;
    const tip = tipRef.current;
    if (!tip) return;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = triggerRect.left + triggerRect.width / 2;
    const cy = triggerRect.top + triggerRect.height / 2;

    // 纵向侧（top/bottom）放不下时翻转；横向侧同理
    let finalSide = side;
    if (side === 'top' && triggerRect.top - th - GAP < MARGIN && triggerRect.bottom + th + GAP <= vh - MARGIN) finalSide = 'bottom';
    else if (side === 'bottom' && triggerRect.bottom + th + GAP > vh - MARGIN && triggerRect.top - th - GAP >= MARGIN) finalSide = 'top';
    else if (side === 'left' && triggerRect.left - tw - GAP < MARGIN && triggerRect.right + tw + GAP <= vw - MARGIN) finalSide = 'right';
    else if (side === 'right' && triggerRect.right + tw + GAP > vw - MARGIN && triggerRect.left - tw - GAP >= MARGIN) finalSide = 'left';

    let p: TipPosition;
    switch (finalSide) {
      case 'top':
        p = { left: cx, top: triggerRect.top - GAP, transform: 'translate(-50%, -100%)' };
        break;
      case 'left':
        p = { left: triggerRect.left - GAP, top: cy, transform: 'translate(-100%, -50%)' };
        break;
      case 'right':
        p = { left: triggerRect.right + GAP, top: cy, transform: 'translate(0, -50%)' };
        break;
      default:
        p = { left: cx, top: triggerRect.bottom + GAP, transform: 'translate(-50%, 0)' };
    }
    // 交叉轴收拢：水平气泡的 left、垂直气泡的 top 都按气泡实际尺寸夹回视口
    if (finalSide === 'top' || finalSide === 'bottom') {
      const half = tw / 2;
      p.left = Math.min(Math.max(p.left, MARGIN + half), vw - MARGIN - half);
    } else {
      const half = th / 2;
      p.top = Math.min(Math.max(p.top, MARGIN + half), vh - MARGIN - half);
    }
    setPos(p);
  }, [open, triggerRect, side]);

  // 事件挂在包裹 span 上（子元素 button 的 hover/focus 会冒泡上来）
  const handlers = {
    onMouseEnter: openAt,
    onMouseLeave: (): void => {
      suppressFocusRef.current = false;
      close();
    },
    onFocus: openAt,
    onBlur: close,
    onMouseDown: (): void => {
      suppressFocusRef.current = true;
      close();
    },
  };

  return (
    <span className="pdb-tooltip-wrap" ref={wrapRef} {...handlers}>
      {children}
      {open && triggerRect
        ? createPortal(
            <span
              ref={tipRef}
              role="tooltip"
              className="pdb-tooltip"
              style={{
                position: 'fixed',
                zIndex: PORTAL_Z,
                left: pos?.left ?? -9999,
                top: pos?.top ?? -9999,
                transform: pos?.transform ?? 'translate(-50%, -100%)',
                visibility: pos ? 'visible' : 'hidden',
              }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
