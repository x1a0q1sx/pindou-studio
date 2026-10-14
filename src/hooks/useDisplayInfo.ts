/**
 * src/hooks/useDisplayInfo.ts —— 启动时拉取显示器列表 → 写入 store；订阅变化并提示重校准。
 *
 * 浏览器降级路径：bridge.getDisplays() 返回 1 条 physicalMm=null 的记录，
 * 此时自动校准不可用，hook 会 pushToast 提示用户需手动标尺校准。
 *
 * 【#25 校准档多档持久化】displayKey 变化时不再直接用 WMI 自动值覆盖（那会丢 manual-ruler 精调）：
 *   命中 core/calibrationProfiles 的档位则恢复该档，未命中才生成默认值；
 *   同时订阅 store 的校准变化，把手动档自动回写档位库。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge } from '@/io/bridge';
import { usePdbStore } from '@/store';
import { calibrationFromDisplay, displayKey, sanitizeCalibration } from '@/core/geometry';
import { getCalibrationForKey, saveCalibrationForKey } from '@/core/calibrationProfiles';
import type { DisplayMetrics } from '@/core/types';

/**
 * 从显示器列表中挑出「用于校准的主屏」：
 * 优先 isPrimary && !isVirtual，其次任意非虚拟屏，兜底取第一项。
 * 虚拟屏（如 Todesk Virtual Display Adapter）physicalMm 为 null，无法做 1:1 物理校准。
 */
export function pickCalibrationDisplay(displays: DisplayMetrics[]): DisplayMetrics | null {
  if (displays.length === 0) return null;
  return (
    displays.find((d) => d.isPrimary && !d.isVirtual)
    ?? displays.find((d) => !d.isVirtual)
    ?? displays[0]!
  );
}

/**
 * 显示器信息 hook：
 * 1. 启动时经 bridge.getDisplays() 拉取 → 选主屏写入 store.setDisplay()
 * 2. 自动生成初始 calibration（Electron: auto-wmi；浏览器: browser-fallback）
 * 3. 订阅 onDisplaysChanged → 重新拉取 → 若 displayKey 或 DPR 变化则 toast 提示重校准
 * 4. 浏览器降级时额外 toast 提示手动校准
 */
export function useDisplayInfo(): void {
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const bridge = getBridge();
    const store = usePdbStore.getState();

    void (async () => {
      try {
        const displays = await bridge.getDisplays();
        if (displays.length === 0) return;

        // 选择主屏（非虚拟屏优先）
        const primary = pickCalibrationDisplay(displays);
        if (!primary) return;

        store.setDisplay(primary);

        // 自动生成初始校准（若 store 已有校准且 displayKey 匹配则保留）
        // 【#25】displayKey 不匹配时先查档位库：命中则恢复该屏的手动校准档，未命中才生成默认值
        const existingCal = usePdbStore.getState().calibration;
        const newKey = displayKey(primary);
        if (!existingCal || existingCal.displayKey !== newKey) {
          const saved = getCalibrationForKey(newKey);
          if (saved) {
            store.setCalibration(sanitizeCalibration(saved));
          } else {
            const cal = sanitizeCalibration(calibrationFromDisplay(primary));
            store.setCalibration(cal);
          }
        }

        // 浏览器降级提示
        if (bridge.env === 'browser') {
          store.pushToast(
            'info',
            '浏览器模式：无法自动检测屏幕物理尺寸，请使用标尺校准功能手动校准',
            5000,
          );
        }

        // 虚拟屏告警
        const virtualDisplays = displays.filter((d) => d.isVirtual);
        if (virtualDisplays.length > 0) {
          console.info(
            '[PinDou] 检测到虚拟显示器（无法 1:1 物理校准）:',
            virtualDisplays.map((d) => d.label),
          );
        }
      } catch (err) {
        console.warn('[PinDou] 显示器检测失败', err);
      }
    })();

    // 订阅显示器变化
    const unsubscribe = bridge.onDisplaysChanged(() => {
      void (async () => {
        try {
          const displays = await bridge.getDisplays();
          if (displays.length === 0) return;

          const prevDisplay = usePdbStore.getState().display;
          const primary = pickCalibrationDisplay(displays);
          if (!primary) return;

          // 检测分辨率/DPR 变化
          const prevKey = prevDisplay ? displayKey(prevDisplay) : '';
          const newKey = displayKey(primary);

          usePdbStore.getState().setDisplay(primary);

          if (prevKey && prevKey !== newKey) {
            // 【#25】先查档位库：命中则恢复该屏的手动校准档（不再用 WMI 自动值覆盖精调）；
            // 未命中才生成默认值并提示重校准
            const saved = getCalibrationForKey(newKey);
            if (saved) {
              usePdbStore.getState().setCalibration(sanitizeCalibration(saved));
              usePdbStore.getState().pushToast(
                'info',
                '检测到显示器切换，已自动恢复该屏的手动校准档',
                4200,
              );
            } else {
              usePdbStore.getState().pushToast(
                'warning',
                '检测到分辨率或缩放变化，建议重新校准以确保 1:1 物理精度',
                6000,
              );
              // 自动重新生成校准
              const cal = sanitizeCalibration(calibrationFromDisplay(primary));
              usePdbStore.getState().setCalibration(cal);
            }
            // 正在拼豆时换了屏 → 立刻按新屏容量重估分块
            // （切到大屏整板放得下自动合回单块；切小屏反之按屏分块）
            if (usePdbStore.getState().mode === 'placement') {
              usePdbStore.getState().reconcileRegionWithDisplay();
            }
          }
        } catch (err) {
          console.warn('[PinDou] 显示器变化处理失败', err);
        }
      })();
    });

    return unsubscribe;
  }, []);

  // 【#25】订阅 store：校准对象变化且有当前显示器时，把手动档自动回写档位库
  // （覆盖校准向导 / 标尺精调 / 项目打开等一切写入路径；自动档被 saveCalibrationForKey 过滤）
  useEffect(() => {
    let lastPersisted: unknown = null;
    const unsubCal = usePdbStore.subscribe((s) => {
      if (!s.calibration || !s.display) return;
      if (s.calibration === lastPersisted) return;
      lastPersisted = s.calibration;
      saveCalibrationForKey(displayKey(s.display), s.calibration);
    });
    return unsubCal;
  }, []);
}

/**
 * 拉取全量显示器列表（供 DisplayPicker 等组件使用）。
 * 返回响应式 state + refresh；并在 onDisplaysChanged 时自动刷新。
 */
export function useDisplayList(): {
  displays: DisplayMetrics[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [displays, setDisplays] = useState<DisplayMetrics[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await getBridge().getDisplays();
      setDisplays(list);
    } catch (err) {
      console.warn('[PinDou] 显示器列表拉取失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = getBridge().onDisplaysChanged(() => { void refresh(); });
    return unsubscribe;
  }, [refresh]);

  return { displays, loading, refresh };
}
