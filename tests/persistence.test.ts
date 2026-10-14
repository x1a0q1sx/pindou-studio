/**
 * tests/persistence.test.ts —— 自动保存/恢复单元测试（最高危缺口：
 * persistence.ts 879 行零测试，自动保存/恢复=丢数据高危区）。
 *
 * 环境手法（node 环境无 DOM/Electron）：
 *  · `vi.stubGlobal('localStorage', fakeLs)` 提供最小 Storage；
 *  · `vi.mock('@/io/bridge')` 关掉 Electron 分支（isElectron=false，浏览器降级路径）；
 *  · **每个用例 `vi.resetModules()` 后动态 import**：persistence 有模块级单例状态
 *    （stopAutoSave / restoreDecisionResolved / seenNonEmptyBeads / debounceTimer），
 *    必须每用例一套全新实例，否则用例间互相污染。
 *
 * 覆盖：保存/加载往返（含 typed array 保真与 board 开关）· 防抖自动保存 ·
 * 恢复决策守卫 · 损坏数据容错 · 陈旧 stop 防护 · 负数索引夹取。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ---------------- mock：关闭 Electron 分支 ---------------- */

vi.mock('@/io/bridge', () => ({
  isElectron: () => false,
  getBridge: () => ({
    env: 'browser',
    getAppInfo: async () => ({ version: '0.0.0-test', platform: 'test', isElectron: false }),
    writeAppData: async () => true,
    readAppData: async () => null,
    listAppData: async () => [],
    openFile: async () => null,
    saveFile: async () => null,
  }),
}));

/* ---------------- 最小 localStorage ---------------- */

function fakeLs(): { map: Map<string, string>; storage: Storage } {
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
  return { map, storage };
}

let ls: ReturnType<typeof fakeLs>;

/** 每用例一套全新模块（persistence + store 同代） */
async function freshModules() {
  vi.resetModules();
  const S = await import('@/store/index');
  const P = await import('@/store/persistence');
  return { S, P };
}

