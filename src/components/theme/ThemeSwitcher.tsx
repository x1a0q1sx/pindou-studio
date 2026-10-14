/**
 * theme/ThemeSwitcher —— 四张实时预览卡片（色板条 + 迷你画布缩略 + 描述）。
 * 选中即时生效（store.setTheme + applyThemeById）并持久化 localStorage（appearance.ts）。
 * 迷你画布缩略直接用各主题自己的 canvas 令牌着色 —— 所见即所得。
 */
import { usePdbStore } from '@/store';
import { Modal } from '@/components/ui/Modal';
import { PdbIcon } from '@/components/icons';
import { applyThemeById, THEMES, THEME_ORDER } from '@/themes';
import { saveAppearance } from './appearance';
import type { ThemeDefinition } from '@/core/types';
import './switchers.css';

export interface ThemeSwitcherProps {
  open: boolean;
  onClose: () => void;
}

export function ThemeSwitcher({ open, onClose }: ThemeSwitcherProps) {
  const theme = usePdbStore((s) => s.theme);
  const setTheme = usePdbStore((s) => s.setTheme);
  const pushToast = usePdbStore((s) => s.pushToast);

  const choose = (id: ThemeDefinition['id']): void => {
    setTheme(id);
    applyThemeById(id); // 即时生效：data-theme + :root 令牌
    saveAppearance({ theme: id });
    pushToast('success', `已切换到「${THEMES[id]!.name}」主题`);
  };

  return (
    <Modal open={open} title="选择主题" onClose={onClose}>
      <div className="pdb-switcher-grid">
        {THEME_ORDER.map((id, idx) => {
          const t = THEMES[id]!;
          const active = id === theme;
          return (
            <button
              key={id}
              type="button"
              className={`pdb-theme-card pdb-pressable ${active ? 'is-active' : ''}`}
              style={{ background: t.tokens['--surface'], borderColor: active ? t.tokens['--primary'] : t.tokens['--border'], animationDelay: `${idx * 60}ms` }}
              aria-pressed={active}
              onClick={() => choose(id)}
            >
              <span className="pdb-theme-card__head">
                <span aria-hidden>{t.emoji}</span>
                <strong>{t.name}</strong>
                <em>{t.nameEn}</em>
                {active && (
                  <span className="pdb-theme-card__check" style={{ color: t.tokens['--primary'] }}>
                    <PdbIcon name="checkCircle" size={16} />
                  </span>
                )}
              </span>
              <MiniCanvasPreview def={t} />
              <span className="pdb-theme-card__swatches">
                {t.previewSwatches.map((hex) => (
                  <span key={hex} className="pdb-theme-card__swatch" style={{ background: hex }} />
                ))}
              </span>
              <span className="pdb-theme-card__desc" style={{ color: t.tokens['--text-soft'] }}>
                {t.description}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/** 迷你画布缩略：网格 + 4 颗豆点，颜色全部取自该主题的 canvas 令牌（不读 CSS 变量） */
function MiniCanvasPreview({ def }: { def: ThemeDefinition }) {
  const c = def.canvas;
  const beadHexes = def.previewSwatches.slice(0, 4);
  return (
    <svg className="pdb-theme-card__mini" viewBox="0 0 120 56" role="img" aria-label={`${def.name} 画布预览`}>
      <rect width="120" height="56" rx="6" fill={c.canvasBg} />
      {/* 细网格 */}
      {[1, 2, 3, 4, 5].map((i) => (
        <line key={`v${i}`} x1={i * 20} y1="0" x2={i * 20} y2="56" stroke={c.gridLine} strokeWidth="1" />
      ))}
      {[1, 2].map((i) => (
        <line key={`h${i}`} x1="0" y1={i * 18.7} x2="120" y2={i * 18.7} stroke={c.gridLine} strokeWidth="1" />
      ))}
      {/* 主线 */}
      <line x1="60" y1="0" x2="60" y2="56" stroke={c.gridLineMajor} strokeWidth="1.4" />
      {/* 空格 + 豆点（glowDark 下 highlightGlow=true → 外圈发光） */}
      <circle cx="10" cy="10" r="6.5" fill={c.emptyCell} stroke={c.emptyCellStroke} strokeWidth="1" />
      {[0, 1, 2, 3].map((i) => {
        const cx = 30 + (i % 2) * 40;
        const cy = 10 + Math.floor(i / 2) * 28;
        const glow = c.highlightGlow === true;
        return (
          <g key={i}>
            {glow && <circle cx={cx} cy={cy} r="9" fill={beadHexes[i]} opacity="0.35" />}
            <circle cx={cx} cy={cy} r="6.5" fill={beadHexes[i]} stroke={c.beadStroke} strokeWidth="1" />
          </g>
        );
      })}
      <text x="112" y="52" fontSize="7" textAnchor="end" fill={c.numberText}>104</text>
    </svg>
  );
}
