# Project Titan — 核心压缩架构文档

> 2026-04-21 | 状态：当前实现

---

## 1. 双引擎路由策略

```
                compress(file, options)
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
      EngineRouter.route(fileSize)
              │
    WebCodecs 可用? ──YES──► WebCodecs Worker (mediabunny)
              │                   │
              NO              失败?
              │                   │
        FFmpeg WASM ◄────YES─────┘
        (降级路径)
```

**入口**：[engine-router.ts](Z/src/engine/engine-router.ts)

路由逻辑：
1. 首次运行时执行能力探测：`VideoEncoder` + `VideoDecoder` 是否存在 && OPFS 是否可用
2. **WebCodecs 可用 → 所有文件走 WebCodecs**（不受文件大小限制）
3. **WebCodecs 不可用 → FFmpeg WASM**
4. WebCodecs 执行失败 → 自动降级到 FFmpeg WASM，记录 warning

`2GB` 阈值当前仅作为 FFmpeg 降级路径的安全提示，不阻断 WebCodecs 路由。

---

## 2. FFmpeg WASM 引擎（降级路径）

**文件**：[ffmpeg-engine.ts](Z/src/engine/ffmpeg-engine.ts)

### 2.1 核心配置
| 项 | 值 |
|---|---|
| Core | `@ffmpeg/core-mt`（多线程版） |
| 静态资源 | `public/ffmpeg-mt/` (js + wasm + worker.js) |
| 多线程 | H.264 启用 `-threads 0`（自动用全部 CPU 核心） |
| 内存隔离 | SharedArrayBuffer 需 COOP/COEP 响应头 |

### 2.2 编码参数

| Codec | 参数 |
|-------|------|
| libx264 (H.264) | `-crf N -preset P -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -threads 0` |
| libx265 (H.265) | `-crf N -preset P -pix_fmt yuv420p -c:a aac -b:a 128k -tag:v hvc1` |
| libaom-av1 | `-cpu-used 8 -crf N -b:v 0 -pix_fmt yuv420p -c:a libopus` |

### 2.3 加载方式
```
ffmpeg-core.js   ─┐
ffmpeg-core.wasm ─┤─ toBlobURL → FFmpeg.load()
ffmpeg-core.worker.js ─┘         (多线程 Web Worker)
```

三个文件从 `/ffmpeg-mt/` 路径通过 Vite static asset server 加载，
转换为 Blob URL 后传给 `FFmpeg` 实例。

### 2.4 性能度量
每次 exec 调用自动记录耗时到控制台：
```
[FFmpegEngine] libx264 done: 12.34s (46.7 MB)
```

---

## 3. WebCodecs Worker 引擎（主路径）

**文件**：[workers/media-worker.ts](Z/src/engine/workers/media-worker.ts)

### 3.1 技术栈
| 层 | 技术 |
|---|---|
| 解析 | mediabunny `Input` + `BlobSource` |
| 编码 | `VideoEncoder` WebCodecs API（浏览器原生） |
| 多路复用 | mediabunny `Mp4OutputFormat` + `StreamTarget` |
| 磁盘 | OPFS `FileSystemSyncAccessHandle`（同步写入，零拷贝） |

### 3.2 硬件加速（分辨率受限）

```typescript
hardwareAcceleration: 'no-preference'  // media-worker.ts:116 & :135
```

`'no-preference'` 让浏览器自动选择最合适的编码器：
- **≤1080p**：浏览器自动启用 GPU 硬件加速（Intel Quick Sync / NVENC）
- **2K (2560×1440)**：浏览器 GPU 编码器不支持此分辨率 → 自动降级为 CPU 软件编码
- **4K**：同上，纯 CPU 软件编码

这是浏览器 VideoEncoder API 的硬性限制，非代码可绕过。

**实测数据**（encoder-diag.html, Intel UHD Graphics 770）：

| 分辨率 | isConfigSupported | 实际编码方式 | 吞吐量 |
|--------|-------------------|------------|--------|
| 640×480 | ✅ supported | GPU 硬件加速 | 279% 实时（83.6 fps） |
| 1080p | ✅ supported（推断） | GPU 硬件加速 | 未实测 |
| 2K 2560×1440 | ❌ **unsupported** | CPU 软件编码 | ~2.3 MB/s |
| 4K | ❌ **unsupported** | CPU 软件编码 | ~2.3 MB/s |

如需 2K/4K GPU 硬件加速，需使用 Native Host 极速模式（调用系统 FFmpeg + NVENC/QSV）。

