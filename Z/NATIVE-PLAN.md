# Titan 极速模式 — 完整实现方案

> 2026-04-21 | 状态：待实现 | 方案：A（扩展页作为极速模式入口）

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
                   <input file>          chrome.runtime
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
| 文件输入 | 扩展页 `<input type="file">` → 真实路径 | 绕过浏览器沙盒，Native 直接读磁盘 |
| 编码输出 | 直接写磁盘，返回输出路径 | 零二进制传输，绕过 1MB 消息限制 |
| 数据流转 | **纯 JSON，零二进制** | 无需 Base64，无序列化开销 |
| 进程管理 | 按需启动，stdin 关闭即退出 | 零常驻，Chrome 自动管理生命周期 |
| GPU 检测 | 检测 + 测试编码双保险 | `ffmpeg -encoders` 只确认编译，不代表 GPU 存在 |
| 与 Web UI 关系 | 独立入口，不混入 Dashboard | 避免沙盒路径冲突，清晰分离 |

---

## Phase 1: Chrome Extension

### 1.1 扩展目录结构

```
native-bridge/
├── manifest.json          # MV3 扩展配置
├── background.js          # Service Worker + Native Messaging
├── extension-page.html    # 极速模式独立 UI
├── extension-page.js      # 扩展页逻辑（文件选择、队列、进度）
├── extension-page.css     # 扩展页样式
└── icon-128.png           # 扩展图标
```

### 1.2 manifest.json

```json
{
  "name": "Titan 极速视频压缩",
  "version": "1.0.0",
  "manifest_version": 3,
  "description": "GPU 硬件加速视频压缩引擎",
  "permissions": ["nativeMessaging", "storage", "tabs"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "extension-page.html",
    "default_icon": {
      "128": "icon-128.png"
    }
  },
  "icons": {
    "128": "icon-128.png"
  }
}
```

**关键变化**：不使用 content script 注入 Web 页面。扩展页通过 popup 或新 tab 独立打开，拥有完整权限。

### 1.3 background.js (Service Worker)

```javascript
// native-bridge/background.js
const HOST_NAME = 'com.yunjing.titan';

let nativePort = null;
let pendingCallbacks = new Map();
let callbackId = 0;

// 暴露给 extension-page.js 的全局 API
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DETECT_NATIVE') {
    detectNative(sendResponse);
    return true;
  }
  if (msg.type === 'COMPRESS_REQUEST') {
    handleCompress(msg.payload, sendResponse);
    return true;
  }
});

function detectNative(callback) {
  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    const timeout = setTimeout(() => {
      port.disconnect();
      callback({ available: false });
    }, 2000);

    port.onMessage.addListener((response) => {
      if (response.type === 'pong') {
        clearTimeout(timeout);
        nativePort = port; // 保持连接，防止 SW 被回收
        callback({ available: true, encoders: response.encoders || [] });
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      nativePort = null;
    });

    port.postMessage({ type: 'ping' });
  } catch {
    callback({ available: false });
  }
}

function handleCompress(payload, callback) {
  if (!nativePort) {
    callback({ type: 'error', message: 'Native host not available' });
    return;
  }

  const id = ++callbackId;

  const onMsg = (response) => {
    // 只处理当前请求的响应（通过任务 ID 匹配）
    if (response._requestId !== id) return;

    switch (response.type) {
      case 'progress':
        callback({
          type: 'progress',
          percent: response.percent,
          fps: response.fps,
          eta: response.eta,
          _requestId: id,
        });
        break;
      case 'complete':
        nativePort.onMessage.removeListener(onMsg);
        callback({
          type: 'complete',
          outputPath: response.outputPath,
          durationSec: response.durationSec,
          _requestId: id,
        });
        break;
      case 'error':
        nativePort.onMessage.removeListener(onMsg);
        callback({
          type: 'error',
          message: response.message,
          _requestId: id,
        });
        break;
    }
  };

  nativePort.onMessage.addListener(onMsg);
  nativePort.postMessage({
    type: 'compress',
    _requestId: id,
    inputPath: payload.inputPath,
    codec: payload.codec,
    crf: payload.crf,
    preset: payload.preset,
  });
}
```

