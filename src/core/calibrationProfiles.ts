/**
 * core/calibrationProfiles.ts —— 校准档按 displayKey 多档持久化。
 *
 * 【约定】校准按 displayKey 持久化，换显示器自动切换对应档。
 * 原缺陷：useDisplayInfo 在 displayKey 变化时直接用 WMI 自动值覆盖 store.calibration，
 * manual-ruler 等手动精调一换屏/改分辨率就丢失。
 *
 * 【设计】
 *   · localStorage key：`pindou.calibrations.v1`，结构 `{ [displayKey]: Calibration }`；
 *   · 只记 **手动校准档**（source = manual-ruler / manual-ppi / manual-span）——
 *     auto-wmi / browser-fallback 可由 display 指标随时再生，存档只会引入过期脏数据；
 *   · 命中语义由 useDisplayInfo 实现：displayKey 变化 → 命中档位则恢复，未命中才生成默认值；
 *   · Electron appdata 镜像省略：现有 appdata 白名单虽支持扁平文件名，但同步 localStorage
 *     路径 + 异步镜像回灌存在启动时序竞争（镜像未读回前写档会互相覆盖），档位数据体积极小，
 *     localStorage 已满足「换显示器自动切换」的需求（报告中已说明）。
 *
 * 【健壮性】全部 try/catch 静默降级（隐私模式 / 配额满 / 脏数据），绝不抛异常阻断校准主流程。
 */
import type { Calibration } from './types';

/** localStorage key（契约，文档按此名） */
export const CALIBRATIONS_LS_KEY = 'pindou.calibrations.v1';

/** 视为「手动精调」的校准来源（只有这些才值得跨会话记档） */
const MANUAL_SOURCES: ReadonlySet<Calibration['source']> = new Set([
  'manual-ruler',
  'manual-ppi',
  'manual-span',
]);

/** 该校准是否为手动精调（决定是否写入档位） */
export function isManualCalibration(cal: Calibration): boolean {
  return MANUAL_SOURCES.has(cal.source);
}

/** 读取全部档位；结构不合法的条目逐条剔除，绝不抛错 */
export function loadCalibrationProfiles(): Record<string, Calibration> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(CALIBRATIONS_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, Calibration> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || typeof value !== 'object' || value === null) continue;
      const cal = value as Partial<Calibration>;
      // 最小结构校验：数字字段可 sanitize 兜底，但 displayKey/pitchMm 必须存在才认
      if (typeof cal.pitchMm !== 'number' || typeof cal.displayKey !== 'string') continue;
      out[key] = cal as Calibration;
    }
    return out;
  } catch {
    return {};
  }
}

/** 按显示器 key 取档位；未命中 / key 为空返回 null */
export function getCalibrationForKey(key: string): Calibration | null {
  if (!key) return null;
  return loadCalibrationProfiles()[key] ?? null;
}

/**
 * 把一份手动校准写入对应显示器档位。
 * 内容与现档完全一致时跳过写盘（防 store 重放触发反复落盘）。
 */
export function saveCalibrationForKey(key: string, cal: Calibration): void {
  if (!key || !isManualCalibration(cal)) return;
  try {
    if (typeof localStorage === 'undefined') return;
    const all = loadCalibrationProfiles();
    const prev = all[key];
    if (prev && sameCalibration(prev, cal)) return;
    all[key] = cal;
    localStorage.setItem(CALIBRATIONS_LS_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式/配额满：静默，档位退化为会话级 */
  }
}

/** 逐字段浅比较（Calibration 无嵌套数组；originDevicePx 两值手比） */
function sameCalibration(a: Calibration, b: Calibration): boolean {
  return (
    a.pitchMm === b.pitchMm &&
    a.mmPerDevicePxX === b.mmPerDevicePxX &&
    a.mmPerDevicePxY === b.mmPerDevicePxY &&
    a.originDevicePx.x === b.originDevicePx.x &&
    a.originDevicePx.y === b.originDevicePx.y &&
    a.source === b.source &&
    a.displayKey === b.displayKey &&
    a.verifiedAt === b.verifiedAt
  );
}
