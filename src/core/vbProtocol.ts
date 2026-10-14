/**
 * core/vbProtocol.ts —— PC 虚拟板帧解析纯函数（可单测）。
 * 协议形态取自公开的酷猫系开放协议：[cmd, payload...]，0x02 为 [R,G,B,x,y,...]。
 * 未知命令统一降级为 hex 摘要——虚拟板对任意 App 都能"看得见写了什么"。
 */

export interface VbPoint { x: number; y: number; rgb: string }

/** hex 字符串 → 字节数组（奇数长度截尾） */
export function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const v = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** 解析 0x02 绘制帧（不含 cmd 字节的前 3 字节为 RGB，其后 x,y 对）；非 0x02 返回空 */
export function parseDrawFrame(hex: string): VbPoint[] {
  const bytes = hexToBytes(hex);
  if (bytes.length < 4 || bytes[0] !== 0x02) return [];
  const [r, g, b] = [bytes[1]!, bytes[2]!, bytes[3]!];
  const rgb = `#${r!.toString(16).padStart(2, '0')}${g!.toString(16).padStart(2, '0')}${b!.toString(16).padStart(2, '0')}`;
  const pts: VbPoint[] = [];
  for (let i = 4; i + 1 < bytes.length; i += 2) pts.push({ x: bytes[i]!, y: bytes[i + 1]!, rgb });
  return pts;
}

/** 帧 → 一行人类可读摘要（日志用） */
export function frameSummary(hex: string): string {
  const bytes = hexToBytes(hex);
  if (bytes.length === 0) return '空帧';
  const cmd = bytes[0]!;
  switch (cmd) {
    case 0x01: return '清屏';
    case 0x02: return `绘制 ${Math.max(0, Math.floor((bytes.length - 4) / 2))} 点`;
    case 0x03: return '提交显示';
    case 0x04: return `亮度 ${bytes[1] ?? 0}`;
    case 0x05: return '按键·上一色';
    case 0x06: return '按键·下一色';
    case 0xa1: return '查询设备信息';
    case 0xa2: return `色号提示 "${asciiOf(bytes.slice(6))}"`;
    case 0xa3: return '取消色号提示';
    case 0xa0: return `回执 cmd=0x${(bytes[1] ?? 0).toString(16)} 状态=${bytes[2] ?? 0}`;
    default: return `帧 0x${cmd.toString(16).padStart(2, '0')}×${bytes.length}B`;
  }
}

function asciiOf(bytes: number[]): string {
  return bytes.map((v) => (v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '')).join('');
}
