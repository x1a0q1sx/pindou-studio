# 调研：智能拼豆板的蓝牙实现

> 本文记录本项目「PC 虚拟智能拼豆板」功能的协议依据与工程结论。
> 所有帧样本均来自**与本项目自身虚拟板联调时收集的实机帧**（App ↔ 虚拟板之间的
> 正常 GATT 通信），用于保证互操作性；不包含任何应用内部实现细节。

## 来源与背景

- **酷猫拼豆「智能拼豆板蓝牙开放协议」**（GitHub `tumao7/pindouban`，v1.3.0，配套微信小程序 + 双端 App「酷猫拼豆」）
  ——国内智能拼豆板生态的**公开协议范本**，含 ESP32/nRF52/Linux 网关三种参考实现。
  本项目的 `kmpd` 协议预设即按此公开协议实现。
- 「颂拼豆」App 的智能板功能：应用商店描述只有图纸生成 / 导出 PNG·PDF；
  经与虚拟板实际连接联调，确认其通过 PIXDOU 协议（双特征）下发点亮图案，
  帧格式已整理如下（见「PIXDOU 协议」一节）。本项目 `pixdou` 协议预设按此实现。

## 「正常智能拼豆板」的标准架构（被开源协议完全证实）

硬件本质 = **LED 点阵屏 + BLE 串口芯片**。手机 App 不存图也不显示，只把「点亮指令」通过 BLE 写给板子：

| 层 | 实现 |
| --- | --- |
| 射频/芯片 | ESP32 常见；GATT 用的就是 Arduino BluetoothSerial 的默认 UUID 对 |
| 广播过滤 | 设备名前缀 `pindou-XXXX` / `kmpd-XXXX`（App 按前缀过滤扫描结果，不符合搜不到） |
| GATT | 单 Service `4fafc201-1fb5-459e-8fcc-c5c9c331914b`；单 Characteristic `beb5483e-36e1-4688-b7f5-ea07361b26a8`（WRITE + WRITE_NO_RESPONSE + NOTIFY） |
| 连接流程 | `connect → discover → 协商MTU →（可选握手）→ clear → draw* → show`，断线自动重连 ≤3 次 |
| 能力分级 | L1 基础（连接/清屏/绘制/显示）；L2 +ACK/心跳/重连；L3 +握手鉴权。**握手是可选项——L1/L2 设备无需鉴权即可被连** |

### 命令集（写特征值，首字节命令码；设备→App 走 NOTIFY）

```text
0x01                        清屏
0x02 R G B x1 y1 x2 y2 ...  绘制像素（RGB565 色，多点位打包，坐标 ≤ 板宽）
0x03                        提交显示（帧缓冲刷到灯板）
0x04 value(0-100)           全局亮度（不随 clear/draw 重置）
0x05 / 0x06                 实体按键上行事件：上一色 / 下一色（防抖20-50ms，App 节流150-200ms）
0x10 nonce(8) / 0x11 sign   握手（推荐扩展，可无）
0x13 ts(4)                  心跳
A1 00 A1 00 BF              查询设备信息 → NOTIFY [A1, enabled, W, H, ver…]（104=0x68，App 以它校验图纸边界）
0xA2 x y dur(2B) len "码"   左上角临时色号覆盖显示（设备端 5×7 点阵字库，自动计时恢复底层图案）
0xA3                        取消临时提示
0xA0 reqCode status         命令执行回执 / 0xE1-E8 错误码
```

分包：单包 ≤180B；批量绘制完必须 `0x03` 提交；WRITE_NO_RESPONSE 10-30ms 节流。

## 对本项目的含义

- 「手机 App 把电脑当板子连」**完全可行**：协议就一张特征值 + 十来条命令，PC 用 WinRT GATT Server 完全可仿（本机已实测 `IsPeripheralRoleSupported=True`、`GattServiceProvider.CreateAsync=Success`）。
- **要连谁的 App 连谁的协议**：酷猫系（含按其公开协议做的第三方板 App/小程序）用 `kmpd` 预设；
  颂拼豆用 `pixdou` 预设（帧格式见下文，已实机联调验证）。
- 快捷通道：颂拼豆支持**导出图纸 PNG/PDF**——已可直接进本项目导入管线。
- 屏幕侧承接：本项目拼豆模式已是 1:1 渲染 + 区块导航，把「0x02 绘制点位」映射成「点亮格子」、0x05/0x06 映射成色卡切换，屏幕即可替身 LED 板。

## 落地路线（供决策）