beforeEach(() => {
  ls = fakeLs();
  vi.stubGlobal('localStorage', ls.storage);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ---------------- 保存 / 加载往返 ---------------- */

describe('自动保存往返', () => {
  it('beads/placedMask 经 base64 往返逐格保真', async () => {
    const { S, P } = await freshModules();
    P.discardAutosave(); // 解锁未决期写入抑制（模拟用户已决策）
    S.usePdbStore.getState().setBoardConfig({ cols: 8, rows: 6 });
    S.usePdbStore.getState().mutateBeads((b, pl) => {
      b[0] = 1;
      b[5] = 2;
      b[47] = 3;
      pl[0] = 1;
      pl[47] = 1;
    });
    expect(P.writeAutosaveOnce()).toBe(true);
    const parsed = P.parseAutosave(ls.map.get(P.AUTOSAVE_LS_KEY));
    expect(parsed).toBeTruthy();
    const project = parsed!.project;
    // 解回 store 再逐格比对
    S.usePdbStore.getState().setBoardConfig({ cols: 4, rows: 4 }); // 先破坏
    const restored = P.restoreAutosave(parsed);
    expect(restored.ok).toBe(true);
    const s = S.usePdbStore.getState();
    expect(s.board.cols).toBe(8);
    expect(s.board.rows).toBe(6);
    expect(s.beads[0]).toBe(1);
    expect(s.beads[5]).toBe(2);
    expect(s.beads[47]).toBe(3);
    expect(s.placedMask[0]).toBe(1);
    expect(s.placedMask[47]).toBe(1);
    expect(s.beads[1]).toBe(0);
    void project;
  });

  it('board 三个可选开关（emptyCheckerboard/showColorCodes/darkBeadEdge）往返保真（缺陷A回归）', async () => {
    const { S, P } = await freshModules();
    P.discardAutosave();
    S.usePdbStore.getState().setBoardConfig({
      cols: 6,
      rows: 6,
      emptyCheckerboard: false,
      showColorCodes: true,
      darkBeadEdge: false,
    });
    S.usePdbStore.getState().mutateBeads((b) => {
      b[0] = 1;
    });
    expect(P.writeAutosaveOnce()).toBe(true);
    const parsed = P.parseAutosave(ls.map.get(P.AUTOSAVE_LS_KEY));
    expect(parsed).toBeTruthy();
    // 解析侧就必须带上（原 sanitizeBoard 白名单遗漏 → 全 undefined）
    expect(parsed!.project.board.emptyCheckerboard).toBe(false);
    expect(parsed!.project.board.showColorCodes).toBe(true);
    expect(parsed!.project.board.darkBeadEdge).toBe(false);
    // 恢复后 store 里也必须是保存时的值（不能被默认值顶掉）
    S.usePdbStore.getState().setBoardConfig({ emptyCheckerboard: true, showColorCodes: false, darkBeadEdge: true });
    expect(P.restoreAutosave(parsed).ok).toBe(true);
    const board = S.usePdbStore.getState().board;
    expect(board.emptyCheckerboard).toBe(false);
    expect(board.showColorCodes).toBe(true);
    expect(board.darkBeadEdge).toBe(false);
  });

  it('恢复的 activeColorIndex 上下限双夹取（缺陷D回归）', async () => {
    const { S, P } = await freshModules();
    P.discardAutosave();
    S.usePdbStore.getState().setBoardConfig({ cols: 4, rows: 4 });
    const project = P.buildAutosave().project;
    const mkFile = (idx: number) => ({
      kind: P.AUTOSAVE_KIND as typeof P.AUTOSAVE_KIND,
      version: 1 as const,
      savedAt: new Date().toISOString(),
      appVersion: 'test',
      project,
      session: {
        theme: 'journal' as const,
        layout: 'classic' as const,
        mode: 'design' as const,
        tool: 'pen' as const,
        activeColorIndex: idx,
        region: { splitsX: 1, splitsY: 1, activeIndex: 0 },
        filter: { colorIndex: -1, mode: 'off' as const },
      },
    });
    // 负数：原实现只有上限夹取，-5 会原样进 store
    expect(P.restoreAutosave(mkFile(-5)).ok).toBe(true);
    expect(S.usePdbStore.getState().activeColorIndex).toBe(0);
    // 超上限：夹到最后一色
    const n = S.usePdbStore.getState().palette.colors.length;
    expect(P.restoreAutosave(mkFile(99999)).ok).toBe(true);
    expect(S.usePdbStore.getState().activeColorIndex).toBe(n - 1);
  });

  it('session 缺字段（无 filter）→ 恢复不抛错、其余字段照常应用（缺陷B回归）', async () => {
    const { S, P } = await freshModules();
    P.discardAutosave();
    S.usePdbStore.getState().setBoardConfig({ cols: 6, rows: 6 });
    S.usePdbStore.getState().mutateBeads((b) => {
      b[3] = 2;
    });
    const project = P.buildAutosave().project;
    const broken = {
      kind: P.AUTOSAVE_KIND as typeof P.AUTOSAVE_KIND,
      version: 1 as const,
      savedAt: new Date().toISOString(),
      appVersion: 'test',
      project,
      session: { theme: 'journal' } as never, // 缺 layout/mode/tool/region/filter
    };
    const r = P.restoreAutosave(broken);
    expect(r.ok).toBe(true); // 原实现抛 Cannot read properties of undefined (reading 'colorIndex')
    const s = S.usePdbStore.getState();
    expect(s.board.cols).toBe(6);
    expect(s.beads[3]).toBe(2);
    expect(s.theme).toBe('journal'); // 有的字段仍应用
  });
});

/* ---------------- 防抖自动保存 ---------------- */

describe('startAutoSave 防抖与订阅', () => {
  it('变更后 3s 防抖写入一次；连续变更只写最后一次', async () => {
    vi.useFakeTimers();
    const { S, P } = await freshModules();
    P.discardAutosave();
    const stop = P.startAutoSave();
    S.usePdbStore.getState().mutateBeads((b) => {
      b[0] = 1;
    });
    vi.advanceTimersByTime(2000); // 未到 3s：不写
    expect(ls.map.has(P.AUTOSAVE_LS_KEY)).toBe(false);
    S.usePdbStore.getState().mutateBeads((b) => {
      b[1] = 2; // 防抖重置
    });
    vi.advanceTimersByTime(2000); // 距上次变更 2s：仍不写
    expect(ls.map.has(P.AUTOSAVE_LS_KEY)).toBe(false);
    vi.advanceTimersByTime(1100); // 距最后一次 3.1s：写
    expect(ls.map.has(P.AUTOSAVE_LS_KEY)).toBe(true);
    stop();
  });

  it('stop 后再变更不再写盘', async () => {
    vi.useFakeTimers();
    const { S, P } = await freshModules();
    P.discardAutosave();
    const stop = P.startAutoSave();
    stop();
    ls.map.delete(P.AUTOSAVE_LS_KEY);
    S.usePdbStore.getState().mutateBeads((b) => {
      b[0] = 1;
    });
    vi.advanceTimersByTime(5000);
    expect(ls.map.has(P.AUTOSAVE_LS_KEY)).toBe(false);
  });

  it('陈旧 stop 不清新订阅的登记（缺陷C回归）：stop1→start2→stop1 后 stop2 仍有效', async () => {
    vi.useFakeTimers();
    const { S, P } = await freshModules();
    P.discardAutosave();
    const stop1 = P.startAutoSave();
    stop1();
    const stop2 = P.startAutoSave();
    stop1(); // 陈旧 stop：不得把 stop2 的登记抹掉（原实现会）
    S.usePdbStore.getState().mutateBeads((b) => {
      b[0] = 1;
    });
    vi.advanceTimersByTime(3100);
    expect(ls.map.has(P.AUTOSAVE_LS_KEY)).toBe(true); // stop2 的订阅仍活着，写盘正常
    // stop2 依然能真正停掉
    ls.map.delete(P.AUTOSAVE_LS_KEY);
    stop2();
    S.usePdbStore.getState().mutateBeads((b) => {
      b[1] = 1;
    });
    vi.advanceTimersByTime(3100);
    expect(ls.map.has(P.AUTOSAVE_LS_KEY)).toBe(false);
  });

  it('重复 start 返回同一 stop（幂等）', async () => {
    const { P } = await freshModules();
    const a = P.startAutoSave();
    const b = P.startAutoSave();
    expect(a).toBe(b);
    a();
  });
});

/* ---------------- 恢复决策守卫与容错 ---------------- */

describe('恢复决策守卫与损坏容错', () => {
  it('用户未决策且无豆 → 写入被抑制；discardAutosave 解锁', async () => {
    const { P } = await freshModules();
    expect(P.writeAutosaveOnce()).toBe(false); // 未决期 + 空板 → 拦截
    P.discardAutosave();
    expect(P.writeAutosaveOnce()).toBe(true);
  });

  it('损坏 JSON / 缺字段 → parseAutosave 返回 null 不抛错', async () => {
    const { P } = await freshModules();
    expect(P.parseAutosave('not json')).toBeNull();
    expect(P.parseAutosave('')).toBeNull();
    expect(P.parseAutosave(null)).toBeNull();
    expect(P.parseAutosave('{"kind":"other"}')).toBeNull();
  });

  it('restoreAutosave(null) / 空记录 → ok:false 不抛错', async () => {
    const { P } = await freshModules();
    expect(P.restoreAutosave(null).ok).toBe(false);
    expect(P.restoreAutosave().ok).toBe(false); // 无自动保存记录
  });

  it('hasUnsavedSession / clearAutosave 生命周期', async () => {
    const { P } = await freshModules();
    P.discardAutosave();
    expect(P.hasUnsavedSession()).toBe(false);
    P.writeAutosaveOnce();
    expect(P.hasUnsavedSession()).toBe(true);
    P.clearAutosave();
    expect(P.hasUnsavedSession()).toBe(false);
  });

  it('buildAutosave 的 session 捕获当前主题/布局/工具', async () => {
    const { S, P } = await freshModules();
    S.usePdbStore.getState().setTheme('minimal');
    S.usePdbStore.getState().setLayout('focus');
    S.usePdbStore.getState().setTool('eraser');
    const auto = P.buildAutosave();
    expect(auto.session?.theme).toBe('minimal');
    expect(auto.session?.layout).toBe('focus');
    expect(auto.session?.tool).toBe('eraser');
  });
});
