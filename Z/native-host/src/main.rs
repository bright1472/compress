use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex;
use walkdir::WalkDir;

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "flv", "wmv", "3gp", "ogv", "m4v", "ts", "mts"];

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Ping,
    PickDir,
    ListFiles { dir: String },
    Compress {
        #[serde(rename = "_requestId")]
        request_id: u64,
        #[serde(rename = "inputDir")]
        input_dir: String,
        #[serde(rename = "outputDir")]
        output_dir: String,
        codec: String,
        crf: u32,
        preset: String,
    },
    OpenDir { path: String },
}

#[derive(Serialize)]
struct PickedDirMsg {
    #[serde(rename = "type")]
    kind: String,
    path: String,
}

#[derive(Serialize)]
struct PongMsg {
    #[serde(rename = "type")]
    kind: String,
    encoders: Vec<String>,
}

#[derive(Serialize)]
struct FileListMsg {
    #[serde(rename = "type")]
    kind: String,
    files: Vec<String>,
}

#[derive(Serialize)]
struct ProgressMsg {
    #[serde(rename = "type")]
    kind: String,
    file: String,
    percent: f64,
    fps: f64,
    eta: String,
    #[serde(rename = "_requestId")]
    request_id: u64,
}

#[derive(Serialize)]
struct CompleteMsg {
    #[serde(rename = "type")]
    kind: String,
    total: usize,
    duration_sec: f64,
    #[serde(rename = "_requestId")]
    request_id: u64,
}

#[derive(Serialize)]
struct ErrorMsg {
    #[serde(rename = "type")]
    kind: String,
    message: String,
    #[serde(rename = "_requestId")]
    request_id: u64,
}

/// Native Messaging protocol: 4-byte LE length prefix + UTF-8 JSON
async fn read_message<R: AsyncReadExt + Unpin>(reader: &mut R) -> std::io::Result<Option<String>> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_bytes) as usize;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(Some(String::from_utf8_lossy(&buf).to_string()))
}

async fn send_message<W: AsyncWriteExt + Unpin>(writer: &mut W, msg: &str) -> std::io::Result<()> {
    let bytes = msg.as_bytes();
    let len = bytes.len() as u32;
    writer.write_all(&len.to_le_bytes()).await?;
    writer.write_all(bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let stdout = Arc::new(Mutex::new(stdout));

    loop {
        let raw = match read_message(&mut reader).await {
            Ok(Some(msg)) => msg,
            Ok(None) => break, // stdin closed
            Err(e) => {
                eprintln!("[titan-host] Read error: {}", e);
                break;
            }
        };

        let req: Request = match serde_json::from_str(&raw) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[titan-host] JSON parse error: {}", e);
                continue;
            }
        };

        let stdout_clone = stdout.clone();

        match req {
            Request::Ping => {
                let encoders = detect_gpu_encoders();
                let msg = serde_json::to_string(&PongMsg { kind: "pong".into(), encoders }).unwrap();
                send_message(&mut *stdout_clone.lock().await, &msg).await?;
            }
            Request::PickDir => {
                let path = pick_directory().unwrap_or_default();
                let msg = serde_json::to_string(&PickedDirMsg { kind: "picked_dir".into(), path }).unwrap();
                send_message(&mut *stdout_clone.lock().await, &msg).await?;
            }
            Request::ListFiles { dir } => {
                let files = scan_video_files(&dir);
                let msg = serde_json::to_string(&FileListMsg { kind: "files".into(), files }).unwrap();
                send_message(&mut *stdout_clone.lock().await, &msg).await?;
            }
            Request::OpenDir { path } => {
                #[cfg(target_os = "macos")]
                let _ = Command::new("open").arg(&path).spawn();
                #[cfg(target_os = "windows")]
                let _ = Command::new("explorer").arg(&path).spawn();
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                let _ = Command::new("xdg-open").arg(&path).spawn();
            }
            Request::Compress {
                request_id,
                input_dir,
                output_dir,
                codec,
                crf,
                preset,
            } => {
                tokio::spawn(async move {
                    let out = stdout_clone;
                    if let Err(e) = compress_directory(&input_dir, &output_dir, &codec, crf, &preset, &out, request_id).await {
                        let msg = serde_json::to_string(&ErrorMsg {
                            kind: "error".into(),
                            message: format!("压缩失败: {}", e),
                            request_id,
                        }).unwrap();
                        let _ = send_message(&mut *out.lock().await, &msg).await;
                    }
                });
            }
        }
    }

    Ok(())
}

fn pick_directory() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .args(["-e", "POSIX path of (choose folder)"])
            .output()
            .ok()?;
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() { None } else { Some(path) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn scan_video_files(dir: &str) -> Vec<String> {
    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| VIDEO_EXTS.contains(&&ext.to_lowercase()[..]))
                .unwrap_or(false)
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect()
}

