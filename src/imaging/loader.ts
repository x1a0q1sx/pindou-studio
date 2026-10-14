/**
 * src/imaging/loader.ts —— 图片文件加载/解码/RGBA 提取。
 *
 * 支持 createImageBitmap（优先）与 HTMLImageElement（降级），
 * OffscreenCanvas（优先）与普通 <canvas>（降级）提取 RGBA 数据。
 */

/* ==================== 常量 ==================== */

export const acceptedImageTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
] as const;

export const acceptedExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] as const;

/** 体积上限 32MB */
const MAX_FILE_SIZE = 32 * 1024 * 1024;

/* ==================== 类型 ==================== */

export interface LoadedSource {
  bitmap: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
}

export interface RgbaData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface FileValidation {
  valid: boolean;
  error?: string;
}

/** 把用户选择的图片文件读成 data URL（用于挂到项目素材中） */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('图片文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/** base64 dataUrl 的实际字节量（去前缀后按 4 字符 = 3 字节估算） */
function base64DataBytes(dataUrl: string): number {
  const idx = dataUrl.indexOf(',');
  const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

/** 降采样档位（最长边）与 JPEG 质量梯度：逐档尝试直到 ≤ 目标字节 */
const COMPRESS_MAX_SIDES = [2048, 1536, 1024, 768, 512];
const COMPRESS_QUALITIES = [0.85, 0.75, 0.6, 0.45];

/**
 * 把 dataUrl 压缩到 maxBytes 以内（源图素材入库用）：
 * 迭代降采样（最长边 2048→512）× JPEG 质量梯度（0.85→0.45），返回第一个 ≤maxBytes 的
 * JPEG dataUrl；全档位仍超限则返回最小档结果（尽力而为）。环境不支持 canvas → null。
 * 注意：JPEG 无透明通道，透明区会铺白底（素材用途可接受；图案数据不受影响）。
 */
export async function compressDataUrlToFit(dataUrl: string, maxBytes: number): Promise<string | null> {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  try {
    const src = await loadImageFromDataUrl(dataUrl);
    let best: string | null = null;
    for (const maxSide of COMPRESS_MAX_SIDES) {
      const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale));
      const h = Math.max(1, Math.round(src.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return best;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#ffffff'; // JPEG 无透明：铺白底防止透明区变黑
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src.bitmap, 0, 0, w, h);
      for (const q of COMPRESS_QUALITIES) {
        const out = canvas.toDataURL('image/jpeg', q);
        best = out;
        if (base64DataBytes(out) <= maxBytes) return out;
      }
      canvas.width = 0; // 及时释放位图内存
      canvas.height = 0;
    }
    return best;
  } catch {
    return null;
  }
}

/* ==================== 校验 ==================== */

/** 校验文件 MIME、扩展名与体积 */
export function validateFile(file: File): FileValidation {
  // 检查 MIME（浏览器可能给空字符串）
  const mime = file.type.toLowerCase();
  if (mime && !acceptedImageTypes.includes(mime as typeof acceptedImageTypes[number])) {
    return { valid: false, error: `不支持的图片格式「${mime}」，请上传 PNG / JPG / WebP / GIF / BMP 文件` };
  }

  // 检查扩展名
  const name = file.name.toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (ext && !acceptedExtensions.includes(ext as typeof acceptedExtensions[number])) {
    // 如果 MIME 也为空，则拒绝
    if (!mime) {
      return { valid: false, error: `不支持的文件扩展名「${ext}」，请上传图片文件（PNG/JPG/WebP/GIF/BMP）` };
    }
  }

  // 检查体积
  if (file.size > MAX_FILE_SIZE) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return { valid: false, error: `图片文件过大（${mb}MB），上限 32MB，请压缩后重试` };
  }

  if (file.size === 0) {
    return { valid: false, error: '文件为空，请选择有效的图片文件' };
  }

  return { valid: true };
}

/* ==================== 加载 ==================== */

/** 从 File 加载图片（createImageBitmap 优先，降级 HTMLImageElement） */
export async function loadImageFromFile(file: File): Promise<LoadedSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // createImageBitmap 失败（格式不支持等），降级
    }
  }
  // 降级：HTMLImageElement + Object URL
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    // 注意：不能立即 revoke，因为后续 toRgba 还要用
    // 调用方用完后自行处理（或 GC 回收）
  }
}

/** 从 DataURL 加载图片 */
export async function loadImageFromDataUrl(dataUrl: string): Promise<LoadedSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      return { bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // 降级
    }
  }
  const img = await loadImageElement(dataUrl);
  return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight };
}

/** 内部：加载 HTMLImageElement */
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败，文件可能已损坏'));
    img.src = src;
  });
}

/* ==================== RGBA 提取 ==================== */

/**
 * 将图片源转为 RGBA Uint8ClampedArray。
 * OffscreenCanvas 优先，降级普通 <canvas>。
 */
export function toRgba(source: ImageBitmap | HTMLImageElement, width: number, height: number): RgbaData {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      return { data: imageData.data, width, height };
    } catch {
      // OffscreenCanvas 失败，降级
    }
  }

  // 降级：普通 canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height };
}

/**
 * 提取源图片指定区域的 RGBA（用于裁剪后取样）。
 */
export function toRgbaRegion(
  source: ImageBitmap | HTMLImageElement,
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
): RgbaData {
  const w = Math.max(1, Math.round(srcW));
  const h = Math.max(1, Math.round(srcH));

  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(source as CanvasImageSource, srcX, srcY, srcW, srcH, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      return { data: imageData.data, width: w, height: h };
    } catch {
      // 降级
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source as CanvasImageSource, srcX, srcY, srcW, srcH, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  return { data: imageData.data, width: w, height: h };
}
