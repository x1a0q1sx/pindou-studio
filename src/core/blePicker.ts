/**
 * core/blePicker.ts —— 蓝牙设备选择器总线（Electron 主进程接管 → 渲染层自绘）。
 *
 * 背景：Electron 无内建蓝牙选择框。主进程 session.on('select-bluetooth-device')
 * 扫到设备后把列表推过来；本模块做**全局**订阅（AppShell 启动即接线），
 * 任何界面（智能板对话框等）通过 subscribeBtPicker 渲染选择 UI——
 * 即使事件到来时对话框恰好重渲染也不会丢单。主进程 60s 无回执自动取消（req=null）。
 *
 * 浏览器模式：onBtDeviceRequest 是 no-op（Chrome 自己弹原生选择框），本模块静默。
 */
import { getBridge, type BtPickerRequest } from '@/io/bridge';

type Listener = (req: BtPickerRequest | null) => void;

let started = false;
let current: BtPickerRequest | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn(current);
    } catch {
      /* 单个监听器异常不广播断链 */
    }
  }
}

/** 接线主进程推送（幂等；首次 subscribe 时自动调用） */
export function startBtPickerBridge(): void {
  if (started) return;
  started = true;
  getBridge().onBtDeviceRequest((req) => {
    current = req;
    emit();
  });
}

/** 订阅当前挂起的选择请求（立即回放现状）。返回取消函数。 */
export function subscribeBtPicker(fn: Listener): () => void {
  startBtPickerBridge();
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** 当前挂起的选择请求（null = 无） */
export function currentBtPickerRequest(): BtPickerRequest | null {
  return current;
}

/**
 * 回传用户选择（deviceId=null 表示取消）。
 * 无论主进程是否还受理，本地状态都清除并广播——UI 收起。
 */
export async function respondBtPicker(deviceId: string | null): Promise<boolean> {
  if (!current) return false;
  const req = current;
  current = null;
  emit();
  return getBridge().resolveBtDevice(req.requestId, deviceId);
}
