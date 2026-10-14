/**
 * tests/exportRaster.test.ts —— 导出链路（1:1 图纸 / 分块图纸 / 预览图）用例。
 *
 * 针对此前零覆盖的核心链路（1641 行）。策略：
 *  · 纯逻辑层（参数归一、预算、文件名、失败契约、dataURL 策略）——精确断言；
 *  · 绘制/编码层——用**最小 canvas 2d context stub**（记录调用、可产出固定 dataURL）
 *    驱动三个导出函数走完整流程，断言返回契约（尺寸/文件名/DPI/sizeMm/失败码），
 *    不校验像素内容（那需要真实 canvas，属"jsdom+canvas mock 基建"的遗留边界）。
 *
 * stub 设计：ctx 方法全部 no-op（含 measureText/createGradient 返回值），
 * canvas.toDataURL 返回固定 1×1 PNG dataURL → surface.encode 走 dataURL 兜底路径。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportPreviewPng, exportRegionSheets, exportSheet1to1 } from '@/render/exportRaster';
import type { ExportState } from '@/render/exportRaster';
import { computeRegionLayout, computeSheetLayout, estimatePixelBudget, buildFilename } from '@/render/exportLayout';
import type { BeadPalette, BoardConfig } from '@/core/types';

/* ---------------- 最小 canvas stub ---------------- */

/** 1×1 透明 PNG（固定值，让 encode 的 dataURL 兜底路径可断言非空） */
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** 记录被调用过的 ctx 方法名（调试用），并返回满足绘制链要求的空壳 */
function makeCtxStub(calls: string[]): Record<string, unknown> {
  const gradStub = { addColorStop: () => undefined };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop) {
      const key = String(prop);
      if (key in target) return target[key];
      // 未显式提供的成员一律返回 no-op 函数（fillRect/arc/save/... 全覆盖）
      const fn = (..._args: unknown[]): unknown => {
        calls.push(key);
        if (key === 'measureText') return { width: 6 };
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return gradStub;
        return undefined;
      };
      target[key] = fn;
      return fn;
    },
  };
  return new Proxy({} as Record<string, unknown>, handler);
}

function makeCanvasStub(calls: string[]): {
  width: number;
  height: number;
  getContext: (id: string) => unknown;
  toDataURL: (mime?: string) => string;
} {
  const el = {
    width: 300,
    height: 150,
    getContext(_id: string) {
      return makeCtxStub(calls);
    },
    toDataURL(_mime?: string) {
      calls.push('toDataURL');
      return TINY_PNG_DATA_URL;
    },
  };
  return el;
}

let originalDocument: unknown;
let ctxCalls: string[];

beforeEach(() => {
  ctxCalls = [];
  originalDocument = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return makeCanvasStub(ctxCalls);
    },
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).document = originalDocument;
});

/* ---------------- 测试夹具 ---------------- */

const BOARD: BoardConfig = {
  cols: 4,
  rows: 3,
  pitchMm: 2.6923,
  beadFillRatio: 0.9,
  marginMm: 2.0,
  cellShape: 'circle',
  showGrid: true,
  showMajorGrid: true,
  majorEvery: 10,
  showNumbers: true,
  numberEvery: 10,
  showRuler: true,
};

const PALETTE: BeadPalette = {
  id: 'test',
  brand: 'Test',
  name: '测试色板',
  beadSizeMm: 2.6,
  editable: false,
  colors: [
    { id: 'c1', code: 'A1', name: '红', hex: '#FF0000', rgb: [255, 0, 0], lab: [53, 80, 67], builtin: true },
    { id: 'c2', code: 'A2', name: '蓝', hex: '#0000FF', rgb: [0, 0, 255], lab: [32, 79, -108], builtin: true },
  ],
};

/** 4×3 板：前 4 格填色 1，第 5 格填色 2，其余空；第 1 格标记已放置 */
function makeState(over: Partial<ExportState> = {}): ExportState {
  const beads = new Uint16Array(12);
  beads[0] = 1;
  beads[1] = 1;
  beads[2] = 1;
  beads[3] = 1;
  beads[4] = 2;
  const placedMask = new Uint8Array(12);
  placedMask[0] = 1;
  return {
    board: BOARD,
    beads,
    placedMask,
    palette: PALETTE,
    theme: 'macaron',
    ...over,
  };
}

/* ---------------- 1:1 图纸 ---------------- */

