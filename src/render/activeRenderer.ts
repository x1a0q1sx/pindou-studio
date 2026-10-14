/**
 * src/render/activeRenderer.ts —— 活动渲染器注册表（模块级，零依赖）。
 *
 * 生产者：StageCanvas 在创建/销毁 Renderer 时写入/清空（唯一生产者，dual 布局
 * 指针进入哪块画布哪块接管）。消费者：
 * - usePointerPaint：拖拽笔画每帧对实际改动的格标脏（缺口 7）；
 * - store/history（经 HistoryAdapter.markCellsDirty）：撤销/重做/pushEdit 的 diff 型
 *   记录按格标脏，替代全量重绘。
 *
 * 从 usePointerPaint 抽出成独立模块的原因：history.ts 已 import store，而
 * usePointerPaint 又 import history —— 若 history 反向 import usePointerPaint 会成环。
 * 本模块不 import 任何业务代码（Renderer 仅 type-only），无环风险。
 */
import type { Renderer } from './renderer';

let active: Renderer | null = null;

/** 由 StageCanvas 调用：渲染器创建时传入实例，dispose 时传入 null。 */
export function setActiveRenderer(renderer: Renderer | null): void {
  active = renderer;
}

/** 非 React 环境读取当前活动渲染器（可能为 null）。 */
export function getActiveRenderer(): Renderer | null {
  return active;
}
