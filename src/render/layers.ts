/**
 * src/render/layers.ts —— 四层离屏缓存系统。
 *
 * | 层 | 内容 | 重绘时机 |
 * |---|---|---|
 * | L0 网格层 | 画布底色、板边轮廓、网格线、主线、行列编号、标尺底 | 板参数/主题/视口/校准变化 |
 * | L1 豆点层 | 全部已填色豆点、placedMask 标记 | beadsVersion 变化（脏矩形局部）/ 视口变化 |
 * | L2 筛选层 | 颜色筛选蒙版 | filterColorIndex/filterMode/beadsVersion 变化 |
 * | L3 交互层 | 悬停高亮、光标环、选区、分区括标、原点十字 | 每次指针移动 |
 *
 * 每层一个离屏 canvas，backing store = CSS尺寸 × min(dpr, 2)。
 * 缓存尺寸 = 视口 + 30% overscan 边距。注意：各层内容的绘制域是**视口 0-based 区**
 * （blit 源矩形恒为 (0,0,devW,devH)，#18 约定），overscan 部分只是画布分配预留、其上无
 * 内容；手势期的平移/缩放由 renderer.blitLayers 的仿射差量变换完成，露白由主题底色铺底
 * 兜底（#24）。
 */

export type LayerId = 0 | 1 | 2 | 3;

export interface LayerEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** 当前缓存的设备像素宽 */
  width: number;
  /** 当前缓存的设备像素高 */
  height: number;
  /** 是否已失效需要重绘 */
  dirty: boolean;
  /** true=全量重绘, false=仅脏瓦片局部重绘 */
  fullDirty: boolean;
}

/** DPR 封顶 2（防止 4K 屏内存暴涨） */
export function clampDpr(dpr: number): number {
  return Math.min(2, Math.max(1, dpr));
}

/** overscan 比例：30%（每侧 15%） */
const OVERSCAN = 0.30;

/**
 * LayerSystem —— 管理四层离屏 canvas。
 */
export class LayerSystem {
  private layers: LayerEntry[] = [];
  private _dpr = 1;
  private _cssW = 0;
  private _cssH = 0;

  constructor() {
    for (let i = 0; i < 4; i++) {
      const canvas = document.createElement('canvas');
      // 【缺陷 #1 修复：画布恒为全黑】只有 L0 保留 alpha:false 不透明上下文——drawL0 会先用
      // 底色 fillRect 完整覆盖 blit 源区域 (0,0,devW,devH)，不透明没有副作用（合成也更快）。
      // L1/L2/L3 必须使用 alpha:true 透明上下文：在 alpha:false 上下文上 clearRect 会把整层
      // 涂成不透明黑，blit 叠加时黑层直接盖住 L0 网格与 L1 豆点（任何主题下画布恒为全黑）。
      // L1 豆点、L2 筛选蒙版（filter 关闭时整层必须保持透明）、L3 交互高亮均为
      // 「透明底 + 局部内容」的合成语义，必须保留 alpha 通道。
      // alpha 属性仅在 getContext 时固定一次，与 resize/DPR clamp/overscan 30% 逻辑无交互。
      const ctx = canvas.getContext('2d', { alpha: i !== 0 })!;
      this.layers.push({ canvas, ctx, width: 0, height: 0, dirty: true, fullDirty: true });
    }
  }

  get dpr(): number { return this._dpr; }

  /** 获取指定层 */
  getLayer(id: LayerId): LayerEntry {
    return this.layers[id]!;
  }

  /** 标记某层完全失效（全量重绘） */
  invalidate(id: LayerId): void {
    const l = this.layers[id]!;
    l.dirty = true;
    l.fullDirty = true;
  }

  /**
   * 标记某层部分失效（仅脏瓦片局部重绘）。
   *
   * 【缺口 7 修复】render() 每次绘制后把 `fullDirty` 复位为 true（默认「下次失效走全量」），
   *   旧实现只置 `dirty=true` 却从不把 `fullDirty` 写回 false，导致 drawL1Partial/drawL2Partial
   *   局部路径永远进不去、单格编辑退化成 10816 格全量重绘。这里显式置 `fullDirty=false`。
   * 【全量吞并守卫】若该层已有「全量重绘」待处理（dirty && fullDirty，通常来自 view/主题/校准
   *   变化的 invalidate），局部脏被其吞并，绝不下调为局部——否则会漏绘整板位移。
   */
  invalidatePartial(id: LayerId): void {
    const l = this.layers[id]!;
    if (l.dirty && l.fullDirty) return; // 已有全量待处理，局部脏被吞并
    l.dirty = true;
    l.fullDirty = false; // 关键：走 drawL1Partial / drawL2Partial 局部路径
  }

  /** 标记全部层失效 */
  invalidateAll(): void {
    for (const l of this.layers) { l.dirty = true; l.fullDirty = true; }
  }

  /**
   * 调整所有层的尺寸。
   * @param cssW 画布 CSS 宽
   * @param cssH 画布 CSS 高
   * @param dpr 设备像素比（原始值，内部 clamp）
   */
  resize(cssW: number, cssH: number, dpr: number): void {
    const clampedDpr = clampDpr(dpr);
    const overscanW = Math.ceil(cssW * OVERSCAN);
    const overscanH = Math.ceil(cssH * OVERSCAN);
    const totalCssW = cssW + overscanW;
    const totalCssH = cssH + overscanH;
    const devW = Math.round(totalCssW * clampedDpr);
    const devH = Math.round(totalCssH * clampedDpr);

    const sizeChanged = devW !== this.layers[0]!.width || devH !== this.layers[0]!.height;
    this._dpr = clampedDpr;
    this._cssW = cssW;
    this._cssH = cssH;

    if (sizeChanged) {
      for (const layer of this.layers) {
        if (layer.width !== devW || layer.height !== devH) {
          layer.canvas.width = devW;
          layer.canvas.height = devH;
          layer.width = devW;
          layer.height = devH;
          layer.dirty = true;
          layer.fullDirty = true;
        }
      }
    }
  }

  /** 视口对应的设备像素尺寸（不含 overscan） */
  get viewportDevW(): number {
    return Math.round(this._cssW * this._dpr);
  }
  get viewportDevH(): number {
    return Math.round(this._cssH * this._dpr);
  }

  /** 释放所有引用（防内存泄漏） */
  dispose(): void {
    for (const layer of this.layers) {
      layer.canvas.width = 0;
      layer.canvas.height = 0;
      layer.width = 0;
      layer.height = 0;
    }
    this.layers = [];
  }
}
