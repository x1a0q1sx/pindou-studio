/**
 * src/render/dirtyRect.ts —— 脏矩形管理（64×64 设备像素瓦片）。
 *
 * 把画布划分为固定大小瓦片网格，标记受影响的瓦片；consumeDirty() 返回去重后的
 * 脏瓦片列表，渲染器只重绘这些瓦片区域内的格子。
 * 合并重叠瓦片避免重复重绘，单格编辑 ≤2ms 的关键基础设施。
 */

/** 瓦片边长（设备像素） */
export const TILE_SIZE = 64;

export interface DirtyTile {
  /** 瓦片列索引 */
  tx: number;
  /** 瓦片行索引 */
  ty: number;
  /** 瓦片在画布中的像素矩形（设备像素域） */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * DirtyRectTracker —— 脏矩形追踪器。
 * 使用 Set<string> 存储已标记瓦片的 key，天然去重。
 */
export class DirtyRectTracker {
  private dirty = new Set<string>();
  /** 画布设备像素尺寸（用于裁剪越界瓦片） */
  private canvasW = 0;
  private canvasH = 0;

  /** 更新画布尺寸（resize 时调用） */
  setSize(w: number, h: number): void {
    this.canvasW = w;
    this.canvasH = h;
  }

  /** 标记一个设备像素矩形区域为脏 */
  markRectDirty(x0: number, y0: number, x1: number, y1: number): void {
    const txMin = Math.max(0, Math.floor(x0 / TILE_SIZE));
    const tyMin = Math.max(0, Math.floor(y0 / TILE_SIZE));
    const txMax = Math.floor(Math.max(0, x1 - 1) / TILE_SIZE);
    const tyMax = Math.floor(Math.max(0, y1 - 1) / TILE_SIZE);

    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        this.dirty.add(`${tx},${ty}`);
      }
    }
  }

  /**
   * 标记一个格子为脏（给定格子在设备像素域的矩形）。
   * 渲染器调用时传入 cellRect。
   */
  markCellDirty(cellX0: number, cellY0: number, cellX1: number, cellY1: number): void {
    this.markRectDirty(cellX0, cellY0, cellX1, cellY1);
  }

  /** 标记全部为脏（全量重绘） */
  markAllDirty(): void {
    if (this.canvasW <= 0 || this.canvasH <= 0) return;
    const txMax = Math.floor((this.canvasW - 1) / TILE_SIZE);
    const tyMax = Math.floor((this.canvasH - 1) / TILE_SIZE);
    for (let ty = 0; ty <= tyMax; ty++) {
      for (let tx = 0; tx <= txMax; tx++) {
        this.dirty.add(`${tx},${ty}`);
      }
    }
  }

  /** 消费脏瓦片列表（返回后清空） */
  consumeDirty(): DirtyTile[] {
    const tiles = this.peekDirty();
    this.dirty.clear();
    return tiles;
  }

  /** 查看脏瓦片列表（不清空） */
  peekDirty(): DirtyTile[] {
    if (this.dirty.size === 0) return [];
    const tiles: DirtyTile[] = [];
    for (const key of this.dirty) {
      const [txStr, tyStr] = key.split(',');
      const tx = Number(txStr);
      const ty = Number(tyStr);
      tiles.push({
        tx,
        ty,
        x0: tx * TILE_SIZE,
        y0: ty * TILE_SIZE,
        x1: Math.min((tx + 1) * TILE_SIZE, this.canvasW),
        y1: Math.min((ty + 1) * TILE_SIZE, this.canvasH),
      });
    }
    return tiles;
  }

  /** 是否有脏瓦片 */
  hasDirty(): boolean {
    return this.dirty.size > 0;
  }

  /** 脏瓦片数量（调试/性能统计） */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** 清空（不消费） */
  clear(): void {
    this.dirty.clear();
  }
}
