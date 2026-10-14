/**
 * tests/vbProgram.test.ts —— PIXDOU 节目接收状态机（core/vbProgram.ts）回归用例。
 * 防对话框（VirtualBoardDialog）0x06/0x00/0x01 分支的三个实测 bug 回归：
 *   缺片时渲染截断 GIF / 整片重发 got 双计 / 0x01 后迟到分片再次触发拼装渲染。
 */
import { describe, expect, it } from 'vitest';
import {
  vbProgramBegin, vbProgramChunk, vbProgramCounts, vbProgramFinish, vbProgramNew,
} from '@/core/vbProgram';

describe('vbProgram —— 正常接收流程', () => {
  it('两片节目（乱序到达）→ finish 拼出原节目并置 done', () => {
    const st = vbProgramNew();
    vbProgramBegin(st, 0xd306d4ba, 5);
    expect(vbProgramChunk(st, 1, [4, 5])).toEqual({ got: 2, chunks: 1 });
    expect(vbProgramChunk(st, 0, [1, 2, 3])).toEqual({ got: 5, chunks: 2 });
    const r = vbProgramFinish(st, 5)!;
    expect(r.program).toEqual([1, 2, 3, 4, 5]);
    expect(st.done).toBe(true);
    expect(st.id).toBe(0xd306d4ba);
    expect(st.total).toBe(5);
  });

  it('expectedLen=null 时跳过总长校验（只查分片连续）', () => {
    const st = vbProgramNew();
    vbProgramBegin(st, 1, 3);
    vbProgramChunk(st, 0, [1, 2]);
    vbProgramChunk(st, 1, [3, 4]); // 实收 4B ≠ 声明 3B
    expect(vbProgramFinish(st, null)).toEqual({ program: [1, 2, 3, 4] });
  });
});

describe('vbProgram —— 整片重发不双计（2026-10-01 实测 bug）', () => {
  it('同 packetId 重复发送：got 精确等于去重后的字节数', () => {
    const st = vbProgramNew();
    vbProgramBegin(st, 0, 6);
    expect(vbProgramChunk(st, 0, [0xaa, 0xbb, 0xcc])).toEqual({ got: 3, chunks: 1 });
    // App 整片重发（同 index 同数据）：覆盖写，不累计
    expect(vbProgramChunk(st, 0, [0xaa, 0xbb, 0xcc])).toEqual({ got: 3, chunks: 1 });
    expect(vbProgramChunk(st, 0, [0xaa, 0xbb, 0xcc])).toEqual({ got: 3, chunks: 1 });
    // 同 index 内容不同：后到覆盖为准，也不累计
    expect(vbProgramChunk(st, 0, [0x11])).toEqual({ got: 1, chunks: 1 });
    expect(vbProgramChunk(st, 1, [0x22, 0x33])).toEqual({ got: 3, chunks: 2 });
  });

  it('vbProgramCounts 一律从 Map 重算', () => {
    const st = vbProgramNew();
    vbProgramBegin(st, 0, 10);
    vbProgramChunk(st, 0, [1, 2, 3]);
    vbProgramChunk(st, 0, [1, 2, 3]); // 重发不双计
    vbProgramChunk(st, 2, [7]);       // 缺 index=1：counts 只反映实收
    expect(vbProgramCounts(st)).toEqual({ got: 4, chunks: 2 });
  });
});

describe('vbProgram —— finish 校验（缺片/总长不符都不渲染）', () => {
  it('缺片（index 不连续）返回 null 且不置 done', () => {
    const st = vbProgramNew();
    vbProgramBegin(st, 0, 5);
    vbProgramChunk(st, 0, [1]);
    vbProgramChunk(st, 2, [4, 5]); // 缺 index=1
    expect(vbProgramFinish(st, 5)).toBeNull();
    expect(st.done).toBe(false);
    // 补上缺片后重试成功（纯函数层语义：finish 可重入。真实链路 0x01 成败即清
    // progRef，App 整片重发会先发 0x06 重建状态，不走这条路）
    vbProgramChunk(st, 1, [2, 3]);
    expect(vbProgramFinish(st, 5)).toEqual({ program: [1, 2, 3, 4, 5] });
  });

  it('分片连续但总长与 expectedLen 不符返回 null', () => {
    const st = vbProgramNew();
    vbProgramBegin(st, 0, 215);
    vbProgramChunk(st, 0, [1, 2, 3]); // 只收 3B，声明 215B
    expect(vbProgramFinish(st, 215)).toBeNull();
    expect(st.done).toBe(false);
  });

  it('空 state（未收到任何分片）finish 返回 null', () => {
    expect(vbProgramFinish(vbProgramNew(), 100)).toBeNull();
    const st = vbProgramNew();
    vbProgramBegin(st, 7, 100);
    expect(vbProgramFinish(st, 100)).toBeNull();
  });
});

describe('vbProgram —— 0x01 后的幂等（迟到/重复帧防护）', () => {
  it('done 后 chunk 不再接收、finish 恒返回 null', () => {
    const st = vbProgramNew();
    vbProgramBegin(st, 0, 3);
    vbProgramChunk(st, 0, [1, 2, 3]);
    expect(vbProgramFinish(st, 3)).toEqual({ program: [1, 2, 3] });
    // 迟到分片 / 重复 0x01：状态冻结
    expect(vbProgramChunk(st, 1, [9, 9])).toEqual({ got: 3, chunks: 1 });
    expect(st.chunks.size).toBe(1);
    expect(vbProgramFinish(st, 3)).toBeNull();
  });

  it('vbProgramBegin 重建即丢弃上一节目残留分片', () => {
    const st = vbProgramNew();
    vbProgramBegin(st, 0xaa, 10);
    vbProgramChunk(st, 0, [1, 2, 3]);
    vbProgramBegin(st, 0xbb, 4); // App 放弃重发：新一轮 0x06
    expect(st.id).toBe(0xbb);
    expect(st.total).toBe(4);
    expect(st.done).toBe(false);
    expect(vbProgramCounts(st)).toEqual({ got: 0, chunks: 0 });
  });
});
