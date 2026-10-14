/**
 * core/displayContrast.ts —— 屏上可见性辅助的纯判定（零 DOM，可单测）。
 *
 * 背景：glowDark 主题画布底色是纯黑（透明板下 LCD 不漏光），
 * 黑/深色豆点（MARD H6/H7 等 #000–#222）画在黑底上亮度差趋近于零——「压暗后
 * 看不到」。这里提供两个与渲染解耦的判定：
 *   1) lowContrastEdge：豆色与底色太接近时，给豆描一圈反向高对比边线；
 *   2) dimVeilStyle：筛选 dim 压暗非目标豆时，深色豆用更浅的压暗层，
 *      保住描边与轮廓可辨。
 * 亮度一律用 YIQ 感知加权（与 codeTextColor 同一口径）。
 */

export type Rgb255 = [number, number, number];

/** YIQ 感知亮度 0–255 */
export function yiqLuma(rgb: Rgb255): number {
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
}

/** #RGB / #RRGGBB → YIQ 亮度；非法串按 0（黑） */
export function hexLuma(hex: string): number {
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s[0]! + s[0]! + s[1]! + s[1]! + s[2]! + s[2]!;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return 0;
  const n = parseInt(s, 16);
  return yiqLuma([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

/** 判定阈值：豆色与底色亮度差小于该值视为「看不见」 */
export const EDGE_CONTRAST_THRESHOLD = 60;

/**
 * 低对比度救援描边颜色：亮度差 < EDGE_CONTRAST_THRESHOLD 时按豆色自身明暗取反向边线
 * （暗豆 → 白边，亮豆 → 黑边；两者亮度几乎相等，比底色必然比不出方向，用绝对明暗）；
 * 对比充足返回 null。
 */
export function lowContrastEdge(beadLuma: number, bgLuma: number): string | null {
  if (Math.abs(beadLuma - bgLuma) >= EDGE_CONTRAST_THRESHOLD) return null;
  return beadLuma < 128 ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
}

/**
 * 筛选 dim 对非目标豆的压暗层：深底上本来就暗的豆用更浅的 veil（0.40），
 * 否则高对比豆正常 0.65——保证压暗后深色豆的救援描边仍可辨。
 */
export function dimVeilStyle(beadLuma: number, bgLuma: number): string {
  return Math.abs(beadLuma - bgLuma) < EDGE_CONTRAST_THRESHOLD + 30
    ? 'rgba(0,0,0,0.40)'
    : 'rgba(0,0,0,0.65)';
}
