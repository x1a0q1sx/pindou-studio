/**
 * palette/PaletteManager —— 色板管理弹窗。
 * 复制内置色板为自定义副本再编辑、色板 JSON 导入/导出、恢复内置默认、删除自定义色板。
 * 自定义色板独立存 localStorage，永不污染内置数据。
 */
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { usePdbStore } from '@/store';
import { getBridge } from '@/io/bridge';
import {
  DEFAULT_PALETTE_ID,
  clonePaletteAsCustom,
  deleteCustomPalette,
  exportPaletteJson,
  getPalette,
  importPaletteJson,
  listPalettes,
  saveCustomPalette,
  type PaletteSummary,
} from '@/palettes';
import './palette.css';

export interface PaletteManagerProps {
  open: boolean;
  onClose: () => void;
}

function dataUrlToText(dataUrl: string): string {
  const b64 = dataUrl.split(',')[1] ?? '';
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function PaletteManager({ open, onClose }: PaletteManagerProps) {
  const paletteId = usePdbStore((s) => s.paletteId);
  const setPaletteId = usePdbStore((s) => s.setPaletteId);
  const resetPaletteToBuiltin = usePdbStore((s) => s.resetPaletteToBuiltin);
  const pushToast = usePdbStore((s) => s.pushToast);

  const [list, setList] = useState<PaletteSummary[]>(() => listPalettes());
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');
  const [exportText, setExportText] = useState('');

  const reload = (): void => setList(listPalettes());

  useEffect(() => {
    if (open) {
      reload();
      setImportErr('');
    }
  }, [open]);

  const doClone = (id: string): void => {
    const base = getPalette(id);
    const clone = clonePaletteAsCustom(id, `${base.name} 副本`);
    setPaletteId(clone.id);
    reload();
    pushToast('success', `已复制为自定义色板「${clone.name}」，可自由编辑`);
  };

  const doExport = async (id: string): Promise<void> => {
    const p = getPalette(id);
    const text = exportPaletteJson(p);
    setExportText(text);
    const saved = await getBridge().saveFile(`${p.id}-palette.json`, { text });
    if (saved) {
      pushToast('success', `已导出「${p.name}」色板 JSON`);
    }
  };

  const doDelete = (id: string): void => {
    deleteCustomPalette(id);
    if (paletteId === id) setPaletteId(DEFAULT_PALETTE_ID);
    reload();
    pushToast('success', '已删除自定义色板');
  };

  const doImport = (): void => {
    if (!importText.trim()) {
      setImportErr('请先粘贴或选择 JSON 内容');
      return;
    }
    try {
      const p = importPaletteJson(importText);
      saveCustomPalette(p);
      setPaletteId(p.id);
      setImportErr('');
      setImportText('');
      reload();
      pushToast('success', `已导入色板「${p.name}」（${p.colors.length} 色）`);
    } catch (e) {
      setImportErr((e as Error).message);
    }
  };

  const doPickFile = async (): Promise<void> => {
    const res = await getBridge().openFile([{ name: 'JSON 色板', extensions: ['json'] }]);
    if (!res) return;
    try {
      setImportText(dataUrlToText(res.dataUrl));
      setImportErr('');
    } catch {
      setImportErr('文件读取失败，请改用粘贴 JSON');
    }
  };

  const currentIsBuiltin = list.some((p) => p.id === paletteId && p.builtin);

  return (
    <Modal open={open} title="色板管理" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>关闭</Button>}>
      <div className="pdb-pman">
        <div className="pdb-pman__list">
          {list.map((p) => (
            <div key={p.id} className={`pdb-pman__item ${p.id === paletteId ? 'is-current' : ''}`}>
              <div className="pdb-pman__item-info">
                <span className="pdb-pman__item-name">
                  {p.name}
                  {p.builtin ? '' : ' ·自定义'}
                  {p.id === paletteId ? ' ·当前' : ''}
                </span>
                <span className="pdb-pman__item-sub">
                  {p.brand} · {p.colorCount} 色 · {p.beadSizeMm}mm
                </span>
              </div>
              <div className="pdb-pman__item-actions">
                {p.id !== paletteId && (
                  <Button size="sm" variant="ghost" onClick={() => setPaletteId(p.id)}>
                    切换
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon onClick={() => doClone(p.id)} aria-label="复制为自定义色板" title="复制为自定义副本">
                  <PdbIcon name="copy" size={14} />
                </Button>
                <Button size="sm" variant="ghost" icon onClick={() => void doExport(p.id)} aria-label="导出 JSON" title="导出 JSON">
                  <PdbIcon name="export" size={14} />
                </Button>
                {!p.builtin && (
                  <Button size="sm" variant="ghost" icon onClick={() => doDelete(p.id)} aria-label="删除自定义色板" title="删除">
                    <PdbIcon name="trash" size={14} />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {currentIsBuiltin && (
          <div className="pdb-pman__section">
            <span className="pdb-pman__section-title">恢复默认</span>
            <span className="pdb-cedit__hint">
              当前为内置色板。若你在颜色编辑器里做过临时改动，可一键恢复注册表中的原始版本（不影响自定义色板）。
            </span>
            <span className="pdb-cedit__rowbtns">
              <Button size="sm" variant="outline" onClick={() => { resetPaletteToBuiltin(); pushToast('success', '已恢复内置原始版本'); }}>
                <PdbIcon name="undo" size={14} /> 恢复内置原始版本
              </Button>
            </span>
          </div>
        )}

        <div className="pdb-pman__section">
          <span className="pdb-pman__section-title">导入色板 JSON</span>
          <textarea
            className="pdb-pman__textarea"
            value={importText}
            placeholder='粘贴 { "format": "pindou-studio/palette", ... } 或点「从文件选择」'
            spellCheck={false}
            onChange={(e) => setImportText(e.target.value)}
          />
          {importErr && <span className="pdb-pman__err">{importErr}</span>}
          <span className="pdb-cedit__rowbtns">
            <Button size="sm" variant="ghost" onClick={() => void doPickFile()}>
              <PdbIcon name="folderOpen" size={14} /> 从文件选择
            </Button>
            <Button size="sm" variant="primary" onClick={doImport}>
              <PdbIcon name="import" size={14} /> 导入为新自定义色板
            </Button>
          </span>
        </div>

        {exportText && (
          <div className="pdb-pman__section">
            <span className="pdb-pman__section-title">最近导出（可复制）</span>
            <textarea className="pdb-pman__textarea" value={exportText} readOnly spellCheck={false} />
          </div>
        )}
      </div>
    </Modal>
  );
}
