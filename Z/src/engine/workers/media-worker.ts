/**
 * src/engine/workers/media-worker.ts
 * mediabunny-based compression pipeline.
 * 外部消息协议与 processor.ts 保持兼容：PING/PONG, START_PROCESS, PROGRESS, DONE, ERROR, STOP
 */

import {
  Input, BlobSource, ALL_FORMATS,
  Output, Mp4OutputFormat, StreamTarget,
  Conversion, ConversionCanceledError,
  type VideoCodec,
} from 'mediabunny';

if (typeof (self as any).window === 'undefined') (self as any).window = self;

self.addEventListener('error', (e) => {
  e.preventDefault();
  postMessage({ type: 'ERROR', data: `[Runtime] ${e.message} @ ${e.filename}:${e.lineno}` });
});
self.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  postMessage({ type: 'ERROR', data: `[Promise] ${e.reason}` });
});

interface FileSystemSyncAccessHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

let accessHandle: FileSystemSyncAccessHandle | null = null;
let conversion: Conversion | null = null;
let input: Input | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;
  if (type === 'PING') { postMessage({ type: 'PONG' }); return; }
  if (type === 'STOP') { await cleanup(); return; }
  if (type === 'START_PROCESS') {
    try {
      await runPipeline(data);
    } catch (err: any) {
      if (err instanceof ConversionCanceledError) {
        console.log('🛑 [Worker] Conversion canceled');
        return;
      }
      console.error('🔥 [Worker] Pipeline Error:', err);
      postMessage({ type: 'ERROR', data: err?.message || String(err) });
      await cleanup();
    }
  }
};

async function runPipeline({ file, config, outputHandle }: any) {
  console.log('🚀 [Worker] Pipeline Start (mediabunny)');

  try {
    accessHandle = await (outputHandle as any).createSyncAccessHandle();
  } catch (ioErr: any) {
    throw new Error(`OPFS 写入句柄创建失败: ${ioErr.message}. 请确保浏览器支持 OPFS.`);
  }

  const totalSize = file.size;

  // OPFS 适配：WritableStream → syncAccessHandle
  const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
    write(chunk) {
      accessHandle!.write(chunk.data as unknown as BufferSource, { at: chunk.position });
    },
  });

  // 读取输入，提取元数据用于 smart bitrate
  input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    throw new Error('未在源文件中检测到视频轨道');
  }
  const durationSec = await input.computeDuration();
  const width = videoTrack.displayWidth;
  const height = videoTrack.displayHeight;
  console.log(`📹 [Worker] ${width}x${height}, duration=${durationSec.toFixed(2)}s`);

  const targetBitrate = calculateSmartBitrate(width, height, totalSize, durationSec, config.bitrate);
  console.log(`🔧 [Worker] Smart bitrate: ${Math.round(targetBitrate / 1000)}kbps (${(targetBitrate / 1000000).toFixed(2)}Mbps)`);

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new StreamTarget(writable),
  });

  conversion = await Conversion.init({
    input,
    output,
    video: {
      codec: mapCodec(config.codec),
      bitrate: targetBitrate,
      keyFrameInterval: 2,
      hardwareAcceleration: 'prefer-hardware',
    },
    audio: { discard: true },
  });

  conversion.onProgress = (p) => {
    postMessage({
      type: 'PROGRESS',
      data: { loaded: Math.round(p * totalSize), total: totalSize, progress: p * 100 },
    });
  };

  await conversion.execute();

  const handle = accessHandle;
  if (handle) {
    handle.flush();
    handle.close();
  }
  accessHandle = null;
  conversion = null;
  input.dispose();
  input = null;

  console.log('🎉 [Worker] Pipeline Complete');
  postMessage({ type: 'DONE' });
}

function mapCodec(legacy: string | undefined): VideoCodec {
  if (legacy === 'libx265') return 'hevc';
  if (legacy === 'av1') return 'av1';
  return 'avc';
}

async function cleanup() {
  try { await conversion?.cancel(); } catch {}
  try { input?.dispose(); } catch {}
  try { accessHandle?.close(); } catch {}
  conversion = null;
  input = null;
  accessHandle = null;
}

/**
 * 智能计算目标 bitrate
 *
 * 策略：
 * 1. 基于分辨率计算基准 bitrate（参考 Netflix/YouTube 推荐值）
 * 2. 估算原视频 bitrate（文件大小 / 时长）
 * 3. 取两者之间的较低值，避免"低码率视频被重新编码成高码率"
 * 4. 🔑 关键修复：即使用户指定了 bitrate，也要检查是否合理，取用户值和智能值的较小者
 */
function calculateSmartBitrate(
  width: number,
  height: number,
  fileSize: number,
  durationSeconds: number,
  userBitrate?: number
): number {
  const originalBitrate = (fileSize * 8) / durationSeconds;

  const pixels = width * height;
  let recommendedBitrate = 0;
  if (pixels <= 640 * 480) {
    recommendedBitrate = 1_500_000;
  } else if (pixels <= 1280 * 720) {
    recommendedBitrate = 4_000_000;
  } else if (pixels <= 1920 * 1080) {
    recommendedBitrate = 8_000_000;
  } else {
    recommendedBitrate = 30_000_000;
  }

  let smartBitrate: number;
  if (originalBitrate < recommendedBitrate) {
    smartBitrate = originalBitrate * 0.8;
    console.log(`🔍 [Worker] Original (${(originalBitrate / 1e6).toFixed(2)}Mbps) < recommended (${(recommendedBitrate / 1e6).toFixed(2)}Mbps), using 80% of original`);
  } else {
    smartBitrate = recommendedBitrate;
    console.log(`🔍 [Worker] Original (${(originalBitrate / 1e6).toFixed(2)}Mbps) > recommended (${(recommendedBitrate / 1e6).toFixed(2)}Mbps), using recommended`);
  }

  const minBitrate = 500_000;
  smartBitrate = Math.max(smartBitrate, minBitrate);

  if (userBitrate) {
    console.log(`🔍 [Worker] User specified bitrate: ${(userBitrate / 1e6).toFixed(2)}Mbps`);
    if (userBitrate > originalBitrate) {
      console.warn(`⚠️ [Worker] User bitrate (${(userBitrate / 1e6).toFixed(2)}Mbps) > original (${(originalBitrate / 1e6).toFixed(2)}Mbps), using smart bitrate to prevent inflation`);
      return Math.round(smartBitrate);
    }
    return userBitrate;
  }

  return Math.round(smartBitrate);
}
