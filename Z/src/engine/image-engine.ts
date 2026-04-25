/**
 * src/engine/image-engine.ts
 * 图片压缩引擎 — Canvas API + UPNG.js
 *
 * PNG  → UPNG.js 调色板量化（quality=100 时 numColors=0 跳过量化，真正无损）
 * 其他格式 → canvas.toBlob 有损压缩（quality slider 生效）
 * 压缩后若体积更小则返回压缩版，否则保留原文件
 */

import UPNG from 'upng-js';

export type ImageOutputFormat = 'original' | 'png' | 'jpg' | 'webp' | 'avif';

export interface ImageCompressionOptions {
  outputFormat: ImageOutputFormat;
  quality: number; // 0–100
}

const MIME_MAP: Record<Exclude<ImageOutputFormat, 'original'>, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

const resolveOriginalMime = (file: File): string => {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  const extMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', avif: 'image/avif', gif: 'image/gif',
    bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff', tif: 'image/tiff',
  };
  return extMap[ext ?? ''] ?? 'image/png';
};

const _formatSupport: Partial<Record<string, boolean>> = {};
export const detectFormatSupport = (format: Exclude<ImageOutputFormat, 'original'>): boolean => {
  if (_formatSupport[format] !== undefined) return _formatSupport[format]!;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const dataUrl = canvas.toDataURL(MIME_MAP[format]);
    _formatSupport[format] = dataUrl.startsWith(`data:${MIME_MAP[format]}`);
  } catch {
    _formatSupport[format] = false;
  }
  return _formatSupport[format]!;
};

const supportsAlpha = (mime: string) => mime !== 'image/jpeg';

export class ImageEngine {
  async compress(file: File, options: ImageCompressionOptions): Promise<Blob> {
    const img = await this._loadImage(file);

    let targetMime: string;
    if (options.outputFormat === 'original') {
      targetMime = resolveOriginalMime(file);
    } else {
      const fmt = options.outputFormat;
      if (fmt !== 'png' && !detectFormatSupport(fmt)) {
        throw new Error(`FORMAT_UNSUPPORTED:${fmt}`);
      }
      targetMime = MIME_MAP[fmt];
    }

    if (targetMime === 'image/png') {
      return this._compressPng(img, file, options.quality);
    }

    return this._compressLossy(img, file, targetMime, options.quality);
  }

  private _compressPng(img: HTMLImageElement, file: File, quality: number): Blob {
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // quality 100 → numColors=0（UPNG 跳过量化，真正无损）
    // quality 0 → 4 colors，quality 85 → ~192 colors
    const numColors = quality === 100 ? 0 : Math.max(4, Math.round((quality / 100) * 256));

    const encoded = UPNG.encode(
      [imageData.data.buffer],
      canvas.width,
      canvas.height,
      numColors,
    );

    const compressed = new Blob([encoded], { type: 'image/png' });

    // 只有压缩后更小才返回压缩版本
    if (compressed.size < file.size) return compressed;
    return file;
  }

  /** 有损格式压缩：JPG / WebP / AVIF */
  private async _compressLossy(
    img: HTMLImageElement,
    file: File,
    targetMime: string,
    quality: number,
  ): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;

    if (!supportsAlpha(targetMime)) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);

    const compressed = await this._canvasToBlob(canvas, targetMime, quality / 100);

    if (compressed.size < file.size) return compressed;
    return file;
  }

  static getOutputExtension(file: File, format: ImageOutputFormat): string {
    if (format === 'original') {
      return file.name.split('.').pop()?.toLowerCase() ?? 'png';
    }
    return format === 'jpg' ? 'jpg' : format;
  }

  static getOutputMime(file: File, format: ImageOutputFormat): string {
    if (format === 'original') return resolveOriginalMime(file);
    return MIME_MAP[format];
  }

  private _loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img  = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`图片加载失败: ${file.name}`)); };
      img.src = url;
    });
  }

  private _canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error(`Canvas 导出失败 (${mime})`));
        },
        mime,
        quality,
      );
    });
  }
}
