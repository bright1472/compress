# Titan 极速模式 — 实现方案与进度

> 2026-04-21 | 状态：**已实现 | 编译通过 | 待安装测试**

---

## 0. 架构总览

### 双模式路由

```
                    用户打开 Web UI
                         │
                         ▼
              detectNativeHost() 探测
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
    未检测到 Native             检测到 Native Host
    (基础模式)                  (极速模式可用)
            │                         │
  WebCodecs / FFmpeg WASM      显示 🚀 极速模式 按钮
  浏览器内压缩                        │
                              点击 → 打开扩展页
                                     │
                           ┌─────────┴──────────┐
                           ▼                    ▼
                   扩展页独立 UI          background.js
                   输入/输出目录        chrome.runtime
                                        .connectNative()
                                              │
                                    stdin/stdout (JSON only)
                                              ▼
                                      Native Host (Rust)
                                        GPU 编码 → 写磁盘
                                              │
                                              ▼
                                    输出同目录 xxx_titan.mp4
                                    扩展页 "📁 打开输出目录"
```

### 核心设计决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 通信协议 | Native Messaging (stdin/stdout) | Chrome 沙盒保护，零端口，零 Token |
| 文件输入 | 扩展页粘贴目录路径 | 绕过浏览器沙盒，Native 直接读磁盘 |
| 编码输出 | 直接写磁盘，返回输出路径 | 零二进制传输，绕过 1MB 消息限制 |
| 数据流转 | **纯 JSON，零二进制** | 无需 Base64，无序列化开销 |
| 进程管理 | 按需启动，stdin 关闭即退出 | 零常驻，Chrome 自动管理生命周期 |
| GPU 检测 | 检测 + 测试编码双保险 | `ffmpeg -encoders` 只确认编译，不代表 GPU 存在 |
| 与 Web UI 关系 | 独立入口，不混入 Dashboard | 避免沙盒路径冲突，清晰分离 |

---

## Phase 1: Chrome Extension ✅ 已完成

### 1.1 扩展目录结构

```
native-bridge/
├── manifest.json          # MV3 扩展配置
├── background.js          # Service Worker + Native Messaging
├── extension-page.html    # 极速模式独立 UI
├── extension-page.js      # 扩展页逻辑（目录扫描/队列/进度）
├── extension-page.css     # 扩展页样式
└── icons/
    └── icon-128.png       # 扩展图标
```

### 1.2 manifest.json

```json
{
  "name": "Titan 极速视频压缩",
  "version": "1.0.0",
  "manifest_version": 3,
  "description": "GPU 硬件加速视频压缩引擎 — 本地原生编码",
  "permissions": ["nativeMessaging", "storage"],
  "background": { "service_worker": "background.js" },
  "action": {
    "default_popup": "extension-page.html",
    "default_icon": { "128": "icons/icon-128.png" }
  },
  "icons": { "128": "icons/icon-128.png" }
}
```

### 1.3 background.js — Service Worker

- `DETECT_NATIVE`：发送 Ping 到 Native Host，返回编码器列表
- `LIST_FILES`：转发目录扫描请求，返回视频文件列表
- `COMPRESS_REQUEST`：开始批量压缩，监听 progress/complete/error
- `OPEN_OUTPUT_DIR`：打开系统资源管理器到输出目录
- Request ID 追踪：多消息关联，支持并发

### 1.4 extension-page — 独立 UI

- 暗色主题，520px 宽度
- 输入/输出目录：用户粘贴路径后回车触发扫描
- 编码参数：Codec (H.264/H.265/AV1) + CRF (18-40) + Preset (p1-p7)
- 文件队列：实时进度条 + 状态图标 + FPS/ETA
- 设置持久化：chrome.storage.local 保存上次使用的设置

---

## Phase 2: Native Host (Rust) ✅ 已完成

### 2.1 项目结构

```
native-host/
├── Cargo.toml              # Rust 项目
├── src/main.rs             # Native Host 核心 (~400行)
├── titan-host.json         # Chrome Native Messaging Host Manifest (模板)
├── install-titan-host.ps1  # Windows 一键安装脚本
└── target/release/
    └── titan-host.exe      # 编译后的二进制 (~1.7MB)
```

### 2.2 Cargo.toml

```toml
[package]
name = "titan-host"
version = "1.0.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["process", "io-util", "io-std", "macros", "rt-multi-thread", "sync"] }
regex = "1"
walkdir = "2"

[profile.release]
opt-level = "z"
lto = true
strip = true
```

### 2.3 src/main.rs — 核心功能

**Native Messaging 协议**（手动实现，~20行）：
```rust
// 4-byte LE 长度前缀 + UTF-8 JSON
async fn read_message<R: AsyncReadExt + Unpin>(reader: &mut R) -> ...;
async fn send_message<W: AsyncWriteExt + Unpin>(writer: &mut W, msg: &str) -> ...;
```

**请求路由**（main 函数事件循环）：
| 请求 | 处理 |
|------|------|
| `Ping` | 检测 GPU 编码器，返回 `pong` + 编码器列表 |
| `ListFiles { dir }` | 扫描目录，返回视频文件路径数组 |
| `Compress { input_dir, output_dir, codec, crf, preset, _requestId }` | 异步执行批量压缩 |

**GPU 编码器检测**（双保险）：
1. `ffmpeg -encoders` 解析可用编码器
2. 1 帧合成视频实测编码，确认 GPU 硬件存在

**编码器映射**（自动匹配）：

