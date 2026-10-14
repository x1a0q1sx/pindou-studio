/**
 * tests/vbStore.test.ts —— 虚拟板旁路状态与「画布点亮」开关的 store 行为用例。
 * 覆盖 setVbStatus/setVbProg 状态上浮（对话框 onEvent → 设计模式小窗）、
 * setVbCanvasOn 开关的档位快照/还原、setVbLight(null) 的联动还原
 * （对话框 / 拼豆顶栏 chip / 小窗三处清除共用同一入口）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { usePdbStore } from '@/store';
import type { VbLightPattern } from '@/core/types';

function fakePattern(): VbLightPattern {
  const mask = new Uint8Array([1, 0, 0, 1]);
  const rgba = new Uint8ClampedArray(16);
  rgba.set([255, 0, 0, 255], 0);
  rgba.set([0, 255, 0, 255], 12);
  return { w: 2, h: 2, mask, rgba, count: 2 };
}

describe('虚拟板旁路状态与画布点亮开关', () => {
  beforeEach(() => {
    const s = usePdbStore.getState();
    s.setVbLight(null);
    s.setVbCanvasOn(false);
    s.setVbStatus(false, false, null);
    s.setFilter(-1, 'off');
  });

  it('setVbStatus/setVbProg：旁路状态上浮到 store', () => {
    usePdbStore.getState().setVbStatus(true, false, null);
    expect(usePdbStore.getState().vbRunning).toBe(true);
    expect(usePdbStore.getState().vbConnected).toBe(false);
    usePdbStore.getState().setVbProg('节目下发中… 180/573B');
    expect(usePdbStore.getState().vbProg).toBe('节目下发中… 180/573B');
    usePdbStore.getState().setVbStatus(true, true, null);
    const s = usePdbStore.getState();
    expect(s.vbConnected).toBe(true);
    expect(s.vbProg).toBeNull(); // setVbStatus 传 null 即清进度
  });

  it('setVbCanvasOn(true)：切 panel 档并记快照；false 还原；重复开不覆盖快照', () => {
    usePdbStore.getState().setFilter(3, 'dim');
    usePdbStore.getState().setVbCanvasOn(true);
    let s = usePdbStore.getState();
    expect(s.filterMode).toBe('panel');
    expect(s.vbCanvasOn).toBe(true);
    expect(s.vbFilterPrev).toBe('dim');

    usePdbStore.getState().setVbCanvasOn(true); // 已是 panel：快照保持不动
    expect(usePdbStore.getState().vbFilterPrev).toBe('dim');

    usePdbStore.getState().setVbCanvasOn(false);
    s = usePdbStore.getState();
    expect(s.filterMode).toBe('dim');
    expect(s.vbCanvasOn).toBe(false);
    expect(s.vbFilterPrev).toBeNull();
  });

  it('setVbLight(null) 联动关掉画布点亮并还原档位（设计模式清除场景）', () => {
    const s = usePdbStore.getState();
    s.setFilter(1, 'only');
    s.setVbCanvasOn(true);
    s.setVbLight(fakePattern());
    expect(usePdbStore.getState().filterMode).toBe('panel');

    usePdbStore.getState().setVbLight(null);
    const after = usePdbStore.getState();
    expect(after.vbLight).toBeNull();
    expect(after.vbCanvasOn).toBe(false);
    expect(after.filterMode).toBe('only'); // 还原到开点亮前的档位
  });

  it('setVbLight(null) 未开画布点亮 → 不动档位（拼豆模式顶栏清除场景）', () => {
    const s = usePdbStore.getState();
    s.setFilter(2, 'panel'); // 拼豆模式自己的 panel（非 vbCanvasOn 来源，vbFilterPrev=null）
    s.setVbLight(fakePattern());
    usePdbStore.getState().setVbLight(null);
    const after = usePdbStore.getState();
    expect(after.filterMode).toBe('panel');
    expect(after.vbCanvasOn).toBe(false);
    expect(after.vbFilterPrev).toBeNull();
  });
});
