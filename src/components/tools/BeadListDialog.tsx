/**
 * tools/BeadListDialog.tsx —— 外部图纸色号清单对话框（体验优化 #8）。
 *
 * 粘贴别人图纸的用料清单（色号 [+数量] 逐行），解析并匹配到当前色板：
 *   ・精确同号 → 直接对上；
 *   ・当前色板没有该号 → 在其他内置色板里找同号颜色，给当前色板的最近色建议（ΔE2000）；
 *   ・找不到 → 标「未匹配」，不猜。
 * 输出规范化清单（可复制），带合计颗数。入口：左侧工具栏「清单」按钮 / `pdb:open-beadlist` 事件。
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { usePdbStore } from '@/store';
import { parseBeadList, matchBeadList, beadListToText } from '@/core/beadList';

const SAMPLE = 'A1 ×120\nB3 45\nM15: 8';

export function BeadListDialog() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);

  const palette = usePdbStore((s) => s.palette);
  const pushToast = usePdbStore((s) => s.pushToast);
  const setActiveColorIndex = usePdbStore((s) => s.setActiveColorIndex);

  useEffect(() => {
    const handler = (): void => setOpen(true);
    window.addEventListener('pdb:open-beadlist', handler);
    return () => window.removeEventListener('pdb:open-beadlist', handler);
  }, []);

  const result = useMemo(() => {
    if (!text.trim()) return null;
    const parsed = parseBeadList(text);
    return { parsed, matched: matchBeadList(parsed.lines, palette) };
  }, [text, palette]);

  const stats = useMemo(() => {
    if (!result) return null;
    const { matches } = result.matched;
    return {
      total: matches.length,
      exact: matches.filter((m) => m.status === 'exact').length,
      similar: matches.filter((m) => m.status === 'similar').length,
      unmatched: matches.filter((m) => m.status === 'unmatched').length,
      skipped: result.parsed.skipped.length,
    };
  }, [result]);

  const handleCopy = async (): Promise<void> => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(beadListToText(result.matched));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      pushToast('warning', '复制失败：浏览器剪贴板不可用', 2600);
    }
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="色号清单 · 对色与用量" wide>
      <div className="pdb-beadlist">
        <p className="pdb-beadlist__intro">
          把别人图纸的用料清单粘贴到下面（每行「色号 数量」，支持 A1 ×120 / B3 45 / M15: 8 等写法），
          自动对到当前色板「{palette.name}」；色号在别的色板体系时给出最近色建议。
        </p>
        <div className="pdb-beadlist__input-row">
          <textarea
            className="pdb-beadlist__textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={SAMPLE}
            rows={7}
            aria-label="色号清单文本"
          />
          <div className="pdb-beadlist__side">
            {stats && (
              <ul className="pdb-beadlist__stats">
                <li>共 {stats.total} 行色号</li>
                <li className="is-ok">精确 {stats.exact}</li>
                {stats.similar > 0 && <li className="is-warn">近似 {stats.similar}</li>}
                {stats.unmatched > 0 && <li className="is-bad">未匹配 {stats.unmatched}</li>}
                {stats.skipped > 0 && <li>跳过 {stats.skipped} 行（不识别）</li>}
                {result?.matched.totalCount !== null && result && (
                  <li className="is-total">合计 {result.matched.totalCount} 颗</li>
                )}
              </ul>
            )}
            <Button variant="ghost" size="sm" onClick={() => setText(SAMPLE)}>
              填入示例
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setText('')}>
              清空
            </Button>
          </div>
        </div>

        {result && result.matched.matches.length > 0 && (
          <div className="pdb-beadlist__table-wrap">
            <table className="pdb-beadlist__table">
              <thead>
                <tr>
                  <th>原色号</th>
                  <th>数量</th>
                  <th>当前色板</th>
                  <th>说明</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {result.matched.matches.map((m, i) => (
                  <tr key={`${m.parsed.code}-${i}`} className={`is-${m.status}`}>
                    <td className="pdb-beadlist__code">{m.parsed.code}</td>
                    <td>{m.parsed.count ?? '—'}</td>
                    <td>
                      {m.status !== 'unmatched' ? (
                        <span className="pdb-beadlist__color">
                          <span className="pdb-beadlist__swatch" style={{ background: m.hex }} />
                          {m.matchedCode} {m.name}
                        </span>
                      ) : (
                        <span className="pdb-beadlist__miss">未匹配</span>
                      )}
                    </td>
                    <td className="pdb-beadlist__hint">{m.hint ?? (m.status === 'exact' ? '同号直配' : '')}</td>
                    <td>
                      {m.index >= 0 && (
                        <button
                          type="button"
                          className="pdb-beadlist__use"
                          title="设为当前色"
                          onClick={() => {
                            setActiveColorIndex(m.index);
                            pushToast('info', `当前色：${m.matchedCode} ${m.name}`, 1400);
                          }}
                        >
                          选它
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="pdb-beadlist__footer">
          <Button variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
          <Button
            variant="primary"
            disabled={!result || result.matched.matches.length === 0}
            onClick={() => void handleCopy()}
          >
            <PdbIcon name="copy" size={14} />
            {copied ? '已复制' : '复制规范化清单'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
