/**
 * src/imaging/cropRect.ts —— 裁剪选区（Crop Rect）纯几何。
 *
 * 【设计铁律】不含任何 DOM / React / Canvas / Worker API，
 * 只有普通对象 + 数学运算，可在 Node / Worker / 主线程无缝执行与单测。
 *
 * 两套坐标系：
 *   - `CropRect`           像素域，相对**源图**左上角，单位 = 源图像素。
 *   - `NormalizedCropRect` 归一化域，0..1，与源图尺寸无关（便于持久化 / 跨尺寸复用）。
 *
 * 手柄语义（`resizeWithAspectLock`）：
 *   - 四角 `nw/ne/se/sw`：把指针位移**投影到等比对角方向**解出宽度增量，
 *     锚点固定在对角，宽高比严格 = aspect（浮点误差 < 1e-12）。
 *   - 四边 `e/w`：**仅由 dx 驱动**（水平单轴），高度由 `h = w / aspect` 派生，
 *     垂直方向保持原矩形**中心线**不动（必要时钳制到边界）。
 *   - 四边 `n/s`：**仅由 dy 驱动**（垂直单轴），宽度由 `w = h * aspect` 派生，
 *     水平方向保持原矩形**中心线**不动（必要时钳制到边界）。
 *   - `move`：整体平移，尺寸完全不变，位置钳制在源图内。
 *
 * 优先级铁律：**不越界 > 最小尺寸 > 比例精度退化**。
 * 当源图小到装不下 `minSize × aspect` 的等比矩形时，以「不越界」为准，此时允许 `w` 或 `h` 小于 minSize。
 */

/* ==================== 类型 ==================== */

/** 像素域裁剪矩形（相对源图左上角，单位 = 源图像素） */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 归一化裁剪矩形（0..1，相对源图宽高） */
export interface NormalizedCropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 与 core/types 的 FitMode 结构一致（此处独立声明以保持零依赖） */
export type CropFitMode = 'cover' | 'contain' | 'stretch';

/** 8 个缩放手柄 + 整体平移 */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

/** 取整后的源像素矩形，可直接喂给 loader.ts 的 toRgbaRegion */
export interface SourcePixelRect {
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
}

/** 默认最小选区边长（源像素） */
export const DEFAULT_MIN_CROP_SIZE = 8;

/* ==================== 内部工具 ==================== */