fn detect_gpu_encoders() -> Vec<String> {
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut available = Vec::new();
    for encoder in &["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"] {
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
        .args([
            "-hide_banner", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=1",
            "-t", "1", "-c:v", encoder, "-f", "null",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn map_video_codec(user_codec: &str, available_encoders: &[String]) -> String {
    let preferred = if available_encoders.is_empty() {
        "libx264".to_string()
    } else {
        available_encoders[0].clone()
    };

    match user_codec {
        "h264" if preferred.contains("nvenc") => "h264_nvenc".to_string(),
        "h265" if preferred.contains("nvenc") => "hevc_nvenc".to_string(),
        "av1" if preferred.contains("nvenc") => "av1_nvenc".to_string(),
        "h264" if preferred.contains("qsv") => "h264_qsv".to_string(),
        "h265" if preferred.contains("qsv") => "hevc_qsv".to_string(),
        "av1" if preferred.contains("qsv") => "av1_qsv".to_string(),
        "h264" if preferred.contains("amf") => "h264_amf".to_string(),
        "h265" if preferred.contains("amf") => "hevc_amf".to_string(),
        "h264" if preferred.contains("videotoolbox") => "h264_videotoolbox".to_string(),
        "h265" if preferred.contains("videotoolbox") => "hevc_videotoolbox".to_string(),
        "av1" if preferred.contains("videotoolbox") => "libaom-av1".to_string(),
        "h264" => "libx264".to_string(),
        "h265" => "libx265".to_string(),
        "av1" => "libaom-av1".to_string(),
        _ => preferred,
    }
}

fn get_duration_seconds(path: &str) -> f64 {
    Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0.0)
}

async fn send_json(stdout: &Arc<Mutex<tokio::io::Stdout>>, msg: &str) -> std::io::Result<()> {
    send_message(&mut *stdout.lock().await, msg).await
}

async fn compress_directory(
    input_dir: &str,
    output_dir: &str,
    codec: &str,
    crf: u32,
    preset: &str,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
    request_id: u64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let files = scan_video_files(input_dir);

    if files.is_empty() {
        return Err(format!("输入目录下未找到视频文件: {}", input_dir).into());
    }

    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("创建输出目录失败: {}", e))?;

    let total = files.len();
    let mut total_duration = 0.0;
    let encoders = detect_gpu_encoders();

    for input_path in &files {
        let filename = Path::new(input_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let stem = Path::new(input_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();

        let ext = Path::new(input_path)
            .extension()
            .unwrap_or_default()
            .to_string_lossy();

        let output_path = Path::new(output_dir)
            .join(format!("{}_titan.{}", stem, ext));

        let video_codec = map_video_codec(codec, &encoders);

        match run_ffmpeg(input_path, &output_path.to_string_lossy(), &video_codec, crf, preset, stdout, &filename, request_id).await {
            Ok(dur) => total_duration += dur,
            Err(e) => {
                eprintln!("[titan-host] {} 编码失败: {}", filename, e);
                let msg = serde_json::to_string(&ErrorMsg {
                    kind: "error".into(),
                    message: format!("{}: {}", filename, e),
                    request_id,
                }).unwrap();
                let _ = send_json(stdout, &msg).await;
            }
        }
    }

    let msg = serde_json::to_string(&CompleteMsg {
        kind: "complete".into(),
        total,
        duration_sec: total_duration,
        request_id,
    }).unwrap();
    send_json(stdout, &msg).await?;

    Ok(())
}

async fn run_ffmpeg(
    input_path: &str,
    output_path: &str,
    video_codec: &str,
    crf: u32,
    preset: &str,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
    filename: &str,
    request_id: u64,
) -> Result<f64, Box<dyn std::error::Error + Send + Sync>> {
    let duration = get_duration_seconds(input_path);

    let is_software = video_codec.starts_with("lib");
    let is_videotoolbox = video_codec.contains("videotoolbox");
    let mut args = vec![
        "-y", "-i", input_path,
        "-c:v", video_codec,
    ];

    let crf_str = crf.to_string();
    // VideoToolbox uses q:v (1-100, higher=better); map CRF 18-40 → q:v 90-20
    let vtb_quality = ((40u32.saturating_sub(crf)) * 70 / 22 + 20).to_string();
    if is_software {
        args.extend_from_slice(&["-preset", preset, "-crf", &crf_str, "-threads", "0"]);
    } else if is_videotoolbox {
        args.extend_from_slice(&["-q:v", &vtb_quality]);
    } else {
        args.extend_from_slice(&["-preset", preset, "-cq", &crf_str]);
    }

    args.extend_from_slice(&[
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]);

    let mut child = TokioCommand::new("ffmpeg")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
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

            let msg = serde_json::to_string(&ProgressMsg {
                kind: "progress".into(),
                file: filename.to_string(),
                percent: pct,
                fps: speed,
                eta: format_eta(eta_sec),
                request_id,
            }).unwrap();
            let _ = send_json(stdout, &msg).await;
        }
        line.clear();
    }

    let status = child.wait().await?;
    if !status.success() {
        return Err("FFmpeg 返回非零退出码".into());
    }

    Ok(duration)
}

fn format_eta(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    let m = s / 60;
    let sec = s % 60;
    if m > 0 { format!("{}m{}s", m, sec) } else { format!("{}s", sec) }
}
