/**
 * src/engine/workers/media-worker.ts
 * Titan V4 — WebCodecs Pipeline (Phase-Locked Feed)
 * 修复竞态根因：两阶段喂流，reader 暂停期间完成所有 codec 初始化
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

  // A. OPFS 同步写入句柄
  try {
    accessHandle = await (outputHandle as any).createSyncAccessHandle();
  } catch (ioErr: any) {
    throw new Error(`OPFS 写入句柄创建失败: ${ioErr.message}. 请确保浏览器支持 OPFS.`);
  }

  // B. MP4Box 解封装器
  const MP4Box = await import('mp4box');
  const mp4box = MP4Box.createFile();

  const reader = file.stream().getReader();
  let bytesLoaded = 0;
  const totalSize = file.size;

  // C. 第一阶段：喂数据直到 onReady 触发
  // onReady 在 appendBuffer 内部同步触发，用 flag 捕获，无需 Promise
  // 关键：reader 在此阶段暂停后，后续所有 async 操作（isConfigSupported 等）
  // 都不会触发 feedPromise 竞争，彻底消除竞态。
  let trackInfo: any = null;
  mp4box.onReady = (info: any) => { trackInfo = info; };
  mp4box.onError = (err: any) => { throw new Error(`MP4Box 解析错误: ${err}`); };

  while (trackInfo === null) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = value.buffer as any;
    buffer.fileStart = bytesLoaded;
    bytesLoaded += value.byteLength;
    mp4box.appendBuffer(buffer);
    postMessage({ type: 'PROGRESS', data: { loaded: bytesLoaded, total: totalSize, progress: (bytesLoaded / totalSize) * 50 } });
  }

  if (!trackInfo?.videoTracks?.[0]) {
    throw new Error('未在源文件中检测到视频轨道');
  }

  const track = trackInfo.videoTracks[0];
  const totalFrames = track.nb_samples || 0;
  const width = track.video.width;
  const height = track.video.height;

  // 硬件编码器对奇数分辨率极度敏感，强制转偶数
  const safeWidth = width % 2 === 0 ? width : width - 1;
  const safeHeight = height % 2 === 0 ? height : height - 1;

  // D. 编解码器字符串
  let encCodecStr = 'avc1.4D002A'; // H.264 Main Profile
  let muxerCodec: 'avc' | 'hevc' | 'av1' | 'vp9' = 'avc';
  if (config.codec === 'libx265') {
    encCodecStr = 'hev1.1.6.L120.90';
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

  // E. 硬件探针（此时 reader 已暂停，async 操作安全）
  try {
    const support = await VideoEncoder.isConfigSupported(encConfig);
    if (!support.supported) {
      throw new Error(`当前浏览器/显卡不支持此硬件编码器配置: ${encCodecStr}`);
    }
  } catch (supportErr: any) {
    throw new Error(`硬件探针探测失败: ${supportErr.message}`);
  }

  // F. Muxer（使用对齐后的安全宽高）
  muxer = new Muxer({
    target: new StreamTarget({
      onData: (data, offset) => {
        if (accessHandle) accessHandle.write(data as unknown as BufferSource, { at: offset });
      }
    }),
    video: { codec: muxerCodec, width: safeWidth, height: safeHeight },
    fastStart: false
  });

  // G. 编码器
  let encodedFrames = 0;
  encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      try {
        let safeMetadata = metadata;
        if (metadata && (metadata.decoderConfig === null || (metadata as any).decoderConfig === undefined)) {
          safeMetadata = { ...metadata };
          delete safeMetadata.decoderConfig;
        }
        muxer?.addVideoChunk(chunk, safeMetadata);
        encodedFrames++;
        postMessage({ type: 'PROGRESS', data: { loaded: bytesLoaded, total: totalSize, progress: 50 + (encodedFrames / Math.max(1, totalFrames)) * 50 } });
      } catch (e: any) {
        postMessage({ type: 'ERROR', data: `Muxer Chunk Error: ${e.message}` });
      }
    },
    error: (e) => postMessage({ type: 'ERROR', data: `Encoder: ${e.message}` })
  });
  encoder.configure(encConfig);

  // H. 解码器
  const description = extractDescription(track, MP4Box);
  decoder = new VideoDecoder({
    output: (frame) => {
      try {
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
  decoder.configure({
    codec: track.codec,
    codedWidth: width,
    codedHeight: height,
    description,
  });

  // I. 注册 onSamples（必须在 start() 之前）
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
  mp4box.setExtractionOptions(track.id, null, { nbSamples: 1 });
  mp4box.start();

  // J. 第二阶段：继续喂剩余数据
  // onSamples 已注册，samples 会随 appendBuffer 实时触发，不丢帧
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = value.buffer as any;
    buffer.fileStart = bytesLoaded;
    bytesLoaded += value.byteLength;
    mp4box.appendBuffer(buffer);
    postMessage({ type: 'PROGRESS', data: { loaded: bytesLoaded, total: totalSize, progress: (bytesLoaded / totalSize) * 50 } });
  }
  mp4box.flush(); // 强制提交所有游离 buffer，触发剩余 onSamples

  // K. 排干编解码管线（顺序：先 decoder 再 encoder）
  await decoder.flush();
  await encoder.flush();

  if (encodedFrames === 0) {
    throw new Error('没有任何视频帧被成功编解码，请检查源文件是否包含了正确的视频轨道数据。');
  }

  // L. 收尾
  muxer.finalize();
  if (accessHandle) {
    accessHandle.flush();
    accessHandle.close();
    accessHandle = null;
  }

  postMessage({ type: 'DONE' });
}

// ── 辅助函数 ───────────────────────────────────────────────────────
function extractDescription(track: any, MP4BoxRef: any): Uint8Array | undefined {
  try {
    for (const entry of track.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC;
      if (box) {
        const DS = (MP4BoxRef as any).DataStream || (self as any).DataStream;
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
