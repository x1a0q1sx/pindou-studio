/**
 * layout/StatusBar —— 底部状态栏（classic/split）。
 * 显示板规格、缩放、beadsVersion、运行环境，以及【验收点】当前主题 Canvas 令牌读值。
 *
 *  追加：当前工具名 + 光标所在格 (行, 列) + 当前色号与名称 + 撤销栈顶 peekLabel()。
 * 光标格不读 store，而是读 `usePointerPaint` 的轻量外部 store（useSyncExternalStore），
 * 避开「每移一格就重渲染整个 AppShell」的灾难。
 */
import { usePdbStore } from '@/store';
import { peekLabel } from '@/store/history';
import { getTheme } from '@/themes';
import { getBridge } from '@/io/bridge';
import { PdbIcon, TOOL_ICONS, TOOL_LABELS } from '@/components/icons';
import { usePaintUi } from '@/hooks/usePointerPaint';
import { TOOL_HOTKEYS } from '@/hooks/hotkeyMap';

export function StatusBar() {
  const board = usePdbStore((s) => s.board);
  const view = usePdbStore((s) => s.view);
  const beadsVersion = usePdbStore((s) => s.beadsVersion);
  const themeId = usePdbStore((s) => s.theme);
  const mode = usePdbStore((s) => s.mode);
  const region = usePdbStore((s) => s.region);
  const tool = usePdbStore((s) => s.tool);
  const palette = usePdbStore((s) => s.palette);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  /** 只为让 peekLabel() 反应式：past 数组引用一变就重算 */
  const pastLen = usePdbStore((s) => s.past.length);
  const { hoverCell } = usePaintUi();

  const tokens = getTheme(themeId).canvas;
  const bridge = getBridge();
  const regionLabel = `${String.fromCharCode(65 + Math.floor(region.activeIndex / Math.max(1, region.splitsX)))}${(region.activeIndex % Math.max(1, region.splitsX)) + 1}`;
  const activeColor = palette.colors[activeColorIndex] ?? null;
  const topLabel = pastLen > 0 ? peekLabel() : null;

  return (
    <footer className="pdb-statusbar" aria-label="状态栏">
      <span className="pdb-chip" title="应用模式">
        <PdbIcon name={mode === 'placement' ? 'bead' : 'pencil'} size={12} />
        {mode === 'placement' ? '拼豆模式' : '设计模式'}
      </span>
      <span className="pdb-chip" title={`当前工具 · ${TOOL_HOTKEYS[tool]}`}>
        <PdbIcon name={TOOL_ICONS[tool]!} size={12} />
        <span className="pdb-statusbar__tool">{TOOL_LABELS[tool]}</span>
      </span>
      <span className="pdb-chip pdb-statusbar__cell" title="光标所在格（绝对行列，1 起计）">
        <PdbIcon name="ruler" size={12} />
        {hoverCell ? `(${hoverCell.row + 1}, ${hoverCell.col + 1})` : '(–, –)'}
      </span>
      <span className="pdb-chip" title="当前色（数字键 1–9 快速选色，取色器 I 可吸取）">
        {activeColor ? (
          <>
            <span className="pdb-statusbar__swatch" style={{ background: activeColor.hex }} />
            {activeColor.code} {activeColor.nameZh ?? activeColor.name}
          </>
        ) : (
          '无色'
        )}
      </span>
      <span className="pdb-chip pdb-statusbar__opt-2" title="撤销栈顶（Ctrl+Z 可撤销的下一步）">
        <PdbIcon name="undo" size={12} />
        {topLabel ?? '无可撤销'}
      </span>
      <span className="pdb-chip" title="板规格">
        <PdbIcon name="grid" size={12} />
        {board.cols}×{board.rows} · {board.pitchMm}mm
      </span>
      <span className="pdb-chip pdb-statusbar__opt-2" title="当前区块（/ 分区导航）">
        <PdbIcon name="blocks" size={12} />
        区块 {regionLabel}（{region.splitsX}×{region.splitsY}）
      </span>
      <span className="pdb-chip" title="设计视图缩放（拼豆 1:1 由  锁定）">
        <PdbIcon name="zoomIn" size={12} />
        {Math.round(view.scale * 100)}%
      </span>
      <span className="pdb-chip pdb-statusbar__opt-1" title="beads 版本号：typed array 变更计数（store 契约）">
        v{beadsVersion}
      </span>
      <span className="pdb-toolbar__spacer" />
      {/* 验收点 5：主题切换时 Canvas 令牌直接从主题对象读取（Canvas 读不到 CSS 变量） */}
      <span
        className="pdb-chip pdb-chip--canvas-proof pdb-statusbar__opt-1"
        title="Canvas 令牌验证点：canvasBg / gridLine 来自主题对象而非 CSS 变量"
      >
        <span className="pdb-chip__dot" style={{ background: tokens.canvasBg, border: `1px solid ${tokens.gridLineMajor}` }} />
        canvas {tokens.canvasBg} · glow {String(tokens.highlightGlow)}
      </span>
      <span className="pdb-chip pdb-statusbar__opt-2" title="运行环境（io/bridge.ts 能力探测）">
        <PdbIcon name="monitor" size={12} />
        {bridge.env === 'electron' ? 'Electron' : '浏览器'}
      </span>
    </footer>
  );
}
