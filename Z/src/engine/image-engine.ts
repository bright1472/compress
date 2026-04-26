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
import imagequantInit from '@panda-ai/imagequant';
import { quantize_image } from '@panda-ai/imagequant';
import imagequantWasmUrl from '@panda-ai/imagequant/imagequant_bg.wasm?url';

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

// ── PNG-8 编码器（palette 模式，1 byte/pixel）────────────────────────
// TinyPNG 的路径：libimagequant 量化 → palette + indices → PNG-8
// 相比 PNG-32 展开方案，体积缩小约 75%

const _crcTbl = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function _crc32(type: Uint8Array, data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of type) c = (_crcTbl[(c ^ b) & 0xff]!) ^ (c >>> 8);
  for (const b of data) c = (_crcTbl[(c ^ b) & 0xff]!) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const _enc = new TextEncoder();
function _chunk(tag: string, data: Uint8Array): Uint8Array {
  const t = _enc.encode(tag);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, _crc32(t, data));
  return out;
}

async function _zlibCompress(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  const r = cs.readable.getReader();
  w.write(raw as unknown as Uint8Array<ArrayBuffer>);
  w.close();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
  }
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function _encodePng8(
  palette: Uint8Array, // RGBA × numColors（已脱离 WASM 内存）
  indices: Uint8Array, // 1 byte/pixel
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const n = palette.length >> 2;

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 3; // 8-bit indexed color

  const plte = new Uint8Array(n * 3);
  const trns = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    plte[i * 3]     = palette[i * 4];
    plte[i * 3 + 1] = palette[i * 4 + 1];
    plte[i * 3 + 2] = palette[i * 4 + 2];
    trns[i]         = palette[i * 4 + 3];
  }

  // 每行：[filter_byte=0][index×width]
  const rows = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0;
    rows.set(indices.subarray(y * width, y * width + width), y * (width + 1) + 1);
  }

  const idat = await _zlibCompress(rows);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, _chunk('IHDR', ihdr), _chunk('PLTE', plte), _chunk('tRNS', trns), _chunk('IDAT', idat), _chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

// ── WASM 编码器懒初始化 ────────────────────────────────────────────

// options 对齐 @jsquash 实际签名（均为 Partial<EncodeOptions>，quality 可选）
type WasmEncode = (data: ImageData, options?: { quality?: number }) => Promise<ArrayBuffer>;

let _jpegEncodePromise: Promise<WasmEncode | null> | null = null;
let _webpEncodePromise: Promise<WasmEncode | null> | null = null;

type OxipngOptimise = (data: ArrayBuffer) => Promise<ArrayBuffer>;
let _oxipngPromise: Promise<OxipngOptimise | null> | null = null;

// libimagequant WASM — 与 TinyPNG 同等感知量化算法（Floyd-Steinberg 抖动）
// 运行时返回 { palette: Uint8Array, indices: Uint8Array }，.d.ts 的 QuantResult 不对应实际行为
let _iqPromise: Promise<boolean> | null = null;

async function _initIq(): Promise<boolean> {
  try {
    await imagequantInit(imagequantWasmUrl);
    return true;
  } catch {
    return false;
  }
}

const getIq = (): Promise<boolean> =>
  (_iqPromise ??= _initIq());

