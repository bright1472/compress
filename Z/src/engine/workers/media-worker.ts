/**
 * src/engine/workers/media-worker.ts
 * Titan V4 Elite - First Principles Ultra-Robust Refactoring
 */

import MP4Box from 'mp4box';
import { Muxer, StreamTarget } from 'mp4-muxer';

// ============================================================
// 0. 环境补丁：针对不规范的第 3 方库进行 Worker 环境拟态
// ============================================================
// 许多 UMD 类库会尝试搜索 window 对象，这在 Worker 加载阶段会导致同步崩溃
if (typeof (self as any).window === 'undefined') {
  (self as any).window = self;
}

self.addEventListener('error', (e) => {
  postMessage({ type: 'ERROR', data: `[Runtime Worker Crash] ${e.message} @ ${e.filename}:${e.lineno}` });
});

self.addEventListener('unhandledrejection', (e) => {
  postMessage({ type: 'ERROR', data: `[Unhandled Promise] ${e.reason}` });
});

// ============================================================
// 1. 严格类型系统与接口
// ============================================================
interface FileSystemSyncAccessHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

interface WorkerConfig {
  codec: 'libx264' | 'libx265' | 'av1';
  bitrate?: number;
}

// ============================================================
// 2. 状态控制
// ============================================================
let currentAccessHandle: FileSystemSyncAccessHandle | null = null;
let muxer: Muxer<StreamTarget> | null = null;
let encoder: VideoEncoder | null = null;
let decoder: VideoDecoder | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;
  
  if (type === 'PING') {
    // 收到 PING 表明脚本解析执行成功
    postMessage({ type: 'PONG' });
    return;
  }

  if (type === 'START_PROCESS') {
    try {
      await startOptimizationPipeline(data);
    } catch (err: any) {
      console.error('🔥 [Worker] Pipe Burst:', err);
      postMessage({ type: 'ERROR', data: err.message || 'Unknown Pipeline Error' });
    }
  } else if (type === 'STOP') {
    cleanup();
  }
};

// ============================================================
// 3. 核心管线重构 (First Principles)
// ============================================================
async function startOptimizationPipeline({ file, config, outputHandle }: any) {
  console.log('🚀 [Worker] Optimization Cycle Initiated');

  // A. 获取 I/O 锁 (这是 0% 进度的常见卡点)
  try {
    currentAccessHandle = await (outputHandle as any).createSyncAccessHandle();
  } catch (ioErr: any) {
    console.warn('[Worker] OPFS SyncAccessHandle blocked, falling back to memory stream.');
  }

  // B. 初始化 Muxer
  muxer = new Muxer({
    target: new StreamTarget({
      onData: (data, offset) => {
        if (currentAccessHandle) currentAccessHandle.write(data, { at: offset });
      }
    }),
    video: {
      codec: config.codec === 'libx265' ? 'hevc' : 'avc',
      width: 0, height: 0
    }
  });

  // C. 配置解封装器 (MP4Box)
  // 注意：在某些 Vite 版本中，MP4Box 可能作为命名空间引入
  const mp4box = MP4Box.createFile();

  mp4box.onReady = (info: any) => {
    const track = info.videoTracks[0];
    if (!track) throw new Error('No video track found in source.');

    initializeHardwareCodecs(track, config);
    
    mp4box.setExtractionConfig(track.id, null, { nb_samples: 1 });
    mp4box.start();
  };

  mp4box.onSamples = (id: any, user: any, samples: any[]) => {
    for (const sample of samples) {
      decoder?.decode(new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: (sample.cts * 1_000_000) / sample.timescale,
        duration: (sample.duration * 1_000_000) / sample.timescale,
        data: sample.data
      }));
    }
  };

  // D. 开启高吞吐读取流
  const reader = file.stream().getReader();
  let bytesLoaded = 0;
  const totalSize = file.size;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const buffer = value.buffer as any;
    buffer.fileStart = bytesLoaded;
    mp4box.appendBuffer(buffer);
    bytesLoaded += value.byteLength;

    postMessage({ 
      type: 'PROGRESS', 
      data: { loaded: bytesLoaded, total: totalSize, progress: (bytesLoaded / totalSize) * 100 } 
    });
  }

  // E. 收尾处理
  mp4box.flush();
  await decoder?.flush();
  await encoder?.flush();
  muxer.finalize();
  
  if (currentAccessHandle) {
    currentAccessHandle.flush();
    currentAccessHandle.close();
  }

  postMessage({ type: 'DONE' });
}

function initializeHardwareCodecs(track: any, config: any) {
  encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer?.addVideoChunk(chunk, metadata),
    error: (e) => postMessage({ type: 'ERROR', data: `Encoder Error: ${e.message}` })
  });

  encoder.configure({
    codec: config.codec === 'libx265' ? 'hev1.1.6.L120.90' : 'avc1.42E01E',
    width: track.video.width,
    height: track.video.height,
    bitrate: 2_000_000,
    hardwareAcceleration: "prefer-hardware"
  });

  decoder = new VideoDecoder({
    output: (frame) => {
      if (encoder && encoder.encodeQueueSize < 60) encoder.encode(frame);
      frame.close();
    },
    error: (e) => postMessage({ type: 'ERROR', data: `Decoder Error: ${e.message}` })
  });

  // 安全提取描述头 (针对 mp4box 导出结构的兼容方案)
  const description = safeGetDescription(track);

  decoder.configure({
    codec: track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description: description
  });
}

function safeGetDescription(track: any): Uint8Array | undefined {
  try {
    for (const entry of track.mdia.minf.stbl.stsd.entries) {
      if (entry.avcC || entry.hvcC) {
        const box = entry.avcC || entry.hvcC;
        // 动态探测 mp4box 内部的 DataStream
        const DS = (MP4Box as any).DataStream || (self as any).DataStream;
        const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);
      }
    }
  } catch (e) {
    console.error('[Worker] Description Extraction Failed:', e);
  }
  return undefined;
}

function cleanup() {
  decoder?.close();
  encoder?.close();
  if (currentAccessHandle) currentAccessHandle.close();
}
