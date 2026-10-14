// tools/virtualboard/VirtualBoard.cs
// PC 虚拟智能拼豆板（BLE 外设 GATT Server 旁路进程）
//
// 用 Windows 蓝牙栈的外设角色广播一块「智能拼豆板」，手机 App 扫描连接后写入指令。
// 两套协议形态：
//  · 酷猫系开放协议（默认，单 Service 单特征）：
//    帧 [cmd, payload...]：0x01 清屏 / 0x02 绘制 / 0x03 提交 / 0x04 亮度
//    / 0xA1 查询设备信息（自动应答尺寸）/ 0xA2 色号提示 / 0xA3 取消 / 0xA0 回执。
//  · 颂拼豆 PIXDOU（--pixdou，双特征 0xA951 控制 + 0xA952 节目数据）：
//    **请求与响应同构**：[0x54][cmd][len16=payload+2][payload][cks16BE]，
//    total = len16+4，cks16 = (前 total-2 字节求和)&0xFFFF；cmd==0 且 len==5 特判 total=11。
//    帧规则按 App 实发帧逐帧归纳（2026-09-23 实机联调验证 18/18 帧）。
//    注意：同步字节是 0x54——协议分析时曾误读为 0xA8（解析器内部把 0x54 左移 1 位的标记值）。
//    回码铁律：结果字节必须=1 —— 无 packetId 时 item[4]==1；有 packetId 时
//    payload 前 4B 为 u32be 序号且 item[8]==1（否则 App 重试 4 次后 TimeoutException）。
//    GIF 临时节目流：0x0A 开屏 → 0x06 新增 → 0x00×N 分片 → 0x01 完成。
//    响应 payload 可经 stdin 热控：ack9/acka/ack0/ackz auto|<hex>、push <hex>、exit。
// 未知命令统一原始帧 JSONL 打 stdout —— 供上层观察/适配。
//
// 通信契约（与 Electron 主进程约定）：
//   stdout 每行一个 JSON：
//     {ev:"ready"|"adv"|"advstat"|"connected"|"disconnected"|"write"|"read"|"error"}
//     {ev:"ack"|"ack9"|"ackto"|"cfg"|"push", ...}（PIXDOU 回码与投递结果）
//     write/read 事件含 hex（原始帧）与 uuid（所在特征）。
//     read：App 等待应答时会**轮询 readCharacteristic** 取最近应答（联调实录：
//     等待 0x06 回码期间持续读特征值）——因此特征必须
//     带 Read 属性并处理 ReadRequested，返回最近一次应答帧；否则真机上 App
//     读不到回码，会话停在 0x0A 开屏、永远不下发 0x06 节目。
//   stdin 每行一个命令：
//     {"cmd":"notify","hex":"aabb"} / "push <hex>"   设备→App 主动通知（两特征都发）
//     "ack9 auto|<hex>" 等回码控制；"exit" 退出
// 参数：--name <广播名(Windows 实际用适配器名)> --service <uuid> --char <uuid>
//       [--pixdou] --w 104 --h 104
//
// 实现注记：桌面 .NET Framework 无 Win10 SDK 聚合元数据，故不使用
// System.Runtime.WindowsRuntime 的 AsTask 扩展，改为手写 IAsyncOperation 等待器
// （Completed 回调 + GetResults），只依赖 WinMetadata 单文件 winmd。
using System;
using System.IO;
using System.Text;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Foundation;
using Windows.Security.Cryptography;
using Windows.Storage.Streams;

static class VirtualBoard
{
    static GattLocalCharacteristic _ch;
    static GattLocalCharacteristic _ch2;
    static BluetoothLEAdvertisementPublisher _pub;
    static GattServiceProvider _provider;
    static GattServiceProviderAdvertisingParameters _ap;
    static ushort _w = 104, _h = 104;
    static bool _pixdou = false;   // PIXDOU 双特征模式（0xA951/0xA952 + 回声）
    static byte[] _lastAck;        // 最近一次应答帧：App 用 GATT 读轮询取应答，读请求时回给它
    static readonly object _stdoutLock = new object();
    static string _logPath;        // 流量文件日志：stdout 会随宿主丢失，落盘才能事后分析
    // 日志轮转上限：AppendAllText 每行追加无上限，userData 下
    // 缓慢无限增长；超 5MB 滚进 .1（单代备份，旧的直接覆盖），当前文件恒为最新
    const int LogMaxBytes = 5 * 1024 * 1024;

