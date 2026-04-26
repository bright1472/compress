# Titan Compress — 本地隐私压缩工具

> Vue 3 + WebAssembly + WebCodecs + Native Host GPU 加速
> 图片 & 视频双模式 · 100% 本地压缩 · 无上传 · 无服务器

---

## 核心功能

### 图片压缩
- **原格式保持**：PNG 压 PNG、JPG 压 JPG，不强制转码
- **支持格式**：PNG、JPG/JPEG、WebP、AVIF、BMP、TIFF、GIF
- **质量调节**：0–100 可调，实时预览压缩率
- **批量处理**：拖拽多张同时压缩，进度逐项显示

### 视频压缩
- **编码格式**：H.264 (AVC) / H.265 (HEVC) / AV1，可切换
- **质量控制**：CRF 滑块（18–40），实时显示质量档位标签
- **速度预设**：ultrafast / fast / medium / slow（条形可视化）
- **取消压缩**：随时中断，已完成项保留，未完成项回滚至待处理
- **批量队列**：拖拽排序，支持 10GB+ 超大文件

### 通用功能
- **账号系统**：登录 / 一键注册（自动生成账户名 + 密码）
- **免费限额**：5 次免费压缩，激活码解锁无限次
- **全局统计**：显示所有用户累计节省的存储空间
- **深色 / 亮色主题**：持久化，支持跟随系统
- **多语言**：中文 / English 实时切换
- **内置日志**：LoggerConsole 面板查看引擎决策日志

---

## 引擎架构

```
用户文件
   │
   ▼
EngineRouter（engine-router.ts）
   │
   ├─ Tier 1  WebCodecs + 硬件 GPU 编码器   → GPU HW（Chrome/Edge + 独显/集显）
   ├─ Tier 2  WebCodecs + 软件 CPU 编码器   → GPU SW（Chrome/Edge，无可用 GPU）
   ├─ Tier 3  FFmpeg WASM 多线程           → CPU MT（有 SharedArrayBuffer）
   └─ Tier 4  FFmpeg WASM 单线程           → CPU ST（iOS Safari / 兜底）

图片走独立 ImageEngine，与视频引擎完全解耦
```

自动降级：Tier 1 失败 → Tier 2 → Tier 3/4，用户无感知。

---

## 极速模式（Native Host）

Chrome Extension + Rust 原生进程 + FFmpeg GPU 硬件编码，绕过浏览器沙盒。

| 指标 | WebCodecs (≤1080p) | WebCodecs (2K/4K) | Native Host (NVENC) |
|------|--------------------|--------------------|---------------------|
| 加速方式 | GPU 硬件 | CPU 软件 | GPU 硬件 |
| 压缩速度 | ~1× 实时 | ~0.3× 实时 | ~10-50× 实时 |
| 安装要求 | 无 | 无 | 扩展 + Native Host |

**GPU 优先级**：NVIDIA NVENC > Intel Quick Sync > AMD AMF > 软件编码

详见 [NATIVE-GUIDE.md](NATIVE-GUIDE.md)

---

## 技术栈

| 层 | 技术 |
|----|------|
| UI 框架 | Vue 3 + TypeScript + Vite |
| 图片引擎 | @jsquash/jpeg · @jsquash/webp · @jsquash/oxipng · UPNG.js |
| 视频主引擎 | mediabunny v1.40.1（WebCodecs Conversion API） |
| 极速模式 | Rust + FFmpeg + Chrome Native Messaging |

| 硬件加速 | `hardwareAcceleration: 'no-preference'`（≤1080p 自动启用 GPU，2K/4K 自动降级 CPU） |

| 降级引擎 | FFmpeg WASM（@ffmpeg/core-mt，-threads 0 自动多核） |
| 账号 & 权限 | basic-backend（NestJS + MongoDB + JWT） |
| 通用统计 | basic-backend `/stats/:namespace` 通用计数接口 |

---

## 快速开始

```bash
cd Z
pnpm install
pnpm dev
```

```bash
pnpm build
```

---

## 部署要求

WebCodecs Worker 使用 `SharedArrayBuffer`，服务器必须返回：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## 文档

| 文档 | 说明 |
|------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 完整技术架构（双引擎 + Native Host） |
| [ROADMAP.md](ROADMAP.md) | 产品路线图（商业化 + 功能迭代） |
| [NATIVE-GUIDE.md](NATIVE-GUIDE.md) | 极速模式安装指引 |
| [NATIVE-PLAN.md](NATIVE-PLAN.md) | 极速模式实现方案 |

---

## 支持格式

**图片输入**：PNG · JPG · JPEG · WebP · AVIF · BMP · TIFF · GIF

**视频输入**：MP4 · MOV · MKV · AVI · WebM · FLV · WMV · 3GP · OGV · M4V · TS · MTS

**视频输出**：MP4
