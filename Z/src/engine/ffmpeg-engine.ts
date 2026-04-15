// src/engine/ffmpeg-engine.ts
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export interface CompressionOptions {
  codec: 'libx264' | 'libx265' | 'libaom-av1';
  crf: number;
  preset: 'ultrafast' | 'fast' | 'medium' | 'slow';
  outputFormat: 'mp4' | 'webm';
}

export type ProgressCallback = (progress: number) => void;

const CORE_PATH = '/ffmpeg';

export class FfmpegEngine {
  private ffmpeg: FFmpeg;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private progressHandler: ((e: { progress: number }) => void) | null = null;

  constructor() {
    this.ffmpeg = new FFmpeg();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    // Guard against concurrent load() calls
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      this.ffmpeg.on('log', ({ message }) => console.log('[FFmpeg]', message));
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_PATH}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_PATH}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      this.loaded = true;
    })();
    return this.loadPromise;
  }

  async compress(inputFile: File, options: CompressionOptions, onProgress?: ProgressCallback): Promise<Blob> {
    if (!this.loaded) await this.load();

    // 清除旧 listener 防止泄漏
    if (this.progressHandler) this.ffmpeg.off('progress', this.progressHandler);
    this.progressHandler = ({ progress }) => onProgress?.(Math.round(progress * 100));
    this.ffmpeg.on('progress', this.progressHandler);

    const ext = inputFile.name.split('.').pop() || 'mp4';
    const inputName = `input_${Date.now()}.${ext}`;
    const outputName = `output_${Date.now()}.${options.outputFormat}`;

    await this.ffmpeg.writeFile(inputName, await fetchFile(inputFile));
    const args = this.buildArgs(inputName, outputName, options);
    console.log('[FFmpegEngine] exec:', args.join(' '));

    await this.ffmpeg.exec(args);
    const data = await this.ffmpeg.readFile(outputName);

    // 清理 FS
    await this.ffmpeg.deleteFile(inputName).catch(() => {});
    await this.ffmpeg.deleteFile(outputName).catch(() => {});

    return new Blob([data], { type: `video/${options.outputFormat}` });
  }

  private buildArgs(input: string, output: string, opt: CompressionOptions): string[] {
    const base = ['-hide_banner', '-loglevel', 'info'];

    if (opt.codec === 'libx264') {
      return [...base, '-i', input, '-c:v', 'libx264', '-crf', String(opt.crf), '-preset', opt.preset, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', output];
    }
    if (opt.codec === 'libx265') {
      return [...base, '-i', input, '-c:v', 'libx265', '-crf', String(opt.crf), '-preset', opt.preset, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-tag:v', 'hvc1', '-x265-params', 'frame-threads=1', '-y', output];
    }
    // AV1
    return [...base, '-i', input, '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', String(opt.crf), '-b:v', '0', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-y', output];
  }

  isReady(): boolean { return this.loaded; }

  terminate(): void {
    if (this.progressHandler) this.ffmpeg.off('progress', this.progressHandler);
    this.ffmpeg.terminate();
    this.loaded = false;
    this.loadPromise = null;
  }
}
