/**
 * palette/ColorEditor —— 编辑单个颜色的弹窗。
 * 能力：改 HEX（文本 + 原生取色器 + HSL 三滑杆联动）、改色号/中英名称、吸管取色、
 * 「替换为另一色」（全图迁移 beads 索引）、「删除」（有用量时弹确认：替换为…/全部留空）、
 * 「新增自定义色」。编辑模式下改动实时写回 store（画布同步预览）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ColorInput } from '@/components/ui/ColorInput';
import { Slider } from '@/components/ui/Slider';
import { PdbIcon } from '@/components/icons';
import { EyedropperButton } from './EyedropperButton';
import { usePdbStore } from '@/store';
import { hexToRgb, rgbToHex, rgbToHsl, hslToRgb, rgbToLab, type Hsl, type Rgb } from '@/color/convert';
import type { BeadColorInput } from '@/palettes/types';
import './palette.css';

export interface ColorEditorProps {
  open: boolean;
  /** null = 新增自定义色；number = 编辑该调色板索引的颜色 */
  index: number | null;
  onClose: () => void;
}

function makeNewColor(n: number): BeadColorInput {
  return {
    id: `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    code: `U${String(n + 1).padStart(3, '0')}`,
    name: 'Custom',
    nameZh: '自定义',
    hex: '#FF9BB3',
    series: '自定义 Custom',
    builtin: false,
  };
}

export function ColorEditor({ open, index, onClose }: ColorEditorProps) {
  const palette = usePdbStore((s) => s.palette);
  const updateColor = usePdbStore((s) => s.updateColor);
  const removeColor = usePdbStore((s) => s.removeColor);
  const replaceColorGlobal = usePdbStore((s) => s.replaceColorGlobal);
  const addColor = usePdbStore((s) => s.addColor);
  const pushToast = usePdbStore((s) => s.pushToast);

  const target = index !== null ? (palette.colors[index] ?? null) : null;
  const [draft, setDraft] = useState<BeadColorInput>(() => makeNewColor(palette.colors.length));
  const [replaceTarget, setReplaceTarget] = useState(-1);
  const [deleteTarget, setDeleteTarget] = useState(-1);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 打开时初始化：新增模式重置草稿；编辑模式预置替换/删除目标为第一个「其它色」
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    const firstOther = palette.colors.findIndex((_, i) => i !== index);
    setReplaceTarget(firstOther);
    setDeleteTarget(firstOther);
    if (index === null) setDraft(makeNewColor(palette.colors.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  const working: BeadColorInput = target
    ? {
        id: target.id,
        code: target.code,
        name: target.name,
        nameZh: target.nameZh,
        hex: target.hex,
        series: target.series,
        builtin: target.builtin,
      }
    : draft;

  const apply = (patch: Partial<BeadColorInput>): void => {
    if (index !== null) updateColor(index, patch);
    else setDraft((d) => ({ ...d, ...patch }));
  };

  // 本图用量 / 已放置（仅编辑模式有意义）——读 store 增量统计（computeStats 在变更入口
  // 重算一次），不再渲染期全板扫描
  const colorStats = usePdbStore((s) => s.colorStats);
  const usage = useMemo(() => {
    if (index === null) return { used: 0, placed: 0 };
    const v = index + 1;
    return { used: colorStats.total[v] ?? 0, placed: colorStats.placed[v] ?? 0 };
  }, [index, colorStats]);

  const rgb = useMemo<Rgb>(() => {
    try {
      return hexToRgb(working.hex);
    } catch {
      return [0, 0, 0];
    }
  }, [working.hex]);
  const hsl = useMemo<Hsl>(() => rgbToHsl(rgb), [rgb]);
  const lab = useMemo(() => rgbToLab(rgb), [rgb]);

  const setHslComp = (comp: 0 | 1 | 2, val: number): void => {
    const next: Hsl = [hsl[0], hsl[1], hsl[2]];
    next[comp] = val;
    const nrgb = hslToRgb(next);
    apply({ hex: rgbToHex(nrgb[0], nrgb[1], nrgb[2]) });
  };

  const doReplace = (): void => {
    if (index === null) return;
    if (replaceTarget < 0 || replaceTarget === index) {
      pushToast('warning', '请选择一个不同的目标色');
      return;
    }
    const migrated = usage.used;
    replaceColorGlobal(index, replaceTarget);
    pushToast('success', `已把本图 ${migrated} 格迁移到 ${palette.colors[replaceTarget]?.code ?? '目标色'}`);
  };

  const beginDelete = (): void => {
    if (index === null) return;
    if (usage.used === 0) {
      doDelete(null);
      return;
    }
    setConfirmDelete(true);
  };

  const doDelete = (repl: number | null): void => {
    if (index === null) return;
    const code = repl !== null ? (palette.colors[repl]?.code ?? '目标色') : null;
    removeColor(index, repl);
    pushToast('success', code ? `已删除该色，${usage.used} 格替换为 ${code}` : `已删除该色，${usage.used} 格留空`);
    onClose();
  };

  const doAdd = (): void => {
    const code = draft.code.trim() || `U${palette.colors.length + 1}`;
    addColor({ ...draft, code });
    pushToast('success', `已新增颜色 ${code}`);
    onClose();
  };

  const otherOptions = palette.colors
    .map((c, i) => ({ c, i }))
    .filter((x) => x.i !== index);

  const title = index === null ? '新增自定义色' : `编辑颜色 · ${target?.code ?? ''}`;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        index === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" onClick={doAdd}>
              <PdbIcon name="plus" size={15} /> 添加颜色
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        )
      }
    >
      <div className="pdb-cedit">
        {/* 预览 + 吸管 */}
        <div className="pdb-cedit__preview">
          <div className="pdb-cedit__chip" style={{ background: working.hex }} />
          <div className="pdb-cedit__titles">
            <span className="pdb-cedit__code">{working.code || '—'}</span>
            <span className="pdb-cedit__sub">
              {working.nameZh ? `${working.nameZh} · ` : ''}
              {working.name}
            </span>
            <span className="pdb-cedit__sub">
              HEX {working.hex.toUpperCase()} · Lab({lab[0].toFixed(1)}, {lab[1].toFixed(1)}, {lab[2].toFixed(1)})
            </span>
          </div>
          <span style={{ marginLeft: 'auto' }}>
            <EyedropperButton onPick={(c) => apply({ hex: c.hex })} size="md" />
          </span>
        </div>

        {/* HEX + 原生取色器 */}
        <div className="pdb-cedit__field">
          <label htmlFor="cedit-hex">HEX</label>
          <span id="cedit-hex">
            <ColorInput value={working.hex} onChange={(hex) => apply({ hex })} />
          </span>
        </div>

        {/* HSL 三滑杆联动 */}
        <div className="pdb-cedit__hsl">
          <div className="pdb-cedit__hsl-row">
            <span>H</span>
            <Slider min={0} max={360} step={1} value={Math.round(hsl[0])} onValueChange={(v) => setHslComp(0, v)} format={(v) => `${v}°`} />
          </div>
          <div className="pdb-cedit__hsl-row">
            <span>S</span>
            <Slider min={0} max={100} step={1} value={Math.round(hsl[1])} onValueChange={(v) => setHslComp(1, v)} format={(v) => `${v}%`} />
          </div>
          <div className="pdb-cedit__hsl-row">
            <span>L</span>
            <Slider min={0} max={100} step={1} value={Math.round(hsl[2])} onValueChange={(v) => setHslComp(2, v)} format={(v) => `${v}%`} />
          </div>
        </div>

        {/* 色号 / 名称 */}
        <div className="pdb-cedit__field">
          <label htmlFor="cedit-code">色号</label>
          <input id="cedit-code" className="pdb-cedit__text" value={working.code} onChange={(e) => apply({ code: e.target.value })} />
        </div>
        <div className="pdb-cedit__field">
          <label htmlFor="cedit-name">英文名</label>
          <input id="cedit-name" className="pdb-cedit__text" value={working.name} onChange={(e) => apply({ name: e.target.value })} />
        </div>
        <div className="pdb-cedit__field">
          <label htmlFor="cedit-namezh">中文名</label>
          <input
            id="cedit-namezh"
            className="pdb-cedit__text"
            value={working.nameZh ?? ''}
            onChange={(e) => apply({ nameZh: e.target.value })}
          />
        </div>

        {/* 编辑模式：用量 / 替换 / 删除 */}
        {index !== null && target && (
          <>
            <div className="pdb-cedit__section">
              <span className="pdb-cedit__section-title">本图用量</span>
              <span className="pdb-cedit__hint">
                共 <b>{usage.used}</b> 格 · 已放置 {usage.placed} · 剩余待放 {usage.used - usage.placed}
              </span>
            </div>

            <div className="pdb-cedit__section">
              <span className="pdb-cedit__section-title">替换为另一色（全图迁移）</span>
              <select
                className="pdb-cedit__select"
                value={replaceTarget}
                onChange={(e) => setReplaceTarget(Number(e.target.value))}
              >
                {otherOptions.map((x) => (
                  <option key={x.c.id} value={x.i}>
                    {x.c.code} · {x.c.nameZh || x.c.name} · {x.c.hex}
                  </option>
                ))}
              </select>
              <span className="pdb-cedit__rowbtns">
                <Button size="sm" variant="soft" onClick={doReplace} disabled={otherOptions.length === 0}>
                  <PdbIcon name="replaceColor" size={14} /> 全图替换为该色
                </Button>
              </span>
              <span className="pdb-cedit__hint">两色都保留，仅把本图中「本色」的格子改成目标色。</span>
            </div>

            <div className="pdb-cedit__section">
              <span className="pdb-cedit__section-title">删除该色</span>
              {!confirmDelete ? (
                <span className="pdb-cedit__rowbtns">
                  <Button size="sm" variant="danger" onClick={beginDelete}>
                    <PdbIcon name="trash" size={14} /> 删除…
                  </Button>
                </span>
              ) : (
                <div className="pdb-cedit__section" style={{ borderTop: 'none', paddingTop: 0 }}>
                  <span className="pdb-cedit__warn">
                    <PdbIcon name="warning" size={15} /> 该色有 {usage.used} 格，如何处理？
                  </span>
                  <select
                    className="pdb-cedit__select"
                    value={deleteTarget}
                    onChange={(e) => setDeleteTarget(Number(e.target.value))}
                  >
                    {otherOptions.map((x) => (
                      <option key={x.c.id} value={x.i}>
                        替换为 {x.c.code} · {x.c.nameZh || x.c.name}
                      </option>
                    ))}
                  </select>
                  <span className="pdb-cedit__rowbtns">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={deleteTarget < 0 || deleteTarget === index}
                      onClick={() => doDelete(deleteTarget)}
                    >
                      替换并删除
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => doDelete(null)}>
                      全部留空
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                      取消
                    </Button>
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