### 3.3 工作流程
```
File (Blob)
  │
  ▼
mediabunny Input.getPrimaryVideoTrack()  ← 读取宽度/高度/时长
  │
  ▼
calculateSmartBitrate()  ← 智能码率计算
  │
  ▼
Conversion.init(video={codec, bitrate, hardwareAcceleration:'no-preference'})
  │
  ▼
conversion.execute()
  │  onProgress(p) ──► postMessage PROGRESS
  ▼
WritableStream ──► OPFS syncAccessHandle.write(chunk, {at: position})
  │
  ▼
flush() + close() ──► DONE
```

### 3.4 calculateSmartBitrate 算法
```
originalBitrate = fileSize * 8 / duration

resolution ──► recommendedBitrate:
  ≤ 640×480    → 1.5 Mbps (SD)
  ≤ 1280×720   → 4.0 Mbps (HD)
  ≤ 1920×1080  → 8.0 Mbps (FHD)
  > 1920×1080  → 30 Mbps (4K)

if original < recommended:
  smart = original * 0.8          ← 低码率视频保守压缩
else:
  smart = recommended             ← 高码率视频激进压缩

smart = max(smart, 500kbps)       ← 最低码率保护

if userBitrate > originalBitrate:
  return smart                     ← 防止码率膨胀
else:
  return userBitrate               ← 用户指定优先
```

**实际效果**：720p 高码率录屏（~12 Mbps）→ 限制到 4 Mbps → 约 67% 压缩率。

---

## 4. 线程与进程模型

```
Main Thread (Dashboard.vue)
  │
  ├── EngineRouter.route() ──► 选择引擎
  │
  ├── FFmpeg WASM 路径（主线程内，WASM 内部多线程）
  │     └── @ffmpeg/core-mt 内部创建 Web Workers 并行编码
  │
  └── WebCodecs Worker 路径（独立 Web Worker）
        └── MediaEngine ──► media-worker?worker&inline
              └── mediabunny Conversion API ──► VideoEncoder (GPU)
```

### 4.1 并发策略
**当前为串行队列**：`processQueue()` 使用 `for...of` + `await` 逐个处理。

理由：
- GPU encoder 通常仅 1–2 个并发 session，并行会互相抢占
- FFmpeg WASM 每个实例 100–300MB 内存，多实例易 OOM
- 单任务独占 CPU/GPU 资源，整体吞吐量不低于并行

### 4.2 Worker 通信协议
```
Main ──► Worker:  PING / START_PROCESS / STOP
Worker ──► Main:  PONG / PROGRESS / DONE / ERROR
```

PING/PONG 握手超时 5s 未响应 → 判定 Worker 初始化失败（代理阻断）。

---

## 5. 用户参数持久化

**文件**：[Dashboard.vue](Z/src/components/Dashboard.vue) (L67–93)

| localStorage Key | 存储内容 |
|---|---|
| `titan-theme` | 主题（dark/light） |
| `titan-settings` | `{ codec, crf, preset }` JSON |

刷新页面后自动恢复上次设置，非法值自动回退默认：
- codec 不在 `['libx264','libx265','av1']` → `libx264`
- crf 不在 18–40 范围 → `28`
- preset 不在枚举中 → `fast`

---

## 6. 部署必要条件

WebCodecs Worker 使用 `SharedArrayBuffer`，服务器**必须**返回：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

开发环境由 `vite.config.ts` server.headers 自动提供。

---

## 7. 依赖版本

| 包 | 版本 | 用途 |
|---|---|---|
| mediabunny | 1.40.1 | WebCodecs Conversion API |
| @ffmpeg/ffmpeg | 0.12.15 | FFmpeg WASM 主包 |
| @ffmpeg/util | 0.12.2 | fetchFile / toBlobURL |
| @ffmpeg/core-mt | (latest) | 多线程 FFmpeg core |
| Vue 3 | - | UI 框架 |
| Vite | - | 构建工具 |

---

## 8. 关键文件清单

| 文件 | 职责 |
|---|---|
| `engine/engine-router.ts` | 双引擎路由 + 降级逻辑 |
| `engine/ffmpeg-engine.ts` | FFmpeg WASM 封装（多线程） |
| `engine/processor.ts` | WebCodecs Worker 管理（握手/通信） |
| `engine/workers/media-worker.ts` | mediabunny 压缩管线（Web Worker） |
| `engine/storage-service.ts` | OPFS 文件系统封装 |
| `components/Dashboard.vue` | UI + 队列管理 + 参数持久化 |
| `public/ffmpeg-mt/` | 多线程 FFmpeg WASM 静态资源 |
| `public/ffmpeg/` | 旧版单线程 FFmpeg WASM 静态资源（可删除） |

---

## 9. Native Host 极速模式（插拔式 GPU 加速）

