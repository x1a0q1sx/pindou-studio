/**
 * color/convert.ts —— 颜色空间转换（纯函数，零依赖，禁止引入任何颜色库）。
 *
 * 公式出处：
 * - sRGB ↔ linear：IEC 61966-2-1（阈值 0.04045 / 12.92 / 1.055）
 * - linear RGB ↔ XYZ：sRGB 矩阵，D65 白点 (0.95047, 1.0, 1.08883)
 * - XYZ ↔ CIELAB：CIE 1976，ε = 216/24389，κ = 24389/100
 *   （采用 Lindbloom 的精确有理数形式，而非旧版 0.008856/7.787）
 */

export type Rgb = [number, number, number];
export type Lab = [number, number, number];
export type Xyz = [number, number, number];
export type Hsl = [number, number, number];
export type Lch = [number, number, number];

/** D65 白点（2° 观察者），sRGB 标准白 */
export const D65: Xyz = [0.95047, 1.0, 1.08883];

const EPS = 216 / 24389; // ≈ 0.008856
// κ = 24389/27 ≈ 903.3（CIE/Lindbloom 精确有理数）。此前误写成 24389/100=243.89，
// 导致暗区（t ≤ ε 的线性支路）Lab 全面失真：L 偏暗、a/b 被放大约 3.7 倍——
// 黑发被匹配成棕色号、暗部色号紊乱的直接根源；labToXyz 反推同样失真。
const KAPPA = 24389 / 27;

/* ================= HEX ================= */

/**
 * HEX → RGB。支持 #RGB / #RRGGBB / 带前后空格 / 不带 #。
 * 非法值抛错（调用方 UI 层自行 catch 做宽容校验）。
 */
export function hexToRgb(hex: string): Rgb {
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  } else if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    throw new Error(`非法 HEX 颜色: "${hex}"（需 #RGB 或 #RRGGBB）`);
  }
  const n = parseInt(s, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** RGB → HEX，统一输出 #RRGGBB 大写 */
export function rgbToHex(r: number, g: number, b: number): string {
  const [cr, cg, cb] = clampRgb([r, g, b]);
  return (
    '#' +
    ((1 << 24) | (cr << 16) | (cg << 8) | cb).toString(16).slice(1).toUpperCase()
  );
}

/** 裁剪到 0-255 整数（round） */
export function clampRgb(rgb: Rgb): Rgb {
  return [
    Math.min(255, Math.max(0, Math.round(rgb[0]))),
    Math.min(255, Math.max(0, Math.round(rgb[1]))),
    Math.min(255, Math.max(0, Math.round(rgb[2]))),
  ];
}

/* ================= sRGB gamma ================= */

/** sRGB 8bit 分量 → 线性 [0,1]。c 输入 0-255 */
export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 线性 [0,1] → sRGB 8bit 分量（0-255，未取整） */
export function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
}

/* ================= RGB ↔ XYZ（sRGB 矩阵，D65） ================= */

/** sRGB(0-255) → XYZ(D65, Y=1 归一) */
export function rgbToXyz(rgb: Rgb): Xyz {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
}

/** XYZ(D65) → sRGB(0-255)，结果可能越界（未 clamp） */
export function xyzToRgb(xyz: Xyz): Rgb {
  const [x, y, z] = xyz;
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

/* ================= XYZ ↔ Lab ================= */

function labF(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/** XYZ(D65) → Lab */
export function xyzToLab(xyz: Xyz): Lab {
  const fx = labF(xyz[0] / D65[0]);
  const fy = labF(xyz[1] / D65[1]);
  const fz = labF(xyz[2] / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Lab → XYZ(D65) */
export function labToXyz(lab: Lab): Xyz {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  // X/Z 分量按标准分段（fy 一定 ≥ 16/116，走线性支路时仍用 labFInv 统一处理）
  const xr = fx * fx * fx > EPS ? fx * fx * fx : (116 * fx - 16) / KAPPA;
  const yr = L > KAPPA * EPS ? Math.pow((L + 16) / 116, 3) : L / KAPPA;
  const zr = fz * fz * fz > EPS ? fz * fz * fz : (116 * fz - 16) / KAPPA;
  return [xr * D65[0], yr * D65[1], zr * D65[2]];
}

/* ================= RGB ↔ Lab 便捷组合 ================= */

/** sRGB(0-255) → Lab(D65) */
export function rgbToLab(rgb: Rgb): Lab {
  return xyzToLab(rgbToXyz(rgb));
}

/** Lab → sRGB(0-255)，含 gamut clamp（越界裁剪到 sRGB 立方体） */
export function labToRgb(lab: Lab): Rgb {
  return clampRgb(xyzToRgb(labToXyz(lab)));
}

/* ================= HSL ================= */

/** sRGB(0-255) → HSL（h:0-360, s/l:0-100） */
export function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [h, s * 100, l * 100];
}

/** HSL（h:0-360, s/l:0-100）→ sRGB(0-255) */
export function hslToRgb(hsl: Hsl): Rgb {
  const [hRaw, s, l] = hsl;
  const h = ((hRaw % 360) + 360) % 360;
  const ss = s / 100;
  const ll = l / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ll - c / 2;
  let seg: [number, number, number];
  if (h < 60) seg = [c, x, 0];
  else if (h < 120) seg = [x, c, 0];
  else if (h < 180) seg = [0, c, x];
  else if (h < 240) seg = [0, x, c];
  else if (h < 300) seg = [x, 0, c];
  else seg = [c, 0, x];
  return [(seg[0] + m) * 255, (seg[1] + m) * 255, (seg[2] + m) * 255];
}

/* ================= Lab ↔ LCh ================= */

/** Lab → LCh（h:0-360，C=0 时 h 定义为 0） */
export function labToLch(lab: Lab): Lch {
  const [L, a, b] = lab;
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}

/** LCh → Lab */
export function lchToLab(lch: Lch): Lab {
  const [L, C, h] = lch;
  const rad = (h * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}
