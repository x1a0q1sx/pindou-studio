/**
 * bluetooth/SmartBoardDialog.tsx —— 智能拼豆板：蓝牙搜索 / 连接 / GATT 探测面板。
 *
 * 定位：**探测与诊断工具**（实验）。三步走验证你那块板能不能被本应用驱动：
 *   搜索附近 BLE 设备（Electron 主进程接管选择器，列表在这里自绘）
 *   → 连接 GATT → 枚举全部主服务与特征值（含属性位 R/W/N/I）。
 * 探测结果可一键复制成文本报告；拿到「哪些服务、有没有可写特征」就能判断
 * 点灯协议是否可驱动（未加密的厂商串口/自定义服务 = 有戏；加密握手 = 没戏）。
 *
 * 授权策略：默认把 0xFF00–0xFFFF 厂商段全放行（国产板绝大多数用这段），
 * 常见板子一次扫描即可列全特征值；冷门 128bit 服务在「附加授权 UUID」补。
 * 入口：LeftRail「智能板」/ 拼豆面板按钮 / `pdb:open-smartboard`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { usePdbStore } from '@/store';
import { subscribeBtPicker, respondBtPicker } from '@/core/blePicker';
import type { BtPickerRequest } from '@/io/bridge';
import {
  defaultOptionalServices,
  parseUuidList,
  shortUuidOf,
  serviceLabel,
  characteristicFlags,
  buildProbeText,
  bleErrorHint,
  type ProbeReport,
  type ProbeService,
} from '@/core/smartBoard';
import './bluetooth.css';

type Phase = 'idle' | 'scanning' | 'connecting' | 'probing' | 'ready';

export function SmartBoardDialog() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [picker, setPicker] = useState<BtPickerRequest | null>(null);
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [connected, setConnected] = useState(false);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [extraServices, setExtraServices] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const [availability, setAvailability] = useState<boolean | null>(null);
  const deviceRef = useRef<BluetoothDevice | null>(null);
  const pushToast = usePdbStore((s) => s.pushToast);

  /* 打开：事件驱动（LeftRail / 拼豆面板按钮）；每次进入都刷新能力探测 */
  useEffect(() => {
    const handler = (): void => {
      const bt = navigator.bluetooth;
      setSupported(!!bt);
      setError(null);
      if (bt) {
        void bt.getAvailability().then(setAvailability).catch(() => setAvailability(null));
      }
      setOpen(true);
    };
    window.addEventListener('pdb:open-smartboard', handler);
    return () => window.removeEventListener('pdb:open-smartboard', handler);
  }, []);

  /* 选择器请求（主进程推送）：对话框开着时在这里画列表 */
  useEffect(() => subscribeBtPicker(setPicker), []);

  /* 关闭对话框时若还有挂起的选择请求 → 替用户取消，防 Promise 悬挂 */
  const close = useCallback((): void => {
    setOpen(false);
    if (picker) void respondBtPicker(null);
  }, [picker]);

  /** 连接后枚举：服务 → 特征值（每步失败都记入报告，不让单点错误毁全表） */
  const probe = useCallback(async (dev: BluetoothDevice): Promise<void> => {
    setPhase('probing');
    const services: ProbeService[] = [];
    let servicesErr: string | null = null;
    try {
      const server = dev.gatt;
      if (!server) throw new Error('no-gatt');
      if (!server.connected) await server.connect();
      const list = await server.getPrimaryServices();
      for (const svc of list) {
        const entry: ProbeService = { uuid: svc.uuid, label: serviceLabel(svc.uuid) };
        try {
          const chars = await svc.getCharacteristics();
          entry.characteristics = chars.map((c) => ({
            uuid: c.uuid,
            flags: characteristicFlags({
              read: c.properties.read,
              write: c.properties.write,
              writeWithoutResponse: c.properties.writeWithoutResponse,
              notify: c.properties.notify,
              indicate: c.properties.indicate,
            }),
          }));
        } catch (err) {
          const name = err instanceof DOMException ? err.name : String(err);
          entry.error = name === 'SecurityError' ? '未授权（把服务 UUID 填进「附加授权」重新扫描）' : name;
        }
        services.push(entry);
      }
    } catch (err) {
      const name = err instanceof DOMException ? err.name : err instanceof Error ? err.message : String(err);
      servicesErr =
        name === 'SecurityError'
          ? '服务枚举被拒：扫描时未授权任何服务（用「附加授权 UUID」重试）'
          : name;
    }
    setReport({
      deviceName: dev.name ?? '',
      deviceId: dev.id,
      connected: dev.gatt?.connected === true,
      probedAt: new Date().toLocaleString(),
      services,
    });
    if (servicesErr) setError(`枚举失败：${servicesErr}`);
    setPhase('ready');
  }, []);

  /** 点选设备 → 回传主进程 → search() 里挂起的 requestDevice 自动兑现 */
  const pickDevice = useCallback(
    async (deviceId: string): Promise<void> => {
      const accepted = await respondBtPicker(deviceId);
      if (!accepted && picker) {
        setError('选择请求已过期，请重新点「搜索并连接」。');
        setPhase('idle');
      }
    },
    [picker],
  );

  const search = useCallback(async (): Promise<void> => {
    if (!navigator.bluetooth) {
      setError('此环境不支持 Web Bluetooth。');
      return;
    }
    setError(null);
    setPhase('scanning');
    try {
      const dev = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: defaultOptionalServices(parseUuidList(extraServices)),
      });
      deviceRef.current = dev;
      setDevice(dev);
      dev.addEventListener('gattserverdisconnected', () => setConnected(false));
      setPhase('connecting');
      const server = dev.gatt;
      if (!server) {
        setError('设备没有 GATT 服务（可能是经典蓝牙设备），无法探测。');
        setPhase('ready');
        return;
      }
      await server.connect();
      setConnected(true);
      await probe(dev);
    } catch (err) {
      setPhase('idle');
      setConnected(false);
      setError(bleErrorHint(err));
    }
  }, [extraServices, probe]);

  const reconnect = useCallback(async (): Promise<void> => {
    const dev = deviceRef.current;
    if (!dev?.gatt) return;
    setError(null);
    try {
      setPhase('connecting');
      await dev.gatt.connect();
      setConnected(true);
      await probe(dev);
    } catch (err) {
      setPhase('ready');
      setError(bleErrorHint(err));
    }
  }, [probe]);

  const disconnect = useCallback((): void => {
    deviceRef.current?.gatt?.disconnect();
    setConnected(false);
  }, []);

  const copyReport = useCallback(async (): Promise<void> => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(buildProbeText(report));
      pushToast('success', '探测报告已复制——发给我即可判断能否驱动点灯', 3200);
    } catch {
      pushToast('warning', '复制失败：剪贴板不可用', 2600);
    }
  }, [report, pushToast]);

  const busy = phase === 'scanning' || phase === 'connecting' || phase === 'probing';

  return (
    <Modal open={open} onClose={close} title="智能拼豆板 · 蓝牙探测（实验）" wide>
      <div className="pdb-smart">
        <p className="pdb-smart__intro">
          搜索附近蓝牙设备并连接你的智能拼豆板，列出它的 GATT 服务与特征值——
          以此判断点灯协议是否可被本应用驱动。<b>探测 ≠ 控制</b>：拿到报告后，
          若板子的可写特征未加密，下一步就能做「逐格亮灯引导」。
        </p>

        {/* 环境状态 */}
        <div className="pdb-smart__env">
          <span className={supported ? 'is-ok' : 'is-bad'}>
            {supported ? 'Web Bluetooth 可用' : '此环境不支持 Web Bluetooth（请用桌面应用）'}
          </span>
          {availability !== null && (
            <span className={availability ? 'is-ok' : 'is-bad'}>
              {availability ? '蓝牙适配器就绪' : '蓝牙适配器不可用：请开系统蓝牙'}
            </span>
          )}
        </div>

        {/* 控制行 */}
        <div className="pdb-smart__bar">
          <label className="pdb-smart__field">
            <span className="pdb-label">附加授权服务 UUID（可选，逗号分隔）</span>
            <input
              className="pdb-smart__input"
              value={extraServices}
              onChange={(e) => setExtraServices(e.target.value)}
              placeholder="如 0xfff0 或 12345678-1234-5678-1234-567890abcdef"
              disabled={busy}
            />
          </label>
          <Button variant="primary" onClick={() => void search()} disabled={busy || !supported}>
            <PdbIcon name="search" size={15} />
            {phase === 'scanning' ? '等待选择…' : phase === 'connecting' ? '连接中…' : phase === 'probing' ? '枚举中…' : '搜索并连接'}
          </Button>
          {device && (
            connected ? (
              <Button variant="outline" onClick={disconnect}>断开</Button>
            ) : (
              <Button variant="outline" onClick={() => void reconnect()} disabled={busy}>重连</Button>
            )
          )}
        </div>

        {error && (
          <div className="pdb-smart__alert" role="alert">
            <PdbIcon name="warning" size={15} />
            <span>{error}</span>
          </div>
        )}

        {/* 设备选择器（主进程推送的列表，自绘） */}
        {picker && (
          <div className="pdb-smart__picker" role="group" aria-label="选择蓝牙设备">
            <span className="pdb-label">选择设备（附近 {picker.devices.length} 台）</span>
            {picker.devices.length === 0 && <span className="pdb-smart__muted">列表为空——把板子开机靠近后取消重试</span>}
            {picker.devices.map((d) => (
              <button
                key={d.id}
                type="button"
                className="pdb-smart__dev"
                onClick={() => void pickDevice(d.id)}
                title={d.id}
              >
                <PdbIcon name="monitor" size={14} />
                <span className="pdb-smart__dev-name">{d.name || '(未广播名称的设备)'}</span>
                <span className="pdb-smart__dev-id">{d.id.slice(-14)}</span>
              </button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => { void respondBtPicker(null); setPicker(null); setPhase('idle'); }}>
              取消
            </Button>
          </div>
        )}

        {/* 当前设备与探测结果 */}
        {device && (
          <div className="pdb-smart__device">
            <span className={`pdb-smart__dot ${connected ? 'is-on' : 'is-off'}`} aria-hidden />
            <strong>{device.name || '(无名设备)'}</strong>
            <span className="pdb-smart__muted">{connected ? '已连接' : '已断开'}</span>
            {report && (
              <Button size="sm" variant="outline" onClick={() => void copyReport}>
                <PdbIcon name="copy" size={13} /> 复制探测报告
              </Button>
            )}
          </div>
        )}

        {report && report.services.length > 0 && (
          <div className="pdb-smart__services">
            {report.services.map((s) => (
              <details key={s.uuid} open={!!s.characteristics?.length}>
                <summary>
                  <code>{shortUuidOf(s.uuid)}</code>
                  {s.label && <span className="pdb-smart__svc-label">{s.label}</span>}
                  <span className="pdb-smart__muted">
                    {s.error ? `⚠ ${s.error}` : `${s.characteristics?.length ?? 0} 个特征`}
                  </span>
                </summary>
                <ul>
                  {(s.characteristics ?? []).map((c) => (
                    <li key={c.uuid}>
                      <code>{c.uuid}</code>
                      {c.flags && <span className="pdb-smart__flags">{c.flags}</span>}
                      {c.error && <span className="pdb-smart__muted">⚠ {c.error}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
        {report && report.services.length === 0 && !error && (
          <p className="pdb-smart__muted">该设备没有暴露主服务。</p>
        )}
      </div>
    </Modal>
  );
}
