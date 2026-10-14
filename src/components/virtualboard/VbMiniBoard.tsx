/**
 * virtualboard/VbMiniBoard.tsx —— 设计模式右下角的「智能板」悬浮小窗。
 *
 * 虚拟板旁路在跑（或已有手机图案）时出现：实时显示手机下发的点亮图案（点阵原色重绘，
 * App 会把色号画进 GIF，这里忠实还原）、连接/下发进度状态，并提供三个动作：
 * 画布点亮开关（主画布临时切 panel 发光板档，见 store.setVbCanvasOn）、清除、打开面板。
 * 拼豆模式自动退场 —— 那边主画布本身就在亮（顶栏 chip 负责状态）。
 *
 * 纯 UI 组件：状态全走 store（VirtualBoardDialog 的 onEvent 写入），**不订阅 bridge
 * 事件** —— preload 的 onVbEvent 回调是单订阅位，对话框已占用。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { usePdbStore } from '@/store';

/** 小窗点阵画布的目标边长（CSS px）：104 板 → 2px/格 */
const MINI_SIZE = 208;

export function VbMiniBoard() {
  const mode = usePdbStore((s) => s.mode);
  const vbLight = usePdbStore((s) => s.vbLight);
  const vbRunning = usePdbStore((s) => s.vbRunning);
  const vbConnected = usePdbStore((s) => s.vbConnected);
  const vbProg = usePdbStore((s) => s.vbProg);
  const vbCanvasOn = usePdbStore((s) => s.vbCanvasOn);
  const board = usePdbStore((s) => s.board);
  const [collapsed, setCollapsed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 设计模式 + （旁路在跑 或 已有图案）才出现；从未用过虚拟板时对界面零打扰
  const show = mode === 'design' && (vbRunning || vbLight !== null);
  // 手机图案与设计板尺寸不一致：主画布只能显示落在本板范围内的部分（如板 52、图案 104）
  const mismatch = vbLight !== null && (vbLight.w !== board.cols || vbLight.h !== board.rows);

  // 重绘点阵：黑色（RGB）=熄灭不画，非黑按 App 原色画圆点（与对话框预览同语义）
  useEffect(() => {
    const cv = canvasRef.current;
    if (!show || collapsed || !cv || !vbLight) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const { w, h, rgba } = vbLight;
    const cell = Math.max(2, Math.floor(MINI_SIZE / Math.max(w, h)));
    cv.width = w * cell;
    cv.height = h * cell;
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
        if (r === 0 && g === 0 && b === 0) continue;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(x * cell + cell / 2, y * cell + cell / 2, cell * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [show, collapsed, vbLight]);

  const toggleCanvas = useCallback(() => {
    const s = usePdbStore.getState();
    s.setVbCanvasOn(!s.vbCanvasOn);
  }, []);
  const clearPattern = useCallback(() => {
    // store 的 setVbLight(null) 会联动还原「画布点亮」的档位快照
    usePdbStore.getState().setVbLight(null);
  }, []);
  const openPanel = useCallback(() => {
    window.dispatchEvent(new CustomEvent('pdb:open-virtualboard'));
  }, []);
  /** 一键把设计板改成与手机图案同尺寸（改尺寸会重建数组、清空当前豆子内容） */
  const fitBoard = useCallback(() => {
    const s = usePdbStore.getState();
    const p = s.vbLight;
    if (!p) return;
    // 尺寸护栏与 BoardParamsForm 的 NumberField 夹取一致（4..400）：越界不应用，只提示
    if (p.w < 4 || p.w > 400 || p.h < 4 || p.h > 400) {
      s.pushToast('warning', `手机图案 ${p.w}×${p.h} 超出板尺寸范围（4..400），未应用`, 3600);
      return;
    }
    s.setBoardConfig({ cols: p.w, rows: p.h });
    s.pushToast('success', `板已设为 ${p.w}×${p.h}（与手机图案一致；改尺寸会清空原有内容）`, 3200);
  }, []);

  if (!show) return null;

  const statusText = vbProg ?? (vbConnected ? '手机已连接' : vbRunning ? '等待连接…' : '已停止');

  if (collapsed) {
    return (
      <div className="pdb-vbmini pdb-vbmini--pill">
        <button
          type="button"
          className="pdb-vbmini__pillbtn pdb-pressable"
          onClick={() => setCollapsed(false)}
          aria-label={`展开智能板小窗${vbLight ? `，当前点亮 ${vbLight.count} 格` : ''}`}
        >
          <span className={`pdb-vbmini__dot ${vbConnected ? 'is-on' : ''}`} aria-hidden />
          智能板{vbLight ? ` · ${vbLight.count} 格` : ''}
        </button>
      </div>
    );
  }

  return (
    <aside className="pdb-vbmini" aria-label="智能板小窗">
      <div className="pdb-vbmini__head">
        <span className={`pdb-vbmini__dot ${vbConnected ? 'is-on' : ''}`} aria-hidden />
        <strong>智能板</strong>
        <span className="pdb-vbmini__status" aria-live="polite">{statusText}</span>
        <button type="button" className="pdb-vbmini__fold pdb-pressable" onClick={() => setCollapsed(true)} aria-label="收起小窗">▾</button>
      </div>
      {vbLight ? (
        <>
          <canvas ref={canvasRef} className="pdb-vbmini__canvas" aria-label="手机下发图案预览" />
          <p className="pdb-vbmini__meta">点亮 <strong>{vbLight.count}</strong> 格{vbCanvasOn ? ' · 画布点亮中' : ''}</p>
          {mismatch && (
            <p className="pdb-vbmini__meta pdb-vbmini__warn">
              板 {board.cols}×{board.rows} ≠ 图案 {vbLight.w}×{vbLight.h}，主画布只显示落在板内的部分
              <button
                type="button"
                className="pdb-vbmini__fix pdb-pressable"
                onClick={fitBoard}
                title="把设计板改成与手机图案同尺寸（会清空当前豆子内容）"
              >
                板设为 {vbLight.w}×{vbLight.h}
              </button>
            </p>
          )}
          <div className="pdb-vbmini__acts">
            <Button size="sm" variant={vbCanvasOn ? 'soft' : 'outline'} onClick={toggleCanvas} aria-pressed={vbCanvasOn}>
              {vbCanvasOn ? '画布熄灭' : '画布点亮'}
            </Button>
            <Button size="sm" variant="outline" onClick={clearPattern}>清除</Button>
            <Button size="sm" variant="ghost" onClick={openPanel} title="打开虚拟板面板（广播设置 / 回码控制 / 事件日志）">面板↗</Button>
          </div>
        </>
      ) : (
        !vbProg && (
          <p className="pdb-vbmini__meta">广播中：手机 App 连接后点色号，图案会显示在这里</p>
        )
      )}
    </aside>
  );
}
