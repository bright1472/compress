/**
 * src/engine/image-engine.ts
 * 图片压缩引擎 — 基于 Canvas API，零外部依赖
 *
 * 支持：
 *  - 原格式保留（智能透明度感知）
 *  - 转换输出：PNG / JPG / WebP / AVIF
 *  - 质量控制（0–100），PNG 使用无损压缩
 *  - AVIF 运行时能力探测（不支持时返回 null 供调用方处理）
 */

export type ImageOutputFormat = 'original' | 'png' | 'jpg' | 'webp' | 'avif';

export interface ImageCompressionOptions {
  outputFormat: ImageOutputFormat;
  quality: number; // 0–100，PNG 忽略此值
}

/** MIME type 映射 */
const MIME_MAP: Record<Exclude<ImageOutputFormat, 'original'>, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** 获取文件的真实 MIME（用于 original 模式） */
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

/** 检测浏览器是否支持指定输出格式 */
const _formatSupport: Partial<Record<string, boolean>> = {};
export const detectFormatSupport = (format: Exclude<ImageOutputFormat, 'original'>): boolean => {
  if (_formatSupport[format] !== undefined) return _formatSupport[format]!;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const dataUrl = canvas.toDataURL(MIME_MAP[format]);
    // 合法输出应以 data:<mime> 开头，否则说明不支持
    _formatSupport[format] = dataUrl.startsWith(`data:${MIME_MAP[format]}`);
  } catch {
    _formatSupport[format] = false;
  }
  return _formatSupport[format]!;
};

/** 判断格式是否需要保留透明通道（PNG/AVIF/WebP 支持，JPG 不支持） */
const supportsAlpha = (mime: string) => mime !== 'image/jpeg';

export class ImageEngine {
  /**
   * 压缩图片文件
   * @returns Blob — 压缩后的图片
   * @throws Error — AVIF/WebP 不受浏览器支持时抛出，供调用方决策降级
   */
  async compress(file: File, options: ImageCompressionOptions): Promise<Blob> {
    const img = await this._loadImage(file);
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;

    const ctx = canvas.getContext('2d')!;

    // 确定目标 mime
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

    // JPG 不支持透明，需要填充白色底色
    if (!supportsAlpha(targetMime)) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);

    // PNG 为无损格式，quality 参数对其无效
    const quality = targetMime === 'image/png' ? undefined : options.quality / 100;

    const compressed = await this._canvasToBlob(canvas, targetMime, quality);
    // If re-encoding made it larger, return the original (common with PNG)
    if (compressed.size >= file.size && options.outputFormat === 'original') {
      return file;
    }
    return compressed;
  }

  /** 获取输出文件的扩展名 */
  static getOutputExtension(file: File, format: ImageOutputFormat): string {
    if (format === 'original') {
      return file.name.split('.').pop()?.toLowerCase() ?? 'png';
    }
    return format === 'jpg' ? 'jpg' : format;
  }

  /** 获取输出 MIME */
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
