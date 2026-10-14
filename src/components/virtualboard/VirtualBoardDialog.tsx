/**
 * virtualboard/VirtualBoardDialog.tsx —— PC 虚拟智能拼豆板。
 *
 * 主进程托管 C# 旁路（WinRT GATT Server + BLE 广播）把这台电脑伪装成一块智能拼豆板。
 * 支持两套协议预设：
 *  · 酷猫开放协议（kmpd）：单特征，[cmd,payload] 帧——0x01 清屏 / 0x02 绘制 / 0x03 提交 /
 *    0x04 亮度 / 0xA1 查询；0x02/0x03 直接渲染成 104×104 点阵（屏幕即灯板）。
 *  · 颂拼豆（pixdou）：双特征 a951(控制)+a952(节目数据)，请求与回码同构
 *    [0x54 cmd len16=payload+2 payload cks16BE]；GIF 临时节目下发（0x0A 开屏 → 0x06 新增
 *    → 0x00×N 分片 → 0x01 完成）。节目收齐后自动解出内嵌 GIF 并渲染到点阵画布
 *    —— 这就是真板子显示的「选哪个色号，亮哪些格子」。
 *
 * 已知平台限制：Windows 托管广播的设备名（=本机蓝牙名），代码无法自定义前缀——
 * 若目标 App 按 pindou-/kmpd- 前缀过滤，需把电脑蓝牙名改成对应前缀（对话框内有指引）。
 * 入口：LeftRail「虚拟板」/ `pdb:open-virtualboard`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { getBridge, type VbEvent } from '@/io/bridge';
import { frameSummary, parseDrawFrame } from '@/core/vbProtocol';
import { buildLightMaskFromRgba } from '@/core/vbLight';
import {
  extractGif, parseChunkPayload, parsePixdou,
  parseProgramHeader, pixdouSummary, programDimensions,
} from '@/core/pixdouProtocol';
import { vbProgramBegin, vbProgramChunk, vbProgramCounts, vbProgramFinish, vbProgramNew, type VbProgramState } from '@/core/vbProgram';
import type { VbLightPattern } from '@/core/types';
import { usePdbStore } from '@/store';
import './virtualboard.css';

/** 开放协议预设 */
const PROTOCOL_PRESETS = [
  {
    id: 'kmpd',
    label: '酷猫开放协议',
    service: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
    char: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
  },
  {
    id: 'pixdou',
    label: '颂拼豆（PIXDOU）',
    service: '0000a950-0000-1000-8000-00805f9b34fb',
    char: '0000a951-0000-1000-8000-00805f9b34fb',
  },
] as const;

type PresetId = (typeof PROTOCOL_PRESETS)[number]['id'];

/**
 * PIXDOU 0x09 板信息帧：状态 0x01 + 宽高（各 u16BE）。App **不会主动查询**板规格
 * （sidecar 注释实锤），连上后收不到这条就用它自家默认 52×52 下发图案 ——
 * 2026-10-01 vb_traffic 00:08 节目 GIF=52×52 实锤；推了才按 104×104 走。
 */
function boardInfoFrame(w: number, h: number): string {
  const payload = [0x01, (w >> 8) & 0xff, w & 0xff, (h >> 8) & 0xff, h & 0xff];
  const head = [0x54, 0x09, 0x00, payload.length + 2, ...payload];
  const sum = head.reduce((a, b) => a + b, 0) & 0xffff;
  return [...head, (sum >> 8) & 0xff, sum & 0xff]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface LogRow { id: number; t: string; text: string; kind: 'info' | 'ok' | 'warn' | 'bad' }

/** FNV-1a 32 位哈希：节目 GIF 字节 → 解码缓存 key（附长度进一步压碰撞；缓存仅 4 项可忽略） */
function gifKey(bytes: number[]): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + bytes.length;
}

