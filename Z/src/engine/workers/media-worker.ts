/**
 * src/engine/workers/media-worker.ts
 * Titan V12 - 使用正确的 mp4box API (mp4box.boxes / mp4box.moov)
 */

import { Muxer, StreamTarget } from 'mp4-muxer';

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
let muxer: Muxer<StreamTarget> | null = null;
let encoder: VideoEncoder | null = null;
let decoder: VideoDecoder | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;
  if (type === 'PING') { postMessage({ type: 'PONG' }); return; }
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

  let trackInfo: any = null;
  let onReadyFired = false;
  const sampleBuffer: any[] = [];

  mp4box.onSamples = (_id: any, _user: any, samples: any[]) => {
    sampleBuffer.push(...samples);
  };

  mp4box.onReady = (info: any) => {
    console.log('✅ [Worker] onReady fired');
    onReadyFired = true;
    trackInfo = info;

    const vTrack = info.videoTracks?.[0];
    if (!vTrack) {
      console.error('❌ [Worker] No video track found');
      return;
    }
    console.log(`📹 [Worker] Video track: id=${vTrack.id}, codec=${vTrack.codec}, ${vTrack.video.width}x${vTrack.video.height}`);

    mp4box.setExtractionOptions(vTrack.id, null, { nbSamples: 200 });
    mp4box.start();
    console.log('✅ [Worker] Extraction started');
  };

  mp4box.onError = (err: any) => {
    console.error('❌ [Worker] MP4Box error:', err);
    postMessage({ type: 'ERROR', data: `MP4Box: ${err}` });
  };

  // Phase 1: 喂数据直到 onReady
  console.log('📖 [Worker] Phase 1: Feeding until onReady...');
  const reader1 = file.stream().getReader();
  let bytesLoaded = 0;
  const totalSize = file.size;

  while (!onReadyFired) {
    const { done, value } = await reader1.read();
    if (done) {
      console.error('❌ [Worker] End of file reached before onReady');
      break;
    }
    const buffer = value.buffer as any;
    buffer.fileStart = bytesLoaded;
    bytesLoaded += value.byteLength;
    mp4box.appendBuffer(buffer);
  }
  reader1.releaseLock();
  console.log(`✅ [Worker] Phase 1 complete`);

  // 🔑 关键修复：在 Phase 2 之前，从 mp4box.boxes 提取 avcC
  console.log('🔧 [Worker] Extracting avcC from mp4box.boxes...');
  const description = extractAVCCFromMp4boxBoxes(trackInfo.videoTracks[0].id, mp4box, MP4Box);
  console.log(`🔧 [Worker] Description: ${description ? `present (${description.length} bytes)` : 'MISSING'}`);

  // Phase 2: 重新喂所有数据
  console.log('📖 [Worker] Phase 2: Re-feeding all data...');
  const reader2 = file.stream().getReader();
  bytesLoaded = 0;

  while (true) {
    const { done, value } = await reader2.read();
    if (done) break;
    const buffer = value.buffer as any;
    buffer.fileStart = bytesLoaded;
    bytesLoaded += value.byteLength;
    mp4box.appendBuffer(buffer);
    postMessage({ type: 'PROGRESS', data: { loaded: bytesLoaded, total: totalSize, progress: (bytesLoaded / totalSize) * 30 } });
  }
  reader2.releaseLock();
  mp4box.flush();
  console.log(`✅ [Worker] Phase 2 complete: ${sampleBuffer.length} samples extracted`);

  if (!trackInfo?.videoTracks?.[0]) {
    throw new Error('未在源文件中检测到视频轨道');
  }
  if (sampleBuffer.length === 0) {
    throw new Error('MP4Box 未提取到任何视频样本');
  }

  const track = trackInfo.videoTracks[0];
  const totalFrames = sampleBuffer.length;
  const width = track.video.width;
  const height = track.video.height;
  const safeWidth = width % 2 === 0 ? width : width - 1;
  const safeHeight = height % 2 === 0 ? height : height - 1;

  // 编解码器字符串
  let encCodecStr = 'avc1.4D002A';
  let muxerCodec: 'avc' | 'hevc' | 'av1' | 'vp9' = 'avc';
  if (config.codec === 'libx265') {
    encCodecStr = 'hev1.1.6.L120.90';
    muxerCodec = 'hevc';
  } else if (config.codec === 'av1') {
    encCodecStr = 'av01.0.04M.08';
    muxerCodec = 'av1';
  }

  // 🔑 智能 bitrate 计算
  // 注意：即使 config.bitrate 存在，也要检查是否合理（不升级低码率视频）
  const calculatedBitrate = calculateSmartBitrate(width, height, totalSize, totalFrames, config.bitrate);
  console.log(`🔧 [Worker] Smart bitrate: ${Math.round(calculatedBitrate / 1000)}kbps (${(calculatedBitrate / 1000000).toFixed(2)}Mbps)`);

  const encConfig: VideoEncoderConfig = {
    codec: encCodecStr,
    width: safeWidth,
    height: safeHeight,
    bitrate: calculatedBitrate,
    hardwareAcceleration: 'prefer-hardware',
  };

  console.log('🔧 [Worker] Checking hardware encoder support...');
  const support = await VideoEncoder.isConfigSupported(encConfig);
  if (!support.supported) {
    throw new Error(`当前浏览器/显卡不支持此硬件编码器配置: ${encCodecStr}`);
  }
  console.log('✅ [Worker] Hardware encoder supported');

  muxer = new Muxer({
    target: new StreamTarget({
      onData: (data, offset) => {
        if (accessHandle) accessHandle.write(data as unknown as BufferSource, { at: offset });
      }
    }),
    video: { codec: muxerCodec, width: safeWidth, height: safeHeight },
    fastStart: false
  });

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
        postMessage({ type: 'PROGRESS', data: { loaded: bytesLoaded, total: totalSize, progress: 30 + (encodedFrames / Math.max(1, totalFrames)) * 70 } });
      } catch (e: any) {
        postMessage({ type: 'ERROR', data: `Muxer Chunk Error: ${e.message}` });
      }
    },
    error: (e) => postMessage({ type: 'ERROR', data: `Encoder: ${e.message}` })
  });
  encoder.configure(encConfig);
  console.log('✅ [Worker] Encoder configured');

  decoder = new VideoDecoder({
    output: (frame) => {
      try {
        encoder!.encode(frame, { keyFrame: encodedFrames % 60 === 0 });
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
  console.log('✅ [Worker] Decoder configured');

  console.log(`🎬 [Worker] Processing ${totalFrames} frames...`);
  for (let i = 0; i < sampleBuffer.length; i++) {
    const sample = sampleBuffer[i];
    while (encoder!.encodeQueueSize >= 30) {
      await new Promise(r => setTimeout(r, 5));
    }
    decoder.decode(new EncodedVideoChunk({
      type: sample.is_sync ? 'key' : 'delta',
      timestamp: (sample.cts * 1_000_000) / sample.timescale,
      duration: (sample.duration * 1_000_000) / sample.timescale,
      data: sample.data,
    }));
  }

  await decoder.flush();
  await encoder.flush();

  console.log(`✅ [Worker] Encode complete: ${encodedFrames}/${totalFrames} frames`);
  if (encodedFrames === 0) {
    throw new Error('没有任何视频帧被成功编解码。请检查源文件格式。');
  }

  muxer.finalize();
  if (accessHandle) {
    accessHandle.flush();
    accessHandle.close();
    accessHandle = null;
  }

  console.log('🎉 [Worker] Pipeline Complete');
  postMessage({ type: 'DONE' });
}

// ── 辅助函数 ───────────────────────────────────────────────────────
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
  totalFrames: number,
  userBitrate?: number
): number {
  // 估算视频时长（秒）- 假设 30fps
  const estimatedDuration = totalFrames / 30;
  const originalBitrate = (fileSize * 8) / estimatedDuration; // bps

  // 基于分辨率的推荐 bitrate（参考 H.264 推荐值）
  const pixels = width * height;
  let recommendedBitrate = 0;

  if (pixels <= 640 * 480) {
    // 480p 及以下: 1-2 Mbps
    recommendedBitrate = 1_500_000;
  } else if (pixels <= 1280 * 720) {
    // 720p: 3-5 Mbps
    recommendedBitrate = 4_000_000;
  } else if (pixels <= 1920 * 1080) {
    // 1080p: 5-10 Mbps
    recommendedBitrate = 8_000_000;
  } else {
    // 4K: 20-40 Mbps
    recommendedBitrate = 30_000_000;
  }

  // 🔑 关键：不升级低码率视频
  // 如果原视频 bitrate 低于推荐值，使用原视频的 80%（允许一定压缩空间）
  // 如果原视频 bitrate 高于推荐值，使用推荐值
  let smartBitrate: number;
  if (originalBitrate < recommendedBitrate) {
    smartBitrate = originalBitrate * 0.8; // 原视频的 80%
    console.log(`🔍 [Worker] Original bitrate (${(originalBitrate / 1000000).toFixed(2)}Mbps) < recommended (${(recommendedBitrate / 1000000).toFixed(2)}Mbps), using 80% of original`);
  } else {
    smartBitrate = recommendedBitrate;
    console.log(`🔍 [Worker] Original bitrate (${(originalBitrate / 1000000).toFixed(2)}Mbps) > recommended (${(recommendedBitrate / 1000000).toFixed(2)}Mbps), using recommended`);
  }

  // 设置最小 bitrate（避免过低导致质量崩溃）
  const minBitrate = 500_000; // 500 kbps
  smartBitrate = Math.max(smartBitrate, minBitrate);

  // 🔑 关键修复：即使用户指定了 bitrate，也要检查是否合理
  // 如果用户指定的 bitrate 会导致文件变大（大于原视频 bitrate），则使用智能计算的值
  if (userBitrate) {
    console.log(`🔍 [Worker] User specified bitrate: ${(userBitrate / 1000000).toFixed(2)}Mbps`);

    // 如果用户指定的 bitrate 会升级低码率视频，使用智能值
    if (userBitrate > originalBitrate && originalBitrate < recommendedBitrate) {
      console.warn(`⚠️ [Worker] User bitrate (${(userBitrate / 1000000).toFixed(2)}Mbps) would upgrade low-bitrate video (${(originalBitrate / 1000000).toFixed(2)}Mbps), using smart bitrate instead`);
      return Math.round(smartBitrate);
    }

    // 用户指定值合理，使用用户值
    return userBitrate;
  }

  return Math.round(smartBitrate);
}

/**
 * 从 mp4box.boxes 或 mp4box.moov 中提取 avcC description
 */
function extractAVCCFromMp4boxBoxes(trackId: number, mp4box: any, MP4Box: any): Uint8Array | undefined {
  try {
    const mp4boxAny = mp4box as any;

    // 方式1：从 mp4box.boxes 访问
    if (mp4boxAny.boxes && Array.isArray(mp4boxAny.boxes)) {
      console.log('🔍 [Worker] Found mp4box.boxes array, length:', mp4boxAny.boxes.length);
      const avcC = findAVCCInBoxes(mp4boxAny.boxes, trackId, MP4Box);
      if (avcC) {
        console.log('✅ [Worker] Found avcC in mp4box.boxes');
        return avcC;
      }
    }

    // 方式2：从 mp4box.moov 直接访问
    if (mp4boxAny.moov) {
      console.log('🔍 [Worker] Found mp4box.moov');
      const avcC = findAVCCInMoov(mp4boxAny.moov, trackId, MP4Box);
      if (avcC) {
        console.log('✅ [Worker] Found avcC in mp4box.moov');
        return avcC;
      }
    }

    console.warn('[Worker] avcC not found in mp4box.boxes or mp4box.moov');
    return undefined;
  } catch (e) {
    console.error('[Worker] Error extracting avcC:', e);
    return undefined;
  }
}

/**
 * 在 boxes 数组中递归查找 avcC
 */
function findAVCCInBoxes(boxes: any[], targetTrackId: number, MP4Box: any): Uint8Array | undefined {
  for (const box of boxes) {
    if (box.type === 'avcC' || box.type === 'hvcC') {
      console.log('🔍 [Worker] Found avcC/hvcC box at top level');
      return extractAVCCData(box, MP4Box);
    }

    if (box.type === 'moov') {
      return findAVCCInMoov(box, targetTrackId, MP4Box);
    }

    if (box.boxes && Array.isArray(box.boxes)) {
      const result = findAVCCInBoxes(box.boxes, targetTrackId, MP4Box);
      if (result) return result;
    }
  }
  return undefined;
}

/**
 * 在 moov box 中查找 avcC
 */
function findAVCCInMoov(moov: any, targetTrackId: number, MP4Box: any): Uint8Array | undefined {
  if (!moov.boxes || !Array.isArray(moov.boxes)) {
    console.warn('[Worker] moov.boxes not found');
    return undefined;
  }

  // 找到对应的 trak
  for (const trak of moov.boxes) {
    if (trak.type !== 'trak') continue;

    // 提取 track ID（从 tkhd）
    const tkhd = trak.boxes?.find((b: any) => b.type === 'tkhd');
    if (!tkhd) continue;

    const trakId = tkhd.track_id;
    if (trakId !== targetTrackId) continue;

    console.log('🔍 [Worker] Found matching trak, id=', trakId);

    // 遍历 trak → mdia → minf → stbl → stsd → avcC
    return findAVCCInTrak(trak, MP4Box);
  }

  return undefined;
}

/**
 * 在 trak box 中查找 avcC
 */
function findAVCCInTrak(trak: any, MP4Box: any): Uint8Array | undefined {
  const mdia = trak.boxes?.find((b: any) => b.type === 'mdia');
  if (!mdia) {
    console.warn('[Worker] mdia not found in trak');
    return undefined;
  }

  const minf = mdia.boxes?.find((b: any) => b.type === 'minf');
  if (!minf) {
    console.warn('[Worker] minf not found');
    return undefined;
  }

  const stbl = minf.boxes?.find((b: any) => b.type === 'stbl');
  if (!stbl) {
    console.warn('[Worker] stbl not found');
    return undefined;
  }

  const stsd = stbl.boxes?.find((b: any) => b.type === 'stsd');
  if (!stsd) {
    console.warn('[Worker] stsd not found');
    return undefined;
  }

  console.log('🔍 [Worker] Found stsd, entries:', stsd.entries ? stsd.entries.length : 'none');

  if (!stsd.entries || !Array.isArray(stsd.entries)) {
    console.warn('[Worker] stsd.entries not found');
    return undefined;
  }

  for (const entry of stsd.entries) {
    console.log('🔍 [Worker] Entry type:', entry.type);

    // 🔑 关键修复：avcC 是 avc1/hev1 entry 的子 box，不是 entries[] 的直接元素
    if (entry.type === 'avc1' || entry.type === 'avc3' || entry.type === 'hev1' || entry.type === 'hvc1') {
      console.log('🔍 [Worker] Found video sample entry, checking its boxes...');

      if (entry.boxes && Array.isArray(entry.boxes)) {
        console.log('🔍 [Worker] Entry has', entry.boxes.length, 'sub-boxes');

        for (const subBox of entry.boxes) {
          console.log('🔍 [Worker] Sub-box type:', subBox.type);

          if (subBox.type === 'avcC' || subBox.type === 'hvcC') {
            console.log('✅ [Worker] Found avcC/hvcC in entry.boxes!');
            return extractAVCCData(subBox, MP4Box);
          }
        }
      } else {
        console.log('🔍 [Worker] Entry has no boxes array');
      }
    }

    // 旧逻辑（保留兼容性）
    if (entry.type === 'avcC' || entry.type === 'hvcC') {
      console.log('✅ [Worker] Found avcC/hvcC directly in entries');
      return extractAVCCData(entry, MP4Box);
    }
  }

  console.warn('[Worker] No avcC/hvcC found in stsd.entries or sub-boxes');
  return undefined;
}

/**
 * 从 avcC box 提取数据
 *
 * 使用 mp4box 的 DataStream.write() 方法，让 mp4box 自己序列化 box
 * 这样可以保证格式完全正确
 */
function extractAVCCData(box: any, MP4Box: any): Uint8Array {
  console.log('🔍 [Worker] extractAVCCData, box has start:', box.start, 'size:', box.size);

  // 🔑 方案A：如果 box 有原始数据引用，直接使用
  if (box.data && box.data instanceof Uint8Array) {
    console.log('✅ [Worker] Using box.data directly');
    return box.data;
  }

  // 🔑 方案B：使用 mp4box 的 DataStream.write() 序列化
  try {
    const DS = (MP4Box as any).DataStream || (self as any).DataStream;
    if (!DS) {
      console.error('[Worker] DataStream not available');
      throw new Error('DataStream not available');
    }

    console.log('🔍 [Worker] Using DataStream.write() to serialize avcC box');
    const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
    box.write(stream);

    // stream.buffer 包含完整的序列化数据（包括 8 字节 header）
    // WebCodecs 需要 avcC 的内容（跳过 header）
    const avcCData = new Uint8Array(stream.buffer, 8); // 跳过 8 字节 box header
    console.log('✅ [Worker] avcC serialized, length:', avcCData.length);
    return avcCData;
  } catch (e) {
    console.error('[Worker] DataStream.write() failed:', e);
    throw e;
  }
}

function cleanup() {
  try { decoder?.close(); } catch {}
  try { encoder?.close(); } catch {}
  try { if (accessHandle) { accessHandle.close(); accessHandle = null; } } catch {}
  decoder = null;
  encoder = null;
  muxer = null;
}