### 1.4 extension-page.html + extension-page.js

```html
<!-- native-bridge/extension-page.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: system-ui; margin: 0; padding: 20px; width: 480px; }
    h2 { margin: 0 0 16px; display: flex; align-items: center; gap: 8px; }
    .drop-zone {
      border: 2px dashed #ccc; border-radius: 8px; padding: 24px;
      text-align: center; cursor: pointer; color: #666;
      transition: border-color 0.2s;
    }
    .drop-zone:hover { border-color: #4f46e5; color: #4f46e5; }
    .queue { margin: 12px 0; }
    .queue-item {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 0; border-bottom: 1px solid #eee;
    }
    .queue-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .queue-item .bar { width: 120px; height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
    .queue-item .bar-fill { height: 100%; background: #4f46e5; transition: width 0.3s; }
    .queue-item .meta { font-size: 11px; color: #999; min-width: 80px; text-align: right; }
    .queue-item.done .meta { color: #22c55e; }
    .queue-item.error .meta { color: #ef4444; }
    .btn {
      display: inline-block; padding: 8px 16px; border-radius: 6px;
      background: #4f46e5; color: white; border: none; cursor: pointer;
      font-size: 14px;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.secondary { background: #e5e7eb; color: #333; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .empty { text-align: center; color: #999; padding: 32px 0; }
  </style>
</head>
<body>
  <h2>🚀 Titan 极速模式</h2>
  <div class="drop-zone" id="dropZone">
    拖拽视频到这里，或 <strong>点击选择文件</strong>
    <input type="file" id="fileInput" multiple accept="video/*" hidden>
  </div>
  <div class="queue" id="queue"></div>
  <div class="actions">
    <button class="btn" id="startBtn" disabled>开始压缩</button>
    <button class="btn secondary" id="openDirBtn" disabled>📁 打开输出目录</button>
  </div>
  <script src="extension-page.js"></script>
</body>
</html>
```

```javascript
// native-bridge/extension-page.js

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const queueEl = document.getElementById('queue');
const startBtn = document.getElementById('startBtn');
const openDirBtn = document.getElementById('openDirBtn');

let queue = []; // { id, file, status: 'pending'|'processing'|'done'|'error', progress: 0, fps: 0, eta: '', outputPath: '' }
let isRunning = false;
let lastOutputDir = '';

// ── 文件选择 ──
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => addFiles(e.target.files));
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#4f46e5'; });
dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = '';
  addFiles(e.dataTransfer.files);
});

// ⚠️ Chrome Extension 的 <input type="file"> 返回 File 对象，
// 但 File.path 已被禁用（安全原因）。我们需要通过 File System Access API 获取路径：
async function addFiles(fileList) {
  for (const file of fileList) {
    // 通过 File System Access API 的 FileHandle 获取路径
    // 备选方案：让 Native Host 读取 File 内容后编码
    // 最优方案：使用 showOpenFilePicker 替代 <input>
    // 见 1.5 节说明
    queue.push({
      id: `native-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      status: 'pending',
      progress: 0, fps: 0, eta: '',
      outputPath: '',
    });
  }
  renderQueue();
  startBtn.disabled = queue.some(f => f.status === 'pending') && !isRunning;
}

function renderQueue() {
  if (queue.length === 0) {
    queueEl.innerHTML = '<div class="empty">暂无文件</div>';
    return;
  }
  queueEl.innerHTML = queue.map(item => {
    const statusIcon = { pending: '○', processing: '◌', done: '✓', error: '✕' }[item.status];
    const sizeMB = (item.file.size / 1048576).toFixed(1);
    return `<div class="queue-item ${item.status}">
      <span class="name">${statusIcon} ${item.file.name} (${sizeMB}MB)</span>
      <div class="bar"><div class="bar-fill" style="width:${item.progress}%"></div></div>
      <span class="meta">${item.status === 'processing' ? `${item.fps}x · ETA ${item.eta}` :
                          item.status === 'done' ? '已完成' :
                          item.status === 'error' ? '失败' : '等待中'}</span>
    </div>`;
  }).join('');
}