export function VirtualBoardDialog() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  // 广播名/协议落 localStorage：对话框每次挂载都会重置，曾导致按 kmpd 默认值广播、
  // App 按 PIXDOU 服务扫描扑空（2026-09-29 联调教训）。未存过时默认 pixdou（当前主用途）。
  const [name, setName] = useState(() => {
    const v = localStorage.getItem('pdb.vb.name');
    return v && /^[A-Za-z0-9_-]{1,20}$/.test(v) ? v : 'pindou-PC01';
  });
  const [presetId, setPresetId] = useState<PresetId>(() => {
    const v = localStorage.getItem('pdb.vb.preset');
    return v === 'kmpd' || v === 'pixdou' ? v : 'pixdou';
  });
  const [log, setLog] = useState<LogRow[]>([]);
  const [w, setW] = useState(104);
  const [h, setH] = useState(104);
  const [prog, setProg] = useState<string | null>(null); // pixdou 节目进度文本
  const [ctrlVerb, setCtrlVerb] = useState<'ack9' | 'acka' | 'ack0' | 'ackz' | 'push'>('ack9');
  const [ctrlArg, setCtrlArg] = useState('auto');
  const pushToast = usePdbStore((s) => s.pushToast);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 帧缓冲：pending 收 0x02，0x03 提交到 shown 并绘制 */
  const pendingRef = useRef<Map<number, string>>(new Map());
  const shownRef = useRef<Map<number, string>>(new Map());
  /** 预览/节目点阵尺寸：kmpd 分片 stride、预览画布、GIF 渲染都用它（渲染节目会被
      GIF 实际尺寸覆盖——只影响预览，绝不能反过来污染 0x09 板信息，见 boardDimsRef） */
  const previewDimsRef = useRef({ w: 104, h: 104 });
  /** 板信息尺寸：0x09 自动推送专用。初值 104×104，只在 vbStart 成功 / ready 事件
      （都带板配置 w/h）时更新——曾被 GIF 的 52×52 覆盖导致「每次连上默认 52 钉」
      （2026-10-01 联调教训），与预览尺寸严格解耦。 */
  const boardDimsRef = useRef({ w: 104, h: 104 });
  /** pixdou 节目接收状态机（纯函数见 core/vbProgram.ts；null=当前没有在收的节目） */
  const progRef = useRef<VbProgramState | null>(null);
  /** 最近一次成功渲染的节目（对话框重开后补画预览用——收节目时对话框可能没开） */
  const lastProgramRef = useRef<{ program: number[]; offset: number } | null>(null);
  /** 主画布发光板上的手机点亮图案（存在时显示清除按钮） */
  const vbLight = usePdbStore((s) => s.vbLight);
  /** 0x09 板信息自动推送的去抖定时器（一次连接会先后来两条 connected 事件） */
  const boardInfoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 当前协议预设（onEvent 里读，避免为它重订阅事件流） */
  const presetIdRef = useRef<PresetId>(presetId);
  presetIdRef.current = presetId;
  /** 换色延迟遥测：0x0A 开屏帧=一次点色/换色的起点，0x06=节目传输起点；
      各记一笔后清零——对话框重开补画不再重复记 */
  const t0OpenRef = useRef<number | null>(null);
  const t0ProgRef = useRef<number | null>(null);
  /** GIF 解码缓存（重开对话框/小窗补画同一节目都要重新
      createImageBitmap 解码）。key=节目 GIF 字节 FNV-1a；LRU 4 项
      （104×104 单帧 ≈ 54KB/项，含 mask+rgba）；被中止/失败的节目不入缓存 */
  const decodeCacheRef = useRef<Map<string, { gw: number; gh: number; data: Uint8ClampedArray; litMask: VbLightPattern }>>(new Map());

  useEffect(() => {
    localStorage.setItem('pdb.vb.name', name);
    localStorage.setItem('pdb.vb.preset', presetId);
  }, [name, presetId]);

  /** 事件日志合批队列 + 定时器 + 稳定自增 id（key 用，滚动截断时不再整列表错位重挂） */
  const logQueueRef = useRef<LogRow[]>([]);
  const logTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logIdRef = useRef(0);

  const flushLog = useCallback((): void => {
    if (logTimerRef.current) {
      clearTimeout(logTimerRef.current);
      logTimerRef.current = null;
    }
    const batch = logQueueRef.current;
    if (batch.length === 0) return;
    logQueueRef.current = [];
    setLog((l) => [...l, ...batch].slice(-200));
  }, []);

  const addLog = useCallback((text: string, kind: LogRow['kind'] = 'info'): void => {
    // 合批：只入队，200ms 批量 flush——分片风暴期每分片
    // 4-5 行、每行全量 reconcile 200 条，合批后每 200ms 一次 setState
    logQueueRef.current.push({
      id: ++logIdRef.current,
      t: new Date().toLocaleTimeString(),
      text,
      kind,
    });
    if (logTimerRef.current === null) {
      logTimerRef.current = setTimeout(flushLog, 200);
    }
  }, [flushLog]);

  const paintCanvas = useCallback((): void => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const { w: cw, h: chh } = previewDimsRef.current;
    const cell = Math.max(2, Math.floor(416 / Math.max(cw, chh)));
    cv.width = cw * cell;
    cv.height = chh * cell;
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (const [idx, rgb] of shownRef.current) {
      const x = idx % cw;
      const y = Math.floor(idx / cw);
      ctx.fillStyle = rgb;
      ctx.beginPath();
      ctx.arc(x * cell + cell / 2, y * cell + cell / 2, cell * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
  }, []);

  /**
   * PIXDOU 节目渲染：解出 programData 里的 GIF 首帧 → 亮点掩码写入 store（主画布
   * 发光板直接点亮，手机点色号=板子显示内容），再把图案画到对话框预览画布。
   * 顺序刻意先 store 后画布：对话框没开时 canvasRef 为 null，若先画布会整段跳过、
   * 主画布也收不到图案（2026-09-30 联调教训）。
   */
  const renderProgram = useCallback(async (program: number[], gifOffset: number): Promise<void> => {
    const gif = program.slice(gifOffset);
    const key = gifKey(gif);
    const cached = decodeCacheRef.current.get(key);
    let gw: number, gh: number, data: Uint8ClampedArray, litMask: VbLightPattern;
    if (cached) {
      gw = cached.gw;
      gh = cached.gh;
      data = cached.data;
      litMask = cached.litMask;
    } else {
      const blob = new Blob([new Uint8Array(gif)], { type: 'image/gif' });
      let bmp: ImageBitmap | null = null;
      try {
        bmp = await createImageBitmap(blob);
        // 板尺寸上限与 main.mjs 侧一致（1..255）：越界的 GIF 解不出合法点亮图案，
        // 直接中止渲染（不写 store、不画预览），防止荒谬尺寸把画布撑爆
        const bw = bmp.width;
        const bh = bmp.height;
        if (bw < 1 || bw > 255 || bh < 1 || bh > 255) {
          addLog(`GIF 尺寸越界：${bw}×${bh}（超出 1..255），已中止渲染`, 'warn');
          return;
        }
        gw = bw;
        gh = bh;
        // 1) 解码亮点（非黑像素=点亮格；rgba 原样带回一份给小窗按原色重绘）
        const off = document.createElement('canvas');
        off.width = gw;
        off.height = gh;
        const octx = off.getContext('2d')!;
        octx.drawImage(bmp, 0, 0);
        data = octx.getImageData(0, 0, gw, gh).data;
        litMask = buildLightMaskFromRgba(data, gw, gh);
        // 解码缓存 LRU 4 项（Map 迭代序=插入序，淘汰最旧）。
        // lastProgramRef（重开补画）也移到解码成功后：原实现解码抛错前就记入，
        // 重开对话框会重放失败日志（与越界中止不同路径的同类问题）
        if (decodeCacheRef.current.size >= 4) {
          const oldest = decodeCacheRef.current.keys().next().value;
          if (oldest !== undefined) decodeCacheRef.current.delete(oldest);
        }
        decodeCacheRef.current.set(key, { gw, gh, data, litMask });
      } catch (e) {
        addLog(`GIF 渲染失败：${e instanceof Error ? e.message : String(e)}`, 'warn');
        return;
      } finally {
        // 统一关闭（close 幂等）：原实现异常路径漏 close，泄漏 ImageBitmap
        bmp?.close?.();
      }
    }
    lastProgramRef.current = { program, offset: gifOffset };
    // 2) 亮点掩码写入 store（与对话框是否打开无关）
    usePdbStore.getState().setVbLight(litMask.count > 0 ? litMask : null);
    // 3) 对话框预览画布（开着才画）
    const cv = canvasRef.current;
    const ctx = cv?.getContext('2d') ?? null;
    if (cv && ctx) {
      const cell = Math.max(2, Math.floor(416 / Math.max(gw, gh)));
      cv.width = gw * cell;
      cv.height = gh * cell;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#05070c';
      ctx.fillRect(0, 0, cv.width, cv.height);
      // GIF 底图：非黑像素按原色绘制（= 板子点亮的豆子）
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const i = (y * gw + x) * 4;
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
          if (r === 0 && g === 0 && b === 0) continue;
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.beginPath();
          ctx.arc(x * cell + cell / 2, y * cell + cell / 2, cell * 0.42, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      previewDimsRef.current = { w: gw, h: gh };
      setW(gw); setH(gh);
    }
    // 换色延迟遥测（2026-10-11）：起点在 0x0A，渲染完成记一笔并清零
    if (t0OpenRef.current != null) {
      addLog(`换色端到端：${Date.now() - t0OpenRef.current}ms（0x0A→点亮落画布${cached ? '，解码缓存命中' : ''}）`, 'ok');
      t0OpenRef.current = null;
    }
    const dims = programDimensions(program);
    addLog(
      `节目已渲染：GIF ${gw}×${gh}（${dims ? `分区声明 ${dims.w}×${dims.h}` : '无分区头'}），点亮 ${litMask.count} 格`
      + `${litMask.count > 0 ? '，已同步主画布发光板' : ''}${cv ? '' : '（对话框未开，预览待重开后补画）'}`,
      'ok',
    );
    // 对话框没开时小窗已在页面右下角显示图案，补一条 toast 告知图到了
    if (!cv && litMask.count > 0) {
      pushToast('info', `手机图案已收到：点亮 ${litMask.count} 格（右下角智能板小窗）`, 3600);
    }
  }, [addLog, pushToast]);

  const onEvent = useCallback((evt: VbEvent): void => {
    switch (evt.ev) {
      case 'ready':
        setRunning(true);
        usePdbStore.getState().setVbStatus(true, false, usePdbStore.getState().vbProg);
        if (evt.w && evt.h) {
          // ready 带板配置 w/h：boardDimsRef 的二次更新点（主更新点在 vbStart 返回值）
          boardDimsRef.current = { w: evt.w, h: evt.h };
          previewDimsRef.current = { w: evt.w, h: evt.h };
          setW(evt.w); setH(evt.h);
        }
        addLog(`广播中：${evt.name}（GATT 就绪，${evt.w}×${evt.h}${evt.addr ? `，本机蓝牙 ${evt.addr}` : ''}）`, 'ok');
        break;
      case 'adv':
        addLog(evt.mode === 'gatt'
          ? `广播通道：GATT 可连接（${evt.status ?? '?'}，含服务 UUID）`
          : `广播通道：Publisher 退路（${evt.status ?? '?'}，仅 mfg 标识，无服务 UUID）`, 'info');
        break;
      case 'advstat':
        break; // 广播状态抖动：太噪，忽略（异常时旁路会自己 restart 并出 adv 事件）
      case 'connected': {
        setConnected(true);
        usePdbStore.getState().setVbStatus(true, true, usePdbStore.getState().vbProg);
        addLog(`手机已连接（订阅者 ${evt.subs ?? '?'}${evt.ch ? `，特征 ${evt.ch}` : ''}）`, 'ok');
        // 连上即自动推送 0x09 板信息帧（去抖 600ms，等订阅稳定）：不推 App 就按自家
        // 默认 52×52 下发图案，用户每次重连都得手动推（2026-10-01 联调教训）。
        // 尺寸取 boardDimsRef（板配置，恒 104×104 起步）——绝不能用预览尺寸：
        // 它会被收到的节目 GIF（可能 52×52）覆盖，曾致「每次连上默认 52 钉」。
        if (boardInfoTimerRef.current) clearTimeout(boardInfoTimerRef.current);
        boardInfoTimerRef.current = setTimeout(() => {
          boardInfoTimerRef.current = null;
          if (presetIdRef.current !== 'pixdou') return;
          const frame = boardInfoFrame(boardDimsRef.current.w, boardDimsRef.current.h);
          void getBridge().vbNotify(frame).then((r) => {
            addLog(
              `已自动推送板信息 0x09（${boardDimsRef.current.w}×${boardDimsRef.current.h}）${r.ok ? '' : '（未运行，跳过）'}`,
              r.ok ? 'ok' : 'info',
            );
          });
        }, 600);
        break;
      }
      case 'disconnected': {
        // WinRT GattServiceProvider 无会话事件，订阅前的物理连接不可观测
        //（tools/virtualboard/VirtualBoard.cs 有实证注释）；若将来需要，出路是
        // DeviceInformation watcher 监听 AEP IsConnected（耳机等会误报，只做旁路日志）。
        setConnected(false);
        usePdbStore.getState().setVbStatus(true, false, usePdbStore.getState().vbProg);
        addLog('手机已断开', 'warn');
        break;
      }
      case 'write': {
        const hex = evt.hex ?? '';
        const f = parsePixdou(hex);
        if (f) {
          addLog(`${pixdouSummary(hex)}`, 'info');
          if (!f.ok) break; // 坏校验帧：只留日志，不入库不渲染（防脏数据拼出错误点亮图案）
          // 节目进度跟踪：0x0A 开屏 → 0x06 新增(总长) → 0x00 分片(累计) → 0x01 完成
          if (f.cmd === 0x0a) {
            t0OpenRef.current = Date.now(); // 换色遥测起点：一次点色/换色从开屏帧开始
            addLog('屏幕已开启', 'ok');
          } else if (f.cmd === 0x06) {
            const hdr = parseProgramHeader(f.payload);
            if (hdr) {
              t0ProgRef.current = Date.now(); // 节目传输起点
              const st = vbProgramNew();
              vbProgramBegin(st, hdr.id, hdr.total);
              progRef.current = st; // 0x06 整体重置：上一节目的残留分片一并丢弃
              setProg(`节目下发中… 0/${hdr.total}B`);
              usePdbStore.getState().setVbProg(`节目下发中… 0/${hdr.total}B`);
              addLog(`新增临时节目 id=0x${hdr.id.toString(16).padStart(8, '0')} 总长=${hdr.total}B`, 'info');
            } else {
              progRef.current = null; // 头损坏：残留分片一并丢弃，后续分片无处落地
              setProg(null); // 进度 chip 同步清空，避免残留上一节目的「下发中…」
              usePdbStore.getState().setVbProg(null);
            }
          } else if (f.cmd === 0x00 && progRef.current) {
            const ck = parseChunkPayload(f.payload);
            if (ck) {
              // 幂等 set + got/chunks 从 Map 重算：App 会整片重发（同 packetId），
              // 累加会双计（实录出现过 395/215B ✓ 的读数）
              const st = progRef.current;
              const r = vbProgramChunk(st, ck.index, ck.data);
              const total = st.total ?? r.got;
              const text = `节目分片 #${ck.index + 1} · ${Math.min(r.got, total)}/${total}B`;
              setProg(text);
              usePdbStore.getState().setVbProg(text);
              // 收齐即渲染（早于 0x01）：0x01 完成帧自己还要再等一轮回码（实测
              // notify 未命中时 0.65s+），而分片连续性+总长校验在拼装时已做，
              // 不必等它确认。提前渲染把换色最后一跳从关键路径摘掉；缺片/不连续
              // 时拼装返回 null，静默回落到 0x01 的正常校验路径，行为不变。
              if (st.total !== null && r.got >= st.total) {
                const fin = vbProgramFinish(st, st.total);
                if (fin) {
                  progRef.current = null; // 0x01 到来不再进节目分支（防重复渲染）
                  const transferMs = t0ProgRef.current != null ? Date.now() - t0ProgRef.current : null;
                  t0ProgRef.current = null;
                  setProg(`节目完成：${r.chunks} 片 / ${r.got}B（期望 ${st.total}B）✓`);
                  usePdbStore.getState().setVbProg(null); // 节目收齐，小窗回到状态/图案视图
                  addLog(
                    `节目数据接收完毕 ${r.got}/${st.total}B（收齐即渲染，不等 0x01）`
                    + `${transferMs != null ? `，传输 ${transferMs}ms` : ''}`,
                    'ok',
                  );
                  const ex = extractGif(fin.program);
                  if (ex) {
                    addLog(`节目解析：GIF 偏移 ${ex.offset}B，共 ${ex.gif.length}B`, 'info');
                    void renderProgram(fin.program, ex.offset);
                  } else {
                    addLog('节目已收齐，但未找到内嵌 GIF', 'warn');
                  }
                }
              }
            }
          } else if (f.cmd === 0x01 && progRef.current) {
            const st = progRef.current;
            const before = vbProgramCounts(st);
            const total = st.total ?? 0;
            // expectedLen 双重校验（分片连续 + 总长一致）：缺片/总长不符返回 null，
            // 绝不渲染截断 GIF（曾把缺片节目渲染成错误点亮图案）
            const finished = vbProgramFinish(st, st.total);
            // 0x01 即终态：无论成败都清节目状态——重复/迟到的 0x01、迟到分片不再触发拼装渲染
            progRef.current = null;
            const transferMs = t0ProgRef.current != null ? Date.now() - t0ProgRef.current : null;
            t0ProgRef.current = null;
            const tail = `节目完成：${before.chunks} 片 / ${before.got}B（期望 ${total}B）`;
            setProg(`${tail}${finished ? ' ✓' : ' ⚠缺片/总长不符'}`);
            usePdbStore.getState().setVbProg(null); // 节目收齐，小窗回到状态/图案视图
            addLog(
              `节目数据接收完毕 ${before.got}/${total}B${transferMs != null ? `（传输 ${transferMs}ms）` : ''}`,
              finished ? 'ok' : 'warn',
            );
            if (finished) {
              // 拼装节目 → 取内嵌 GIF → 渲染点亮图案（= 真板子显示的内容）
              const ex = extractGif(finished.program);
              if (ex) {
                addLog(`节目解析：GIF 偏移 ${ex.offset}B，共 ${ex.gif.length}B`, 'info');
                void renderProgram(finished.program, ex.offset);
              } else {
                addLog('节目已收齐，但未找到内嵌 GIF', 'warn');
              }
            }
          }
        } else {
          addLog(`← ${frameSummary(hex)}`, 'info');
        }
        // 酷猫协议（kmpd）帧走原路径；PIXDOU 帧由上面的节目渲染处理
        const cmd = hex.slice(0, 2);
        const { w: cw } = previewDimsRef.current;
        if (!f && cmd === '02') {
          for (const p of parseDrawFrame(hex)) pendingRef.current.set(p.y * cw + p.x, p.rgb);
        } else if (!f && cmd === '03') {
          shownRef.current = new Map(pendingRef.current);
          paintCanvas();
        } else if (!f && cmd === '01') {
          pendingRef.current.clear();
          shownRef.current.clear();
          paintCanvas();
        }
        break;
      }
      case 'ack':
        addLog(`回码 ${evt.hex ? pixdouSummary(evt.hex) : ''}`, 'info');
        break;
      case 'ack9':
        // 旁路实际发 {ev:'ack9', cmd, hex}（VirtualBoard.cs），显示回码帧本身
        addLog(`0x09 响应 ${evt.hex ?? ''}`, 'info');
        break;
      case 'read':
        addLog(`App 读轮询 ← ${evt.hex ? pixdouSummary(evt.hex) : ''}`, 'info');
        break;
      case 'ackto':
        addLog(`投递 ${evt.to ?? '?'}：${evt.st ?? '?'}（订阅 ${evt.subs ?? '?'}）${evt.err ? ` ${evt.err}` : ''}`, evt.st === 'Completed' ? 'ok' : 'warn');
        break;
      case 'cfg':
        addLog(`控制：${evt.ack9 ?? evt.acka ?? evt.ack0 ?? evt.ackz ?? '?'}`, 'ok');
        break;
      case 'push':
        addLog(`主动 notify ${evt.hex ?? ''}`, 'info');
        break;
      case 'error':
        addLog(`错误：${evt.msg ?? '?'}`, 'bad');
        break;
      case 'stopped':
        setRunning(false);
        setConnected(false);
        setProg(null);
        progRef.current = null;
        usePdbStore.getState().setVbStatus(false, false, null);
        if (boardInfoTimerRef.current) { clearTimeout(boardInfoTimerRef.current); boardInfoTimerRef.current = null; }
        addLog('虚拟板已停止', 'warn');
        break;
    }
  }, [addLog, paintCanvas, renderProgram]);

  /* 订阅主进程旁路事件（对话框常驻挂载，关闭时日志继续累积） */
  useEffect(() => {
    const unsub = getBridge().onVbEvent(onEvent);
    return () => {
      unsub();
      if (boardInfoTimerRef.current) { clearTimeout(boardInfoTimerRef.current); boardInfoTimerRef.current = null; }
      if (logTimerRef.current) { clearTimeout(logTimerRef.current); logTimerRef.current = null; }
    };
  }, [onEvent]);

  useEffect(() => {
    const handler = (): void => {
      setOpen(true);
      // 收节目时对话框可能没开（预览当时画不了）：重开即补画。store 的点亮掩码
      // 已同步过，这里只补对话框预览；重复解码幂等。
      const lp = lastProgramRef.current;
      if (lp) void renderProgram(lp.program, lp.offset);
    };
    window.addEventListener('pdb:open-virtualboard', handler);
    return () => window.removeEventListener('pdb:open-virtualboard', handler);
  }, [renderProgram]);

  const start = useCallback(async (): Promise<void> => {
    const preset = PROTOCOL_PRESETS.find((p) => p.id === presetId) ?? PROTOCOL_PRESETS[0];
    addLog(`启动旁路（${preset.label}，名 ${name}）…`, 'info');
    const r = await getBridge().vbStart({
      name,
      service: preset.service,
      char: preset.char,
      w: 104,
      h: 104,
      protocol: preset.id === 'pixdou' ? 'pixdou' : 'kmpd',
    });
    if (!r.ok) {
      const err = r.error ?? '?';
      const msg = err.startsWith('compile-failed')
        ? `旁路编译失败：${err.slice('compile-failed'.length).replace(/^[:：]\s*/, '')}`
        : err;
      addLog(`启动失败：${msg}`, 'bad');
      pushToast('danger', '虚拟板启动失败，见日志', 3200);
    } else if (r.w && r.h) {
      // 板信息尺寸的主更新点：vbStart 返回旁路实际生效的板配置（main.mjs 夹取后的 w/h）。
      // 只认这里与 ready 事件，绝不被收到的节目 GIF 尺寸污染。
      boardDimsRef.current = { w: r.w, h: r.h };
    }
  }, [name, presetId, addLog, pushToast]);

  const stop = useCallback(async (): Promise<void> => {
    await getBridge().vbStop();
  }, []);

  /** 清除主画布发光板上的手机点亮图案（只影响本地显示，不涉及手机端） */
  const clearVbLight = useCallback((): void => {
    usePdbStore.getState().setVbLight(null);
    addLog('已清除主画布点亮图案', 'info');
  }, [addLog]);

  const sendButton = useCallback(async (cmd: 0x05 | 0x06): Promise<void> => {
    const r = await getBridge().vbNotify(cmd.toString(16).padStart(2, '0'));
    addLog(`→ 按键事件 0x${cmd.toString(16)}（${cmd === 5 ? '上一色' : '下一色'}）${r.ok ? '' : '（未运行）'}`, r.ok ? 'ok' : 'bad');
  }, [addLog]);

  const sendCtrl = useCallback(async (): Promise<void> => {
    const line = `${ctrlVerb} ${ctrlArg.trim() || 'auto'}`;
    const r = await getBridge().vbCtrl(line);
    addLog(`控制 ${line} → ${r.ok ? '已送达' : `失败（${r.error ?? '未运行'}）`}`, r.ok ? 'ok' : 'bad');
  }, [ctrlVerb, ctrlArg, addLog]);

  const isDesktop = getBridge().env === 'electron';
  const isPixdou = presetId === 'pixdou';

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="本机当作智能板（实验）" wide>
      <div className="pdb-vb">
        <p className="pdb-vb__intro">
          把<strong>这台电脑</strong>广播成一块智能拼豆板——本项目扮演<strong>板子</strong>（被连的一方），
          手机 App 等工具扫描连接后，下发的图案会实时显示在下面的点阵预览里，原始帧进日志（用于对照真实协议）。
          图案同时显示在页面右下角的「智能板」小窗，点小窗里的「画布点亮」可把主画布临时变成发光板。
        </p>
        {!isDesktop && (
          <div className="pdb-vb__alert"><PdbIcon name="warning" size={15} /><span>浏览器模式无蓝牙外设能力，请在桌面应用中使用。</span></div>
        )}

        <div className="pdb-vb__bar">
          <label className="pdb-vb__field">
            <span className="pdb-label">协议</span>
            <select className="pdb-vb__input" value={presetId} onChange={(e) => setPresetId(e.target.value as PresetId)} aria-label="协议预设">
              {PROTOCOL_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="pdb-vb__field">
            <span className="pdb-label">广播标识*</span>
            <input className="pdb-vb__input pdb-vb__input--name" value={name} onChange={(e) => setName(e.target.value)} aria-label="广播名" maxLength={20} />
          </label>
          {running ? (
            <Button variant="outline" onClick={() => void stop()}>
              <PdbIcon name="close" size={15} /> 停止
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void start()} disabled={!isDesktop}>
              <PdbIcon name="monitor" size={15} /> 开始广播
            </Button>
          )}
          <span className={`pdb-vb__chip ${connected ? 'is-on' : running ? 'is-wait' : ''}`}>
            {connected ? '手机已连接' : running ? '等待连接…' : '未运行'}
          </span>
          {prog && <span className="pdb-vb__chip is-wait">{prog}</span>}
        </div>
        <p className="pdb-vb__note">
          * Windows 托管广播设备名（用本机蓝牙适配器名，代码改不了）：若 App 按 <code>pindou-</code> /
          <code>kmpd-</code> 前缀过滤设备，请到 Windows 设置 → 蓝牙和其他设备 → 重命名这台电脑再重试；
          颂拼豆按服务 UUID（a950/a951）过滤，对名字无要求。
        </p>

        {isPixdou && running && (
          <div className="pdb-vb__bar">
            <label className="pdb-vb__field">
              <span className="pdb-label">回码控制</span>
              <select className="pdb-vb__input" value={ctrlVerb} onChange={(e) => setCtrlVerb(e.target.value as typeof ctrlVerb)} aria-label="控制命令">
                <option value="ack9">0x09 查询响应</option>
                <option value="acka">0x0A 状态响应</option>
                <option value="ack0">0x00 分片应答</option>
                <option value="ackz">其他命令响应</option>
                <option value="push">主动 notify</option>
              </select>
            </label>
            <label className="pdb-vb__field">
              <span className="pdb-label">参数</span>
              <input className="pdb-vb__input pdb-vb__input--name" value={ctrlArg} onChange={(e) => setCtrlArg(e.target.value)} aria-label="参数（auto 或 hex payload）" placeholder="auto 或 hex（如 0100）" maxLength={260} />
            </label>
            <Button size="sm" variant="outline" onClick={() => void sendCtrl()}>发送</Button>
            <span className="pdb-vb__muted">ack9/acka/ack0/ackz 设响应 payload（auto=回退轮转/回显）；push 立即向两特征 notify 原始 hex</span>
          </div>
        )}

        <div className="pdb-vb__main">
          <div className="pdb-vb__board">
            <canvas ref={canvasRef} className="pdb-vb__canvas" width={416} height={416} aria-label="虚拟板点阵预览" />
            <div className="pdb-vb__acts">
              {!isPixdou && (
                <>
                  <Button size="sm" variant="outline" onClick={() => void sendButton(0x05)} disabled={!running}>◀ 上一色（0x05）</Button>
                  <Button size="sm" variant="outline" onClick={() => void sendButton(0x06)} disabled={!running}>下一色（0x06）▶</Button>
                </>
              )}
              {isPixdou && vbLight && (
                <Button size="sm" variant="outline" onClick={clearVbLight} title="清除主画布发光板上由手机下发的点亮图案">
                  <PdbIcon name="close" size={13} /> 清除主画布点亮（{vbLight.count} 格）
                </Button>
              )}
              <span className="pdb-vb__muted">{w}×{h} 点阵 · 屏幕即灯板</span>
            </div>
          </div>
          <div className="pdb-vb__logwrap">
            <span className="pdb-label">事件日志（{log.length}）
              {log.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    logQueueRef.current = []; // 清掉未 flush 的队列，否则清空后旧事件又冒出来
                    if (logTimerRef.current) { clearTimeout(logTimerRef.current); logTimerRef.current = null; }
                    setLog([]);
                  }}
                >清空</Button>
              )}
            </span>
            <ul className="pdb-vb__log">
              {log.length === 0 && <li className="pdb-vb__muted">还没有事件。点「开始广播」，再用手机 App 连接。</li>}
              {log.map((r) => (
                <li key={r.id} className={`pdb-vb__logrow is-${r.kind}`}>
                  <span className="pdb-vb__logt">{r.t}</span> {r.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Modal>
  );
}