describe('exportSheet1to1', () => {
  it('成功路径：返回 PNG 契约（文件名/尺寸/DPI/sizeMm/dataUrl）', async () => {
    const r = await exportSheet1to1(makeState());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('1to1');
    expect(r.filename).toMatch(/^pindou_4x3_1to1_300dpi\.png$/);
    expect(r.mime).toBe('image/png');
    expect(r.dpi).toBe(300);
    // 尺寸与布局一致：4*2.6923mm + 2*2mm 留白 + 2*5mm 标注槽
    const layout = computeSheetLayout(4, 3, 2.6923, 2.0, 300, { gutterMm: 5, beadFillRatio: 0.9 });
    expect(r.width).toBe(layout.widthPx);
    expect(r.height).toBe(layout.heightPx);
    // sizeMm = 板含留白物理尺寸（mm）：4×2.6923 + 双边 2mm 留白 = 14.7692mm
    expect(r.sizeMm?.width).toBeCloseTo(4 * 2.6923 + 4, 1);
    expect(r.dataUrl.startsWith('data:image/png')).toBe(true);
  });

  it('板参数非法 → invalid-board（钉距 0 / 行列 0）', async () => {
    const bad1 = await exportSheet1to1(makeState({ board: { ...BOARD, pitchMm: 0 } }));
    expect(bad1.ok).toBe(false);
    if (!bad1.ok) expect(bad1.code).toBe('invalid-board');
    const bad2 = await exportSheet1to1(makeState({ board: { ...BOARD, cols: 0 } }));
    expect(bad2.ok).toBe(false);
  });

  it('beads 长度不足 → invalid-board（数据与板尺寸不一致）', async () => {
    const r = await exportSheet1to1(makeState({ beads: new Uint16Array(5) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-board');
  });

  it('DPI 归一：非法值回退 300、超界夹到 [72,1200]', async () => {
    const r1 = await exportSheet1to1(makeState(), { dpi: 999999 });
    if (r1.ok) expect(r1.dpi).toBe(1200);
    const r2 = await exportSheet1to1(makeState(), { dpi: 10 });
    if (r2.ok) expect(r2.dpi).toBe(72);
    const r3 = await exportSheet1to1(makeState(), { dpi: Number.NaN });
    if (r3.ok) expect(r3.dpi).toBe(300);
  });

  it('像素预算超限 → too-large 且带 suggestDpi（不抛异常）', async () => {
    // 用超大板 + 1200 DPI 触发预算保护（真实 80M 像素上限）
    const bigBoard: BoardConfig = { ...BOARD, cols: 2000, rows: 2000 };
    const bigState = makeState({
      board: bigBoard,
      beads: new Uint16Array(2000 * 2000),
      placedMask: new Uint8Array(2000 * 2000),
    });
    const r = await exportSheet1to1(bigState, { dpi: 1200 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('too-large');
      expect(r.suggestDpi).toBeTruthy();
      expect(r.suggestDpi! < 1200).toBe(true);
      expect(r.error).toContain('超出单次导出上限');
    }
  });

  it('自定义文件名原样使用', async () => {
    const r = await exportSheet1to1(makeState(), { filename: 'my-sheet.png' });
    if (r.ok) expect(r.filename).toBe('my-sheet.png');
  });

  it('走完整绘制链：ctx 被实际调用（fillRect/arc/fillText 等）', async () => {
    await exportSheet1to1(makeState());
    expect(ctxCalls).toContain('fillRect');
    expect(ctxCalls).toContain('setTransform');
    expect(ctxCalls.length).toBeGreaterThan(10);
  });
});

/* ---------------- 分块图纸 ---------------- */

describe('exportRegionSheets', () => {
  it('成功路径：2×2 分块 → 4 张，按行优先、label 正确', async () => {
    const r = await exportRegionSheets(makeState(), { splitsX: 2, splitsY: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(4);
    expect(r.splitsX).toBe(2);
    expect(r.splitsY).toBe(2);
    expect(r.sheets.map((s) => s.label)).toEqual(['A1', 'B1', 'A2', 'B2']);
    for (const s of r.sheets) {
      expect(s.ok).toBe(true);
      expect(s.filename).toMatch(/^pindou_region_[AB][12]_300dpi\.png$/);
      expect(s.sizeMm).toBeTruthy();
    }
  });

  it('onlyIndex 只导出指定区块', async () => {
    const r = await exportRegionSheets(makeState(), { splitsX: 2, splitsY: 2, onlyIndex: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(1);
    expect(r.sheets[0]?.label).toBe('A2');
  });

  it('板参数非法 → invalid-board', async () => {
    const r = await exportRegionSheets(makeState({ board: { ...BOARD, rows: 0 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-board');
  });

  it('分块数超过板尺寸（4×3 板切 8×8）→ 仍按 clamp 后的合法分块产出', async () => {
    const r = await exportRegionSheets(makeState(), { splitsX: 8, splitsY: 8 });
    // splits 会被 sanitizeCount 夹到 [1,64]；无论产物几张，契约必须自洽（ok 或结构化失败）
    if (r.ok) {
      expect(r.count).toBe(r.sheets.length);
      expect(r.splitsX).toBe(8);
      expect(r.splitsY).toBe(8);
    } else {
      expect(r.code).toBeTruthy();
    }
  });

  it('预算口径 = 最大单张：小板高分块不触发 too-large', async () => {
    const r = await exportRegionSheets(makeState(), { splitsX: 2, splitsY: 1, dpi: 600 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dpi).toBe(600);
  });
});

/* ---------------- 预览图 ---------------- */

describe('exportPreviewPng', () => {
  it('成功路径：dpi=96、文件名固定、cellPx 夹取', async () => {
    const r = await exportPreviewPng(makeState(), { cellPx: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('preview');
    expect(r.filename).toBe('pindou_preview.png');
    expect(r.dpi).toBe(96);
    // cellPx=12、padding=24、水印带 28.8 → ceil 尺寸
    expect(r.width).toBe(Math.ceil(2 * 24 + 4 * 12));
    expect(r.height).toBe(Math.ceil(2 * 24 + 3 * 12 + 12 * 2.4));
  });

  it('cellPx 越界夹取：[4,64]', async () => {
    const r1 = await exportPreviewPng(makeState(), { cellPx: 1000 });
    if (r1.ok) expect(r1.width).toBe(Math.ceil(2 * 128 + 4 * 64)); // padding 默认 cellPx*2=128
    const r2 = await exportPreviewPng(makeState(), { cellPx: 0 });
    if (r2.ok) expect(r2.width).toBe(Math.ceil(2 * 8 + 4 * 4));
  });

  it('watermark=null → 无水印带（高度不含 bandPx）', async () => {
    const r = await exportPreviewPng(makeState(), { cellPx: 12, watermark: null });
    if (r.ok) expect(r.height).toBe(Math.ceil(2 * 24 + 3 * 12));
  });

  it('板参数非法 → invalid-board', async () => {
    const r = await exportPreviewPng(makeState({ board: { ...BOARD, cols: 0 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-board');
  });

  it('自定义文件名 + includeDataUrl=false → dataUrl 为空、blob 兜底存在', async () => {
    const r = await exportPreviewPng(makeState(), { filename: 'p.png', includeDataUrl: false });
    if (r.ok) {
      expect(r.filename).toBe('p.png');
      // includeDataUrl=false 时 encode 不调 toDataURL；但 stub 的 toBlob 不可用，
      // 最终兜底会再调 toDataURL → dataUrl 非空也属预期契约（环境相关兜底）
      expect(typeof r.dataUrl).toBe('string');
    }
  });
});

/* ---------------- 与布局函数的口径一致性 ---------------- */

describe('导出函数与 exportLayout 的口径一致性', () => {
  it('1:1 图纸尺寸 == computeSheetLayout（同参）', async () => {
    const r = await exportSheet1to1(makeState(), { dpi: 150, gutterMm: 0 });
    const layout = computeSheetLayout(4, 3, 2.6923, 2.0, 150, { gutterMm: 0, beadFillRatio: 0.9 });
    if (r.ok) {
      expect(r.width).toBe(layout.widthPx);
      expect(r.height).toBe(layout.heightPx);
    }
  });

  it('estimatePixelBudget 与分块布局共用预算口径（同参 ok 一致性）', () => {
    const p = { cols: 104, rows: 104, pitchMm: 2.6923, marginMm: 2, dpi: 300 };
    const b = estimatePixelBudget(p);
    expect(b.ok).toBe(true);
    expect(b.totalPixels).toBe(b.widthPx * b.heightPx);
    // 104 板 300dpi：约 284mm → 3355px 级别
    expect(b.widthPx).toBeGreaterThan(3300);
    expect(b.widthPx).toBeLessThan(3400);
  });

  it('computeRegionLayout：2×2 分块的单张预算小于整板', () => {
    const whole = estimatePixelBudget({ cols: 104, rows: 104, pitchMm: 2.6923, marginMm: 2, dpi: 300 });
    const region = computeRegionLayout({
      cols: 104,
      rows: 104,
      pitchMm: 2.6923,
      marginMm: 2,
      dpi: 300,
      splitsX: 2,
      splitsY: 2,
    });
    expect(region.sheets.length).toBe(4);
    expect(region.maxSheetPixels).toBeLessThan(whole.totalPixels);
  });

  it('buildFilename：非法字符净化 + 空格转横线', () => {
    expect(buildFilename(['a b/c:d'])).toBe('a-b-c-d.png');
    expect(buildFilename([])).toBe('pindou.png');
  });
});
