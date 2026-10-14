/**
 * cast/CastDialog.tsx —— 手机投图对话框。
 *
 * 开启本机局域网服务 → 生成带 token 的上传页二维码（手机扫码即开，同一 WiFi）；
 * 手机选图发送后：图 A 走完整导入向导，图 B 免对话框自动像素化落进对照屏。
 * 收件箱实时列出最近上传与落地状态。二维码由 qrcode 库本地生成（无外部依赖）。
 * 入口：LeftRail「手机投图」/ `pdb:open-cast` 事件。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { getBridge, type CastState } from '@/io/bridge';
import { subscribeCastInbox, getCastInboxItems, clearCastInbox, type CastInboxItem } from '@/core/castInbox';
import './cast.css';

const STATUS_TEXT: Record<CastInboxItem['status'], string> = {
  wizard: '已进导入向导',
  applying: '像素化中…',
  applied: '已落图 B',
  error: '失败',
};

export function CastDialog() {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<CastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inbox = useSyncExternalStore(subscribeCastInbox, getCastInboxItems);
  const bridge = getBridge();
  const isDesktop = bridge.env === 'electron';

  useEffect(() => {
    const handler = (): void => {
      setOpen(true);
      setErr(null);
      void getBridge().castState().then(setSt).catch(() => setSt(null));
    };
    window.addEventListener('pdb:open-cast', handler);
    return () => window.removeEventListener('pdb:open-cast', handler);
  }, []);

  /* 二维码本地生成（只画第一个可用网址） */
  const firstUrl = st?.urls?.[0] ?? '';
  useEffect(() => {
    if (!firstUrl) {
      setQr(null);
      return;
    }
    let alive = true;
    void QRCode.toDataURL(firstUrl, { margin: 1, width: 260 })
      .then((dataUrl) => { if (alive) setQr({ url: firstUrl, dataUrl }); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [firstUrl]);

  const start = useCallback(async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await getBridge().castStart();
      setSt(r);
      if (!r.ok) {
        setErr(r.error === 'port-busy'
          ? '本机端口 4763–4768 都被占用，关闭一些本机服务后重试。'
          : `启动失败：${r.error ?? '未知错误'}`);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setSt(await getBridge().castStop());
    } finally {
      setBusy(false);
    }
  }, []);

  const copyUrl = useCallback(async (): Promise<void> => {
    if (!firstUrl) return;
    try {
      await navigator.clipboard.writeText(firstUrl);
    } catch { /* 剪贴板不可用时忽略 */ }
  }, [firstUrl]);

  const running = st?.running === true;

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="手机投图 · 局域网" wide>
      <div className="pdb-cast">
        {!isDesktop && (
          <div className="pdb-cast__alert">
            <PdbIcon name="warning" size={15} />
            <span>浏览器模式无法开启本机服务，请在桌面应用（PinDou Studio）里使用手机投图。</span>
          </div>
        )}

        <div className="pdb-cast__head">
          <span className={`pdb-cast__chip ${running ? 'is-on' : ''}`}>
            {running ? `服务运行中 · 端口 ${st?.port}` : '服务未启动'}
          </span>
          <Button variant={running ? 'outline' : 'primary'} onClick={() => void (running ? stop() : start())} disabled={busy || !isDesktop}>
            <PdbIcon name={running ? 'close' : 'monitor'} size={15} />
            {running ? '停止服务' : '开启投图'}
          </Button>
        </div>
        {err && <div className="pdb-cast__alert"><PdbIcon name="warning" size={15} /><span>{err}</span></div>}

        {running && qr && (
          <div className="pdb-cast__qr">
            <img src={qr.dataUrl} alt="手机扫码投图的二维码" className="pdb-cast__qr-img" />
            <div className="pdb-cast__qr-side">
              <p className="pdb-cast__howto">
                手机连<b>同一 WiFi</b> → 相机扫码（或复制链接）→ 选图发送。<br />
                选「图 A」：进导入向导，可裁剪调参；<br />
                选「图 B」：按图 B 板尺寸<b>自动像素化落图</b>，零操作直达对照屏。
              </p>
              <code className="pdb-cast__url" title="手机浏览器手动输入也可用">{qr.url}</code>
              <div className="pdb-cast__url-acts">
                <Button size="sm" variant="outline" onClick={() => void copyUrl()}>
                  <PdbIcon name="copy" size={13} /> 复制链接
                </Button>
                {st && st.urls.length > 1 && (
                  <span className="pdb-cast__muted">本机有多个网络（{st.urls.length} 个地址），连不上时换 IP 试试</span>
                )}
              </div>
            </div>
          </div>
        )}
        {running && !qr && <p className="pdb-cast__muted">二维码生成中…</p>}

        <div className="pdb-cast__inbox">
          <span className="pdb-label">
            收件箱（{inbox.length}）
            {inbox.length > 0 && (
              <Button size="sm" variant="ghost" onClick={clearCastInbox}>清空记录</Button>
            )}
          </span>
          {inbox.length === 0 ? (
            <p className="pdb-cast__muted">还没有手机投过来的图。{running ? '等一等——手机上点发送就会出现在这里。' : '先「开启投图」再扫码。'}</p>
          ) : (
            <ul className="pdb-cast__list">
              {inbox.map((it) => (
                <li key={it.id} className={`pdb-cast__row is-${it.status}`}>
                  <span className="pdb-cast__time">{new Date(it.at).toLocaleTimeString()}</span>
                  <span className={`pdb-cast__pane pdb-cast__pane--${it.pane}`}>图 {it.pane}</span>
                  <span className="pdb-cast__name" title={it.name}>{it.name}</span>
                  <span className="pdb-cast__status">
                    {STATUS_TEXT[it.status]}
                    {it.error ? `：${it.error}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="pdb-cast__note">
          安全说明：链接带随机 token（关服务即作废），只在局域网内监听，图片不经过任何外部服务器，转完即弃。
        </p>
      </div>
    </Modal>
  );
}
