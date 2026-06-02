// src/engine/ffmpeg-engine.ts
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export interface CompressionOptions {
  codec: 'libx264' | 'libx265' | 'libaom-av1';
  crf: number;
  preset: 'ultrafast' | 'fast' | 'medium' | 'slow';
  outputFormat: 'mp4' | 'webm' | 'avi' | 'flv';
}

const OUTPUT_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/avi',
  flv: 'video/x-flv',
};

export type ProgressCallback = (progress: number) => void;

/**
 * 构造 FFmpeg 命令行参数（纯函数，无副作用，可单测）
 *
 * 关键 flag：
 *   -map_metadata 0                       → 复制源文件全局 metadata
 *   -movflags use_metadata_tags+faststart → mp4 容器保留 QuickTime 私有 atom（iPhone）
 */
export function buildFfmpegArgs(
  input: string,
  output: string,
  opt: CompressionOptions,
  isMultiThreaded: boolean,
): string[] {
  if ((opt.codec === 'libx265' || opt.codec === 'libaom-av1') &&
      (opt.outputFormat === 'avi' || opt.outputFormat === 'flv')) {
    throw new Error(
      `编解码器 ${opt.codec === 'libx265' ? 'H.265' : 'AV1'} 不支持 ${opt.outputFormat.toUpperCase()} 容器，请切换为 H.264`
    );
  }

  const base = ['-hide_banner', '-loglevel', 'error'];
  const threadFlag = isMultiThreaded ? ['-threads', '0'] : ['-threads', '1'];
  const meta = ['-map_metadata', '0'];
  const isMp4Family = opt.outputFormat === 'mp4';
  const mp4Flags = isMp4Family ? ['-movflags', 'use_metadata_tags+faststart'] : [];

  if (opt.codec === 'libx264') {
    return [...base, '-i', input, ...meta, '-c:v', 'libx264', '-crf', String(opt.crf), '-preset', opt.preset, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', ...mp4Flags, ...threadFlag, '-y', output];
  }
  if (opt.codec === 'libx265') {
    // H.265 only works reliably in MP4/MOV containers; caller should not request H.265 + AVI/FLV.
    return [...base, '-i', input, ...meta, '-c:v', 'libx265', '-crf', String(opt.crf), '-preset', opt.preset, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-tag:v', 'hvc1', ...mp4Flags, ...threadFlag, '-y', output];
  }
  // AV1 — cpu-used=8 for speed; AV1 only in MP4/WebM containers.
  return [...base, '-i', input, ...meta, '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', String(opt.crf), '-b:v', '0', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', ...mp4Flags, ...threadFlag, '-y', output];
}

// Multi-thread requires SharedArrayBuffer (crossOriginIsolated).
// Single-thread works in every browser including iOS Safari.
const isMultiThreaded = (): boolean => {
  try { return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true; }
  catch { return false; }
};

const corePath = () => isMultiThreaded() ? '/ffmpeg-mt' : '/ffmpeg';

export class FfmpegEngine {
  private ffmpeg: FFmpeg;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private progressHandler: ((e: { progress: number }) => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;
  private _isMultiThreaded = false;

  constructor() {
    this.ffmpeg = new FFmpeg();
  }

  get threaded(): boolean { return this._isMultiThreaded; }

  preload(): void {
    this.load();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    this._isMultiThreaded = isMultiThreaded();
    const path = corePath();

    this.loadPromise = (async () => {
      const loadArgs: Parameters<FFmpeg['load']>[0] = {
        coreURL: await toBlobURL(`${path}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${path}/ffmpeg-core.wasm`, 'application/wasm'),
      };
      // Single-threaded core has no worker file; skip it to avoid 404.
      if (this._isMultiThreaded) {
        loadArgs.workerURL = await toBlobURL(`${path}/ffmpeg-core.worker.js`, 'text/javascript');
      }
      await this.ffmpeg.load(loadArgs);
      this.loaded = true;
    })().catch((e: unknown) => {
      // Clear the cached promise so callers can retry after a transient network error.
      this.loadPromise = null;
      throw e;
    });
    return this.loadPromise;
  }

  async compress(inputFile: File, options: CompressionOptions, onProgress?: ProgressCallback): Promise<Blob> {
    if (!this.loaded) await this.load();

    if (this.progressHandler) this.ffmpeg.off('progress', this.progressHandler);
    this.progressHandler = ({ progress }) => onProgress?.(Math.round(progress * 100));
    this.ffmpeg.on('progress', this.progressHandler);

    const ext = inputFile.name.split('.').pop() || 'mp4';
    const inputName = `input_${Date.now()}.${ext}`;
    const outputName = `output_${Date.now()}.${options.outputFormat}`;

    await this.ffmpeg.writeFile(inputName, await fetchFile(inputFile));
    const args = this.buildArgs(inputName, outputName, options);

    try {
      await new Promise<void>(async (resolve, reject) => {
        this.currentReject = reject;
        try {
          await this.ffmpeg.exec(args);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    } finally {
      this.currentReject = null;
    }
    const data = await this.ffmpeg.readFile(outputName);

    await this.ffmpeg.deleteFile(inputName).catch(() => {});
    await this.ffmpeg.deleteFile(outputName).catch(() => {});

    return new Blob([data as BlobPart], { type: OUTPUT_MIME[options.outputFormat] ?? `video/${options.outputFormat}` });
  }

  private buildArgs(input: string, output: string, opt: CompressionOptions): string[] {
    return buildFfmpegArgs(input, output, opt, this._isMultiThreaded);
  }

  isReady(): boolean { return this.loaded; }

  terminate(): void {
    if (this.currentReject) {
      this.currentReject(new Error('AbortError: FFmpeg 任务已中止'));
      this.currentReject = null;
    }
    if (this.progressHandler) this.ffmpeg.off('progress', this.progressHandler);
    this.ffmpeg.terminate();
    this.loaded = false;
    this.loadPromise = null;
  }
}
