/**
 * core/vbProgram.ts —— PIXDOU 临时节目接收状态机（纯函数）。
 *
 * 从 VirtualBoardDialog 抽出的 0x06/0x00/0x01 节目接收逻辑，修掉三个实测 bug：
 *   · 0x01 完成拼装缺 expectedLen：缺片时截断 GIF 也照渲染（错误点亮图案）；
 *   · 坏校验帧（f.ok===false）不拦，0x06/0x00/0x01 照常入库（对话框侧已补拦）；
 *   · 0x01 处理完不复位：迟到/重复分片再次触发拼装渲染（done 置位 + 对话框清 progRef 双保险）。
 *
 * 语义基线（2026-10-01 联调实锤，重构必须精确保留）：
 *   · 0x00 分片的 got/chunks 一律**从 Map 重算**——App 会整片重发（同 packetId），
 *     累加会双计（实录出现过 395/215B ✓ 的读数）；同 index 覆盖写入即幂等。
 *   · 拼装走 core/pixdouProtocol.assembleProgram：分片 index 必须连续从 0 起，
 *     且总长与 0x06 声明的 total（expectedLen）一致，任一不符返回 null（不渲染）。
 */
import { assembleProgram } from './pixdouProtocol';

/** PIXDOU 临时节目接收状态（对话框侧一个节目一份，0x06 到来即整体重建） */
export interface VbProgramState {
  /** 0x06 声明的节目 id（u32be，日志用） */
  id: number | null;
  /** 0x06 声明的节目总长（字节）；0x01 拼装时的 expectedLen */
  total: number | null;
  /** 分片缓存：index → 数据字节（同 index 覆盖写，天然幂等） */
  chunks: Map<number, number[]>;
  /** 0x01 拼装成功后置位：之后的分片/完成帧一律忽略（迟到/重复帧防护） */
  done: boolean;
}

/** 新建空白状态（对话框收到 0x06 时调用，顺带丢弃上一节目的残留分片） */
export function vbProgramNew(): VbProgramState {
  return { id: null, total: null, chunks: new Map(), done: false };
}

/** 0x06 新增节目：登记 id/总长并清空残留分片 */
export function vbProgramBegin(st: VbProgramState, id: number, total: number): void {
  st.id = id;
  st.total = total;
  st.chunks = new Map();
  st.done = false;
}

/**
 * 0x00 收到分片：幂等写入（同 index 重发覆盖，不双计 got），got/chunks 从 Map 重算。
 * 已 done（0x01 已成功）则直接返回当前计数，不再接收任何分片。
 */
export function vbProgramChunk(
  st: VbProgramState,
  index: number,
  data: number[],
): { got: number; chunks: number } {
  if (!st.done) st.chunks.set(index, data);
  return vbProgramCounts(st);
}

/** 当前累计字节数与分片数（一律从 Map 重算——同 index 重发不双计） */
export function vbProgramCounts(st: VbProgramState): { got: number; chunks: number } {
  let got = 0;
  for (const d of st.chunks.values()) got += d.length;
  return { got, chunks: st.chunks.size };
}

/**
 * 0x01 完成：拼装 + 双重校验（分片连续、总长与 expectedLen 一致）。
 * 任一不符 / 空 state / 已 done → 返回 null（缺片或总长不符都不得渲染截断 GIF）；
 * 通过则置 done 并返回完整节目字节。
 */
export function vbProgramFinish(
  st: VbProgramState,
  expectedLen: number | null,
): { program: number[] } | null {
  if (st.done || st.chunks.size === 0) return null;
  const program = assembleProgram(st.chunks, expectedLen === null ? undefined : expectedLen);
  if (!program) return null;
  st.done = true;
  return { program };
}
