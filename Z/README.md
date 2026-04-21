# Project Titan — 视频压缩引擎

> Vue 3 + WebAssembly + WebCodecs + Native Host GPU 加速 | 浏览器端视频压缩

---

## 架构概览

Titan 采用**三引擎路由 + 自动降级**策略：

```
用户文件
   │
   ▼
EngineRouter（engine-router.ts）
   │
   ├─ Native Host 可用 ──► Native Host GPU 编码（10-50× 速度）
   │                          Rust + FFmpeg + GPU 硬件加速
   │                          Chrome Extension + Native Messaging
   │
   ├─ WebCodecs 可用 ──► WebCodecs Worker（mediabunny）
   │                          浏览器原生 VideoEncoder + GPU
   │                      失败? ──YES──► 降级到 FFmpeg WASM
   │
   └─ WebCodecs 不可用 ──► FFmpeg WASM 多线程（兼容性兜底）
```

- **Native Host**（极速模式）：Chrome Extension + Rust 原生进程 + FFmpeg GPU 编码，绕过浏览器沙盒
- **WebCodecs Worker**（主模式）：基于 [mediabunny v1.40.1](https://github.com/Vanilagy/mediabunny)，强制 GPU 硬件加速
- **FFmpeg WASM**（降级模式）：浏览器内运行的 FFmpeg，多线程版本 `@ffmpeg/core-mt`

---

## 核心功能

### 压缩参数
- **编码格式**：H.264 (AVC) / H.265 (HEVC) / AV1，可切换
- **质量控制**：CRF 滑块（18–40），实时显示质量档位
- **速度预设**：ultrafast / fast / medium / slow（条形可视化）
- **智能码率**：`calculateSmartBitrate` 自动计算目标码率
  - 原始码率 < 分辨率推荐值 → 使用 80% 原始码率
  - 原始码率 ≥ 分辨率推荐值 → 限制到推荐上限（SD 1.5M / HD 4M / FHD 8M / 4K 30M）
  - 防止膨胀：用户指定码率超过原始时自动回退到智能值
- **设置持久化**：codec / CRF / preset 自动保存到 localStorage，刷新不丢失

### 处理进度
- 实时进度百分比 + MB/s 速率
- **剩余时间**胶囊（前 2% 显示 `--`，之后实时估算）
- **耗时**徽章（完成后显示总耗时）
- Header 状态栏：文件名 · 速率 · 进度 · 剩余时间

### UI 功能
- 拖拽 / 点击上传，支持批量队列
- 完成后内置对比滑块（ComparisonSlider）查看压缩前后画质
- 深色 / 亮色主题切换（持久化）
- 多语言（i18n）
- 内置日志控制台（LoggerConsole）

---

## 极速模式（Native Host）

### 什么是极速模式？

Chrome Extension + Rust 原生进程 + FFmpeg GPU 硬件加速的视频压缩方案。
绕过浏览器沙盒限制，直接调用系统 FFmpeg 和 GPU 编码器（NVENC / QSV / AMF），
速度可达 WebCodecs 模式的 **10-50 倍**。

### 插拔式设计

- **自动检测**：Web UI 自动探测 Native Host 是否已安装
- **可用**：显示 🚀 极速模式入口，点击打开扩展页
- **不可用**：无缝降级到 WebCodecs / FFmpeg WASM，用户无感知

### GPU 编码器优先级

```
NVIDIA NVENC > Intel Quick Sync (QSV) > AMD AMF > 软件编码 (libx264)
```

根据硬件自动选择，用户无需手动配置。

### 安装指南

详见 [NATIVE-GUIDE.md](NATIVE-GUIDE.md)

**快速安装**：
```powershell
cd Z/native-host
cargo build --release
powershell -ExecutionPolicy Bypass -File install-titan-host.ps1
```

然后 `chrome://extensions` → 开发者模式 → 加载 `native-bridge/` 目录。

### 关键指标

| 指标 | WebCodecs | Native Host (NVENC) |
|------|-----------|---------------------|
| 1080p 压缩速度 | ~1× 实时 | ~10-50× 实时 |
| 二进制大小 | 浏览器内置 | 1.7MB (Rust) |
| 依赖 | 无 | FFmpeg + GPU 驱动 |
| 安装 | 无需安装 | 需安装扩展 + Native Host |

---

## 技术栈

| 层 | 技术 |
|----|------|
| UI 框架 | Vue 3 + TypeScript + Vite |
| 主引擎 | mediabunny v1.40.1（WebCodecs Conversion API） |
| 极速模式 | Rust + FFmpeg + Chrome Native Messaging |
| 硬件加速 | `hardwareAcceleration: 'prefer-hardware'`（强制 GPU encoder） |
| 降级引擎 | FFmpeg WASM 多线程（`@ffmpeg/core-mt`，`-threads 0` 自动多核） |
| 封装格式 | MP4（mediabunny Mp4OutputFormat） |
| 磁盘写入 | OPFS `FileSystemSyncAccessHandle`（同步写入，零拷贝） |

---

## 部署要求

WebCodecs Worker 使用 `SharedArrayBuffer`，服务器**必须**返回以下响应头：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Native Host 模式不需要此要求（运行在浏览器外）。

---

## 快速开始

```bash
cd Z
npm install
npm run dev
```

```bash
npm run build
```

---

## 文档

| 文档 | 说明 |
|------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 完整技术架构文档（双引擎 + Native Host） |
| [NATIVE-PLAN.md](NATIVE-PLAN.md) | 极速模式实现方案（已完成） |
| [NATIVE-GUIDE.md](NATIVE-GUIDE.md) | 极速模式安装和使用指引 |

---

## 支持的格式

输入：MP4、MOV、MKV、AVI、WebM、FLV、WMV、3GP、OGV、M4V、TS、MTS

输出：MP4
