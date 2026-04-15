/**
 * src/engine/workers/media-worker.ts
 * Titan V4 — WebCodecs Pipeline (Architectural Fix)
 * 修复：Muxer 0x0 尺寸 / OPFS 降级静默失败 / 背压控制
 */

import { Muxer, StreamTarget } from 'mp4-muxer';

// ── Worker 环境补丁 ────────────────────────────────────────────────
if (typeof (self as any).window === 'undefined') (self as any).window = self;

self.addEventListener('error', (e) => {
  e.preventDefault();
  postMessage({ type: 'ERROR', data: `[Runtime] ${e.message} @ ${e.filename}:${e.lineno}` });
});
self.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  postMessage({ type: 'ERROR', data: `[Promise] ${e.reason}` });
});

// ── Types ──────────────────────────────────────────────────────────
interface FileSystemSyncAccessHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

interface WorkerConfig {
  codec: 'libx264' | 'libx265' | 'av1';
  bitrate?: number;
}

// ── State ──────────────────────────────────────────────────────────
let accessHandle: FileSystemSyncAccessHandle | null = null;
let muxer: Muxer<StreamTarget> | null = null;
let encoder: VideoEncoder | null = null;
let decoder: VideoDecoder | null = null;

// ── Message Router ─────────────────────────────────────────────────
self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === 'PING') {
    postMessage({ type: 'PONG' });
    return;
  }
  if (type === 'START_PROCESS') {
    try { await runPipeline(data); }
    catch (err: any) {
      console.error('🔥 [Worker] Pipeline Error:', err);
      postMessage({ type: 'ERROR', data: err.message || 'Unknown Pipeline Error' });
    }
  } else if (type === 'STOP') {
    cleanup();
  }
};

