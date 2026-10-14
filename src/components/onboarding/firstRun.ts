/**
 * onboarding/firstRun.ts —— 引导流程的偏好持久化与「重开入口」事件契约。
 *
 * 【命名空间】沿用项目既有约定 `pindou-studio:*`
 *   （对齐 theme/appearance.ts 的 `pindou-studio:appearance`
 *     与 store/placementPrefs.ts 的 `pindou-studio:placement-prefs`）。
 *
 * 【为什么不是 store 切片】首启标志只在「挂载时读一次 + 完成时写一次」，
 *   不参与渲染响应式；把它做成独立 localStorage 读写函数，
 *   既不给 core/types.ts 与 store 形状加任何新字段（契约零改动），
 *   也避免向导关闭时的 setState 波及渲染器脏矩形链路。
 *
 * 【失败降级】隐私模式 / 配额满 / SSR 下 localStorage 可能抛异常，
 *   全部 try/catch 静默回落到内存默认值：最坏情况是「每次启动都弹引导」，绝不白屏。
 */

/** localStorage key（契约） */
export const ONBOARDING_LS_KEY = 'pindou-studio:onboarding';

export interface OnboardingPrefs {
  /** 首次启动引导是否已结束（走完 5 步 / 跳过 / 直接关闭，三者都算结束） */
  firstRunDone: boolean;
  /** 引导结束的时间戳（ISO 8601）；未结束为 null */
  completedAt: string | null;
  /** 画布「空白板」引导卡是否已被用户点「知道了」永久收起 */
  emptyHintDismissed: boolean;
}

const DEFAULTS: OnboardingPrefs = {
  firstRunDone: false,
  completedAt: null,
  emptyHintDismissed: false,
};

/** 内存兜底：localStorage 不可用时至少保证同一次会话内不重复弹 */
let memoryFallback: OnboardingPrefs = { ...DEFAULTS };
let storageUsable = true;

function normalize(raw: unknown): OnboardingPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const o = raw as Partial<OnboardingPrefs>;
  return {
    firstRunDone: o.firstRunDone === true,
    completedAt: typeof o.completedAt === 'string' ? o.completedAt : null,
    emptyHintDismissed: o.emptyHintDismissed === true,
  };
}

/** 读取全部引导偏好（永不抛异常） */
export function readOnboardingPrefs(): OnboardingPrefs {
  if (!storageUsable) return { ...memoryFallback };
  try {
    const text = localStorage.getItem(ONBOARDING_LS_KEY);
    if (!text) return { ...memoryFallback };
    const parsed = normalize(JSON.parse(text) as unknown);
    memoryFallback = parsed;
    return { ...parsed };
  } catch {
    storageUsable = false;
    return { ...memoryFallback };
  }
}

/** 合并写入引导偏好，返回写入后的完整值（永不抛异常） */
export function writeOnboardingPrefs(patch: Partial<OnboardingPrefs>): OnboardingPrefs {
  const next: OnboardingPrefs = { ...readOnboardingPrefs(), ...patch };
  memoryFallback = next;
  if (!storageUsable) return { ...next };
  try {
    localStorage.setItem(ONBOARDING_LS_KEY, JSON.stringify(next));
  } catch {
    // 写失败（隐私模式/配额满）：退化为会话级记忆，本次运行内不再重复弹
    storageUsable = false;
  }
  return { ...next };
}

/** 首启引导是否已经结束 */
export function isFirstRunDone(): boolean {
  return readOnboardingPrefs().firstRunDone;
}

/** 标记首启引导结束（走完 / 跳过 / 关闭都调用它） */
export function markFirstRunDone(): void {
  if (isFirstRunDone()) return;
  writeOnboardingPrefs({ firstRunDone: true, completedAt: new Date().toISOString() });
}

/** 复位首启标志（调试用；「重看引导」不需要它，直接派发打开事件即可） */
export function resetFirstRun(): void {
  writeOnboardingPrefs({ firstRunDone: false, completedAt: null });
}

/** 空白板引导卡是否已被永久收起 */
export function isEmptyHintDismissed(): boolean {
  return readOnboardingPrefs().emptyHintDismissed;
}

/** 永久收起空白板引导卡 */
export function dismissEmptyHint(): void {
  writeOnboardingPrefs({ emptyHintDismissed: true });
}

/* ==================== 重开入口：自定义事件契约 ==================== */

/**
 * 打开首次启动引导（WelcomeWizard）。
 * 与  的 `pdb:open-save` / `pdb:open-open`、 的 `pdb:open-import` 同构：
 * 派发方（Toolbar 帮助按钮 / 开始面板 / 空状态卡）与挂载方（AppShell）解耦，
 * 任何布局下都只有一个 WelcomeWizard 实例，不会重复挂载。
 */
export const EV_OPEN_WIZARD = 'pdb:open-wizard';

/** 打开「开始 / 帮助」面板（StartPanel：快速开始 + 最近项目 + 快捷键速查） */
export const EV_OPEN_START = 'pdb:open-start';

/** 派发「打开引导」事件 */
export function openWelcomeWizard(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ handled: boolean }>(EV_OPEN_WIZARD, { detail: { handled: false } }));
}

/** 派发「打开开始/帮助面板」事件 */
export function openStartPanel(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ handled: boolean }>(EV_OPEN_START, { detail: { handled: false } }));
}
