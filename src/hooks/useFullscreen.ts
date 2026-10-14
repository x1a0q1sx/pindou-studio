/**
 * src/hooks/useFullscreen.ts —— 进入/退出全屏，维护 isFullscreen 状态。
 *
 * Electron: bridge.enterFullscreen(displayId?) 可在指定显示器无边框全屏。
 * 浏览器: Fullscreen API（F11 效果，仅当前屏）。
 * 失败时 pushToast 告知用户。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge } from '@/io/bridge';
import { usePdbStore } from '@/store';

export interface UseFullscreenReturn {
  isFullscreen: boolean;
  enter: (displayId?: string) => Promise<void>;
  exit: () => Promise<void>;
  toggle: (displayId?: string) => Promise<void>;
}

export function useFullscreen(): UseFullscreenReturn {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pendingRef = useRef(false);

  // 浏览器降级：监听 fullscreenchange 同步状态
  useEffect(() => {
    const handler = (): void => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const enter = useCallback(async (displayId?: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const bridge = getBridge();
      await bridge.enterFullscreen(displayId);
      setIsFullscreen(true);
    } catch (err) {
      console.warn('[PinDou] 进入全屏失败', err);
      usePdbStore.getState().pushToast('danger', '进入全屏失败，请检查显示器连接');
    } finally {
      pendingRef.current = false;
    }
  }, []);

  const exit = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const bridge = getBridge();
      await bridge.exitFullscreen();
      setIsFullscreen(false);
    } catch (err) {
      console.warn('[PinDou] 退出全屏失败', err);
    } finally {
      pendingRef.current = false;
    }
  }, []);

  const toggle = useCallback(async (displayId?: string) => {
    if (isFullscreen) {
      await exit();
    } else {
      await enter(displayId);
    }
  }, [isFullscreen, enter, exit]);

  return { isFullscreen, enter, exit, toggle };
}
