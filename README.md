# PinDou Studio · 智能拼豆板工作台

> **把屏幕变成一块发光底板** —— 按真实物理尺寸 1:1 渲染拼豆钉位网格的 Electron 桌面应用。
> 把透明拼豆板叠在屏幕上、板角对准括标，即可照着屏幕逐颗放豆。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-lightgrey)
![Electron](https://img.shields.io/badge/Electron-44-47848F)

## 这是什么

一块 28cm 的 104 钉拼豆板比大多数笔记本屏幕都高——传统做法是打印纸质图纸或用小屏幕逐块对照，容易错位。本项目把屏幕本身变成 1:1 的「发光底板」：

- **物理 1:1**：按钉距（默认 2.6923mm）与屏幕 PPI 精确渲染，屏幕上相邻格距 = 板上相邻钉距；
- **屏幕即灯板**：拼豆模式只亮「当前色的未拼格」，与真实 LED 发光底板观感一致；
- **全流程**：图片导入 → 像素化减色 → 色板匹配 → 逐色拼豆 → 施工图导出，一个应用完成。

适用：2.6mm 迷你豆（104/78/52 钉）与 5mm 标准豆（Perler / Hama / Artkal / MARD 色板）。

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 🎯 物理校准 | 五种校准法：WMI 自动检测 / 标尺拖拽 / 实测跨度 / PPI 输入 / 拼豆模式内整板对位；多显示器分屏存档 |
| 🖼️ 图片导入 | 裁剪 → 像素化 → 减色（Median Cut + Lab K-means）→ CIEDE2000 匹配色板；去背景 / 抖动 / 高光保护 / 成品拼豆逆向（含四角透视校正） |
| 🎨 色板 | 内置 5 套（通用 / Artkal 225 / MARD 221 / Perler / Hama）+ 自定义色板；颜色编辑器 + 吸管实测校正 |
| ✏️ 编辑 | 画笔 / 橡皮 / 连通填充 / 同色替换 / 吸管 / 平移 / 标记已放；稀疏 diff 撤销栈（300 步）；包边一键描边 |
| 💡 拼豆模式 | 按 `P` 进入：自动全屏 + 1:1 + 发光底板主题 + 防休眠；逐色进度、剩余量排序换色、区块导航、防错位 L 形括标 |
| 📤 导出 | 7 种产物：1:1 PNG / 分块 PNG / 预览图 / CSV 清单 / CSV 网格 / TXT 施工图 / JSON 色板 |
| 🖥️ 双板并排 | 左右两块独立画布（图 A / 图 B），可拖分割线，对照浏览 |
| 📱 手机投图 | 局域网二维码上传：手机拍照 → 直接落进画板 |
| 🔗 社区图纸 | 内置 Reddit 拼豆社区（r/PerlerBeads 等）图纸检索，一键导入走完整像素化管线 |
| 🔵 虚拟智能板 | 把 PC 伪装成 BLE 智能拼豆板（WinRT GATT Server）：手机 App 连上后点色号，屏幕实时点亮对应格子 |
| 🎨 主题 × 布局 | 4 主题 × 4 布局任意组合；全部动效尊重系统「减少动态效果」设置 |

完整功能说明见 **[docs/USAGE.md](docs/USAGE.md)**（约 700 行的使用手册）。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（完整功能）；macOS / Linux 可运行，物理尺寸自动检测等系统能力降级 |
| Node.js | v20 及以上 |
| 浏览器（可选） | Chromium 内核（Chrome / Edge），用于纯浏览器模式 |

## 快速开始

```powershell
# 1. 安装依赖
npm install

# 2. 开发模式（Vite 热更新 + Electron，推荐）
npm run dev

# 3. 打包 Windows 安装器（可选）
npm run dist
```

> PowerShell 下请用 `;` 而不是 `&&` 连接命令（如 `npm install; npm run dev`）。

其他脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run dev:web` | 仅浏览器模式（无 Electron，系统能力降级），打开 http://127.0.0.1:5173 |
| `npm run start` | 以成品形态运行已构建的 `dist/` |
| `npm test` | 运行全量单元测试（Vitest，264 用例） |
| `npm run test:types` | 对测试代码做类型检查 |
| `npm run lint` | ESLint 检查（`lint:fix` 自动修复） |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run clean` | 清理打包产物缓存 |

## 使用流程（三步）

1. **校准**：首启引导第 4 步，把实物板贴在屏幕上拖滑块，直到屏幕格距与板上钉距完全重合（或跳过引导后用「校准向导」）；
2. **出图**：导入图片 → 裁剪 → 调参数 → 生成图案；也可以直接开空白板手绘；
3. **拼豆**：按 `P` 进入拼豆模式，屏幕只亮当前色待拼格，放一颗点一下，逐色拼完自动跳下一色。

## 技术栈

- **Electron 44 + Vite 6 + TypeScript 5 + React 18 + zustand 5**
- 颜色科学（sRGB↔Lab、CIEDE2000、Median Cut + K-means 量化）与渲染器（四层离屏缓存 + 脏矩形）**全部手写**，无第三方算法库；
- 图片管线跑 Web Worker（OffscreenCanvas 优先，自动回退主线程）；
- 测试：Vitest（26 个测试文件 / 264 用例）+ 测试代码类型门禁 + ESLint。

## 项目结构

```
src/
  core/       纯逻辑层：几何分区、编辑操作、拼豆导航、蓝牙协议（酷猫/PIXDOU）
  color/      色彩科学：转换、量化、色板匹配
  imaging/    成像管线：解码、裁剪、像素化（Web Worker）
  io/         桥接、导出器（7 种产物）、项目序列化
  render/     Canvas 渲染器、脏矩形、四层失效状态机、导出光栅
  store/      zustand 状态库、撤销栈、持久化
  components/ UI 组件（画布/调色板/导入/拼豆/项目/布局/主题/引导/社区/投图/虚拟板）
  palettes/   5 套内置色板
  themes/     4 套主题
electron/      主进程：物理校准、全屏、防休眠、虚拟板旁路托管
tools/         虚拟板 C# 旁路源码（WinRT GATT Server）
docs/          使用手册 + 蓝牙协议调研
tests/         Vitest 用例
```

## 文档

- **[docs/USAGE.md](docs/USAGE.md)** —— 完整使用手册（环境、引导、功能指南、快捷键全表、校准五法、导出、FAQ）
- **[docs/RESEARCH-BLE-SMART-BEAD-BOARD.md](docs/RESEARCH-BLE-SMART-BEAD-BOARD.md)** —— 蓝牙智能板协议调研与 Windows WinRT GATT 外设实现要点
- **[AGENTS.md](AGENTS.md)** —— 面向 AI 编码助手的项目结构说明
- **[CHANGELOG.md](CHANGELOG.md)** —— 版本变更记录

## 免责声明

- **色板数据**：内置色板的 HEX 值为社区整理值（部分为按颜色名称语义推导），**不是厂商官方色卡数据**；批次间存在色差，屏幕显示 ≠ 实物颜色。请以实物豆为准，可用吸管 + 颜色编辑器校正。
- **社区图纸**：Reddit 等来源的图纸多为同人创作，个人使用无碍，商用请自行确认授权。
- **智能板协议**：`kmpd`（酷猫开放协议）为公开协议实现；`pixdou` 帧格式按实机联调帧样本整理，仅用于互操作。相关产品名称与商标归各自所有者所有。
- 本项目与上述任何硬件/App 厂商无关联。

## 开源协议

[GPL-3.0](LICENSE) © 2026 PinDou Studio