| 用户选择 | NVENC | QSV | AMF | Software |
|----------|-------|-----|-----|----------|
| H.264 | h264_nvenc | h264_qsv | h264_amf | libx264 |
| H.265 | hevc_nvenc | hevc_qsv | hevc_amf | libx265 |
| AV1 | av1_nvenc | av1_qsv | — | libaom-av1 |

**FFmpeg 进度解析**：
```rust
let progress_re = regex::Regex::new(
    r"time=(\d{2}):(\d{2}):(\d{2})\.(\d{2}).*?speed=([\d.]+)x"
)?;
// 从 stderr 提取 time= 和 speed= → 计算百分比 + ETA
```

**线程安全**：
```rust
let stdout = Arc::new(Mutex::new(stdout));  // 多任务共享
tokio::spawn(async move { /* compress_directory */ });
```

### 2.4 编译结果

| 指标 | 值 |
|------|-----|
| 编译状态 | ✅ `cargo build --release` 通过 |
| 二进制大小 | ~1.7MB |
| 运行时依赖 | FFmpeg + ffprobe（系统 PATH） |

---

## Phase 3: Web UI 集成 ⏳ 待实现

### 3.1 Dashboard.vue 集成点

- 自动检测 Native Host 可用性
- 检测到后在 header 或设置区显示 🚀 极速模式入口
- 点击后通过 `chrome.runtime.sendMessage` 打开扩展页
- `chrome.storage.local` 共享设置（codec/crf/preset）

### 3.2 检测逻辑

```typescript
async function detectNativeHost() {
  try {
    chrome.runtime.sendMessage(
      '__EXTENSION_ID__',
      { type: 'DETECT_NATIVE' },
      (result) => {
        if (result?.available) {
          // 显示极速模式入口
        }
      }
    );
  } catch { /* 扩展未安装 */ }
}
```

---

## Phase 4: 安装部署 ⏳ 待测试

### 4.1 一键安装脚本

`install-titan-host.ps1` 执行：

1. 检测 FFmpeg 是否在 PATH 中
2. 创建安装目录 `%LOCALAPPDATA%\TitanHost\`
3. 复制 `titan-host.exe` 到安装目录
4. 生成 `titan-host.json`（Native Messaging Host Manifest）
5. 注册 Chrome Native Messaging Host 到 Windows 注册表：
   `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.titan.video.host`

### 4.2 Chrome 扩展加载

1. 打开 `chrome://extensions`
2. 启用开发者模式
3. 加载已解压的扩展 → 选择 `native-bridge/` 目录
4. 复制 Extension ID
5. 编辑 `titan-host.json`，替换 `PLACEHOLDER_EXTENSION_ID`
6. 重新加载扩展

### 4.3 依赖检查

| 依赖 | 必需 | 说明 |
|------|------|------|
| FFmpeg + ffprobe | ✅ | 安装脚本会检测并提示 |
| GPU 驱动 | 可选 | 无 GPU 时自动降级到软件编码 |
| Chrome / Edge ≥ 110 | ✅ | Native Messaging 支持 |

---

## Phase 5: 验证清单 ⏳ 待执行

### 5.1 安装验证
- [ ] `install-titan-host.ps1` 执行无错误
- [ ] Chrome 扩展已加载，无错误
- [ ] 注册表存在 Native Messaging Host 条目
- [ ] FFmpeg 在 PATH 中

### 5.2 通信验证
- [ ] `DETECT_NATIVE` 返回 `{ available: true, encoders: [...] }`
- [ ] 扩展页能输入目录路径并触发扫描
- [ ] 文件列表正确显示
- [ ] 进度消息实时推送
- [ ] 编码完成后显示完成状态

### 5.3 性能验证
- [ ] 同一视频对比 WebCodecs 和 Native 模式耗时
- [ ] NVENC 模式 `speed=` 值 ≥ 5x
- [ ] 1GB 文件编码 ≤ 60 秒（NVENC）

---

## 已知风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 用户未安装 FFmpeg | Native Host 无法工作 | 安装脚本检测并提示下载 |
| 用户无 NVIDIA GPU | NVENC 不可用 | 自动降级 QSV → AMF → libx264 |
| 输入路径包含空格/中文 | 编码失败 | FFmpeg 支持 Unicode 路径 |
| Chrome 扩展审核 | Web Store 审核 Native Messaging | 自托管分发 |
| Windows Defender 误报 | titan-host.exe 被隔离 | 代码签名 + 提交白名单 |
| 扩展页被关闭 | 任务中断 | background.js port 保持连接 |

---

## 文件清单

| 文件 | 状态 | 说明 |
|------|------|------|
| `native-host/src/main.rs` | ✅ | Native Host 核心 (~400行) |
| `native-host/Cargo.toml` | ✅ | Rust 项目配置 |
| `native-host/titan-host.json` | ✅ | Host Manifest 模板 |
| `native-host/install-titan-host.ps1` | ✅ | Windows 安装脚本 |
| `native-bridge/manifest.json` | ✅ | Chrome Extension MV3 清单 |
| `native-bridge/background.js` | ✅ | Extension Service Worker |
| `native-bridge/extension-page.html` | ✅ | 极速模式 UI |
| `native-bridge/extension-page.css` | ✅ | 极速模式样式 |
| `native-bridge/extension-page.js` | ✅ | 极速模式逻辑 |
| `native-bridge/icons/icon-128.png` | ✅ | 扩展图标 |

---

## 下一步

1. 运行 `install-titan-host.ps1` 安装 Native Host
2. 加载 Chrome Extension 并测试通信
3. 在 Dashboard.vue 中集成 Native Host 检测入口
4. 端到端测试：选择目录 → 扫描 → 压缩 → 输出验证