**状态：已实现 | 编译通过 | 待安装测试**

### 9.1 架构概览

```
Web UI (Dashboard.vue)
  │
  ├── 检测到 Native Host → 显示 🚀 极速模式入口
  │
Chrome Extension (native-bridge/)
  │
  ├── extension-page.html/css/js  → 独立 UI（目录选择/队列/进度）
  ├── background.js              → Service Worker，管理 Native Messaging 连接
  │
  ▼  stdin/stdout (JSON only, 4-byte LE length prefix)
  │
Rust Native Host (titan-host.exe)
  │
  ├── GPU 编码器检测（NVENC > QSV > AMF > libx264）
  ├── FFmpeg 调用 + stderr 进度解析
  ├── 目录扫描（walkdir）+ 批量编码
  │
  ▼  直接写磁盘
  │
输出文件: xxx_titan.mp4（同输出目录）
```

### 9.2 技术要点

| 维度 | 决策 | 说明 |
|------|------|------|
| 通信协议 | Native Messaging | Chrome 沙盒保护，4-byte LE 长度前缀 + UTF-8 JSON |
| 数据流转 | 纯 JSON，零二进制 | 绕过 1MB 消息限制，无 Base64 开销 |
| 文件 IO | Native 端直接读写 | 扩展页输入目录路径，Native Host 扫描+编码+写盘 |
| GPU 检测 | 双保险 | `ffmpeg -encoders` 确认编译 + 1帧合成实测确认硬件 |
| 线程模型 | tokio async | `Arc<Mutex<Stdout>>` 线程安全消息发送 |
| 二进制大小 | ~1.7MB | `opt-level=z` + LTO + strip |

### 9.3 Native Messaging 协议

**请求类型**：
| 类型 | 字段 | 响应 |
|------|------|------|
| `Ping` | — | `pong` + 可用编码器列表 |
| `ListFiles` | `dir` | `files` + 视频路径数组 |
| `Compress` | `input_dir`, `output_dir`, `codec`, `crf`, `preset`, `_requestId` | `progress`/`complete`/`error` |

**响应类型**：
| 类型 | 字段 |
|------|------|
| `pong` | `encoders: string[]` |
| `files` | `files: string[]` |
| `progress` | `file`, `percent`, `fps`, `eta`, `_requestId` |
| `complete` | `total`, `duration_sec`, `_requestId` |
| `error` | `message`, `_requestId` |

### 9.4 编码器映射

用户选择 → 实际编码器（根据硬件自动匹配）：

| 用户选择 | NVENC | QSV | AMF | Software |
|----------|-------|-----|-----|----------|
| H.264 | h264_nvenc | h264_qsv | h264_amf | libx264 |
| H.265 | hevc_nvenc | hevc_qsv | hevc_amf | libx265 |
| AV1 | av1_nvenc | av1_qsv | — | libaom-av1 |

GPU 编码器不可用时，软件编码器参数：
- libx264/libx265: `-preset` + `-crf` + `-threads 0`
- libaom-av1: `-cpu-used 8` + `-crf`

GPU 编码器参数：`-preset` (p1-p7) + `-cq` (CRF 等效)

### 9.5 关键文件

| 文件 | 职责 |
|------|------|
| `native-host/src/main.rs` | Native Host 核心 (~400行) |
| `native-host/Cargo.toml` | Rust 项目配置 |
| `native-host/install-titan-host.ps1` | Windows 一键安装脚本 |
| `native-host/titan-host.json` | Chrome Native Messaging Host Manifest（模板） |
| `native-bridge/manifest.json` | Chrome Extension MV3 清单 |
| `native-bridge/background.js` | Extension Service Worker |
| `native-bridge/extension-page.{html,css,js}` | 极速模式独立 UI |
| `native-bridge/icons/icon-128.png` | 扩展图标 |

### 9.6 安装步骤

```powershell
# 1. 编译 Rust Native Host（已编译通过）
cd Z/native-host
cargo build --release

# 2. 运行安装脚本
powershell -ExecutionPolicy Bypass -File install-titan-host.ps1

# 3. Chrome 加载扩展
# chrome://extensions → 开发者模式 → 加载已解压的扩展 → 选择 native-bridge/

# 4. 复制 Extension ID 到 titan-host.json 的 allowed_origins
# 然后重新加载扩展
```

### 9.7 依赖

| 依赖 | 状态 | 说明 |
|------|------|------|
| FFmpeg + ffprobe | 必需 | 必须在系统 PATH 中，安装脚本会检测 |
| GPU 驱动 | 可选 | 无 GPU 时自动降级到软件编码器 |
| Chrome / Edge | 必需 | 版本 ≥ 110 |
