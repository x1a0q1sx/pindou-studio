/**
 * core/smartBoard.ts —— 智能拼豆板（BLE 探测）的纯逻辑层（零 DOM / 零蓝牙调用）。
 *
 * 职责：requestDevice 的 optionalServices 策略（默认放开常见厂商服务段）、
 * 用户输入的服务 UUID 解析、GATT 探测结果的数据结构与报告导出。
 * 真正的 navigator.bluetooth 调用在 SmartBoardDialog —— 这里全部可单测。
 *
 * 为什么默认带 0xFF00–0xFFFF：国产智能硬件（含灯板/拼豆板/蓝牙串口）绝大多数用
 * 该段厂商服务；把它们全部放进 optionalServices（共 256 个短 UUID），枚举这些
 * 板子的特征值就**不需要**二次授权。冷门 128bit 服务用「附加授权 UUID」输入补。
 */

/** 0xFF00–0xFFFF 全段厂商服务（短 UUID 数字形式） */
export const VENDOR_FF_SERVICES: number[] = (() => {
  const out: number[] = [];
  for (let u = 0xff00; u <= 0xffff; u++) out.push(u);
  return out;
})();

/** 始终允许的 SIG 标准服务（名字形式） */
export const BASE_SERVICES: Array<string | number> = [
  'generic_access',
  'device_information',
  'battery_service',
];

/** 解析用户输入的服务 UUID 串：逗号/分号/空格/换行分隔（含全角，防中文粘贴）；0x180A / 180a / 0000fff0-0000-... */
export function parseUuidList(text: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const raw of text.split(/[,，;；\s]+/)) {
    const tok = raw.trim().toLowerCase();
    if (!tok) continue;
    if (/^0x[0-9a-f]{1,4}$/.test(tok)) {
      out.push(parseInt(tok.slice(2), 16));
    } else if (/^[0-9a-f]{4}$/.test(tok)) {
      out.push(parseInt(tok, 16));
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tok)) {
      out.push(tok);
    }
    /* 非法 token 静默丢弃：探测工具宽容输入 */
  }
  return out;
}

/** requestDevice 用的默认 optionalServices：SIG 基础 + FF 全段 + 用户附加（去重） */
export function defaultOptionalServices(extra: Array<string | number> = []): Array<string | number> {
  const seen = new Set<string>();
  const out: Array<string | number> = [];
  for (const s of [...BASE_SERVICES, ...VENDOR_FF_SERVICES, ...extra]) {
    const key = typeof s === 'number' ? `n${s}` : `s${s}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** 服务 UUID（API 返回恒为小写 128bit）→ 短 uuid（0000xxxx-… 形式提取 xxxx）或原样 */
export function shortUuidOf(uuid: string): string {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(uuid.toLowerCase());
  return m ? m[1]! : uuid.toLowerCase();
}

/** 已知服务/厂商服务的中文名（保守：只标注业界公知映射，认不出的留空不猜） */
const KNOWN_NAMES: Record<string, string> = {
  '1800': 'Generic Access',
  '1801': 'Generic Attribute',
  '180a': 'Device Information',
  '180f': 'Battery',
  '1812': 'Human Interface Device',
  '1813': 'Heart Rate',
  ffe0: '蓝牙串口（HM-10 类固件）',
  fff0: '厂商自定义（ESP32 常见）',
  ff00: '厂商自定义',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e': 'Nordic UART Service',
};

export function serviceLabel(uuid: string): string {
  return KNOWN_NAMES[shortUuidOf(uuid)] ?? '';
}

export interface ProbeCharacteristic {
  uuid: string;
  /** R W Wn N I 属性位摘要 */
  flags: string;
  /** 读取失败原因（如 GATT 忙）；成功为 undefined */
  error?: string;
}

export interface ProbeService {
  uuid: string;
  label: string;
  /** 特征值枚举成功时的列表；受限（未在 optionalServices 授权）为 undefined */
  characteristics?: ProbeCharacteristic[];
  /** 枚举失败原因（SecurityError=未授权 / GATT 错误等） */
  error?: string;
}

export interface ProbeReport {
  deviceName: string;
  deviceId: string;
  connected: boolean;
  probedAt: string;
  services: ProbeService[];
}

/** 特征属性位 → 紧凑摘要（R=read W=write Wn=writeNoResp N=notify I=indicate） */
export function characteristicFlags(p: {
  read?: boolean;
  write?: boolean;
  writeWithoutResponse?: boolean;
  notify?: boolean;
  indicate?: boolean;
} | undefined): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.read) parts.push('R');
  if (p.write) parts.push('W');
  if (p.writeWithoutResponse) parts.push('Wn');
  if (p.notify) parts.push('N');
  if (p.indicate) parts.push('I');
  return parts.join(' ');
}

/** 探测报告 → 可粘贴给开发者分析的纯文本树 */
export function buildProbeText(r: ProbeReport): string {
  const lines: string[] = [
    `# PinDou Studio 智能板探测报告`,
    `设备：${r.deviceName || '(无名)'} [${r.deviceId}]`,
    `连接：${r.connected ? '在线' : '已断开'} · 探测时间：${r.probedAt}`,
    `服务数：${r.services.length}`,
    '',
  ];
  for (const s of r.services) {
    lines.push(`服务 ${shortUuidOf(s.uuid)}${s.label ? ` · ${s.label}` : ''}`);
    if (s.error) {
      lines.push(`  ⚠ 枚举失败：${s.error}`);
      continue;
    }
    for (const ch of s.characteristics ?? []) {
      lines.push(`  特征 ${ch.uuid}${ch.flags ? ` [${ch.flags}]` : ''}${ch.error ? ` ⚠ ${ch.error}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Web Bluetooth 异常 name → 中文可读提示 */
export function bleErrorHint(err: unknown): string {
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotFoundError':
      return '没有选中设备（选择窗被关闭 / 列表里没有你的板子）。确认板子已开机、处于配对状态后重试。';
    case 'SecurityError':
      return '当前上下文不允许 Web Bluetooth（安全检查未过）。';
    case 'NetworkError':
      return 'GATT 连接失败：把板子拿近一些、确认没被手机 App 占用，再重连。';
    case 'InvalidStateError':
      return '蓝牙适配器状态异常：系统里关掉再打开蓝牙后重试。';
    case 'AbortError':
      return '操作被取消。';
    default:
      return `蓝牙操作失败（${name || '未知错误'}）：${err instanceof Error ? err.message : String(err)}`;
  }
}
