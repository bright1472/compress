# Titan 极速模式 — 安装与使用指引

> Chrome Extension + Rust Native Host + FFmpeg GPU 硬件加速
> 速度可达 WebCodecs 模式的 10-50 倍

---

## 1. 概述

### 什么是极速模式？

极速模式是一个**插拔式**的视频压缩加速方案。它通过 Chrome Extension 与本地 Rust 进程通信，
调用系统 FFmpeg 和 GPU 编码器（NVENC / QSV / AMF），绕过浏览器沙盒限制，实现极致的压缩速度。

### 工作原理

```
Web UI (Dashboard.vue)
  ├── 自动检测 Native Host
  ├── 已安装 → 显示 🚀 极速模式入口
  └── 未安装 → 继续用 WebCodecs / FFmpeg WASM
       │
       ▼
Chrome Extension (native-bridge/)
  ├── 扩展页 UI：选择目录、设置参数、查看进度
  ├── background.js：管理 Native Messaging 连接
  │
  ▼  stdin/stdout (JSON only)
  │
Rust Native Host (titan-host.exe, ~1.7MB)
  ├── 扫描输入目录下的视频文件
  ├── 自动检测 GPU 编码器 (NVENC > QSV > AMF)
  ├── 调用 FFmpeg 逐个编码
  ├── 解析 stderr 实时推送进度
  │
  ▼  直接写磁盘
  │
输出: xxx_titan.mp4（输出目录）
```

### 系统要求

| 组件 | 必需/可选 | 说明 |
|------|----------|------|
| Chrome / Edge ≥ 110 | ✅ 必需 | 支持 Native Messaging |
| FFmpeg + ffprobe | ✅ 必需 | 必须在系统 PATH 中 |
| NVIDIA GPU | 可选 | 启用 NVENC 编码器（最快） |
| Intel 集显 | 可选 | 启用 Quick Sync (QSV) |
| AMD GPU | 可选 | 启用 AMF 编码器 |
| 无 GPU | 可用 | 自动降级到 libx264 软件编码 |

### 编码器自动选择

用户只需选择 H.264 / H.265 / AV1，系统自动匹配最佳编码器：

| 用户选择 | 有 NVIDIA | 有 Intel | 有 AMD | 无 GPU |
|----------|-----------|----------|--------|--------|
| H.264 | h264_nvenc | h264_qsv | h264_amf | libx264 |
| H.265 | hevc_nvenc | hevc_qsv | hevc_amf | libx265 |
| AV1 | av1_nvenc | av1_qsv | — | libaom-av1 |

---

## 2. 安装指南

### 步骤 1：安装 FFmpeg

如果尚未安装 FFmpeg：

1. 下载：https://www.gyan.dev/ffmpeg/builds/ （推荐 ffmpeg-release-essentials.zip）
2. 解压到任意目录（如 `C:\ffmpeg\`）
3. 将 `C:\ffmpeg\bin\` 添加到系统 PATH：
   - Win + R → `sysdm.cpl` → 高级 → 环境变量 → Path → 编辑 → 新增
4. 验证：打开 PowerShell，输入 `ffmpeg -version`

### 步骤 2：编译 Rust Native Host

需要安装 Rust：https://rustup.rs/

```powershell
cd Z/native-host
cargo build --release
```

编译成功后，二进制位于：
`Z/native-host/target/release/titan-host.exe` (~1.7MB)

### 步骤 3：运行安装脚本

```powershell
cd Z/native-host
powershell -ExecutionPolicy Bypass -File install-titan-host.ps1
```

脚本会执行：
1. ✅ 检测 FFmpeg 是否在 PATH 中
2. ✅ 创建 `%LOCALAPPDATA%\TitanHost\` 目录
3. ✅ 复制 `titan-host.exe` 到安装目录
4. ✅ 生成 `titan-host.json`（Native Messaging Manifest）
5. ✅ 注册到 Windows 注册表

### 步骤 4：加载 Chrome Extension

1. 打开 `chrome://extensions`
2. 右上角启用 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `Z/native-bridge/` 目录
5. 记录显示的 **Extension ID**（形如 `abcdefghijklmnopqrstuvwxyz123456`）

### 步骤 5：更新 Extension ID

1. 打开 `%LOCALAPPDATA%\TitanHost\titan-host.json`
2. 将 `PLACEHOLDER_EXTENSION_ID` 替换为实际的 Extension ID
3. 确保 `allowed_origins` 格式为：
   ```json
   "allowed_origins": [
     "chrome-extension://你的实际ID/"
   ]
   ```
4. 回到 `chrome://extensions`，点击 Titan 扩展的 **重新加载** 按钮

### 步骤 6：验证安装

1. 点击浏览器工具栏的 Titan 扩展图标
2. 顶部应显示 **GPU 引擎就绪: h264_nvenc**（或对应你的硬件）
3. 绿色状态栏显示 `GPU 引擎就绪`
4. 如果显示"未检测到 Native Host"，检查：
   - FFmpeg 是否在 PATH 中
   - 注册表路径是否正确
   - Extension ID 是否已更新到 titan-host.json

---

## 3. 使用指南

### 3.1 基本流程

1. **打开极速模式**：点击浏览器工具栏的 Titan 扩展图标
2. **输入目录**：粘贴包含视频文件的文件夹路径，按回车
   - 如：`C:\Videos\input`
   - 支持格式：MP4、MOV、MKV、AVI、WebM、FLV、WMV 等
