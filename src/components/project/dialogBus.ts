/**
 * components/project/dialogBus.ts —— 保存/打开对话框的事件总线（零依赖）。
 *
 * 独立成模块的原因：SaveDialog/OpenDialog 组件本体走 React.lazy 懒加载，
 * AppShell / useHotkeys 只需要「派发打开事件」的能力——从这个轻量模块导入，
 * 不会把对话框组件（及其依赖链）拉回首屏主包。
 */

/** 打开「保存项目」对话框（对话框挂载后才有人监听；未挂载时事件无害地落空） */
export function openSaveDialog(): void {
  window.dispatchEvent(new CustomEvent('pdb:open-save', { detail: { handled: false } }));
}

/** 打开「打开项目」对话框 */
export function openOpenDialog(): void {
  window.dispatchEvent(new CustomEvent('pdb:open-open', { detail: { handled: false } }));
}