// ── 压缩执行 ──
startBtn.addEventListener('click', async () => {
  isRunning = true;
  startBtn.disabled = true;

  for (const item of queue) {
    if (item.status !== 'pending') continue;

    item.status = 'processing';
    item.progress = 0;
    renderQueue();

    try {
      // ⚠️ 这里需要的是文件路径，但 File 对象没有 .path 属性
      // 解决方案见 1.5 节
      const result = await compressItem(item);
      item.status = 'done';
      item.outputPath = result.outputPath;
      lastOutputDir = result.outputPath;
    } catch (err) {
      item.status = 'error';
      item.errorMsg = err.message;
    }
    renderQueue();
  }

  isRunning = false;
  startBtn.disabled = queue.some(f => f.status === 'pending');
  openDirBtn.disabled = !lastOutputDir;
});

function compressItem(item) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'COMPRESS_REQUEST',
        payload: {
          inputPath: item.filePath,  // 通过 File System Access API 获取
          codec: 'h264',
          crf: 28,
          preset: 'p4',
        },
      },
      (response) => {
        switch (response.type) {
          case 'progress':
            item.progress = response.percent;
            item.fps = response.fps;
            item.eta = response.eta;
            renderQueue();
            break;
          case 'complete':
            resolve({ outputPath: response.outputPath });
            break;
          case 'error':
            reject(new Error(response.message));
            break;
        }
      }
    );
  });
}

// ── 打开输出目录 ──
openDirBtn.addEventListener('click', () => {
  if (lastOutputDir) {
    // 打开父目录
    const dir = lastOutputDir.substring(0, lastOutputDir.lastIndexOf('\\') || lastOutputDir.lastIndexOf('/'));
    chrome.tabs.create({ url: `file:///${dir}` });
  }
});

