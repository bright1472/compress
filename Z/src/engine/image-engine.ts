/**
 * src/engine/image-engine.ts
 * 图片压缩引擎 — Canvas API + UPNG.js + jsquash WASM
 *
 * PNG  → UPNG.js 调色板量化（quality=100 时 numColors=0 真正无损）
 * JPG  → @jsquash/jpeg (mozjpeg WASM)，压缩率比 canvas.toBlob 高 20-30%
 * WebP → @jsquash/webp (libwebp WASM)，自动检测 SIMD 加速
 * AVIF → canvas.toBlob（avif WASM 体积过大，浏览器原生即可）
 * 压缩后若体积更小则返回压缩版，否则保留原文件
 */

import UPNG from 'upng-js';
import mozjpegWasmUrl from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url';
import webpWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url';
import webpSimdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url';
import oxipngWasmUrl from '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm?url';

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
    heic: 'image/jpeg', heif: 'image/jpeg',
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

// ── WASM 编码器懒初始化 ────────────────────────────────────────────

// options 对齐 @jsquash 实际签名（均为 Partial<EncodeOptions>，quality 可选）
type WasmEncode = (data: ImageData, options?: { quality?: number }) => Promise<ArrayBuffer>;

let _jpegEncodePromise: Promise<WasmEncode | null> | null = null;
let _webpEncodePromise: Promise<WasmEncode | null> | null = null;

type OxipngOptimise = (data: ArrayBuffer) => Promise<ArrayBuffer>;
let _oxipngPromise: Promise<OxipngOptimise | null> | null = null;

async function _initOxipng(): Promise<OxipngOptimise | null> {
  try {
    const { default: optimise, init } = await import('@jsquash/oxipng/optimise');
    await init(oxipngWasmUrl);
    // level 1 比 level 3 快 5-8×，压缩率差距仅 1-3%，大图优先选速度
    return (buf: ArrayBuffer) => {
      const level = buf.byteLength > 1_000_000 ? 1 : 2;
      return optimise(buf, { level, optimiseAlpha: true });
    };
  } catch {
    return null;
  }
}

const getOxipng = (): Promise<OxipngOptimise | null> =>
  (_oxipngPromise ??= _initOxipng());

async function _initJpegEncoder(): Promise<WasmEncode | null> {
  try {
    const { default: encode, init } = await import('@jsquash/jpeg/encode');
    await init({ locateFile: () => mozjpegWasmUrl });
    return encode as WasmEncode;
  } catch {
    return null;
  }
}

async function _initWebpEncoder(): Promise<WasmEncode | null> {
  try {
    const { default: encode, init } = await import('@jsquash/webp/encode');
    await init({
      locateFile: (path: string) => path.includes('simd') ? webpSimdWasmUrl : webpWasmUrl,
    });
    return encode as WasmEncode;
  } catch {
    return null;
  }
}

const getJpegEncoder = (): Promise<WasmEncode | null> =>
  (_jpegEncodePromise ??= _initJpegEncoder());

const getWebpEncoder = (): Promise<WasmEncode | null> =>
  (_webpEncodePromise ??= _initWebpEncoder());

export function warmupEncoders(): void {
  void getJpegEncoder();
  void getWebpEncoder();
  void getOxipng();
}

// ── 引擎主体 ──────────────────────────────────────────────────────

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

  private async _compressPng(img: HTMLImageElement, file: File, quality: number): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // quality=100 → numColors=0（真正无损，纯 DEFLATE 优化）
    // quality<100 → 调色板量化（quality=85 → ~217 色，4MB 真彩照片可压到 ~1MB）
    // 与 TinyPNG 同路径：即使高质量也做量化，差异肉眼不可见
    const numColors = quality >= 100 ? 0 : Math.max(4, Math.round((quality / 100) * 256));

    const encoded = UPNG.encode(
      [imageData.data.buffer],
      canvas.width,
      canvas.height,
      numColors,
    );

    // oxipng 二次优化：对量化后（已缩小）的结果做 DEFLATE 再压，以 encoded 大小为准
    const oxipng = encoded.byteLength < 2_000_000 ? await getOxipng() : null;
    let best: ArrayBuffer = encoded;
    if (oxipng) {
      try {
        const timeout = new Promise<null>(r => setTimeout(() => r(null), 2000));
        const result = await Promise.race([oxipng(encoded), timeout]);
        if (result && result.byteLength < encoded.byteLength) best = result;
      } catch { /* ignore, fall through to UPNG result */ }
    }

    const compressed = new Blob([best], { type: 'image/png' });
    if (compressed.size < file.size) return compressed;
    return file;
  }

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

    // JPG → mozjpeg WASM（比 canvas.toBlob 压缩率高 20-30%）
    if (targetMime === 'image/jpeg') {
      const encode = await getJpegEncoder();
      if (encode) {
        // Emscripten 会将像素数据复制进 WASM 线性内存，buffer 所有权仍在浏览器侧。
        // 若将来升级多线程 WASM（SharedArrayBuffer），需在此处先 .slice() 再传入。
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const buffer = await encode(imageData, { quality });
        const compressed = new Blob([buffer], { type: 'image/jpeg' });
        if (compressed.size < file.size) return compressed;
        return file;
      }
    }

    // WebP → libwebp WASM（SIMD 自动加速）
    if (targetMime === 'image/webp') {
      const encode = await getWebpEncoder();
      if (encode) {
        // 同上：多线程 WASM 升级时需先 .slice() 再传入
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const buffer = await encode(imageData, { quality });
        const compressed = new Blob([buffer], { type: 'image/webp' });
        if (compressed.size < file.size) return compressed;
        return file;
      }
    }

    // 回退：canvas.toBlob（AVIF 或 WASM 初始化失败时）
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
