/**
 * hooks/useAutoSave.ts —— 自动保存的 React 接线层。
 *
 * 职责很薄，全部实际逻辑在 store/persistence.ts：
 *   1. 挂载时 startAutoSave()（3s 防抖 → localStorage + Electron appData 镜像），卸载时调用停止函数；
 *   2. beforeunload / pagehide / visibilitychange(hidden) 时 saveAutosaveNow() 立即刷新，
 *      避免用户直接关窗丢掉最后 3 秒内的改动；
 *   3. 启动时若 hasUnsavedSession() 为真，通过 store 的 pushToast 推一条**中文可操作提示**。
 *
 * 【刻意不做的事】不自己造 Modal / 对话框组件 —— 恢复确认的正式 UI 由后续任务实现。
 *   本 hook 只把 pending（自动保存快照）+ restore()/discard() 暴露出去，UI 想怎么呈现都行。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePdbStore } from '@/store/index';
import {
  describeAutosave,
  discardAutosave,
  hasUnsavedSession,
  loadAutosave,
  loadAutosaveAsync,
  restoreAutosave,
  saveAutosaveNow,
  startAutoSave,
  type AutosaveFile,
} from '@/store/persistence';

/** 一次应用生命周期内只提示一次（防 StrictMode 双挂载 / 多组件同时挂载导致重复弹提示） */
let promptedThisSession = false;

export interface UseAutoSaveOptions {
  /** 挂载时是否检测并提示「未保存的上次会话」，默认 true */
  promptOnStart?: boolean;
  /** 是否注册 beforeunload / pagehide / visibilitychange 立即刷新，默认 true */
  flushOnHide?: boolean;
  /** 提示 toast 的停留毫秒数；<=0 表示常驻直到用户处理，默认 0 */
  promptDuration?: number;
  /** 提示文案前缀，默认「检测到上次未保存的会话」 */
  promptTitle?: string;
}

export interface UseAutoSaveResult {
  /** 待恢复的自动保存快照；null = 没有可恢复会话（或用户已处理） */
  pending: AutosaveFile | null;
  /** 人类可读摘要，可直接显示在 Toast / 对话框里 */
  summary: string;
  /** 恢复上次会话（写回 store + 清历史）；成功返回 true */
  restore: () => boolean;
  /** 丢弃上次会话（删除自动保存记录） */
  discard: () => void;
  /** 立即刷新一次自动保存（不等 3s 防抖） */
  saveNow: () => boolean;
  /** 自动保存是否正在运行 */
  running: boolean;
}

/**
 * 自动保存 hook。在应用根部（AppShell）挂一次即可；重复挂载是安全的（startAutoSave 幂等）。
 */
export function useAutoSave(options: UseAutoSaveOptions = {}): UseAutoSaveResult {
  const {
    promptOnStart = true,
    flushOnHide = true,
    promptDuration = 0,
    promptTitle = '检测到上次未保存的会话',
  } = options;

  const [pending, setPending] = useState<AutosaveFile | null>(null);
  const [running, setRunning] = useState(false);
  const mounted = useRef(true);
  /**
   * 【缺陷 #2b】启动时捕获的待恢复快照（与 pending state 同步维护，用 ref 避开闭包过期）。
   * restore() 必须把它原样传给 restoreAutosave(snapshot)，绝不能让 restoreAutosave()
   * 无参重读 localStorage——3s 防抖可能在用户点击前已覆盖 LS，重读会拿到空快照，
   * 表现为「提示恢复成功、豆却全丢」。弹窗承诺恢复什么，就恢复什么。
   */
  const pendingRef = useRef<AutosaveFile | null>(null);

  /* ---- 生命周期：订阅 + 卸载停止 ---- */
  useEffect(() => {
    mounted.current = true;
    let stop: (() => void) | null = null;
    try {
      stop = startAutoSave();
      setRunning(true);
    } catch {
      setRunning(false);
    }

    /* ---- 启动检测：有未保存会话就推一条中文可操作提示 ---- */
    if (promptOnStart && !promptedThisSession) {
      const prompt = (file: AutosaveFile | null): void => {
        if (!file || promptedThisSession) return;
        promptedThisSession = true;
        pendingRef.current = file; // 记住启动捕获的快照：恢复时传回它，而不是重读可能已被覆盖的 LS
        if (mounted.current) setPending(file);
        try {
          usePdbStore.getState().pushToast(
            'warning',
            `${promptTitle}：${describeAutosave(file)}。可选择「恢复上次会话」继续，或「丢弃」从空白开始。`,
            promptDuration,
          );
        } catch {
          /* store 未就绪时静默；pending 仍然暴露给 UI */
        }
      };

      // 同步路径（localStorage）优先；Electron 下再异步补查 appData 镜像
      if (hasUnsavedSession()) {
        prompt(loadAutosave());
      } else {
        let cancelled = false;
        void loadAutosaveAsync()
          .then((file) => {
            if (!cancelled && mounted.current) prompt(file);
          })
          .catch(() => undefined);
        // 组件在异步返回前就卸载时不要再弹提示
        const prevStop = stop;
        stop = () => {
          cancelled = true;
          if (prevStop) prevStop();
        };
      }
    }

    return () => {
      mounted.current = false;
      setRunning(false);
      if (stop) {
        try {
          stop();
        } catch {
          /* 静默 */
        }
      }
    };
    // 只在挂载时执行一次：options 里的文案变化不值得重启整条订阅链
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- 关窗 / 切后台：立即刷新，别丢最后 3 秒 ---- */
  useEffect(() => {
    if (!flushOnHide) return undefined;
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;

    const flush = (): void => {
      try {
        saveAutosaveNow();
      } catch {
        /* 关窗阶段的异常无人可报，静默 */
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushOnHide]);

  const restore = useCallback((): boolean => {
    // 【缺陷 #2b】恢复「启动时捕获的 pending 快照」：弹窗承诺恢复什么就恢复什么，
    // 不再让 restoreAutosave() 无参重读已被覆盖风险的 localStorage。
    const snapshot = pendingRef.current;
    pendingRef.current = null;
    const result = restoreAutosave(snapshot);
    promptedThisSession = true;
    if (mounted.current) setPending(null);
    if (!result.ok && result.error) {
      try {
        usePdbStore.getState().pushToast('danger', `恢复上次会话失败：${result.error}`, 6000);
      } catch {
        /* 静默 */
      }
    }
    return result.ok;
  }, []);

  const discard = useCallback((): void => {
    discardAutosave();
    pendingRef.current = null; // 与 pending state 同步清空，避免残留旧快照
    promptedThisSession = true;
    if (mounted.current) setPending(null);
    try {
      usePdbStore.getState().pushToast('info', '已丢弃上次未保存的会话', 2600);
    } catch {
      /* 静默 */
    }
  }, []);

  const saveNow = useCallback((): boolean => {
    try {
      return saveAutosaveNow();
    } catch {
      return false;
    }
  }, []);

  return { pending, summary: describeAutosave(pending), restore, discard, saveNow, running };
}

export default useAutoSave;
