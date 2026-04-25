/**
 * src/engine/engine-router.ts
 * 统一调度层 — 4 档降级路由
 *
 * Tier 1  WebCodecs + 硬件 GPU 编码器   (Chrome/Edge + 独显/集显)
 * Tier 2  WebCodecs + 软件 CPU 编码器   (Chrome/Edge，无可用硬件编码器)
 * Tier 3  FFmpeg WASM 多线程           (有 SharedArrayBuffer 的环境)
 * Tier 4  FFmpeg WASM 单线程           (iOS Safari / 无 COOP-COEP 的服务器)
 *
 * 图片走独立 ImageEngine，与视频引擎完全解耦。
 */

import { FfmpegEngine } from './ffmpeg-engine';
import type { CompressionOptions, ProgressCallback } from './ffmpeg-engine';
import { MediaEngine } from './processor';
import { ImageEngine } from './image-engine';
import type { ImageCompressionOptions } from './image-engine';
import { logger } from './logger';

export type EngineType = 'webcodecs-hw' | 'webcodecs-sw' | 'ffmpeg-mt' | 'ffmpeg-st';

export interface RouteDecision {
  engine: EngineType;
  reason: string;
  tier: 1 | 2 | 3 | 4;
}

// ── 能力探测 ─────────────────────────────────────────────────────────

const detectWebCodecs = (): boolean => {
  try { return typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function'; }
  catch { return false; }
};

const detectOPFS = async (): Promise<boolean> => {
  try { await navigator.storage.getDirectory(); return true; }
  catch { return false; }
};

const detectSharedArrayBuffer = (): boolean => {
  try { return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true; }
  catch { return false; }
};

// Probe whether a hardware encoder is actually available for H.264.
// Returns true when the browser can route to a GPU encoder.
const detectHardwareEncoder = async (): Promise<boolean> => {
  if (!detectWebCodecs()) return false;
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f',
      width: 1280,
      height: 720,
      bitrate: 4_000_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
    });
    // Must be explicitly 'prefer-hardware'; 'prefer-software' and undefined both mean CPU.
    return result.supported === true && result.config?.hardwareAcceleration === 'prefer-hardware';
  } catch {
    return false;
  }
};

// ── Router ───────────────────────────────────────────────────────────

export class EngineRouter {
  private ffmpegEngine: FfmpegEngine;
  private webCodecsEngine: MediaEngine;
  private imageEngine: ImageEngine;

  private _tier: (1 | 2 | 3 | 4) | null = null;
  private _routePromise: Promise<RouteDecision> | null = null;

  constructor() {
    this.ffmpegEngine = new FfmpegEngine();
    this.webCodecsEngine = new MediaEngine();
    this.imageEngine = new ImageEngine();

    // Background preload — whichever engine ends up being used will be warm.
    this.ffmpegEngine.preload();
    this.webCodecsEngine.warmup().catch(() => {});
  }

  /** Resolve and cache the tier. Safe to call multiple times. */
  async route(_fileSize?: number): Promise<RouteDecision> {
    if (this._routePromise) return this._routePromise;

    this._routePromise = (async (): Promise<RouteDecision> => {
      const hasWebCodecs = detectWebCodecs();
      const hasOPFS = hasWebCodecs ? await detectOPFS() : false;

      if (hasWebCodecs && hasOPFS) {
        const hasHW = await detectHardwareEncoder();
        if (hasHW) {
          this._tier = 1;
          return { engine: 'webcodecs-hw', tier: 1, reason: 'GPU 硬件加速 · WebCodecs + 硬件编码器' };
        }
        this._tier = 2;
        return { engine: 'webcodecs-sw', tier: 2, reason: 'CPU 软件编码 · WebCodecs（无可用 GPU 编码器）' };
      }

      if (detectSharedArrayBuffer()) {
        this._tier = 3;
        return { engine: 'ffmpeg-mt', tier: 3, reason: 'CPU 多线程 · FFmpeg WASM（兼容模式）' };
      }

      this._tier = 4;
      return { engine: 'ffmpeg-st', tier: 4, reason: 'CPU 单线程 · FFmpeg WASM（iOS Safari / 通用兼容）' };
    })();

    return this._routePromise;
  }

  /** Current tier (null until first route() call resolves). */
  get tier(): (1 | 2 | 3 | 4) | null { return this._tier; }

  /** True when hardware GPU encoding is being used (tier 1). */
  get isHardwareAccelerated(): boolean { return this._tier === 1; }

  // ── 统一压缩入口 ────────────────────────────────────────────────────

  async compress(
    file: File,
    options: { codec: string; crf: number; preset: string },
    onProgress: ProgressCallback,
    onRouteDecision?: (decision: RouteDecision) => void,
    fileType?: 'video' | 'image',
    imageOptions?: ImageCompressionOptions,
  ): Promise<Blob> {
    // ── 图片路径 ─────────────────────────────────────────────────────
    if (fileType === 'image') {
      onProgress(10);
      const blob = await this.imageEngine.compress(file, imageOptions ?? { outputFormat: 'original', quality: 85 });
      onProgress(100);
      return blob;
    }

    // ── 视频路径 ─────────────────────────────────────────────────────
    const decision = await this.route(file.size);
    onRouteDecision?.(decision);

    // Tier 1 & 2 — WebCodecs
    if (decision.engine === 'webcodecs-hw' || decision.engine === 'webcodecs-sw') {
      try {
        const codecMap: Record<string, string> = { libx264: 'libx264', libx265: 'libx265', av1: 'av1' };
        const resultFile = await this.webCodecsEngine.processLargeVideo(
          file,
          { codec: codecMap[options.codec] ?? 'libx264', bitrate: 5_000_000, crf: options.crf, preset: options.preset },
          (data) => onProgress(Math.round(data.progress)),
        );
        return resultFile as unknown as Blob;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('system', `WebCodecs crash: ${msg}. Falling back to FFmpeg WASM.`);
        const fallbackTier: 3 | 4 = detectSharedArrayBuffer() ? 3 : 4;
        this._tier = fallbackTier;
        const fallback: RouteDecision = {
          engine: fallbackTier === 3 ? 'ffmpeg-mt' : 'ffmpeg-st',
          tier: fallbackTier,
          reason: `硬件加速引擎失败，自动降级至 FFmpeg WASM（CPU ${fallbackTier === 3 ? '多线程' : '单线程'}）`,
        };
        // Fix (HIGH): pin the promise to the fallback so concurrent calls don't re-probe WebCodecs.
        this._routePromise = Promise.resolve(fallback);
        onRouteDecision?.(fallback);
        // Fall through to FFmpeg below.
      }
    }

    // Tier 3 & 4 — FFmpeg WASM (multi or single thread, auto-selected inside FfmpegEngine)
    const ffmpegCodecMap: Record<string, CompressionOptions['codec']> = {
      libx264: 'libx264',
      libx265: 'libx265',
      av1: 'libaom-av1',
    };
    if (!this.ffmpegEngine.isReady()) await this.ffmpegEngine.load();
    return this.ffmpegEngine.compress(
      file,
      {
        codec: ffmpegCodecMap[options.codec] ?? 'libx264',
        crf: options.crf,
        preset: options.preset as CompressionOptions['preset'],
        outputFormat: 'mp4',
      },
      onProgress,
    );
  }

  getFfmpegEngine(): FfmpegEngine { return this.ffmpegEngine; }

  terminate(): void {
    this.ffmpegEngine.terminate();
    this.webCodecsEngine.stop();
  }
}