1. **A 虚拟板路线（协议现成，推荐先做）**：PC 端做 WinRT GATT Server 外设（PowerShell/C# 旁路进程，Electron 只做桥接与渲染），广播 `pindou-PC01` + 上述 GATT；酷猫系 App/小程序即可连上投图案 → 本项目收命令、屏上点亮。全程有文档可依。
2. **B 协议分析路线**：安卓开 HCI 日志复现一次连接 + 投图，Wireshark 解帧找帧格式，再仿协议到 PC。工作量与不确定性高（可能带鉴权）。
3. **C 零风险路线**：颂拼豆导出 PNG → 本项目「导入图片」/局域网投图。（已可用）

## Windows WinRT GATT 外设实测要点（2026-09）

- `BluetoothAdapter.IsPeripheralRoleSupported = True`、`GattServiceProvider.CreateAsync = Success`——**Windows 桌面可以把电脑变成 BLE 外设**，旁路 `tools/virtualboard/VirtualBoard.cs` 已跑通（GATT 服务 + 特征值 + 广播 Started，ready 事件输出）。
- **广播内容限制（逐类型二分实测）**：
  - `ManufacturerData` ✅ 唯一可靠的自定义载荷；
  - `Flags` 属性 / `LocalName` 属性 / `ServiceUuids` ❌ ArgumentException（值不在预期范围）；
  - 手工数据段 0x01(Flags)/0x09(Complete Local Name) ❌ E_ACCESSDENIED——**Windows 把设备名与标志收归系统托管**，广播名 = 本机蓝牙适配器名（= 电脑名）。
  - 结论：想让按 `pindou-`/`kmpd-` 前缀过滤的 App 搜到电脑，需把**电脑名（蓝牙名）改成该前缀**；自定义标识可放 ManufacturerData。
- 单蓝牙芯片收不到自己的广播（watcher 与 publisher 同机互不可见），**空中可见性必须用手机侧（nRF Connect / 目标 App）验证**。
- **「手机搜不到」诊断结论**：
  - `BluetoothLEAdvertisementPublisher`（仅 mfg）`Started` ✅——**广播确实在发**；手机搜不到的根因是过滤条件不匹配（名字/服务 UUID 都进不了广播），不是没发。
  - `ServiceUuids`属性 ❌ ArgumentException；**原始 AD 段 0x07（完整 128 位服务 UUID）也 ❌ E_ACCESSDENIED**——Windows 把服务 UUID 一并托管，Publisher 路线无法让「按服务过滤」的 App 扫到。
  - `GattServiceProvider.StartAdvertising`（可连接广播 + 系统自带服务 UUID 的正统路子）**并非不可用**——Start 后会先报一次**瞬态 Aborted，数百毫秒后自动迁移 Started**；首轮轮询就放弃是误判。已修：首轮非 Started 时再等 1.2s 二次确认。
  - 修正后的链路（全部实测打通）：**GATT 可连接广播（带服务 UUID + 系统托管名）→ nRF Connect 扫到并连接 → 订阅 CCCD → PC 端 `SubscribedClientsChanged` 触发「手机已连接（订阅者 1）」**。
  - Windows 每次广播会话用**不同的随机地址**（非适配器静态 MAC），旁路重启后手机端旧地址会连接失败，需重新扫描。
  - `BluetoothLEAdvertisementPublisher` **天生不可连接**（winmd 里 Publisher2/3 接口根本没有 IsConnectable，只有功率/扩展广播/匿名等参数）；`BluetoothLEAdvertisement` 的 IsConnectable 是只读。手工 ComImport 声明 Publisher2 接口会因调用错槽位直接 AV 崩溃，别走这条路。
  - 旁路对策（已实现）：广播优先走 GATT 通道，失败自动退回 Publisher + mfg 标识，并吐 `adv` 事件告知实际通道。
  - 教训：**窗口最小化时 Electron 渲染节流，无障碍树/日志会假死**——排查 PC 端事件时必须把窗口恢复前台再读，否则会得出「事件没触发」的错误结论。
- 桌面 .NET Framework 直连 WinRT 的编译配方（无需 Windows SDK）：`csc -r:WinMetadata\{Foundation,Devices,Storage,Security}.winmd -r:GAC 门面 System.Runtime.dll + System.Runtime.InteropServices.WindowsRuntime.dll`，异步用 `IAsyncOperation.Completed` 手写等待器（无聚合 Windows.winmd 时不能用 AsTask）。
- 本投影（Win11 新 WinMD）与经典 UWP 文档的差异备忘：`GattWriteRequestedEventArgs` 无 Characteristic 属性（用 `GetRequestAsync().Value`）；`GattSessionStatus` 是 `Closed/Active`；`GattLocalService` 无 Session（连接状态用特征值 `SubscribedClientsChanged` 近似）；`Publisher.Start()` 异步（状态 Created→Waiting→Started 轮询）。