renderQueue();
```

### 1.5 ⚠️ 文件路径获取 —— 核心问题与解决方案

Chrome 扩展中 `<input type="file">` 返回的 File 对象**没有 `.path` 属性**（Chrome 86+ 禁用了 File.path）。

**解决方案：用 `showOpenFilePicker()` 替代 `<input>`**

```javascript
// 替换 <input type="file"> 方案
async function pickFiles() {
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: [{
        description: '视频文件',
        accept: { 'video/*': ['.mp4', '.mov', '.mkv', '.avi', '.webm'] },
      }],
    });

    for (const handle of handles) {
      const file = await handle.getFile();
      // file.path 仍然不可用，但我们有 handle
      // 通过 Native Host 的 "read-file-path" 命令获取路径：
      const pathResult = await chrome.runtime.sendMessage({
        type: 'GET_FILE_PATH',
        payload: { handle },  // FileHandle 可序列化
      });

      queue.push({
        id: `native-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        filePath: pathResult.path,  // ← 这才是真实路径
        status: 'pending',
        progress: 0, fps: 0, eta: '',
        outputPath: '',
      });
    }
    renderQueue();
  } catch {
    // 用户取消选择
  }
}
```

**但这仍然不行**——`FileHandle` 不能通过 Native Messaging 传递。

**最终方案：Native Host 直接弹出系统文件选择器**

让 Native Host 弹出 OS 原生文件选择器（GTK 文件选择、Win32 对话框），获取路径后直接编码。扩展页只负责**发送"开始选择文件"指令**和**显示进度**。

修改 background.js 新增命令：

```javascript
// background.js 新增
if (msg.type === 'PICK_AND_COMPRESS') {
  // Native Host 弹出文件选择器 + 编码 + 返回结果
  handlePickAndCompress(msg.payload, sendResponse);
  return true;
}
```

Native Host (Rust) 弹出文件选择器：

```rust
// Windows: 使用 Win32 GetOpenFileNameW
// macOS: 使用 NSOpenPanel
// Linux: 使用 zenity/gtk 对话框

// 编码完成后返回输出路径给扩展页
// 扩展页显示"完成！文件已保存到: xxx" + "📁 打开目录"按钮
```

**简化方案（推荐 MVP 先做）**：

扩展页让用户**手动粘贴文件路径**或**拖拽文件到扩展页**（扩展页使用 File System Access API `showOpenFilePicker` 获取 `FileSystemFileHandle`），然后：

1. 扩展页调用 `handle.getFile()` 获得 File 对象用于显示文件名/大小
2. 扩展页通过 Native Messaging 将**文件名**发送给 Native Host
3. **Native Host 不负责读文件**——而是扩展页通过 `file.stream()` 读取数据，通过 **multiple Native Messaging chunks** 传给 Native Host
4. Native Host 写入临时文件 → FFmpeg 编码 → 返回输出路径

**但这又引入了二进制传输瓶颈。**

### 最终推荐 MVP 方案：用户指定输入/输出目录

```
扩展页 UI:
  1. 📂 选择输入目录（用户选择包含视频的文件夹）
  2. 📂 选择输出目录（用户选择输出文件夹）
  3. 文件列表自动扫描（Native Host 扫描目录）
  4. 点击"开始编码"
  5. Native Host 直接读写两个目录
  6. 完成后扩展页显示"完成" + "📁 打开输出目录"
```

这样 **Native Host 全程只传 JSON**，没有任何二进制数据，也没有路径问题。

---

## Phase 2: Native Host (Rust)

### 2.1 Cargo.toml

```toml
[package]
name = "titan-host"
version = "1.0.0"
edition = "2021"

[[bin]]
name = "titan-host"
path = "src/main.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
native-messaging = "0.2"
tokio = { version = "1", features = ["process", "io-util", "macros", "rt", "fs"] }
regex = "1"
walkdir = "2"  # 目录扫描

[target.'cfg(windows)'.dependencies]
winreg = "0.52"  # Windows 注册表

[profile.release]
opt-level = "z"
lto = true
strip = true
```

### 2.2 src/main.rs

```rust
use native_messaging::host::event_loop;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use walkdir::WalkDir;

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Request {
    Ping,
    PickAndCompress { input_dir: String, output_dir: String, codec: String, crf: u32, preset: String },
    ListFiles { dir: String },
}

#[derive(Serialize)]
struct PongMsg {
    r#type: String,
    encoders: Vec<String>,
}

#[derive(Serialize)]
struct FileListMsg {
    r#type: String,
    files: Vec<String>,
}

#[derive(Serialize)]
struct ProgressMsg {
    r#type: String,
    file: String,
    percent: f64,
    fps: f64,
    eta: String,
}

#[derive(Serialize)]
struct CompleteMsg {
    r#type: String,
    total: usize,
    duration_sec: f64,
}

#[derive(Serialize)]
struct ErrorMsg {
    r#type: String,
    message: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    event_loop(|raw: String, send: native_messaging::host::Sender| async move {
        let req: Request = serde_json::from_str(&raw)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        match req {
            Request::Ping => {
                let encoders = detect_gpu_encoders();
                send.send(&PongMsg { r#type: "pong".into(), encoders }).await?;
            }
            Request::ListFiles { dir } => {
                let files: Vec<String> = WalkDir::new(&dir)
                    .into_iter()
                    .filter_map(|e| e.ok())
                    .filter(|e| {
                        e.path().extension()
                            .map(|ext| matches!(ext.to_str().unwrap_or(""), "mp4" | "mov" | "mkv" | "avi" | "webm"))
                            .unwrap_or(false)
                    })
                    .map(|e| e.path().to_string_lossy().to_string())
                    .collect();
                send.send(&FileListMsg { r#type: "files".into(), files }).await?;
            }
            Request::PickAndCompress { input_dir, output_dir, codec, crf, preset } => {
                tokio::spawn(compress_directory(
                    input_dir, output_dir, codec, crf, preset, send.clone(),
                ));
            }
        }

        Ok(())
    }).await?;

    Ok(())
}

/// 扫描目录并逐个编码
async fn compress_directory(
    input_dir: String,
    output_dir: String,
    codec: String,
    crf: u32,
    preset: String,
    send: native_messaging::host::Sender,
) {
    let files: Vec<_> = WalkDir::new(&input_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension()
                .map(|ext| matches!(ext.to_str().unwrap_or(""), "mp4" | "mov" | "mkv" | "avi" | "webm"))
                .unwrap_or(false)
        })
        .map(|e| e.path().to_path_buf())
        .collect();

    let total = files.len();
    let mut total_duration = 0.0;

    for input_path in files {
        let filename = input_path.file_name().unwrap().to_string_lossy();
        let output_path = Path::new(&output_dir)
            .join(format!("{}_titan{}", input_path.file_stem().unwrap().to_string_lossy(), input_path.extension().unwrap().to_string_lossy()));

        match run_ffmpeg(&input_path.to_string_lossy(), &output_path.to_string_lossy(), &codec, crf, &preset, &send, &filename).await {
            Ok(dur) => total_duration += dur,
            Err(e) => {
                let _ = send.send(&ErrorMsg { r#type: "error".into(), message: format!("{}: {}", filename, e) }).await;
            }
        }
    }

    let _ = send.send(&CompleteMsg { r#type: "complete".into(), total, duration_sec: total_duration }).await;
}

/// GPU 编码器检测（编译检测 + 硬件实测）
fn detect_gpu_encoders() -> Vec<String> {
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut available = Vec::new();
    for encoder in &["h264_nvenc", "h264_qsv", "h264_amf"] {
        if output.contains(encoder) && test_encoder_works(encoder) {
            available.push(encoder.to_string());
        }
    }
    if available.is_empty() {
        available.push("libx264".to_string());
    }
    available
}

fn test_encoder_works(encoder: &str) -> bool {
    Command::new("ffmpeg")
        .args(["-hide_banner", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=1", "-t", "1", "-c:v", encoder, "-f", "null",
            if cfg!(windows) { "NUL" } else { "/dev/null" }])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map(|s| s.success()).unwrap_or(false)
}

fn get_duration_seconds(path: &str) -> f64 {
    Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
        .output().ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0.0)
}

async fn run_ffmpeg(
    input_path: &str,
    output_path: &str,
    codec: &str,
    crf: u32,
    preset: &str,
    send: &native_messaging::host::Sender,
    filename: &str,
) -> Result<f64, Box<dyn std::error::Error>> {
    let duration = get_duration_seconds(input_path);

    let video_codec = match codec.as_str() {
        "h264" => "h264_nvenc",
        "h265" => "hevc_nvenc",
        "av1" => "av1_nvenc",
        _ => "libx264",
    };

    let mut child = TokioCommand::new("ffmpeg")
        .args(["-y", "-i", input_path, "-c:v", video_codec, "-preset", preset, "-cq", &crf.to_string(), "-c:a", "copy", "-movflags", "+faststart", output_path])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
        .spawn()?;

    let stderr = child.stderr.take().unwrap();
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();

    let progress_re = regex::Regex::new(r"time=(\d{2}):(\d{2}):(\d{2})\.(\d{2}).*?speed=([\d.]+)x")?;

    while reader.read_line(&mut line).await? > 0 {
        if let Some(caps) = progress_re.captures(&line) {
            let hours: f64 = caps[1].parse().unwrap_or(0.0);
            let minutes: f64 = caps[2].parse().unwrap_or(0.0);
            let seconds: f64 = caps[3].parse().unwrap_or(0.0);
            let centis: f64 = caps[4].parse().unwrap_or(0.0);
            let speed: f64 = caps[5].parse().unwrap_or(0.1);

            let elapsed = hours * 3600.0 + minutes * 60.0 + seconds + centis / 100.0;
            let pct = if duration > 0.0 { (elapsed / duration * 100.0).min(100.0) } else { 0.0 };
            let eta_sec = if speed > 0.0 { (duration - elapsed) / speed } else { 0.0 };

            send.send(&ProgressMsg {
                r#type: "progress".into(),
                file: filename.to_string(),
                percent: pct, fps: speed, eta: format_eta(eta_sec),
            }).await?;
        }
        line.clear();
    }

    let status = child.wait().await?;
    if !status.success() { return Err("FFmpeg 编码失败".into()); }
    Ok(duration)
}

fn format_eta(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    let m = s / 60; let sec = s % 60;
    if m > 0 { format!("{}m{}s", m, sec) } else { format!("{}s", sec) }
}
```

### 2.3 关键实现要点

| 要点 | 说明 |
|------|------|
| `native-messaging` crate | 处理 4-byte LE 长度前缀 + JSON 编解码 + Windows 二进制模式 |
| `event_loop` 异步事件循环 | 自动处理 stdin 关闭 → 进程退出 |
| `walkdir` | 扫描输入目录下的所有视频文件 |
| `tokio::spawn` | 压缩任务异步执行，不阻塞消息循环 |
| FFmpeg 进度解析 | regex 从 stderr 提取 `time=` + `speed=` → 计算百分比 + ETA |
| GPU 双保险检测 | `ffmpeg -encoders` 确认编译 + 1帧合成测试确认硬件存在 |
| Release 优化 | `opt-level = "z"` + LTO + strip → ~2MB 二进制 |

---

## Phase 3: 前端集成

### 3.1 Web UI 检测 + 入口按钮

在 Dashboard.vue 中添加检测逻辑和极速模式入口：

```typescript
// Dashboard.vue — 在 <script setup> 中新增

const nativeAvailable = ref(false);
const nativeEncoders = ref<string[]>([]);

// 检测 Native Host
async function detectNativeHost() {
  try {
    chrome.runtime.sendMessage(
      '__YOUR_EXTENSION_ID__',
      { type: 'DETECT_NATIVE' },
      (result) => {
        if (chrome.runtime.lastError) return;
        nativeAvailable.value = result.available;
        nativeEncoders.value = result.encoders || [];
        if (result.available) {
          logger.info('system', `[极速模式] 已启用，检测到: ${result.encoders.join(', ')}`);
        }
      }
    );
  } catch {
    // 扩展未安装
  }
}

// 打开极速模式
function openNativeMode() {
  chrome.runtime.sendMessage('__YOUR_EXTENSION_ID__', { type: 'OPEN_EXTENSION_PAGE' });
}

onMounted(() => {
  detectNativeHost();
  // ... existing code
});
```

### 3.2 Dashboard.vue UI 新增

在 header 或设置区添加极速模式入口：

```vue
<!-- Dashboard.vue template 中新增 -->
<div v-if="nativeAvailable" class="native-badge" @click="openNativeMode">
  <span class="badge-icon">🚀</span>
  <span class="badge-text">极速模式</span>
  <span class="badge-encoders">{{ nativeEncoders[0] }}</span>
</div>
```

### 3.3 Web UI 与扩展页的通信

由于扩展页是独立页面，使用 `chrome.storage.local` 共享设置：

```javascript
// Web UI 写入设置
chrome.storage.local.set({ titanSettings: { codec: 'h264', crf: 28, preset: 'p4' } });

// 扩展页读取设置
chrome.storage.local.get('titanSettings', (data) => {
  const settings = data.titanSettings || { codec: 'h264', crf: 28, preset: 'p4' };
  // 使用设置进行编码
});
```

---

## Phase 4: 安装部署

### 4.1 一键安装脚本 (Windows)

`install-titan-host.ps1`:

```powershell
$ErrorActionPreference = "Stop"

# 1. 安装目录
$installDir = "$env:LOCALAPPDATA\TitanEncoder"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# 2. 写入 Native Host 二进制
# Copy-Item -Path ".\titan-host.exe" -Destination "$installDir\titan-host.exe" -Force

# 3. 写入 JSON manifest
$manifest = @{
    name = "com.yunjing.titan"
    description = "Titan Video Encoder Native Host"
    path = "$installDir\titan-host.exe"
    type = "stdio"
    allowed_origins = @("chrome-extension://__YOUR_EXTENSION_ID__/")
} | ConvertTo-Json -Depth 10

$manifestPath = "$installDir\com.yunjing.titan.json"
$manifest | Out-File -FilePath $manifestPath -Encoding utf8 -Force

# 4. 注册 Chrome Native Messaging Host
$keyPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.yunjing.titan"
if (!(Test-Path $keyPath)) { New-Item -Path $keyPath -Force | Out-Null }
Set-ItemProperty -Path $keyPath -Name "(Default)" -Value $manifestPath -Force

Write-Host "✅ Titan Native Host 安装成功" -ForegroundColor Green
```

### 4.2 Chrome 扩展加载

**开发者模式**：`chrome://extensions` → 加载已解压的扩展程序 → 选择 `native-bridge/` 目录

**生产分发**：打包为 `.crx`，用户双击安装

### 4.3 FFmpeg 依赖

用户必须已安装 FFmpeg + ffprobe（在系统 PATH 中）。安装脚本可检测并提示：

```powershell
if (!(Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️ 未检测到 FFmpeg，请先安装 FFmpeg 并加入系统 PATH" -ForegroundColor Yellow
    Write-Host "   下载: https://ffmpeg.org/download.html" -ForegroundColor Yellow
    exit 1
}
```

**推荐**：安装包内嵌 FFmpeg 静态二进制（~80MB），放到 `$installDir\ffmpeg\` 目录，Native Host 优先使用该路径。

---

## Phase 5: 验证清单

### 5.1 安装验证
- [ ] `install-titan-host.ps1` 执行无错误
- [ ] Chrome 扩展已加载，`chrome://extensions` 中无错误
- [ ] Registry 中存在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.yunjing.titan`
- [ ] `titan-host.exe` 存在且可执行
- [ ] FFmpeg 在 PATH 中或内嵌路径可用

### 5.2 通信验证
- [ ] `detectNative()` 返回 `{ available: true, encoders: ['h264_nvenc'] }`
- [ ] 扩展页能选择输入/输出目录
- [ ] 文件列表正确扫描
- [ ] FFmpeg 进程启动并能看到编码日志
- [ ] 进度消息实时推送（每 1-2 秒一条）
- [ ] 编码完成后扩展页显示完成状态
- [ ] "📁 打开输出目录" 按钮能打开系统资源管理器

### 5.3 性能验证
- [ ] 同一个视频对比 WebCodecs 和 Native 模式耗时
- [ ] NVENC 模式 `speed=` 值 ≥ 5x（5 倍实时速度）
- [ ] 1GB 文件编码 ≤ 60 秒（NVENC）
- [ ] 多文件队列串行执行，每个文件独立 FFmpeg 进程

### 5.4 安全验证
- [ ] `allowed_origins` 只包含本扩展 ID
- [ ] 其他 Chrome 扩展无法连接到 `com.yunjing.titan`
- [ ] 输入路径包含空格、中文、括号时正常处理

---

## 已知风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Chrome 扩展中无法获取文件路径 | 核心阻塞 | 采用"目录选择"方案：用户选输入/输出目录，Native 全程本地 IO |
| 用户未安装 FFmpeg | Native Host 无法工作 | 安装包内嵌 FFmpeg 静态二进制（~80MB） |
| 用户无 NVIDIA GPU | NVENC 不可用 | 自动降级 QSV → AMF → libx264 |
| Chrome 扩展审核 | Web Store 审核 Native Messaging 权限 | 自托管分发（.crx 下载 + 安装脚本） |
| Windows Defender 误报 | titan-host.exe 被隔离 | 代码签名证书 + 提交白名单 |
| 大文件编码时扩展页被关闭 | 任务中断 | background.js port 保持连接，SW 不会被关闭 |

---

## 工作量估算

| 阶段 | 文件 | 行数 | 时间 |
|------|------|------|------|
| Chrome Extension | manifest.json + background.js + extension-page.* | ~250 | 1 天 |
| Rust Native Host | main.rs + Cargo.toml | ~250 | 1.5 天 |
| Web UI 集成 | Dashboard.vue 修改 | ~40 | 0.5 天 |
| 安装脚本 | install-titan-host.ps1 | ~30 | 0.5 天 |
| 测试 + 调试 | - | - | 1 天 |
| **总计** | | **~570 行** | **4-5 天** |