async function _initOxipng(): Promise<OxipngOptimise | null> {
  try {
    const { default: optimise, init } = await import('@jsquash/oxipng/optimise');
    await init(oxipngWasmUrl);
    // level 6 启用 zopfli — 与 TinyPNG 同等的 DEFLATE 优化路径，体积比 level 2 小 10-25%
    // PNG-8（量化后）通常 < 1MB，level 6 在 1-3 秒内完成；超时由调用方控制
    return (buf: ArrayBuffer) =>
      optimise(buf, { level: 6, optimiseAlpha: true });
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
  void getIq();
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
    let encoded: ArrayBuffer;

    if (quality >= 100) {
      // 真正无损：纯 DEFLATE 优化
      encoded = UPNG.encode([imageData.data.buffer], canvas.width, canvas.height, 0);
    } else {
      // 激进量化曲线：q=99→256, q=80→128, q=60→64, q=40→32（与 TinyPNG 自适应输出对齐）
      // 真彩色照片 128 色 + Floyd-Steinberg 抖动已视觉无损，体积接近 TinyPNG
      const t = quality / 100;
      const numColors = Math.max(8, Math.min(256, Math.round(8 * Math.pow(2, t * 5))));
      const iq = await getIq();

      const iqEncoded = iq ? await this._iqEncode(imageData, canvas.width, canvas.height, numColors) : null;
      encoded = iqEncoded ?? await this._ditheredEncode(imageData, canvas.width, canvas.height, numColors);
    }

    // oxipng (zopfli + palette/bit-depth reduction) — 关键体积优化，与 TinyPNG 同档
    // 量化后 PNG-8 通常 < 1MB，6 秒超时容忍 zopfli 多轮迭代
    const oxipng = await getOxipng();
    let best: ArrayBuffer = encoded;
    if (oxipng) {
      try {
        const timeout = new Promise<null>(r => setTimeout(() => r(null), 6000));
        const result = await Promise.race([oxipng(encoded), timeout]);
        if (result && result.byteLength < encoded.byteLength) best = result;
      } catch { /* ignore, fall through */ }
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

  private async _ditheredEncode(
    imageData: ImageData,
    width: number,
    height: number,
    numColors: number,
  ): Promise<ArrayBuffer> {
    // Step 1: UPNG Wu 协方差量化 → 调色板
    // 关键：UPNG 的 est.q 是 alpha-premultiplied 后归一化到 [0,1] 的浮点向量；
    // 真实 RGBA8888 在 est.rgba（packed ABGR，已做 alpha de-premultiply）。
    // 之前误用 est.q 导致整张调色板被四舍五入成 0/1，色带由此而来。
    type UPNGPlte = { est: { rgba: number } }[];
    const qRes = (UPNG as unknown as { quantize: (b: ArrayBuffer[], n: number) => { plte: UPNGPlte } })
      .quantize([imageData.data.buffer], numColors);
    const n = qRes.plte.length;
    const palette = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const rgba = qRes.plte[i].est.rgba >>> 0;
      palette[i * 4]     = rgba         & 0xff; // R
      palette[i * 4 + 1] = (rgba >>>  8) & 0xff; // G
      palette[i * 4 + 2] = (rgba >>> 16) & 0xff; // B
      palette[i * 4 + 3] = (rgba >>> 24) & 0xff; // A
    }

    // Step 2: 64³ 快速 LUT — RGB(6-bit/ch) → 最近调色板索引
    // 构建时间 O(64³×n)，查找时间 O(1)，整体比逐像素暴力搜索快 ~256 倍
    const lut = new Uint8Array(64 * 64 * 64);
    for (let ri = 0; ri < 64; ri++) {
      for (let gi = 0; gi < 64; gi++) {
        for (let bi = 0; bi < 64; bi++) {
          const r = ri * 4 + 2, g = gi * 4 + 2, b = bi * 4 + 2;
          let best = 0, bestD = Infinity;
          for (let j = 0; j < n; j++) {
            const dr = r - palette[j * 4], dg = g - palette[j * 4 + 1], db = b - palette[j * 4 + 2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bestD) { bestD = d; best = j; }
          }
          lut[ri * 4096 + gi * 64 + bi] = best;
        }
      }
    }

    // Step 3: Floyd-Steinberg 抖动（双行误差缓冲，内存 O(width)）
    const data = imageData.data;
    const indices = new Uint8Array(width * height);
    // x 使用 +1 偏移，避免 x=0 时左邻越界
    const currErr = new Float32Array((width + 2) * 3);
    const nextErr = new Float32Array((width + 2) * 3);

    for (let y = 0; y < height; y++) {
      nextErr.fill(0);
      for (let x = 0; x < width; x++) {
        const pi = (y * width + x) * 4;
        const ei = (x + 1) * 3;

        const r = Math.max(0, Math.min(255, Math.round(data[pi]     + currErr[ei])));
        const g = Math.max(0, Math.min(255, Math.round(data[pi + 1] + currErr[ei + 1])));
        const b = Math.max(0, Math.min(255, Math.round(data[pi + 2] + currErr[ei + 2])));

        const idx = lut[(Math.min(63, r >> 2)) * 4096 + (Math.min(63, g >> 2)) * 64 + Math.min(63, b >> 2)];
        indices[y * width + x] = idx;

        const er = r - palette[idx * 4];
        const eg = g - palette[idx * 4 + 1];
        const eb = b - palette[idx * 4 + 2];

        // 误差扩散：右 7/16，左下 3/16，正下 5/16，右下 1/16
        const ne = ei + 3;
        currErr[ne]     += er * 0.4375;
        currErr[ne + 1] += eg * 0.4375;
        currErr[ne + 2] += eb * 0.4375;
        const bl = ei - 3;
        nextErr[bl]     += er * 0.1875;
        nextErr[bl + 1] += eg * 0.1875;
        nextErr[bl + 2] += eb * 0.1875;
        nextErr[ei]     += er * 0.3125;
        nextErr[ei + 1] += eg * 0.3125;
        nextErr[ei + 2] += eb * 0.3125;
        nextErr[ne]     += er * 0.0625;
        nextErr[ne + 1] += eg * 0.0625;
        nextErr[ne + 2] += eb * 0.0625;
      }
      currErr.set(nextErr);
    }

    return _encodePng8(palette, indices, width, height);
  }

  private async _iqEncode(
    imageData: ImageData,
    width: number,
    height: number,
    numColors: number,
  ): Promise<ArrayBuffer | null> {
    try {
      // byteOffset 保护：确保从正确偏移量读取 canvas 像素数据
      const pixels = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
      const result = quantize_image(pixels, width, height, numColors) as unknown as {
        palette: Uint8Array;
        indices: Uint8Array;
      };

      // .slice() 立即脱离 WASM 线性内存
      const pal = result.palette.slice();
      const idx = result.indices.slice();

      // PNG-8：真正的调色板模式，1 byte/pixel，比 PNG-32 展开小 75%
      return await _encodePng8(pal, idx, width, height);
    } catch {
      return null; // WASM panic 或 OOM → 调用方回退到 UPNG Octree 量化
    }
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