    static void Emit(string json)
    {
        lock (_stdoutLock)
        {
            Console.Out.WriteLine(json); Console.Out.Flush();
            if (_logPath == null)
            {
                try { _logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "vb_traffic.log"); }
                catch { _logPath = ""; }
            }
            if (_logPath.Length > 0)
            {
                try
                {
                    var fi = new FileInfo(_logPath);
                    if (fi.Exists && fi.Length > LogMaxBytes)
                    {
                        string bak = _logPath + ".1";
                        try { File.Delete(bak); } catch { /* 被占用/无旧文件 */ }
                        try { File.Move(_logPath, bak); } catch { /* 同上，下一行追加重建 */ }
                    }
                    File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss.fff ") + json + Environment.NewLine);
                }
                catch { /* 日志失败不影响主流程 */ }
            }
        }
    }

    static string Hex(byte[] b)
    {
        var sb = new StringBuilder(b.Length * 2);
        foreach (var x in b) sb.Append(x.ToString("x2"));
        return sb.ToString();
    }

    // ---- 手写 WinRT 异步等待器 ----
    static T Wait<T>(IAsyncOperation<T> op)
    {
        using (var mre = new ManualResetEventSlim(false))
        {
            T result = default(T);
            Exception err = null;
            op.Completed = (o, s) =>
            {
                try
                {
                    if (s == AsyncStatus.Error) err = o.ErrorCode;
                    else result = o.GetResults();
                }
                catch (Exception ex) { err = ex; }
                mre.Set();
            };
            mre.Wait(8000);
            if (err != null) throw err;
            return result;
        }
    }

    static void NotifyBytes(byte[] bytes)
    {
        if (_ch == null) return;
        try
        {
            IBuffer buf = CryptographicBuffer.CreateFromByteArray(bytes);
            var ignored = _ch.NotifyValueAsync(buf); // fire-and-forget
        }
        catch (Exception ex)
        {
            Emit("{\"ev\":\"error\",\"msg\":\"notify-ex:" + ex.GetType().Name + "\"}");
        }
    }

    // PIXDOU：回码两个特征都 notify（App 订阅了谁就收到谁）；读轮询走 OnReadRequested
    static void NotifyAck(byte[] ack)
    {
        NotifyOne(_ch, "a951", ack);
        NotifyOne(_ch2, "a952", ack);
    }

    static void NotifyOne(GattLocalCharacteristic ch, string tag, byte[] bytes)
    {
        if (ch == null) return;
        try
        {
            int subs = 0;
            try { subs = ch.SubscribedClients.Count; } catch { }
            IBuffer buf = CryptographicBuffer.CreateFromByteArray(bytes);
            var op = ch.NotifyValueAsync(buf);
            op.Completed = (o, s) =>
            {
                string st = s.ToString();
                Exception ex = null;
                try { if (s == AsyncStatus.Error) ex = o.ErrorCode; } catch { }
                Emit("{\"ev\":\"ackto\",\"to\":\"" + tag + "\",\"st\":\"" + st +
                     "\",\"subs\":" + subs + (ex != null ? ",\"err\":\"" + ex.GetType().Name + "\"" : "") + "}");
            };
        }
        catch (Exception ex)
        {
            Emit("{\"ev\":\"ackto\",\"to\":\"" + tag + "\",\"st\":\"throw\",\"err\":\"" + ex.GetType().Name + "\"}");
        }
    }

    // ---- PIXDOU 帧构造（请求与响应同构）----
    // [54][cmd][len16=payload+2][payload][cks16BE]；total = len16+4
    // cks16 = (前 total-2 字节求和) & 0xFFFF，大端存放。
    // 注：cmd==0 的应答 payload 必须为 5 字节（u32be 序号 + 状态 0x01），此时 len16=7、total=11；
    //     解析器另有 len16==5→total=11 的紧凑特例，两种形式解析结果相同。
    // 实机验证：0x0A/0x06/0x00/0x01 四条指令的应答全部被 App 接受（2026-09-23）。
    static byte[] PixFrame(byte cmd, byte[] payload)
    {
        int lf = payload.Length + 2;
        int total = lf + 4;
        byte[] f = new byte[total];
        f[0] = 0x54; f[1] = cmd;
        f[2] = (byte)(lf >> 8); f[3] = (byte)(lf & 0xFF);
        Array.Copy(payload, 0, f, 4, payload.Length);
        int s = 0; for (int i = 0; i < total - 2; i++) s = (s + f[i]) & 0xFFFF;
        f[total - 2] = (byte)((s >> 8) & 0xFF);
        f[total - 1] = (byte)(s & 0xFF);
        return f;
    }

    // 回码帧 = 同构帧（App 的 PixDouResponseParser 找 0x54 同步字 + 16 位累加和）
    static byte[] PixResp(byte cmd, byte[] payload)
    {
        return PixFrame(cmd, payload);
    }

    static byte[] _ack9manual = null;
    static byte[] _ackAmanual = null;   // cmd 0x0a 响应 payload 覆盖
    static byte[] _ack0manual = null;   // cmd 0x00 分片响应 payload 覆盖
    static byte[] _ackZmanual = null;   // 其他 cmd 响应 payload 覆盖
    // 0x09（板信息查询）的默认应答：状态 0x01 + 宽高（App 当前不匹配 0x09，留作兼容）。
    // 其余指令的应答 payload 一律 [0x01]（结果字节=1 是 App 匹配器的硬性要求）。
    static byte[] Ack9Payload(byte[] req)
    {
        if (_ack9manual != null) return _ack9manual;
        return new byte[] { 0x01, (byte)(_w >> 8), (byte)(_w & 0xFF), (byte)(_h >> 8), (byte)(_h & 0xFF) };
    }

    static bool SetManual(ref byte[] slot, string arg, string tag)
    {
        if (arg == "auto") { slot = null; Emit("{\"ev\":\"cfg\",\"" + tag + "\":\"auto\"}"); return true; }
        string hx = arg.Trim();
        if (hx.Length % 2 != 0) return false;
        try
        {
            byte[] b = new byte[hx.Length / 2];
            for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hx.Substring(i * 2, 2), 16);
            slot = b;
            Emit("{\"ev\":\"cfg\",\"" + tag + "\":\"" + hx + "\"}");
            return true;
        }
        catch { return false; }
    }

    static void StdinLoop()
    {
        try
        {
            using (var sr = new System.IO.StreamReader(System.Console.OpenStandardInput()))
            {
                string line;
                while ((line = sr.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (line.Length == 0) continue;
                    int sp = line.IndexOf(' ');
                    string verb = sp < 0 ? line : line.Substring(0, sp);
                    string arg = sp < 0 ? "" : line.Substring(sp + 1).Trim();
                    bool ok = true;
                    if (verb == "ack9") ok = SetManual(ref _ack9manual, arg, "ack9");
                    else if (verb == "acka") ok = SetManual(ref _ackAmanual, arg, "acka");
                    else if (verb == "ack0") ok = SetManual(ref _ack0manual, arg, "ack0");
                    else if (verb == "ackz") ok = SetManual(ref _ackZmanual, arg, "ackz");
                    else if (verb == "push")
                    {
                        try
                        {
                            byte[] b = new byte[arg.Length / 2];
                            for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(arg.Substring(i * 2, 2), 16);
                            if (_pixdou) NotifyAck(b); else NotifyBytes(b);
                            Emit("{\"ev\":\"push\",\"hex\":\"" + arg + "\"}");
                        }
                        catch { ok = false; }
                    }
                    else if (verb == "exit")
                    {
                        try { if (_pub != null) _pub.Stop(); } catch { }
                        Environment.Exit(0);
                    }
                    else if (line.Contains("\"hex\":\""))
                    {
                        // 兼容 Electron 旧契约：{"cmd":"notify","hex":".."}
                        try
                        {
                            int i = line.IndexOf("\"hex\":\"", StringComparison.Ordinal) + 7;
                            int j = line.IndexOf('"', i);
                            string hx = line.Substring(i, j - i);
                            byte[] b = new byte[hx.Length / 2];
                            for (int k = 0; k < b.Length; k++) b[k] = Convert.ToByte(hx.Substring(k * 2, 2), 16);
                            if (_pixdou) NotifyAck(b); else NotifyBytes(b);
                        }
                        catch { ok = false; }
                    }
                    else ok = false;
                    if (!ok) Emit("{\"ev\":\"error\",\"msg\":\"stdin-bad:" + verb + "\"}");
                }
            }
        }
        catch { }
        // stdin EOF = 宿主已退（父进程死/管道断）：必须自杀，否则本进程成为僵尸
        // 继续占用 BLE 广播、看门狗还会不停重拉——宿主退出时 ReadLine 返回 null 落到这里
        Environment.Exit(0);
    }

    // 回码构造（纯函数，便于自测）：请求帧 → 应答帧；非 PIXDOU 帧返回 null。
    // 规则（实机验证）：0x00 → u32be(序号)+[01]；其余 → [01]（结果字节必须=1）。
    static byte[] BuildAck(byte[] data)
    {
        if (data == null || data.Length < 7 || data[0] != 0x54) return null;
        byte cmd = data[1];
        if (cmd == 0x09) return PixResp(0x09, Ack9Payload(data));
        if (cmd == 0x00 && data.Length >= 10)
        {
            if (_ack0manual != null) return PixResp(0x00, _ack0manual);
            byte[] pl = new byte[5];
            Array.Copy(data, 4, pl, 0, 4);
            pl[4] = 0x01;
            return PixResp(0x00, pl);
        }
        if (cmd == 0x0A) return PixResp(0x0A, _ackAmanual ?? new byte[] { 0x01 });
        if (_ackZmanual != null) return PixResp(cmd, _ackZmanual);
        return PixResp(cmd, new byte[] { 0x01 });
    }

    // App 等待应答时会轮询 readCharacteristic（联调实测行为）：
    // 读返回最近一次应答帧；一次都还没应答过时返回设备信息帧（0x09 / 0xA1）。
    static void OnReadRequested(GattLocalCharacteristic sender, GattReadRequestedEventArgs args)
    {
        var deferral = args.GetDeferral();
        try
        {
            var req = Wait(args.GetRequestAsync());
            byte[] data = _lastAck;
            if (data == null)
            {
                data = _pixdou
                    ? PixResp(0x09, Ack9Payload(null))
                    : new byte[] { 0xA1, 0x01, (byte)_w, (byte)_h, 0x01, 0x00, 0x00 };
            }
            using (var writer = new DataWriter())
            {
                writer.WriteBytes(data);
                // RespondWithValue：15063 合同即有（Response/Value 属性是 18362 新增，
                // 本机 csc + System32 WinMetadata 只解析到老合同，用新属性会 CS1061）
                req.RespondWithValue(writer.DetachBuffer());
            }
            Emit("{\"ev\":\"read\",\"uuid\":\"" + sender.Uuid + "\",\"hex\":\"" + Hex(data) + "\"}");
        }
        catch (Exception ex)
        {
            Emit("{\"ev\":\"error\",\"msg\":\"read-ex:" + ex.GetType().Name + "\"}");
        }
        finally { deferral.Complete(); }
    }

    static void OnWriteRequested(GattLocalCharacteristic sender, GattWriteRequestedEventArgs args)
    {
        var deferral = args.GetDeferral();
        byte[] data = null;
        int opt = -1;
        try
        {
            var req = Wait(args.GetRequestAsync());
            opt = (int)req.Option;   // 0=WriteWithResponse 1=WriteWithoutResponse
            using (var reader = DataReader.FromBuffer(req.Value))
            {
                data = new byte[reader.UnconsumedBufferLength];
                reader.ReadBytes(data);
            }
            // ATT 写响应：带响应写必须显式 Respond，否则手机端写 future 永不完成——
            // App 2.5s 超时、重试 3 次后放弃，且进不到「轮询读回码」阶段。
            // 2026-09-29 真机证据：写事件+回码投递 Completed 都有，但零 read 事件、
            // App 每次只连发 3 条 0x0A——缺的就是这一下 ATT 写响应。
            if (req.Option == GattWriteOption.WriteWithResponse) req.Respond();
        }
        catch (Exception ex)
        {
            Emit("{\"ev\":\"error\",\"msg\":\"write-ex:" + ex.GetType().Name + "\"}");
        }
        finally { deferral.Complete(); }   // 写应答先落地（对齐钩子时序：先回写成功，再送回码帧）
        if (data != null) ThreadPool.QueueUserWorkItem(_ => ProcessWrite(sender, data, opt));
    }

    /** 写完成后的回码流程（线程池执行，不占 ATT bearer，App 的写 future 立刻可用） */
    static void ProcessWrite(GattLocalCharacteristic sender, byte[] data, int opt)
    {
        Emit("{\"ev\":\"write\",\"uuid\":\"" + sender.Uuid + "\",\"opt\":" + opt + ",\"hex\":\"" + Hex(data) + "\"}");

        // PIXDOU 回码：0x54 同构帧（App 解析器认 0x54 同步字 + 16 位累加和）
        if (_pixdou)
        {
            byte[] ack = BuildAck(data);
            if (ack != null)
            {
                _lastAck = ack;   // 记录给 readCharacteristic 轮询取用
                byte ackCmd = ack[1];
                Emit("{\"ev\":\"" + (ackCmd == 0x09 ? "ack9" : "ack") + "\",\"cmd\":\""
                     + ackCmd.ToString("x2") + "\",\"hex\":\"" + Hex(ack) + "\"}");
                // 回码必须延迟：App 写 future 完成后才挂 waitFor 监听（broadcast 流不缓存、
                // 先到的帧直接丢）。18ms 的即时回码每次都输给挂载竞态（09-29 联调实录）。
                // 150ms 单发在 App 空闲时命中（21:55 实录每步 ~20ms 连发），但 App 忙时
                // 监听挂载晚于 150ms 就错过、整条指令退化到 ~0.65s 的读轮询（23:08 实录：
                // 4 分片节目 3.5s+，切色等待的主因）。改为 40~500ms 五连发（累计时刻）：
                // 挂载窗口落在哪儿都被命中；全错过也不劣化——读轮询（OnReadRequested 回
                // _lastAck）照旧兜底。重复帧无害：waitFor 用 firstWhere 按 cmd+packetId
                // 匹配、同帧多份与错帧都会被过滤（21:55 已实录重复帧被正确容忍）。
                foreach (int gap in new[] { 40, 80, 100, 130, 150 })
                {
                    Thread.Sleep(gap);
                    NotifyAck(ack);
                }
                return;
            }
        }

        // 协议层自动应答（低延迟，不绕主进程）
        if (data.Length >= 1)
        {
            byte cmd = data[0];
            if (cmd == 0xA1)
            {
                _lastAck = new byte[] { 0xA1, 0x01, (byte)_w, (byte)_h, 0x01, 0x00, 0x00 };
                NotifyBytes(_lastAck);
                NotifyBytes(new byte[] { 0xA0, 0xA1, 0x00 });
            }
            else if (cmd == 0xA2 || cmd == 0xA3)
            {
                _lastAck = new byte[] { 0xA0, cmd, 0x00 };
                NotifyBytes(_lastAck);
            }
        }
    }

    static int Run(string name, Guid svcGuid, Guid chGuid)
    {
        var provResult = Wait(GattServiceProvider.CreateAsync(svcGuid));
        if (provResult.Error != BluetoothError.Success)
        {
            Emit("{\"ev\":\"error\",\"msg\":\"provider:" + provResult.Error + "\"}");
            return 2;
        }
        var provider = provResult.ServiceProvider;
        // 【2026-10-03 编译实证】GattServiceProvider 无 Session 属性/任何连接事件（winmd 投影
        // 就是没有），App 停在设备列表页的「已连接」无法观测——只有下方 CCCD 订阅才可见。
        // 若将来需要订阅前可见性，出路是 DeviceInformation watcher 监听本机蓝牙 LE AEP 的
        // System.Devices.Aep.IsConnected（旁路日志用，勿直接驱动状态——耳机等设备会误报）。

        // 属性：四属性全开（Read+Write+WnR+Notify）。实测对比：全开时 App 会订阅并下发 0x0A；
        // 改成钩子树（a951 无 Notify / a952 不可写）反而 App 只订阅 a951 且一帧不发。
        // 回码双通道齐发：notify a951+a952 + 读轮询 lastAck，由流量日志判定 App 真正用哪条。
        var p = new GattLocalCharacteristicParameters();
        p.CharacteristicProperties = GattCharacteristicProperties.Read
            | GattCharacteristicProperties.Write
            | GattCharacteristicProperties.WriteWithoutResponse
            | GattCharacteristicProperties.Notify;
        var chRes = Wait(provider.Service.CreateCharacteristicAsync(chGuid, p));
        if (chRes.Error != BluetoothError.Success)
        {
            Emit("{\"ev\":\"error\",\"msg\":\"char:" + chRes.Error + "\"}");
            return 3;
        }
        _ch = chRes.Characteristic;
        _ch.WriteRequested += OnWriteRequested;
        _ch.ReadRequested += OnReadRequested;
        // 本投影无 GATT 会话事件：以「订阅者数量变化」近似连接状态（手机连上并订阅 NOTIFY）
        _ch.SubscribedClientsChanged += (s, e) =>
        {
            var n = s.SubscribedClients.Count;
            Emit("{\"ev\":\"" + (n > 0 ? "connected" : "disconnected") + "\",\"subs\":" + n + "}");
        };
        if (_pixdou)
        {
            // 第二特征 0xA952（节目数据通道）：同样四属性全开
            Guid ch2 = new Guid("0000a952-0000-1000-8000-00805f9b34fb");
            var p2 = new GattLocalCharacteristicParameters();
            p2.CharacteristicProperties = GattCharacteristicProperties.Read
                | GattCharacteristicProperties.Write
                | GattCharacteristicProperties.WriteWithoutResponse
                | GattCharacteristicProperties.Notify;
            var chRes2 = Wait(provider.Service.CreateCharacteristicAsync(ch2, p2));
            if (chRes2.Error == BluetoothError.Success)
            {
                var c2 = chRes2.Characteristic;
                _ch2 = c2;
                c2.WriteRequested += OnWriteRequested;
                c2.ReadRequested += OnReadRequested;
                c2.SubscribedClientsChanged += (s, e) =>
                {
                    var n = s.SubscribedClients.Count;
                    Emit("{\"ev\":\"" + (n > 0 ? "connected" : "disconnected") + "\",\"ch\":\"a952\",\"subs\":" + n + "}");
                };
            }
        }

        // 广播通道①：GATT 服务自带广播（IsConnectable → 手机可发起连接，
        // 系统自动把服务 UUID 放进 ADV——这是 App「按服务过滤」能扫到我们的唯一途径）。
        string advMode = null, advStatus = null;
        try
        {
            _ap = new GattServiceProviderAdvertisingParameters();
            _ap.IsConnectable = true;
            _ap.IsDiscoverable = true;
            provider.StartAdvertising(_ap);
            for (int t = 0; t < 60 && provider.AdvertisementStatus == GattServiceProviderAdvertisementStatus.Created; t++)
                Thread.Sleep(50);
            // 实测（本机 Win11 + 该驱动）：Start 后会先报一次瞬态 Aborted，约数百毫秒后
            // 自动迁移到 Started——首轮不是 Started 时必须再等一拍确认，不能立刻放弃。
            if (provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started)
                Thread.Sleep(1200);
            if (provider.AdvertisementStatus == GattServiceProviderAdvertisementStatus.Started)
            {
                advMode = "gatt";
                advStatus = "Started";
            }
            else
            {
                try { provider.StopAdvertising(); } catch { /* 未真正启动 */ }
            }
        }
        catch { /* 通道不可用，走退路 */ }

        // 广播通道②（退路）：Publisher 只发自定义 ManufacturerData——
        // Flags/LocalName/ServiceUuids 由 Windows 托管，手动设置一律 ArgumentException。
        // 广播名 = 本机计算机名（Windows 强制），改名需在系统设置里改计算机名后重启。
        if (advMode == null)
        {
            // Publisher 广播天生「不可连接」（Windows 设计如此，无 API 可改）——
            // 手机端只能看到 ADV，没有 CONNECT 入口；可连接广播只能靠通道①（GATT 服务）。
            _pub = new BluetoothLEAdvertisementPublisher();
            byte[] nameBytes = Encoding.UTF8.GetBytes(name);
            var mfg = new byte[nameBytes.Length + 4];
            mfg[0] = 0x50; mfg[1] = 0x44; mfg[2] = (byte)nameBytes.Length; // "PD" 魔数 + 长度
            Array.Copy(nameBytes, 0, mfg, 3, nameBytes.Length);
            _pub.Advertisement.ManufacturerData.Add(new BluetoothLEManufacturerData(0xFFFF, CryptographicBuffer.CreateFromByteArray(mfg)));
            _pub.Start();
            // Start() 是异步的：等状态机走到 Started（或 Aborted/Stopped 即失败）
            for (int t = 0; t < 40 && _pub.Status == BluetoothLEAdvertisementPublisherStatus.Created; t++)
                Thread.Sleep(50);
            if (_pub.Status != BluetoothLEAdvertisementPublisherStatus.Started
                && _pub.Status != BluetoothLEAdvertisementPublisherStatus.Waiting)
            {
                Emit("{\"ev\":\"error\",\"msg\":\"advertise:" + _pub.Status + "\"}");
                return 4;
            }
            advMode = "publisher";
            advStatus = _pub.Status.ToString();
        }
        Emit("{\"ev\":\"adv\",\"mode\":\"" + advMode + "\",\"status\":\"" + advStatus + "\"}");
        // 本机蓝牙静态地址：nRF Connect 里对 MAC 用（注意 Windows 广播可能用随机地址 RPA，
        // 真正稳定的指纹是 mfg 数据 0xFFFF + "PD" 魔数）
        string addr = "";
        try
        {
            var ad = Wait(BluetoothAdapter.GetDefaultAsync());
            ulong x = ad.BluetoothAddress;
            addr = string.Format("{0:X2}:{1:X2}:{2:X2}:{3:X2}:{4:X2}:{5:X2}",
                (x >> 40) & 0xFF, (x >> 32) & 0xFF, (x >> 24) & 0xFF,
                (x >> 16) & 0xFF, (x >> 8) & 0xFF, x & 0xFF);
        }
        catch { /* 地址拿不到不影响主流程 */ }
        Emit("{\"ev\":\"ready\",\"pixdou\":" + (_pixdou ? "true" : "false") + ",\"name\":\"" + name + "\",\"addr\":\"" + addr + "\",\"w\":" + _w + ",\"h\":" + _h + "}");

        if (advMode == "gatt")
        {
            // 广播看门狗：Windows 会在连接/断开周期后静默 abort GATT 广播，
            // 状态一离开 Started 就立刻 Stop+Start 重拉。
            _provider = provider;
            provider.AdvertisementStatusChanged += (s, e) =>
                Emit("{\"ev\":\"advstat\",\"status\":\"" + s.AdvertisementStatus + "\"}");
            var wd = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(3000);
                    try
                    {
                        if (_provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started)
                        {
                            try { _provider.StopAdvertising(); } catch { }
                            Thread.Sleep(300);
                            _provider.StartAdvertising(_ap);
                            Emit("{\"ev\":\"adv\",\"mode\":\"gatt\",\"status\":\"restarted\"}");
                        }
                    }
                    catch { }
                }
            });
            wd.IsBackground = true; wd.Start();
        }

        // stdin 由 StdinLoop 线程独占；这里只需挂起主线程保活
        while (true) Thread.Sleep(2000);
