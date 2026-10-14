/**
 * hooks/useEyedropper.ts —— 吸管取色。
 *
 * 优先用浏览器原生 `EyeDropper` API（Chrome/Edge 支持，可取屏幕**任意处**颜色，
 * 包括用户拍的实物豆照片，用于校正品牌色批次色差）。用 `'EyeDropper' in window` 做特性检测。
 *
 * 不支持时降级为三种途径：
 *   ① 从画布格子取色  → pickFromImageData(canvasImageData, x, y)
 *   ② 从已导入图片取色 → pickFromImageData(imageImageData, x, y)
 *   ③ 手动输入 HEX     → fromHex('#RRGGBB')
 * 取到色后可直接用于「新增颜色」或「修改当前颜色」。
 */
import { useCallback, useState } from 'react';
import { hexToRgb, rgbToHex, type Rgb } from '@/color/convert';

/** 取色结果：规范化大写 HEX + 对应 RGB */
export interface PickedColor {
  hex: string;
  rgb: Rgb;
}

/** ImageData 的最小形状（Canvas getImageData / OffscreenCanvas 均满足） */
export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | ArrayLike<number>;
}

/** 浏览器原生 EyeDropper（Chromium 系）最小声明 */
interface NativeEyeDropper {
  open: (options?: { signal?: AbortSignal }) => Promise<{ sRGBHex: string }>;
}

declare global {
  interface Window {
    EyeDropper?: new () => NativeEyeDropper;
  }
}

export interface UseEyedropperResult {
  /** 是否支持原生 EyeDropper API（决定 EyedropperButton 走原生还是降级菜单） */
  supported: boolean;
  /** 触发原生取色；不支持或用户取消（Esc）返回 null */
  pick: () => Promise<PickedColor | null>;
  /** 降级①②：从 ImageData（画布格子 / 已导入图片）按像素坐标取色 */
  pickFromImageData: (imageData: ImageDataLike, x: number, y: number) => PickedColor | null;
  /** 降级③：把任意 HEX 文本规范化为取色结果（非法返回 null） */
  fromHex: (hex: string) => PickedColor | null;
  /** 原生取色进行中（用于按钮 loading 态、避免重复触发） */
  isPicking: boolean;
}

export function useEyedropper(): UseEyedropperResult {
  const supported = typeof window !== 'undefined' && 'EyeDropper' in window;
  const [isPicking, setIsPicking] = useState(false);

  const pick = useCallback(async (): Promise<PickedColor | null> => {
    if (typeof window === 'undefined' || typeof window.EyeDropper !== 'function') return null;
    setIsPicking(true);
    try {
      const dropper = new window.EyeDropper();
      const res = await dropper.open();
      const rgb = hexToRgb(res.sRGBHex);
      return { hex: rgbToHex(rgb[0], rgb[1], rgb[2]), rgb };
    } catch {
      return null; // 用户按 Esc 取消会以 AbortError reject —— 视为「没取到」
    } finally {
      setIsPicking(false);
    }
  }, []);

  const pickFromImageData = useCallback((imageData: ImageDataLike, x: number, y: number): PickedColor | null => {
    const { width, height, data } = imageData;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const i = (py * width + px) * 4;
    if (i + 2 >= data.length) return null;
    const rgb: Rgb = [data[i], data[i + 1], data[i + 2]];
    return { hex: rgbToHex(rgb[0], rgb[1], rgb[2]), rgb };
  }, []);

  const fromHex = useCallback((hex: string): PickedColor | null => {
    try {
      const rgb = hexToRgb(hex);
      return { hex: rgbToHex(rgb[0], rgb[1], rgb[2]), rgb };
    } catch {
      return null;
    }
  }, []);

  return { supported, pick, pickFromImageData, fromHex, isPicking };
}
