# Project Titan — Web 视频压缩引擎

> Vue 3 + WebAssembly + WebCodecs | 浏览器端视频压缩，硬件加速

---

## 架构概览

Titan 采用**双引擎路由 + 自动降级**策略：

```
用户文件
   │
   ▼
EngineRouter（engine-router.ts）
   │
   ├─ WebCodecs 可用 ──► WebCodecs Worker（mediabunny，性能优先）
   │                         │
   │                     失败? ──YES──► 降级到 FFmpeg WASM
   │
   └─ WebCodecs 不可用 ──► FFmpeg WASM（兼容性兜底）
```

- **Main Thread**：Vue 3 UI，状态管理，队列调度（Dashboard.vue）
- **FFmpeg WASM**：浏览器内运行的 FFmpeg，多线程版本 `@ffmpeg/core-mt`，支持 H.264 / H.265 / AV1
- **WebCodecs Worker**：基于 [mediabunny v1.40.1](https://github.com/Vanilagy/mediabunny) 的 Conversion API，强制 GPU 硬件加速

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

## 技术栈

| 层 | 技术 |
|----|------|
| UI 框架 | Vue 3 + TypeScript + Vite |
| 主引擎 | mediabunny v1.40.1（WebCodecs Conversion API） |
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

---

## 快速开始

```bash
npm install
npm run dev
```

```bash
npm run build
```

---

## 支持的格式

输入：MP4、MOV、MKV、AVI、WebM、FLV、WMV、3GP、OGV、M4V、TS、MTS

输出：MP4
