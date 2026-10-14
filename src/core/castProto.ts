/**
 * core/castProto.ts —— 手机投图协议层的纯函数（零 DOM，可单测）。
 * dataUrl 白名单校验、解码为 File、图 B 自动导入的默认配色参数。
 */

/** dataUrl 白名单：仅常见位图 mime + base64 载荷 */
export const CAST_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;

/** 解码上限（与主进程 9MB 体上限对应，base64 膨胀 4/3 → 约 6.7MB 字节） */
export const CAST_MAX_BYTES = 7 * 1024 * 1024;

/** dataUrl → 字节；非法/超限返回 null（泛型参数固定为 ArrayBuffer，可直接进 File/Blob） */
export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> | null {
  if (typeof dataUrl !== 'string' || !CAST_DATA_URL_RE.test(dataUrl)) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  try {
    const bin = atob(dataUrl.slice(comma + 1).replace(/\s/g, ''));
    if (bin.length === 0 || bin.length > CAST_MAX_BYTES) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null; // bad base64
  }
}

/** dataUrl → File（喂给导入管线的契约入参）；非法返回 null */
export function dataUrlToFile(dataUrl: string, name: string, mime: string): File | null {
  const bytes = dataUrlToBytes(dataUrl);
  if (!bytes) return null;
  // 消毒：路径/保留字符 → 下划线；连续点折叠（防 '.._.._etc' 这类残留穿越片段）
  const safeName = (name || '手机图片.png')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 120);
  return new File([bytes], safeName, { type: mime || 'image/png' });
}

/** dataUrl 的字节数（校验前粗算：base64 长度 ×3/4） */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

/** 图 B 自动导入（手机投图直进对照屏）的配色默认：与桌面导入默认值同档 */
export const CAST_B_REDUCE = {
  colorCount: 32,
  dither: false,
  fewColorExact: true,
  despeckle: true,
  mergeSimilarColors: true,
  kmeansRefine: true,
  chromaGate: true,
  highlightProtect: true,
  paletteDedup: true,
} as const;
