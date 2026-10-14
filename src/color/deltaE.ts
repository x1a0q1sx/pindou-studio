/**
 * color/deltaE.ts —— 色差计算（纯函数）。
 *
 * - CIE76：欧氏距离，|ΔE*ab| = sqrt(ΔL² + Δa² + Δb²)
 * - CIEDE2000：严格按 Sharma, Wu & Dalal (2005) "The CIEDE2000 Color-Difference
 *   Formula: Implementation Notes, Supplementary Test Data, and Mathematical
 *   Observations" 实现，kL = kC = kH = 1。
 *   要点：C' 用 ab 均值、h' 的 360° 环绕（|h1'-h2'| > 180 时 ±360）、
 *   C1'C2' = 0 时 h 差视为 0、h̄ 在 |h1'-h2'| ≤ 180 取均值否则 ±360、
 *   Δθ = 30·exp(-((h̄-275)/25)²)、Rt = -sin(2Δθ)·Rc。
 */
import type { Lab } from './convert';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** CIE76 色差（欧氏距离） */
export function deltaE76(lab1: Lab, lab2: Lab): number {
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * CIEDE2000 色差（kL=kC=kH=1）。
 * 完整标准公式：L'/C'/h' → ΔL'/ΔC'/ΔH' → SL/SC/SH → T → Δθ → Rc → Rt。
 */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  // Step 1: C'ab, h'ab（式 1-3）
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7 = 6103515625
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);

  // Step 2: ΔL', ΔC', ΔH'（式 4-6；C1'C2'=0 时 Δh'=0）
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);

  // Step 3: 加权函数 SL/SC/SH/T/Rc/Rt（式 7-11）
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) {
    hbp = h1p + h2p; // Sharma 注：此时 h̄ 未定义，直接取和（等价处理）
  } else {
    hbp = h1p + h2p;
    if (Math.abs(h1p - h2p) > 180) {
      hbp += h1p + h2p < 360 ? 360 : -360;
    }
    hbp /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * RAD) +
    0.24 * Math.cos(2 * hbp * RAD) +
    0.32 * Math.cos((3 * hbp + 6) * RAD) -
    0.2 * Math.cos((4 * hbp - 63) * RAD);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625));
  const Lbp50sq = (Lbp - 50) * (Lbp - 50);
  const Sl = 1 + (0.015 * Lbp50sq) / Math.sqrt(20 + Lbp50sq);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;

  // Step 4: 最终色差（式 12，kL=kC=kH=1）
  const tL = dLp / Sl;
  const tC = dCp / Sc;
  const tH = dHp / Sh;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + Rt * tC * tH);
}

/** h' = atan2(b, a')，取 [0, 360)；a'=b=0（无彩/L'=0 边界）时 h' 定义为 0 */
function hueAngle(b: number, ap: number): number {
  if (ap === 0 && b === 0) return 0;
  let h = Math.atan2(b, ap) * DEG;
  if (h < 0) h += 360;
  return h;
}