#pragma warning disable 0162
        try { if (_pub != null) _pub.Stop(); } catch { /* 已停 */ }
        try { provider.StopAdvertising(); } catch { /* 未启用 */ }
        return 0;
#pragma warning restore 0162
    }

    // ---- 自测：用实机被 App 接受的真实字节对拍回码构造（无需蓝牙）----
    // 通过标准：0x0A/0x06/0x00×N/0x01 四条指令的应答逐字节等于实机验证值。
    static int SelfTest()
    {
        _pixdou = true;
        int pass = 0, fail = 0;
        Action<string, bool, string> chk = (name, ok, extra) =>
        {
            Console.WriteLine((ok ? "PASS " : "FAIL ") + name + (extra.Length > 0 ? "  " + extra : ""));
            if (ok) pass++; else fail++;
        };
        // 真实 App 下发帧（联调实录）
        string[] reqs = {
            "540a0003000061",                                                      // 0x0A 开屏
            "5406000db385044a000004350000000226",                                  // 0x06 新增节目
            "540000bc0000000000b49380b7640100000000000000000000000000000000"       // 0x00 分片#0（截断版仅用于 cmd 判定）
                .Substring(0, 20) + "00000000000000000000000000000000000000000000",
            "54010003010059",                                                      // 0x01 完成
        };
        // 期望应答（= 联调时被 App 接受的字节）
        string[] wants = {
            "540a0003010062",
            "5406000301005e",
            "540000070000000001005c",   // 分片#0 → u32be(0)+01
            "54010003010059",
        };
        for (int i = 0; i < reqs.Length; i++)
        {
            byte[] req = FromHex(reqs[i]);
            byte[] got = BuildAck(req);
            string g = got == null ? "(null)" : Hex(got);
            chk("ack for cmd=0x" + req[1].ToString("x2"), g == wants[i], "got=" + g + " want=" + wants[i]);
        }
        // 分片#3 单独验序号回显
        {
            byte[] req = FromHex("540000bc0000000300b4" + new string('0', 360));
            byte[] got = BuildAck(req);
            string g = got == null ? "(null)" : Hex(got);
            chk("ack for chunk #3", g == "540000070000000301005f", "got=" + g + " want=540000070000000301005f");
        }
        // 回码自身必须能被 App 匹配器接受：0x54 头 + 校验吻合 + 结果字节=1
        // 结果字节位置：无 packetId（cmd!=0x00）→ item[4]；有 packetId（cmd==0x00）→ item[8]
        foreach (var w in wants)
        {
            byte[] b = FromHex(w);
            int total = b.Length;
            int s = 0; for (int i = 0; i < total - 2; i++) s += b[i];
            int given = (b[total - 2] << 8) | b[total - 1];
            int resAt = b[1] == 0x00 ? 8 : 4;
            bool okFrame = b[0] == 0x54 && (s & 0xFFFF) == given && b[resAt] == 0x01;
            chk("frame-valid " + w, okFrame, "res@[" + resAt + "]=" + b[resAt]);
        }
        Console.WriteLine();
        Console.WriteLine(string.Format("selftest: {0} passed, {1} failed", pass, fail));
        return fail == 0 ? 0 : 1;
    }

    static byte[] FromHex(string h)
    {
        byte[] b = new byte[h.Length / 2];
        for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(h.Substring(i * 2, 2), 16);
        return b;
    }

    static int Main(string[] argv)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        string name = "pindou-PC01";
        Guid svc = Guid.Parse("4fafc201-1fb5-459e-8fcc-c5c9c331914b");
        Guid ch = Guid.Parse("beb5483e-36e1-4688-b7f5-ea07361b26a8");
        for (int a = 0; a < argv.Length; a++)
        {
            if (argv[a] == "--pixdou") _pixdou = true;
            else if (argv[a] == "--selftest") return SelfTest();
            else if (a + 1 < argv.Length)
            {
                if (argv[a] == "--name") name = argv[++a];
                else if (argv[a] == "--service") svc = Guid.Parse(argv[++a]);
                else if (argv[a] == "--char") ch = Guid.Parse(argv[++a]);
                else if (argv[a] == "--w") _w = ushort.Parse(argv[++a]);
                else if (argv[a] == "--h") _h = ushort.Parse(argv[++a]);
            }
        }
        // PIXDOU 双特征模式强制 UUID（放在最后，避免被 --service/--char 旧默认值覆盖）
        if (_pixdou) { svc = new Guid("0000a950-0000-1000-8000-00805f9b34fb"); ch = new Guid("0000a951-0000-1000-8000-00805f9b34fb"); }
        var si = new Thread(StdinLoop); si.IsBackground = true; si.Start();
        try
        {
            return Run(name, svc, ch);
        }
        catch (Exception ex)
        {
            string st = (ex.StackTrace ?? "").Replace("\r", " ").Replace("\n", " ").Replace("\"", "'");
            if (st.Length > 320) st = st.Substring(0, 320);
            Emit("{\"ev\":\"error\",\"msg\":\"fatal:" + ex.GetType().Name + ":" + ex.Message.Replace("\"", "'") + " @" + st + "\"}");
            return 1;
        }
    }
}
