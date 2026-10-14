/**
 * core/vbLight.ts —— 手机点亮图案（VbLightPattern）构建纯函数。
 *
 * 数据源：虚拟板对话框收齐 PIXDOU 节目后解出的内嵌 GIF 首帧 ImageData。
 * 语义与真板子一致：**非黑像素 = 点亮的豆子**（黑色是底板熄灭色；2026-09-30 真机
 * 573B 节目实测：104×104 单帧 GIF、黑+红双色调色板、1146 个亮点格）。
 */
import type { VbLightPattern } from './types';

/**
 * RGBA（行主序，每像素 4 字节）→ 点亮掩码。
 * 黑色判定只看 RGB、不看 alpha（GIF 经 canvas 解码后 alpha 恒 255，与对话框
 * 预览画布的跳过条件 `r===0&&g===0&&b===0` 保持同一口径）。
 */
export function buildLightMaskFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): VbLightPattern {
  const mask = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i]! !== 0 || rgba[i + 1]! !== 0 || rgba[i + 2]! !== 0) {
        mask[y * w + x] = 1;
        count++;
      }
    }
  }
  // rgba 原样带回一份拷贝：小窗（VbMiniBoard）要按 App 画的颜色重绘每个亮点
  return { w, h, mask, rgba: new Uint8ClampedArray(rgba), count };
}
