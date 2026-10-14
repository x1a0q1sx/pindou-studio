/**
 * themes/_paper.ts —— 纸纹背景生成（journal 主题专用）。
 * 用 SVG feTurbulence 生成 data-URI，零外部图片、离线可用。
 */

/** 生成细腻纸纹 data-URI（baseFrequency 越大颗粒越细） */
export function paperTextureDataUri(opts: {
  baseFrequency?: number;
  octaves?: number;
  inkColor?: string;
  inkOpacity?: number;
}): string {
  const baseFrequency = opts.baseFrequency ?? 0.82;
  const octaves = opts.octaves ?? 4;
  const inkColor = opts.inkColor ?? '#8a7a58';
  const inkOpacity = opts.inkOpacity ?? 0.05;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>` +
    `<filter id='p'><feTurbulence type='fractalNoise' baseFrequency='${baseFrequency}' numOctaves='${octaves}' stitchTiles='stitch'/>` +
    `<feColorMatrix type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.6 0.3 0.1 0 0'/></filter>` +
    `<rect width='240' height='240' fill='${inkColor}' fill-opacity='${inkOpacity}'/>` +
    `<rect width='240' height='240' filter='url(%23p)' opacity='0.5'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