3. **输出目录**（可选）：粘贴输出文件夹路径，留空则输出到输入目录
4. **设置参数**：
   - **编码**：H.264 / H.265 / AV1
   - **质量 (CRF)**：18-40，默认 28（数字越小质量越高）
   - **速度预设**：p1(最快) ~ p7(最慢/最高质量)，默认 p4
5. **开始压缩**：点击"开始压缩"按钮
6. **查看进度**：文件列表实时显示进度条、FPS、剩余时间
7. **完成**：状态栏显示"全部完成！共 X 个文件，总耗时 XmYs"
8. **打开输出目录**：点击"📁 打开输出目录"

### 3.2 参数说明

#### 编码格式

| 格式 | 特点 | 适用场景 |
|------|------|----------|
| H.264 (AVC) | 兼容性最好，速度快 | 通用场景，推荐 |
| H.265 (HEVC) | 压缩率更高，文件更小 | 存储空间敏感 |
| AV1 | 最新开源标准，压缩率最高 | 未来兼容 |

#### 质量 (CRF)

Constant Rate Factor，控制输出质量：

| CRF | 质量 | 文件大小 | 推荐场景 |
|-----|------|---------|---------|
| 18-22 | 极高 | 较大 | 归档 / 母版 |
| 23-28 | 高 | 中等 | 日常使用，**推荐 28** |
| 29-35 | 中 | 较小 | 网络传输 |
| 36-40 | 低 | 最小 | 极致压缩 |

#### 速度预设 (Preset)

| Preset | 速度 | 质量 | 适用 |
|--------|------|------|------|
| p1 | 最快 | 略低 | 紧急场景 |
| p2-p3 | 快 | 中 | 批量处理 |
| **p4** | 平衡 | 高 | **默认推荐** |
| p5-p6 | 慢 | 更高 | 质量优先 |
| p7 | 最慢 | 最高 | 归档级 |

### 3.3 设置持久化

所有设置（输入目录、输出目录、编码、CRF、预设）自动保存到浏览器存储，
下次打开极速模式时自动恢复上次的配置。

---

## 4. 故障排除

### 未检测到 Native Host

**症状**：扩展页顶部显示"未检测到 Native Host"

**排查步骤**：
1. 确认 FFmpeg 已安装且在 PATH 中：`ffmpeg -version`
2. 确认注册表存在条目：
   - Win + R → `regedit` → 导航到 `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.titan.video.host`
   - 默认值应为 `%LOCALAPPDATA%\TitanHost\titan-host.json` 的完整路径
3. 确认 `titan-host.json` 中 `path` 指向正确的 exe 路径
4. 确认 `allowed_origins` 包含正确的 Extension ID
5. 重启 Chrome 后重试

### 编码失败

**症状**：状态栏显示错误信息

**常见原因**：
- **FFmpeg 未安装**：`ffmpeg -version` 无输出 → 安装 FFmpeg
- **输入目录不存在**：检查路径拼写
- **无视频文件**：确认目录下有支持格式的视频
- **路径包含特殊字符**：尝试使用不含空格/中文的路径

### 速度慢（未使用 GPU）

**症状**：压缩速度与 WebCodecs 模式相近

**排查步骤**：
1. 检查 encoder badge 是否显示 `h264_nvenc` 或 `h264_qsv`
2. 如果显示 `libx264`，说明 GPU 编码器不可用
3. 更新 GPU 驱动到最新版本
4. 确认 FFmpeg 版本支持对应的 GPU 编码器：
   - `ffmpeg -hide_banner -encoders | findstr nvenc`
   - `ffmpeg -hide_banner -encoders | findstr qsv`

### 扩展图标不显示

**症状**：浏览器工具栏中看不到 Titan 图标

**解决**：
1. 点击 Chrome 工具栏的拼图图标 🧩
2. 找到"Titan 极速视频压缩"
3. 点击右侧的图钉图标 📌 固定到工具栏

---

## 5. 性能参考

以下数据基于实际测试（1080p H.264 视频，~100MB）：

| 模式 | 编码器 | 耗时 | speed= |
|------|--------|------|--------|
| WebCodecs | GPU VideoEncoder | ~60s | ~1.5× |
| Native Host | NVENC (RTX 3060) | ~5s | ~18× |
| Native Host | QSV (Intel UHD 770) | ~12s | ~8× |
| Native Host | libx264 (无 GPU) | ~30s | ~3× |

**极速模式的优势**：
- GPU 硬件编码器直接操作 GPU，无需经过浏览器 API 层
- FFmpeg 原生进程无沙盒开销
- 零二进制传输（仅 JSON 通信）
- 输出直接写磁盘，无需通过浏览器下载

---

## 6. 卸载

### 卸载 Native Host

```powershell
# 删除安装目录
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\TitanHost"

# 删除注册表项
Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.titan.video.host" -Force
```

### 移除 Chrome Extension

1. `chrome://extensions`
2. 找到 "Titan 极速视频压缩"
3. 点击 **移除**

---

## 7. 开发调试

### 查看 Native Host 日志

Native Host 通过 `eprintln!` 输出日志到 stderr，在 Chrome 中可通过以下方式查看：

1. 打开 `chrome://extensions`
2. 找到 Titan 扩展，点击 **Service Worker**
3. 在 DevTools Console 中查看 background.js 日志

### 扩展页调试

1. 右键点击扩展图标 → **检查弹出窗口**
2. 或 `chrome://extensions` → Service Worker → Console

### 重新编译

```bash
cd Z/native-host
cargo build --release
```

安装脚本会自动复制最新的二进制，重新运行即可。