## PIXDOU 协议（兼容实现）

> 帧样本来自 App ↔ 虚拟板联调实录（18/18 帧 + 全链路点灯跑通，2026-09）。
> 双特征：控制 `0xA951` + 节目数据 `0xA952`；App 按服务 UUID（`0xA950`/`0xA951`）过滤设备，对名字无要求。

### 帧格式（**请求与回码同构**）

- **统一帧**：`[0x54][cmd][len16=payload+2][payload][cks16BE]`，`total = len16+4`
  - `cks16 = (前 total-2 字节求和) & 0xFFFF`，大端存放
  - 特例：`cmd==0 && len16==5` → total=11（分片应答紧凑形式，与 len16=7 形式解析等价）
  - 最短可解析帧：cmd!=0 → 7B；cmd==0 → 11B
- ⚠ **关键坑**：协议分析时曾把回码头写成 `0xA8`——那是 App 侧解析器把同步字节
  `0x54` 左移 1 位后的内部标记值（`0x54 << 1 = 0xA8`），**真实同步字节是 0x54**。
  写成 0xA8 → 解析器找不到同步字 → 所有响应被当噪音丢弃 → 全部超时。
- **回码匹配铁律**：`item[1]==responseCommand`，且结果字节必须=1 —— 无 packetId 时 `item[4]==1`；
  有 packetId 时 payload 前 4B 为 u32be 序号且 `item[8]==1`。
  不符 → 重试 4 次 → `TimeoutException` → `lighting failed`。
- 实测回码（全部被接受，`protocol response accepted` → `lighting completed`）：
  - 0x0A 开屏 `54 0a 00 03 01 00 62`（App 无 responseCommand，不匹配，回之无妨）
  - 0x06 新增节目 `54 06 00 03 01 00 5e`
  - 0x00 分片#N `54 00 00 07 <u32be N> 01 <cks>`
  - 0x01 完成 `54 01 00 03 01 00 59`

### 节目下发流（实机跑通）

`0x0A 开屏` → `0x06 新增临时节目(id=crc32c,总长)` → `0x00×N`（180B/片：idx4B+len2B+data）→ `0x01 完成`。
分片应答 payload=`u32be(idx)+状态(1B)`。

### 节目数据布局（实测帧样本）

```
programData = u32be(crc32c(programWithoutId))   [4B]
            + [1,0,0,0]                          [4B]  分区数=1
            + u32be(0)×4                         [16B] 分区地址补 0
            + partition:
                u16be(x0) u16be(y0)              [4B]
                u16be(宽) u16be(高)              [4B]  ← 宽在偏移 28、高在偏移 30
                000 06 u16be(0) + 0×8            [14B]
                <GIF 原始字节>                    ← 实测从偏移 46 开始
```

实测：A3 色号 104×104 单帧 GIF，37 格亮点（与 App「数量37」一致）；A10 → 31 格橙棕。
**业务语义**：点色号 → App 把该色号所有格子打包成 GIF 下发 → 板子只亮这些格子。

### 点灯业务语义

`高亮切换 → 同步智能板点亮 → 节目队列提交 → GIF89a 编码 → 下发`
- App 侧存在 `supportsLighting` 门：厂商/型号不在支持列表时弹提示「该厂家未启用点亮协议」。
- App 画布「高亮/取消高亮」按钮在**已拼完（进度 n/n）且无高亮色**时不会触发同步——验证前先留未完成色。
- 调试入口：App 内开发者模式页 → 蓝牙调试开关 → 智能板弹窗右上角日志入口。

### 运行时驱动现状

- 旁路 `VirtualBoard.exe`（= `tools/virtualboard/VirtualBoard.cs`）响应按 0x54 同构帧构造，
  stdin 热控：`ack9|acka|ack0|ackz auto|<hex>`（按命令改响应 payload）、`push <hex>`（主动 notify）、`exit`。
- 连接仪式：PC「添加设备」蓝牙飞窗必须开着，手机设置点选电脑蓝牙名 → App 内连接。
  曾遇到系统设置挂死（UIA 只剩 3 按钮、点击无响应）→ 重启 PC 恢复。
- 长连接排障提示：Windows 系统设置/蓝牙面板与旁路进程同时抢蓝牙栈时偶发挂死；
  排障时先退旁路再开系统设置。
