// src/engine/ffmpeg-engine.ts
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export type CompressionOptions = {
  codec: 'libx264' | 'libx265' | 'libaom-av1';
  crf: number;   // 0-51, 越小质量越好
  preset: 'ultrafast' | 'fast' | 'medium' | 'slow';
  outputFormat: 'mp4' | 'webm';
};

export type ProgressCallback = (progress: number) => void;

const DEFAULT_CDN = '/ffmpeg';

export class FfmpegEngine {
  private ffmpeg: FFmpeg;
  private loaded = false;

  constructor() {
    this.ffmpeg = new FFmpeg();
  }

  async load() {
    if (this.loaded) return;

    // 管道化 FFmpeg 内部日志到浏览器控制台
    this.ffmpeg.on('log', ({ message }) => {
      console.log('🚀 [FFmpeg Log]', message);
    });

    // 加载单线程核心 (100% 稳定性，解决 Chromium Pthreads 死锁问题)
    await this.ffmpeg.load({
      coreURL: await toBlobURL(`${DEFAULT_CDN}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${DEFAULT_CDN}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    this.loaded = true;
  }

  async compress(
    inputFile: File,
    options: CompressionOptions,
    onProgress?: ProgressCallback
  ): Promise<Blob> {
    if (!this.loaded) await this.load();

    // 每次压缩都重新绑定进度监听器，确保 UI 同步
    this.ffmpeg.on('progress', ({ progress }) => {
      onProgress?.(Math.round(progress * 100));
    });

    const inputName = `input.${inputFile.name.split('.').pop() || 'mp4'}`;
    const outputName = `output.${options.outputFormat}`;

    await this.ffmpeg.writeFile(inputName, await fetchFile(inputFile));

    const args = this.buildArgs(inputName, outputName, options);
    console.log('[FFmpegEngine] Executing:', args.join(' '));

    await this.ffmpeg.exec(args);

    // 3. 读取输出文件
    const data = await this.ffmpeg.readFile(outputName);

    // 4. 清理虚拟文件系统
    await this.ffmpeg.deleteFile(inputName);
    await this.ffmpeg.deleteFile(outputName);

    return new Blob([data], { type: `video/${options.outputFormat}` });
  }

  private buildArgs(input: string, output: string, options: CompressionOptions): string[] {
    const common = ['-hide_banner', '-loglevel', 'info', '-threads', '4'];
    
    // H.264 配置
    if (options.codec === 'libx264') {
      return [
        ...common,
        '-i', input,
        '-c:v', 'libx264',
        '-crf', String(options.crf),
        '-preset', options.preset,
        '-pix_fmt', 'yuv420p', // 强制指定像素格式提高兼容性
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', output,
      ];
    }

    // HEVC / H.265 配置
    if (options.codec === 'libx265') {
      return [
        ...common,
        '-i', input,
        '-c:v', 'libx265',
        '-crf', String(options.crf),
        '-preset', options.preset,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-tag:v', 'hvc1',
        '-y', output,
      ];
    }

    // AV1 配置
    return [
      ...common,
      '-i', input,
      '-c:v', 'libaom-av1',
      '-cpu-used', '8', // 提高 AV1 在 Wasm 下的编码速度
      '-crf', String(options.crf),
      '-b:v', '0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus',
      '-y', output,
    ];
  }

  /**
   * 生成原始视频的预览 URL
   */
  getPreviewUrl(file: File): string {
    return URL.createObjectURL(file);
  }

  isReady(): boolean {
    return this.loaded;
  }

  terminate() {
    this.ffmpeg.terminate();
    this.loaded = false;
  }
}