// ── Core Pipeline ──────────────────────────────────────────────────
async function runPipeline({ file, config, outputHandle }: any) {
  console.log('🚀 [Worker] Pipeline Start');

  // A. OPFS 同步写入句柄（失败则 REJECT 而非静默继续）
  try {
    accessHandle = await (outputHandle as any).createSyncAccessHandle();
  } catch (ioErr: any) {
    throw new Error(`OPFS 写入句柄创建失败: ${ioErr.message}. 请确保浏览器支持 OPFS.`);
  }

  // B. 解封装（MP4Box 动态引入，防止静态提升导致的 ReferenceError）
  const MP4BoxModule = await import('mp4box');
  const MP4Box = MP4BoxModule.default || MP4BoxModule;
  const mp4box = MP4Box.createFile();

  // 使用 Promise 驱动，确保 onReady 与后续流程串行
  const trackInfoPromise = new Promise<any>((resolve, reject) => {
    mp4box.onReady = (info: any) => {
      const track = info.videoTracks[0];
      if (!track) return reject(new Error('未在源文件中检测到视频轨道'));
      resolve(track);
    };
    mp4box.onError = (err: any) => reject(new Error(`MP4Box 解析错误: ${err}`));
  });

  // C. 高吞吐流式读取
  const reader = file.stream().getReader();
  let bytesLoaded = 0;
  const totalSize = file.size;

  // 异步送入 MP4Box
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = value.buffer as any;
      buffer.fileStart = bytesLoaded;
      mp4box.appendBuffer(buffer);
      bytesLoaded += value.byteLength;
      postMessage({ type: 'PROGRESS', data: { loaded: bytesLoaded, total: totalSize, progress: (bytesLoaded / totalSize) * 50 } });
    }
    mp4box.flush();
  })();

  // D. 等待轨道信息，然后初始化编解码器和 Muxer（宽高在此时已知）
  const track = await trackInfoPromise;
  const width = track.video.width;
  const height = track.video.height;

  // 硬件编码器对奇数分辨率极度敏感，强制转偶数
  const safeWidth = width % 2 === 0 ? width : width - 1;
  const safeHeight = height % 2 === 0 ? height : height - 1;

  let encCodecStr = 'avc1.4D002A'; // H.264 Main Profile (兼容性最好)
  let muxerCodec: 'avc' | 'hevc' | 'av1' | 'vp9' = 'avc';
  if (config.codec === 'libx265') {
    encCodecStr = 'hev1.1.6.L120.90'; // HEVC Main10
    muxerCodec = 'hevc';
  } else if (config.codec === 'av1') {
    encCodecStr = 'av01.0.04M.08';
    muxerCodec = 'av1';
  }

  const encConfig: VideoEncoderConfig = {
    codec: encCodecStr,
    width: safeWidth,
    height: safeHeight,
    bitrate: config.bitrate || 2_000_000,
    hardwareAcceleration: 'prefer-hardware',
  };

  // 🔥 核心重构：调用硬件前，先让浏览器探针验证显卡驱动是否支持该配置！
  try {
    const support = await VideoEncoder.isConfigSupported(encConfig);
    if (!support.supported) {
      throw new Error(`当前浏览器/显卡不支持此硬件编码器配置: ${encCodecStr}`);
    }
  } catch (supportErr: any) {
    throw new Error(`硬件探针探测失败: ${supportErr.message}`);
  }

  // 创建 Muxer（使用对齐后的安全宽高）
  muxer = new Muxer({
    target: new StreamTarget({
      onData: (data, offset) => {
        if (accessHandle) accessHandle.write(data, { at: offset });
      }
    }),
    video: {
      codec: muxerCodec,
      width: safeWidth,
      height: safeHeight,
    },
    fastStart: false
  });

  // 编码完成计数器
  let encodedFrames = 0;
  const encodeDone = new Promise<void>((resolve) => {
    let flushed = false;
    const checkDone = () => {
      if (flushed && encoder && encoder.encodeQueueSize === 0) resolve();
    };

    encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        try {
          let safeMetadata = metadata;
          if (metadata && (metadata.decoderConfig === null || (metadata as any).decoderConfig === undefined)) {
            // Fix null decoderConfig crashes in mp4-muxer
            safeMetadata = { ...metadata };
            delete safeMetadata.decoderConfig;
          }
          muxer?.addVideoChunk(chunk, safeMetadata);
          encodedFrames++;
          postMessage({ type: 'PROGRESS', data: { loaded: bytesLoaded, total: totalSize, progress: 50 + (encodedFrames / Math.max(1, encodedFrames + (encoder?.encodeQueueSize ?? 0))) * 50 } });
        } catch (e: any) {
          postMessage({ type: 'ERROR', data: `Muxer Chunk Error: ${e.message}` });
        }
      },
      error: (e) => postMessage({ type: 'ERROR', data: `Encoder: ${e.message}` })
    });

    encoder.configure(encConfig);

    decoder = new VideoDecoder({
      output: (frame) => {
        try {
          // 背压控制：如果编码队列过大则等待
          if (encoder && encoder.encodeQueueSize < 30) {
            encoder.encode(frame, { keyFrame: encodedFrames % 60 === 0 });
          }
        } catch (e: any) {
          postMessage({ type: 'ERROR', data: `Encoder.encode Error: ${e.message}` });
        } finally {
          frame.close();
        }
      },
      error: (e) => postMessage({ type: 'ERROR', data: `Decoder: ${e.message}` })
    });

    // 配置解码器
    const description = extractDescription(track);
    decoder.configure({
      codec: track.codec,
      codedWidth: width,
      codedHeight: height,
      description,
    });

    mp4box.setExtractionOptions(track.id, null, { nbSamples: 1 });
    mp4box.start();

    mp4box.onSamples = (_id: any, _user: any, samples: any[]) => {
      for (const sample of samples) {
        decoder?.decode(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: (sample.cts * 1_000_000) / sample.timescale,
          duration: (sample.duration * 1_000_000) / sample.timescale,
          data: sample.data,
        }));
      }
    };

    // 等待所有数据读完后 flush 解码器 → 编码器
    (async () => {
      // 等待读取完成
      while (bytesLoaded < totalSize) await new Promise(r => setTimeout(r, 50));
      await decoder?.flush();
      await encoder?.flush();
      flushed = true;
      checkDone();
    })();
  });

  await encodeDone;

  // E. 收尾
  muxer.finalize();
  if (accessHandle) {
    accessHandle.flush();
    accessHandle.close();
    accessHandle = null;
  }

  postMessage({ type: 'DONE' });
}

// ── 辅助函数 ───────────────────────────────────────────────────────
function extractDescription(track: any): Uint8Array | undefined {
  try {
    for (const entry of track.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC;
      if (box) {
        const DS = (MP4Box as any).DataStream || (self as any).DataStream;
        if (!DS) { console.warn('[Worker] DataStream not available'); return undefined; }
        const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);
      }
    }
  } catch (e) {
    console.error('[Worker] Description extraction failed:', e);
  }
  return undefined;
}

function cleanup() {
  try { decoder?.close(); } catch {}
  try { encoder?.close(); } catch {}
  try { if (accessHandle) { accessHandle.close(); accessHandle = null; } } catch {}
  decoder = null;
  encoder = null;
  muxer = null;
}
