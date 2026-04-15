/**
 * src/engine/engine-router.ts
 * 双引擎统一调度层 — FFmpeg WASM vs WebCodecs 自动选择
 *
 * 策略：
 *  - 文件 ≤ 2GB → FFmpeg WASM（稳定、兼容性好）
 *  - 文件 > 2GB → WebCodecs（流式处理、OPFS 磁盘缓冲、无内存上限）
 *  - 降级：若 WebCodecs 不可用则回退 FFmpeg + 警告用户
 */

import { FfmpegEngine } from './ffmpeg-engine';
import type { CompressionOptions, ProgressCallback } from './ffmpeg-engine';
import { MediaEngine } from './processor';

// 2GB 阈值（WASM 内存安全上限）
const WASM_SIZE_LIMIT = 2 * 1024 * 1024 * 1024;

export type EngineType = 'ffmpeg' | 'webcodecs';

export interface RouteDecision {
  engine: EngineType;
  reason: string;
}

/** 运行时能力探测 */
const detectWebCodecs = (): boolean => {
  try { return typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function'; }
  catch { return false; }
};

const detectOPFS = async (): Promise<boolean> => {
  try { await navigator.storage.getDirectory(); return true; }
  catch { return false; }
};

export class EngineRouter {
  private ffmpegEngine: FfmpegEngine;
  private webCodecsEngine: MediaEngine;
  private webCodecsAvailable: boolean | null = null;

  constructor() {
    this.ffmpegEngine = new FfmpegEngine();
    this.webCodecsEngine = new MediaEngine();
  }

  /** 根据文件大小 + 浏览器能力自动选择引擎 */
  async route(fileSize: number): Promise<RouteDecision> {
    if (fileSize <= WASM_SIZE_LIMIT) {
      return { engine: 'ffmpeg', reason: `文件 ${(fileSize / 1048576).toFixed(0)}MB ≤ 2GB，使用 FFmpeg WASM 引擎` };
    }

    // 大文件 → 尝试 WebCodecs
    if (this.webCodecsAvailable === null) {
      this.webCodecsAvailable = detectWebCodecs() && await detectOPFS();
    }

    if (this.webCodecsAvailable) {
      return { engine: 'webcodecs', reason: `文件 ${(fileSize / 1048576).toFixed(0)}MB > 2GB，使用 WebCodecs 流式引擎` };
    }

    // WebCodecs 不可用 → 降级回 FFmpeg + 警告
    return { engine: 'ffmpeg', reason: `大文件但 WebCodecs 不可用，降级使用 FFmpeg（可能导致内存不足）` };
  }

  /** 统一压缩入口 */
  async compress(
    file: File,
    options: { codec: string; crf: number; preset: string },
    onProgress: ProgressCallback,
    onRouteDecision?: (decision: RouteDecision) => void,
  ): Promise<Blob> {
    const decision = await this.route(file.size);
    onRouteDecision?.(decision);

    if (decision.engine === 'webcodecs') {
      const codecMap: Record<string, string> = { libx264: 'libx264', libx265: 'libx265', av1: 'av1' };
      const resultFile = await this.webCodecsEngine.processLargeVideo(
        file,
        { codec: codecMap[options.codec] ?? 'libx264', bitrate: 5_000_000, crf: options.crf, preset: options.preset },
        (data) => onProgress(Math.round(data.progress)),
      );
      return resultFile as unknown as Blob;
    }

    // FFmpeg path
    const ffmpegCodecMap: Record<string, CompressionOptions['codec']> = { libx264: 'libx264', libx265: 'libx265', av1: 'libaom-av1' };
    if (!this.ffmpegEngine.isReady()) await this.ffmpegEngine.load();
    return this.ffmpegEngine.compress(
      file,
      { codec: ffmpegCodecMap[options.codec] ?? 'libx264', crf: options.crf, preset: options.preset as CompressionOptions['preset'], outputFormat: 'mp4' },
      onProgress,
    );
  }

  getFfmpegEngine(): FfmpegEngine { return this.ffmpegEngine; }

  terminate(): void {
    this.ffmpegEngine.terminate();
    this.webCodecsEngine.stop();
  }
}
