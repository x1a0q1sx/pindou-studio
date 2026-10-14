/**
 * layout/DualPalette.tsx —— dual 布局的调色板浮动弹层（体验优化 #4）。
 *
 * 双板并排布局没有右侧面板，选色/换色板原本必须切回其他布局。这里在右下角
 * 提供一个浮动按钮，点开即得「色板切换 + 全部色卡」的迷你选色层：
 *   ・按钮可拖动换位置（复用拼豆 FAB 的手势语义：位移 <6px 视为点击）；
 *   ・点击弹层外部自动收起；Esc 收起；
 *   ・选中色写入全局 store（activeColorIndex），两块画布的画笔/标记即时生效。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePdbStore } from '@/store';
import { PalettePicker } from '@/components/palette/PalettePicker';
import { PdbIcon } from '@/components/icons';
import './layout.css';

const BTN = 44;
const DRAG_THRESHOLD = 6;

interface FabPos { x: number; y: number }

const POS_KEY = 'pindou-studio:dual-palette:v1';

function clampPos(p: FabPos): FabPos {
  const x = Math.min(Math.max(p.x, 8), window.innerWidth - BTN - 8);
  const y = Math.min(Math.max(p.y, 8), window.innerHeight - BTN - 8);
  return { x, y };
}

function loadPos(): FabPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as FabPos;
      if (typeof p.x === 'number' && typeof p.y === 'number') return clampPos(p);
    }
  } catch {
    /* 损坏回退默认 */
  }
  return { x: window.innerWidth - BTN - 18, y: Math.round(window.innerHeight * 0.42) };
}

/** dual 布局调色板浮动按钮 + 弹层 */
export function DualPalette() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<FabPos>(loadPos);
  const dragRef = useRef<{ px: number; py: number; bx: number; by: number; moved: boolean } | null>(null);
  const btnRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const palette = usePdbStore((s) => s.palette);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  const setActiveColorIndex = usePdbStore((s) => s.setActiveColorIndex);

  /* 视口变化时把按钮夹回可视区 */
  useEffect(() => {
    const onResize = (): void => setPos((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* 弹层打开时：点击按钮/弹层以外区域收起 */
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return;
    dragRef.current = { px: e.clientX, py: e.clientY, bx: pos.x, by: pos.y, moved: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败不视为错误 */
    }
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    const next = clampPos({ x: d.bx + dx, y: d.by + dy });
    setPos(next);
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(next));
    } catch {
      /* 本次会话生效即可 */
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 无效/合成 pointerId：忽略，收尾逻辑照常 */
    }
    if (!d) return;
    if (!d.moved) setOpen((v) => !v);
  }, []);

  /* 弹层锚定：按钮在右半屏 → 弹层向左展开，否则向右 */
  const popLeft = pos.x > window.innerWidth / 2
    ? Math.max(8, pos.x - 300 - 12)
    : Math.min(pos.x + BTN + 12, Math.max(8, window.innerWidth - 308));
  const popTop = Math.min(Math.max(pos.y - 80, 10), Math.max(10, window.innerHeight - 460));

  return (
    <>
      {open && (
        <div
          ref={popRef}
          className="pdb-dual-palette__pop"
          role="dialog"
          aria-label="调色板（dual 布局）"
          style={{ left: popLeft, top: popTop }}
        >
          <header className="pdb-dual-palette__head">
            <span className="pdb-label">
              <PdbIcon name="color" size={13} />
              选色（作用于两块板）
            </span>
          </header>
          <PalettePicker />
          <div className="pdb-dual-palette__grid">
            {palette.colors.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`pdb-swatch pdb-pressable ${i === activeColorIndex ? 'is-active' : ''}`}
                style={{ background: c.hex }}
                title={`${c.code} ${c.nameZh ?? c.name}`}
                aria-label={`${c.code} ${c.nameZh ?? c.name}`}
                onClick={() => setActiveColorIndex(i)}
              />
            ))}
          </div>
        </div>
      )}
      <div ref={btnRef} className="pdb-dual-palette" style={{ left: pos.x, top: pos.y }}>
        <button
          type="button"
          className={`pdb-dual-palette__btn pdb-pressable ${open ? 'is-open' : ''}`}
          style={{ width: BTN, height: BTN }}
          aria-expanded={open}
          aria-label={open ? '收起调色板' : '打开调色板（可拖动）'}
          title={open ? '收起调色板' : '调色板 · 拖动可换位置'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <PdbIcon name={open ? 'close' : 'color'} size={20} />
        </button>
      </div>
    </>
  );
}
