/**
 * palette/PalettePicker —— 色板切换卡片。
 * 列出 4 套内置色板 + 用户自定义色板，显示 品牌 / 色数 / 豆径(mm) / 数据来源，
 * 当前选中态清晰；顶部提供「管理」入口打开 PaletteManager（复制/导入导出/删除/恢复）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { usePdbStore } from '@/store';
import { getPalette, listPalettes, type PaletteSummary } from '@/palettes';
import { PaletteManager } from './PaletteManager';
import './palette.css';

export function PalettePicker() {
  const paletteId = usePdbStore((s) => s.paletteId);
  const setPaletteId = usePdbStore((s) => s.setPaletteId);
  const [managerOpen, setManagerOpen] = useState(false);
  const [list, setList] = useState<PaletteSummary[]>(() => listPalettes());
  /** 缩略模式（用户反馈）：默认只显示在用的色板卡，点击展开全部进行切换 */
  const [open, setOpen] = useState(false);

  // paletteId 变化或管理弹窗开合后（可能新增/删除自定义色板）刷新列表
  useEffect(() => {
    setList(listPalettes());
  }, [paletteId, managerOpen]);

  // 每张卡片的迷你色带（最多 16 段，均匀取样）
  const strips = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of list) {
      const colors = getPalette(p.id).colors;
      const step = Math.max(1, Math.floor(colors.length / 16));
      const arr: string[] = [];
      for (let i = 0; i < colors.length && arr.length < 16; i += step) arr.push(colors[i].hex);
      m.set(p.id, arr);
    }
    return m;
  }, [list]);

  return (
    <div className="pdb-pal-picker">
      <div className="pdb-pal-picker__head">
        <span className="pdb-label">调色板</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setManagerOpen(true)}
          title="管理色板：复制 / 导入导出 JSON / 删除 / 恢复内置"
        >
          <PdbIcon name="settings" size={13} /> 管理
        </Button>
      </div>

      <div className={`pdb-pal-picker__grid ${open ? '' : 'is-collapsed'}`}>
        {(open ? list : list.filter((p) => p.id === paletteId)).map((p) => {
          const active = p.id === paletteId;
          const strip = strips.get(p.id) ?? [];
          return (
            <button
              key={p.id}
              type="button"
              className={`pdb-pal-card pdb-pressable ${active ? 'is-active' : ''}`}
              onClick={() => {
                if (!open) {
                  setOpen(true); // 缩略态：先展开全部色板
                  return;
                }
                if (!active) setPaletteId(p.id); // 展开态：切换后收回
                setOpen(false);
              }}
              aria-pressed={active}
              title={`切换到 ${p.name}（${p.colorCount} 色 · 豆径 ${p.beadSizeMm}mm）\n数据来源：${p.source ?? '内置'}`}
            >
              {!p.builtin && <span className="pdb-pal-card__badge">自定义</span>}
              <span className="pdb-pal-card__top">
                <span className="pdb-pal-card__brand">{p.brand}</span>
                <span className="pdb-pal-card__count">{p.colorCount} 色</span>
              </span>
              <span className="pdb-pal-card__name">{p.name}</span>
              <span className="pdb-pal-card__strip" aria-hidden>
                {strip.map((hex, i) => (
                  <span key={i} style={{ background: hex }} />
                ))}
              </span>
              <span className="pdb-pal-card__meta">
                <span className="pdb-chip">豆径 {p.beadSizeMm}mm</span>
                {active && <span className="pdb-chip pdb-chip--active">{open ? '使用中' : `使用中 · 点此展开 ${list.length} 块色板切换`}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <PaletteManager open={managerOpen} onClose={() => setManagerOpen(false)} />
    </div>
  );
}
