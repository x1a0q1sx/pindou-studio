/**
 * components/onboarding/index.ts —— 引导流程与体验打磨的桶导出。
 *
 * 挂载点只有一个：`AppShell`（WelcomeWizard / StartPanel / EmptyStates 各挂一份）。
 * 触发方式全部走自定义事件，与 / 的对话框保持同一套解耦范式：
 *   pdb:open-wizard → WelcomeWizard     pdb:open-start → StartPanel
 */
export { WelcomeWizard } from './WelcomeWizard';
export { StartPanel } from './StartPanel';
export { EmptyStates } from './EmptyStates';
export {
  EV_OPEN_START,
  EV_OPEN_WIZARD,
  ONBOARDING_LS_KEY,
  dismissEmptyHint,
  isFirstRunDone,
  isEmptyHintDismissed,
  markFirstRunDone,
  openStartPanel,
  openWelcomeWizard,
  readOnboardingPrefs,
  resetFirstRun,
  writeOnboardingPrefs,
} from './firstRun';
export type { OnboardingPrefs } from './firstRun';
