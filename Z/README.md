# Project Titan: Elite Media Engine (V4 Elite)

> **Silicon Valley Standards | High-Key Aesthetics | Extreme Performance**

Project Titan 是一款面向 2026 时代的专业级 Web 端媒体处理引擎。它通过融合 WebAssembly、WebGPU 以及最新的 Web Storage APIs，在浏览器环境中实现了以往只有原生应用才能处理的 10GB+ 级超大视频处理能力。

---

## 1. 系统架构设计 (Architecture)

Titan 采用了一种**非对称多线程架构**，旨在确保在进行高负载转码任务的同时，主 UI 线程始终保持 60FPS 的丝滑流畅。

- **Main Thread (UI/UX)**: 负责状态机管理、动效渲染（Spring Physics）以及用户交互。
- **Titan Worker (Control Plane)**: 作为中枢神经系统，协调文件流、存储句柄与转码引擎。它利用 `Transferable Objects` 传递 `FileSystemSyncAccessHandle`，实现零拷贝数据传输。
- **FFmpeg WASM (Data Plane)**: 核心转码引擎，通过编译后的 WASM 模块直接操作内存中的原始比特流。
- **WebGPU Shader (Graphics Plane)**: 专门处理视频预处理、实时滤镜以及画质增强。

---

## 2. 核心技术深度解析

### 2.1 FFmpeg.wasm 转码Suite
我们集成了高度定制化的 FFmpeg 编译版本，针对浏览器环境进行了指令集优化：
- **多编码器支持**: 支持 `libx264` (Standard), `libx265` (HEVC) 以及谷歌力推的 `libaom-av1` (Next-Gen)。
- **硬件加速**: 在支持的 Chromium 浏览器中，利用 `Cross-Origin-Embedder-Policy: require-corp` 开启多核并行加速。
- **双流处理**: 在转码过程中同时生成缩略图与元数据流，确对比功能的实时性。

### 2.2 OPFS 混合存储方案
针对 10GB+ 的超大视频，传统的 `Blob` 或 `ArrayBuffer` 会导致浏览器 OOM (Out of Memory)。Titan 引入了 **OPFS (Origin Private File System)**：
- **原生 I/O 吞吐**: 使用 `createSyncAccessHandle` 在 Worker 中直接读写磁盘，绕过主线程异步 I/O 的开销，达到原生级别的读写速度。
- **磁盘缓冲区**: 所有处理过程中的中间文件均保存在沙盒化的私有文件系统中，不占用用户物理磁盘的可见空间，处理完成后自动清理。

### 2.3 WebGPU Shader 零拷贝加速
Project Titan 的视觉预处理器通过 WebGPU (WGSL) 实现：
- **零拷贝采样**: 使用 `texture_external` 绑定，直接从 WebCodecs 解码出的原始视频帧采样，无需将数据从 GPU 拷贝回 CPU。
- **Kernel 全维过滤**: `kernel.wgsl` 实现了高性能的像素级处理逻辑，支持降噪、动态对比度调整等高级视觉功能。

---

## 3. 设计美学 (Aesthetics & UX)

Titan 不仅仅是一款工具，更是一件艺术品。我们遵循 **Luminous & Textural** 的高阶设计原则：

- **High-Key Palette**: 采用高明度、低饱和度的“空灵”色调（Airy White & Deep Blue Accent），消除专业工具的压迫感。
- **Glassmorphism 2.0**: 深度使用 `backdrop-filter: blur(24px)`，配合 0.5px 的半透明极细边框，营造出“悬浮”在系统之上的高级感。
- **物理动效**: 所有的界面切换与进度反馈均基于弹簧物理（Spring Physics），确保每一次点击都能得到符合物理直觉的 tactile 响应。
- **实时对比系统**: 内置 `ComparisonSlider` 组件，允许用户在处理过程中实时横向拉动，对比原片与压缩后的画质差异。

---

## 4. 性能优化与稳定性 (Performance)

- **内存隔离**: 通过 `SharedArrayBuffer` 实现主线程与 Worker 间的原子化操作，减少线程间同步耗时。
- **首屏秒开**: 将 FFmpeg 核心模块解耦，采用按需加载策略，确保 UI 框架能在 500ms 内完成渲染。
- **故障恢复机制**: 完善的转码状态捕获逻辑，支持检测 WASM 运行错误并自动进行优雅降级处理。

---

## 5. 开发者与部署指南

### 前项依赖 (Critical Headers)
由于使用了 SharedArrayBuffer 和跨域隔离技术，服务器环境**必须**配置以下响应头：
```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### 快速启动
```bash
npm install
npm run dev
```

### 生产构建
```bash
npm run build
```

---

**Project Titan** —— 重新定义 Web 端媒体处理的界限。