function num(v: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** 源图宽高兜底为 ≥1 的有限数 */
function safeSize(srcW: number, srcH: number): [number, number] {
  return [Math.max(1, num(srcW, 1)), Math.max(1, num(srcH, 1))];
}

/** 比例兜底为 >0 的有限数 */
function safeAspect(aspect: number): number {
  const a = num(aspect, 1);
  return a > 0 ? a : 1;
}

/**
 * 等比缩放时「驱动轴」长度的上下界。
 *
 * @param min     最小边长（源像素）
 * @param a       驱动轴长度 L 与派生轴长度的关系：`derived = L / a`
 * @param W       驱动轴方向的源图边长上限
 * @param H       派生轴方向的源图边长上限
 * @param availW  驱动轴方向从锚点出发的可用空间
 * @param availH  派生轴方向从锚点出发的可用空间
 * @returns `[minL, maxL]`，保证 `minL <= maxL`，且取 maxL 时两轴都不越界。
 *
 * 语义：maxL 同时受「驱动轴可用空间」与「派生轴可用空间 / 比例」限制；
 * minL 同时保证两轴都 ≥ min，但当这与不越界冲突时**让位于不越界**。
 */
function widthBounds(
  min: number,
  a: number,
  W: number,
  H: number,
  availW: number,
  availH: number,
): [number, number] {
  const minW0 = Math.min(min, W);
  const minH0 = Math.min(min, H);
  // 上界严格由「不越界」给出，绝不被 minSize 抬高
  const maxL = Math.min(Math.max(0, availW), Math.max(0, availH) * a);
  // 下界：两轴都 ≥ min；与上界冲突时让位于上界（不越界优先）
  const minL = Math.min(Math.max(minW0, minH0 * a), maxL);
  return [minL, maxL];
}

/* ==================== 基础换算 ==================== */

/** cols × rows → 宽高比（非法输入回退 1） */
export function aspectOf(cols: number, rows: number): number {
  const c = num(cols, 0);
  const r = num(rows, 0);
  if (c <= 0 || r <= 0) return 1;
  return c / r;
}

/** 像素域 → 归一化域 */
export function toNormalized(rect: CropRect, srcW: number, srcH: number): NormalizedCropRect {
  const [W, H] = safeSize(srcW, srcH);
  return {
    x: num(rect.x, 0) / W,
    y: num(rect.y, 0) / H,
    w: num(rect.w, 0) / W,
    h: num(rect.h, 0) / H,
  };
}

/** 归一化域 → 像素域 */
export function fromNormalized(norm: NormalizedCropRect, srcW: number, srcH: number): CropRect {
  const [W, H] = safeSize(srcW, srcH);
  return {
    x: num(norm.x, 0) * W,
    y: num(norm.y, 0) * H,
    w: num(norm.w, 0) * W,
    h: num(norm.h, 0) * H,
  };
}

/* ==================== 钳制 ==================== */

/**
 * 把裁剪矩形钳制进源图边界，保证：
 *   `x >= 0 && y >= 0 && x + w <= srcW && y + h <= srcH && w,h >= min(minSize, 对应边长)`
 * 不会产生负宽高；NaN / Infinity 输入被替换为安全值。
 */
export function clampCropRect(
  rect: CropRect,
  srcW: number,
  srcH: number,
  minSize: number = DEFAULT_MIN_CROP_SIZE,
): CropRect {
  const [W, H] = safeSize(srcW, srcH);
  const minW = Math.min(Math.max(1, num(minSize, 1)), W);
  const minH = Math.min(Math.max(1, num(minSize, 1)), H);

  const w = clamp(num(rect.w, minW), minW, W);
  const h = clamp(num(rect.h, minH), minH, H);
  const x = clamp(num(rect.x, 0), 0, W - w);
  const y = clamp(num(rect.y, 0), 0, H - h);
  return { x, y, w, h };
}

/* ==================== 初始裁剪框 ==================== */

/**
 * 按目标比例生成初始裁剪框。
 * - `cover`   ：源图内**最大内接等比矩形**，居中（多余部分被裁掉）。
 * - `contain` ：等于全图，比例差由后续 `fitRect` 以「留白」方式处理。
 * - `stretch` ：等于全图，比例差由后续 `fitRect` 以「拉伸」方式处理。
 */
export function makeAspectLockedRect(
  srcW: number,
  srcH: number,
  aspect: number = 1,
  mode: CropFitMode = 'cover',
): CropRect {
  const [W, H] = safeSize(srcW, srcH);
  const a = safeAspect(aspect);

  if (mode === 'contain' || mode === 'stretch') {
    return { x: 0, y: 0, w: W, h: H };
  }

  const srcAspect = W / H;
  let w: number;
  let h: number;
  if (srcAspect > a) {
    // 源更宽 → 高度顶满，宽度按比例收窄
    h = H;
    w = H * a;
  } else {
    // 源更高（或恰好相等）→ 宽度顶满，高度按比例收窄
    w = W;
    h = W / a;
  }
  w = clamp(w, 1, W);
  h = clamp(h, 1, H);
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/* ==================== 等比缩放 / 平移 ==================== */

/**
 * 拖拽手柄缩放（等比锁定）或整体平移。
 *
 * @param rect    拖拽开始时的矩形（源像素域）
 * @param handle  8 个手柄之一，或 `'move'`
 * @param dx,dy   指针位移（**源像素域**，不是屏幕像素）
 * @param aspect  锁定比例 = cols / rows
 * @param srcW,srcH 源图尺寸
 * @param minSize 最小边长（源像素），默认 8
 *
 * 保证：输出宽高比严格 = aspect（四角/四边），且始终落在源图内，`w,h >= minSize`，
 * 反向拖拽（拖过对边）只会退化到最小尺寸，不产生负值、不抛异常。
 */
export function resizeWithAspectLock(
  rect: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  aspect: number,
  srcW: number,
  srcH: number,
  minSize: number = DEFAULT_MIN_CROP_SIZE,
): CropRect {
  const [W, H] = safeSize(srcW, srcH);
  const min = Math.max(1, num(minSize, DEFAULT_MIN_CROP_SIZE));
  const a = safeAspect(aspect);
  const ddx = num(dx, 0);
  const ddy = num(dy, 0);
  const base = clampCropRect(rect, W, H, min);

  /* ---- 整体平移 ---- */
  if (handle === 'move') {
    return {
      x: clamp(base.x + ddx, 0, Math.max(0, W - base.w)),
      y: clamp(base.y + ddy, 0, Math.max(0, H - base.h)),
      w: base.w,
      h: base.h,
    };
  }

  /* ---- 四角：投影到等比对角方向 ---- */
  if (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw') {
    const sx = handle === 'ne' || handle === 'se' ? 1 : -1;
    const sy = handle === 'sw' || handle === 'se' ? 1 : -1;

    // 锚点 = 被拖角的对角（固定不动）
    const ax = sx > 0 ? base.x : base.x + base.w;
    const ay = sy > 0 ? base.y : base.y + base.h;

    // 等比位移方向：宽度变化 t 时高度变化 t/a
    const vx = sx;
    const vy = sy / a;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? (ddx * vx + ddy * vy) / len2 : 0;

    const availW = sx > 0 ? W - ax : ax;
    const availH = sy > 0 ? H - ay : ay;
    const [minW, maxW] = widthBounds(min, a, W, H, availW, availH);

    const w = clamp(base.w + t, minW, maxW);
    const h = w / a;
    return {
      x: sx > 0 ? ax : ax - w,
      y: sy > 0 ? ay : ay - h,
      w,
      h,
    };
  }

  /* ---- 左右边：仅 dx 驱动，垂直居中 ---- */
  if (handle === 'e' || handle === 'w') {
    const sx = handle === 'e' ? 1 : -1;
    const ax = sx > 0 ? base.x : base.x + base.w;
    const cy = base.y + base.h / 2;

    const availW = sx > 0 ? W - ax : ax;
    const [minW, maxW] = widthBounds(min, a, W, H, availW, H);

    const w = clamp(base.w + sx * ddx, minW, maxW);
    const h = w / a;
    return {
      x: sx > 0 ? ax : ax - w,
      y: clamp(cy - h / 2, 0, Math.max(0, H - h)),
      w,
      h,
    };
  }

  /* ---- 上下边：仅 dy 驱动，水平居中 ---- */
  const sy = handle === 's' ? 1 : -1;
  const ay = sy > 0 ? base.y : base.y + base.h;
  const cx = base.x + base.w / 2;

  const availH = sy > 0 ? H - ay : ay;
  // 以「高」为驱动轴：等价于把宽度上下界换算成高度上下界
  const [minH, maxH] = widthBounds(min, 1 / a, H, W, availH, W);

  const h = clamp(base.h + sy * ddy, minH, maxH);
  const w = h * a;
  return {
    x: clamp(cx - w / 2, 0, Math.max(0, W - w)),
    y: sy > 0 ? ay : ay - h,
    w,
    h,
  };
}

/**
 * 自由比例缩放（「自由比例」开关打开时使用）。
 * 与 `resizeWithAspectLock` 同手柄语义，但**不锁定宽高比**：
 * 四角双向自由、四边单轴自由（`e/w` 只改宽度，`n/s` 只改高度，对边固定）。
 */
export function resizeFree(
  rect: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  srcW: number,
  srcH: number,
  minSize: number = DEFAULT_MIN_CROP_SIZE,
): CropRect {
  const [W, H] = safeSize(srcW, srcH);
  const min = Math.max(1, num(minSize, DEFAULT_MIN_CROP_SIZE));
  const ddx = num(dx, 0);
  const ddy = num(dy, 0);
  const base = clampCropRect(rect, W, H, min);

  if (handle === 'move') {
    return {
      x: clamp(base.x + ddx, 0, Math.max(0, W - base.w)),
      y: clamp(base.y + ddy, 0, Math.max(0, H - base.h)),
      w: base.w,
      h: base.h,
    };
  }

  const minW = Math.min(min, W);
  const minH = Math.min(min, H);
  let left = base.x;
  let top = base.y;
  let right = base.x + base.w;
  let bottom = base.y + base.h;

  if (handle === 'nw' || handle === 'w' || handle === 'sw') {
    left = clamp(base.x + ddx, 0, right - minW);
  }
  if (handle === 'ne' || handle === 'e' || handle === 'se') {
    right = clamp(right + ddx, left + minW, W);
  }
  if (handle === 'nw' || handle === 'n' || handle === 'ne') {
    top = clamp(base.y + ddy, 0, bottom - minH);
  }
  if (handle === 'sw' || handle === 's' || handle === 'se') {
    bottom = clamp(bottom + ddy, top + minH, H);
  }

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * 框外按下 → 重新框选：由两个源像素点生成矩形。
 * `aspect` 为 null 时自由比例；否则自动吸附到目标比例（取主轴较大者展开）。
 */
export function rectFromTwoPoints(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  aspect: number | null,
  srcW: number,
  srcH: number,
  minSize: number = DEFAULT_MIN_CROP_SIZE,
): CropRect {
  const [W, H] = safeSize(srcW, srcH);
  const min = Math.max(1, num(minSize, DEFAULT_MIN_CROP_SIZE));
  const x0 = num(ax, 0);
  const y0 = num(ay, 0);
  const x1 = num(bx, 0);
  const y1 = num(by, 0);

  let w = Math.abs(x1 - x0);
  let h = Math.abs(y1 - y0);

  if (aspect !== null) {
    const a = safeAspect(aspect);
    // 取「较大」的一轴作为主导，另一轴按比例派生
    if (h * a >= w) {
      w = h * a;
    } else {
      h = w / a;
    }
    if (w > W) { w = W; h = W / a; }
    if (h > H) { h = H; w = H * a; }
    const minW = Math.min(min, W);
    const minH = Math.min(min, H);
    if (w < minW || h < minH) {
      w = Math.max(minW, minH * a);
      h = w / a;
      if (w > W) { w = W; h = W / a; }
      if (h > H) { h = H; w = H * a; }
    }
  } else {
    w = Math.min(Math.max(w, Math.min(min, W)), W);
    h = Math.min(Math.max(h, Math.min(min, H)), H);
  }

  const x = x1 >= x0 ? x0 : x0 - w;
  const y = y1 >= y0 ? y0 : y0 - h;
  // minSize=1：只保证在界内且 ≥1px，不再二次放大（放大逻辑上面已按等比处理）
  return clampCropRect({ x, y, w, h }, W, H, 1);
}

/* ==================== 键盘微调 ==================== */

/**
 * 键盘微调：整体平移 dxPx/dyPx 源像素（1px，Shift=10px）。
 * **尺寸严格不变**，只钳制位置。
 */
export function nudge(rect: CropRect, dxPx: number, dyPx: number, srcW: number, srcH: number): CropRect {
  const [W, H] = safeSize(srcW, srcH);
  const w = clamp(num(rect.w, 1), 1, W);
  const h = clamp(num(rect.h, 1), 1, H);
  return {
    x: clamp(num(rect.x, 0) + num(dxPx, 0), 0, Math.max(0, W - w)),
    y: clamp(num(rect.y, 0) + num(dyPx, 0), 0, Math.max(0, H - h)),
    w,
    h,
  };
}

/* ==================== 输出到源像素 ==================== */

/**
 * 归一化选区 → 取整后的源像素矩形。
 * 保证：全部为整数、`srcX + srcW <= srcW`、`srcY + srcH <= srcH`、`srcW,srcH >= 1`，
 * 可直接喂给 `loader.ts` 的 `toRgbaRegion(source, srcX, srcY, srcW, srcH)`。
 */
export function cropRectToSourcePixels(
  norm: NormalizedCropRect,
  srcW: number,
  srcH: number,
): SourcePixelRect {
  const W = Math.max(1, Math.floor(num(srcW, 1)));
  const H = Math.max(1, Math.floor(num(srcH, 1)));

  const nx = clamp(num(norm.x, 0), 0, 1);
  const ny = clamp(num(norm.y, 0), 0, 1);
  const nx2 = clamp(nx + Math.max(0, num(norm.w, 0)), 0, 1);
  const ny2 = clamp(ny + Math.max(0, num(norm.h, 0)), 0, 1);

  const srcX = clamp(Math.round(nx * W), 0, W - 1);
  const srcY = clamp(Math.round(ny * H), 0, H - 1);
  const right = clamp(Math.round(nx2 * W), srcX + 1, W);
  const bottom = clamp(Math.round(ny2 * H), srcY + 1, H);

  return { srcX, srcY, srcW: right - srcX, srcH: bottom - srcY };
}

/**
 * 判断选区是否等于全图（用于跳过一次多余的 RGBA 提取 / 拷贝）。
 * `tolerance` 单位为源像素，默认 0.5（容忍归一化往返的亚像素误差）。
 */
export function isFullImage(
  rect: CropRect,
  srcW: number,
  srcH: number,
  tolerance: number = 0.5,
): boolean {
  const [W, H] = safeSize(srcW, srcH);
  const tol = Math.max(0, num(tolerance, 0));
  const r = clampCropRect(rect, W, H, 1);
  return r.x <= tol && r.y <= tol && W - (r.x + r.w) <= tol && H - (r.y + r.h) <= tol;
}
