import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellIndex } from '@/core/board';
import {
  applyDiff,
  applyLine,
  clearAll,
  countValues,
  fillConnectedRegion,
  preStateFromDiff,
  replaceAllOfColor,
  setCell,
} from '@/core/editOps';
import {
  projectFromText,
  projectToText,
  serializeProject,
} from '@/io/project';
import {
  computeUsage,
  exportPlacementTxt,
  type ExportSource,
} from '@/io/exporters';
import { mapPaletteColors } from '@/color/match';
import {
  buildFilename,
  computeSheetLayout,
} from '@/render/exportLayout';
import type { BeadColor, BeadPalette, BoardConfig } from '@/core/types';

test('cellIndex 使用统一的行列参数', () => {
  assert.equal(cellIndex(0, 0, 5), 0);
  assert.equal(cellIndex(1, 2, 5), 7);
  assert.equal(cellIndex(3, 4, 5), 19);
});

test('绘制原语写入并生成稀疏 diff', () => {
  const beads = new Uint16Array(20);
  const line = applyLine(beads, 5, 4, { col: 0, row: 1 }, { col: 4, row: 1 }, 3);
  assert.equal(line.length, 5);
  assert.equal(beads[5], 3);
  assert.equal(beads[9], 3);

  const one = setCell(beads, 5, 4, 2, 2, 7);
  assert.equal(one.length, 1);
  assert.equal(beads[12], 7);
  assert.deepEqual(one[0], { i: 12, prev: 0, next: 7 });

  const replaced = replaceAllOfColor(beads, 5, 4, 3, 8);
  assert.equal(replaced.length, 5);
  assert.equal(beads[5], 8);
  assert.equal(beads[9], 8);

  const cleared = clearAll(beads);
  assert.equal(cleared.length, 6);
  assert.equal(countValues(beads).get(0), 20);
});

test('连通填充不会递归爆栈且只填充同色区域', () => {
  const beads = new Uint16Array(5 * 5);
  beads[1] = 1;
  beads[2] = 1;
  beads[6] = 1;
  beads[7] = 1;
  const diff = fillConnectedRegion(beads, 5, 5, 1, 1, 9);
  assert.equal(diff.length, 4);
  assert.equal(beads[1], 9);
  assert.equal(beads[6], 9);
  assert.equal(beads[0], 0);
});

test('diff 可以精确还原改前状态', () => {
  const beads = new Uint16Array(8);
  const d1 = applyLine(beads, 4, 2, { col: 0, row: 0 }, { col: 3, row: 0 }, 2);
  const before = preStateFromDiff(beads, d1);
  assert.equal(before[0], 0);
  assert.equal(before[3], 0);
  applyDiff(beads, d1, 'undo');
  assert.equal(beads[0], 0);
  assert.equal(beads[3], 0);
  applyDiff(beads, d1, 'redo');
  assert.equal(beads[0], 2);
  assert.equal(beads[3], 2);
});

test('项目文件序列化往返保持图案与已放置标记', () => {
  const board: BoardConfig = {
    cols: 4,
    rows: 3,
    pitchMm: 2.6923,
    beadFillRatio: 0.9,
    marginMm: 2,
    cellShape: 'circle',
    showGrid: true,
    showMajorGrid: true,
    majorEvery: 10,
    showNumbers: true,
    numberEvery: 10,
    showRuler: true,
  };
  const palette: BeadPalette = {
    id: 'test',
    brand: '测试',
    name: '测试色板',
    beadSizeMm: 2.6,
    editable: true,
    colors: [
      {
        id: 'c1',
        code: 'C1',
        name: 'Black',
        nameZh: '黑',
        hex: '#000000',
        rgb: [0, 0, 0],
        lab: [0, 0, 0],
        builtin: true,
      },
    ],
  };
  const beads = new Uint16Array(12).fill(1);
  beads[3] = 0;
  const placedMask = new Uint8Array(12);
  placedMask[1] = 1;
  placedMask[4] = 1;

  const project = serializeProject({
    board,
    beads,
    placedMask,
    palette,
    paletteId: 'test',
    paletteCustomized: false,
    meta: { name: '往返测试' },
    sourceImage: {
      name: 'sample.png',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    },
  });
  const parsed = projectFromText(projectToText(project));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.project.board.cols, 4);
  assert.equal(parsed.project.board.rows, 3);
  assert.equal(parsed.project.sourceImage?.name, 'sample.png');
  assert.equal(parsed.project.meta.name, '往返测试');
});

test('导出统计与分色施工图包含必要坐标', () => {
  const board: BoardConfig = {
    cols: 2,
    rows: 2,
    pitchMm: 2.6923,
    beadFillRatio: 0.9,
    marginMm: 2,
    cellShape: 'circle',
    showGrid: true,
    showMajorGrid: true,
    majorEvery: 10,
    showNumbers: true,
    numberEvery: 10,
    showRuler: true,
  };
  const palette: BeadPalette = {
    id: 'test',
    brand: '测试',
    name: '测试色板',
    beadSizeMm: 2.6,
    editable: true,
    colors: [
      {
        id: 'c1',
        code: 'C1',
        name: 'Red',
        nameZh: '红',
        hex: '#FF0000',
        rgb: [255, 0, 0],
        lab: [53.2, 80.1, 67.2],
        builtin: true,
      },
    ],
  };
  const state: ExportSource = {
    board,
    beads: new Uint16Array([1, 1, 0, 1]),
    placedMask: new Uint8Array([0, 1, 0, 0]),
    palette,
    meta: { name: '施工图' },
  };
  const usage = computeUsage(state);
  assert.equal(usage.board.filled, 3);
  assert.equal(usage.board.placed, 1);
  assert.equal(usage.list[0]?.total, 3);
  assert.equal(usage.list[0]?.remaining, 2);

  const txt = exportPlacementTxt(state);
  assert.match(txt.text, /2 列 × 2 行/);
  assert.match(txt.text, /\(1,1\)/);
  assert.match(txt.text, /\(2,2\)/);
});

test('导出图纸布局保持浮点累计精度', () => {
  const layout = computeSheetLayout(104, 104, 2.6923, 2, 300, { gutterMm: 5 });
  assert.equal(layout.cellLeftAbs(104), layout.originX + layout.areaWidthPx);
  assert.equal(buildFilename(['a', 'b']), 'a_b.png');
});

test('色板切换生成旧色到新色的最近色映射', () => {
  const source: BeadColor[] = [
    { id: 'r', code: 'R', name: 'Red', hex: '#FF0000', rgb: [255, 0, 0], lab: [53.2, 80.1, 67.2], builtin: true },
    { id: 'b', code: 'B', name: 'Blue', hex: '#0000FF', rgb: [0, 0, 255], lab: [32.3, 79.2, -107.9], builtin: true },
  ];
  const target: BeadPalette = {
    id: 'target',
    brand: '测试',
    name: '目标色板',
    beadSizeMm: 2.6,
    editable: true,
    colors: [
      { id: 'r2', code: 'R2', name: 'Red 2', hex: '#FF1111', rgb: [255, 17, 17], lab: [53.3, 78.4, 63.1], builtin: true },
      { id: 'g', code: 'G', name: 'Green', hex: '#00FF00', rgb: [0, 255, 0], lab: [87.7, -86.2, 83.2], builtin: true },
      { id: 'b2', code: 'B2', name: 'Blue 2', hex: '#1111FF', rgb: [17, 17, 255], lab: [32.3, 79.2, -107.9], builtin: true },
    ],
  };
  const remap = mapPaletteColors(source, target);
  assert.equal(remap.get(0), 0);
  assert.equal(remap.get(1), 2);
});
