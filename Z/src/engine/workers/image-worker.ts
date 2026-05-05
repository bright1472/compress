/**
 * src/engine/workers/image-worker.ts
 * 图片压缩 Worker — 所有 WASM 编码和重量级 CPU 运算在此线程执行，不阻塞主线程 UI
 *
 * 与 image-engine.ts 的差异（Worker 兼容替换）：
 *   document.createElement('canvas') → new OffscreenCanvas(w, h)
 *   new Image() + onload             → createImageBitmap(blob)
 *   canvas.toBlob()                  → offscreenCanvas.convertToBlob()
 *
 * 消息协议（主线程 → Worker）：
 *   { type: 'WARMUP' }
 *   { type: 'COMPRESS', id, buffer: ArrayBuffer, fileName, mimeType, options, preservedExif? }
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'READY' }
 *   { type: 'DONE',  id, buffer: ArrayBuffer, outputMime: string }
 *   { type: 'ERROR', id, message: string }
 */

import UPNG from 'upng-js';
import mozjpegWasmUrl from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url';
import webpWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url';
import webpSimdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url';
import oxipngWasmUrlSt from '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm?url';
import oxipngWasmUrlMt from '@jsquash/oxipng/codec/pkg-parallel/squoosh_oxipng_bg.wasm?url';
import imagequantInit from '@panda-ai/imagequant';
import { quantize_image } from '@panda-ai/imagequant';
import imagequantWasmUrl from '@panda-ai/imagequant/imagequant_bg.wasm?url';
import { injectExifToJpeg } from '../exif-preserve';
import type { PreservedExif } from '../exif-preserve';

export type ImageOutputFormat = 'original' | 'png' | 'jpg' | 'webp' | 'avif';
export interface ImageCompressionOptions {
  outputFormat: ImageOutputFormat;
  quality: number;
}


// ── 类型 ──────────────────────────────────────────────────────────────

type WasmEncodeOptions = Record<string, number | boolean>;
type WasmEncode = (data: ImageData, options?: WasmEncodeOptions) => Promise<ArrayBuffer>;
type OxipngOptimise = (data: ArrayBuffer) => Promise<ArrayBuffer>;

// ── MIME 映射 ─────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', avif: 'image/avif', gif: 'image/gif',
  bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff', tif: 'image/tiff',
  heic: 'image/jpeg', heif: 'image/jpeg',
};

const OUTPUT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif',
};

function resolveInputMime(fileName: string, mimeType: string): string {
  if (mimeType) return mimeType;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] ?? 'image/png';
}

const supportsAlpha = (mime: string) => mime !== 'image/jpeg';

// ── PNG-8 二进制编码（CRC / zlib / chunk — 与主线程版本相同）────────────

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
  palette: Uint8Array,
  indices: Uint8Array,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const n = palette.length >> 2;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 3;
  const plte = new Uint8Array(n * 3);
  const trns = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    plte[i * 3]     = palette[i * 4];
    plte[i * 3 + 1] = palette[i * 4 + 1];
    plte[i * 3 + 2] = palette[i * 4 + 2];
    trns[i]         = palette[i * 4 + 3];
  }
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

// ── WASM 懒初始化 ──────────────────────────────────────────────────────

let _jpegEncodePromise: Promise<WasmEncode | null> | null = null;
let _webpEncodePromise: Promise<WasmEncode | null> | null = null;
let _oxipngPromise: Promise<OxipngOptimise | null> | null = null;
let _iqPromise: Promise<boolean> | null = null;

async function _initIq(): Promise<boolean> {
  try { await imagequantInit(imagequantWasmUrl); return true; }
  catch { return false; }
}
const getIq = (): Promise<boolean> => (_iqPromise ??= _initIq());

async function _initOxipng(): Promise<OxipngOptimise | null> {
  try {
    const { default: optimise, init } = await import('@jsquash/oxipng/optimise');
    const { threads } = await import('wasm-feature-detect');
    // @jsquash/oxipng init 在 Worker + 线程支持时走 MT 分支，需要匹配的 MT wasm；否则用 ST
    // typeof 守卫规避 TS 编译时找不到 WorkerGlobalScope 的问题
    const isWorker = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined'
      && self instanceof (globalThis as unknown as { WorkerGlobalScope: { new (): unknown } }).WorkerGlobalScope;
    const useMt = isWorker && (navigator?.hardwareConcurrency ?? 0) > 1 && (await threads());
    await init(useMt ? oxipngWasmUrlMt : oxipngWasmUrlSt);
    return (buf: ArrayBuffer) => optimise(buf, { level: 6, optimiseAlpha: true });
  } catch {
    return null;
  }
}
const getOxipng = (): Promise<OxipngOptimise | null> => (_oxipngPromise ??= _initOxipng());

async function _initJpegEncoder(): Promise<WasmEncode | null> {
  try {
    const { default: encode, init } = await import('@jsquash/jpeg/encode');
    await init({ locateFile: () => mozjpegWasmUrl });
    return encode as WasmEncode;
  } catch { return null; }
}

async function _initWebpEncoder(): Promise<WasmEncode | null> {
  try {
    const { default: encode, init } = await import('@jsquash/webp/encode');
    await init({ locateFile: (path: string) => path.includes('simd') ? webpSimdWasmUrl : webpWasmUrl });
    return encode as WasmEncode;
  } catch { return null; }
}

const getJpegEncoder = (): Promise<WasmEncode | null> => (_jpegEncodePromise ??= _initJpegEncoder());
const getWebpEncoder = (): Promise<WasmEncode | null> => (_webpEncodePromise ??= _initWebpEncoder());

function warmupAll(): void {
  void getJpegEncoder();
  void getWebpEncoder();
  void getOxipng();
  void getIq();
}

// ── 调色板辅助函数 ─────────────────────────────────────────────────────

function _tryExactPalette(
  data: Uint8ClampedArray,
  totalPx: number,
  maxColors: number,
): { palette: Uint8Array; indices: Uint8Array } | null {
  const map = new Map<number, number>();
  const indices = new Uint8Array(totalPx);
  for (let p = 0; p < totalPx; p++) {
    const i = p * 4;
    const key = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    let idx = map.get(key);
    if (idx === undefined) {
      if (map.size >= maxColors) return null;
      idx = map.size;
      map.set(key, idx);
    }
    indices[p] = idx;
  }
  const palette = new Uint8Array(map.size * 4);
  for (const [key, idx] of map) {
    const k = key >>> 0;
    palette[idx * 4]     = (k >>> 24) & 0xff;
    palette[idx * 4 + 1] = (k >>> 16) & 0xff;
    palette[idx * 4 + 2] = (k >>>  8) & 0xff;
    palette[idx * 4 + 3] =  k         & 0xff;
  }
  return { palette, indices };
}

function _kmeansRefine(
  data: Uint8ClampedArray,
  palette: Uint8Array,
  n: number,
  totalPx: number,
  iterations: number,
): void {
  const SAMPLE_TARGET = 65_536;
  const step = Math.max(1, Math.floor(totalPx / SAMPLE_TARGET)) * 4;
  const sumR = new Float64Array(n), sumG = new Float64Array(n);
  const sumB = new Float64Array(n), sumA = new Float64Array(n);
  const counts = new Uint32Array(n);
  const byteLen = data.length;

  for (let iter = 0; iter < iterations; iter++) {
    sumR.fill(0); sumG.fill(0); sumB.fill(0); sumA.fill(0); counts.fill(0);
    for (let i = 0; i < byteLen; i += step) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      let best = 0, bestD = Infinity;
      for (let j = 0; j < n; j++) {
        const j4 = j * 4;
        const dr = r - palette[j4], dg = g - palette[j4 + 1];
        const db = b - palette[j4 + 2], da = a - palette[j4 + 3];
        const d = dr * dr + dg * dg + db * db + da * da;
        if (d < bestD) { bestD = d; best = j; }
      }
      sumR[best] += r; sumG[best] += g; sumB[best] += b; sumA[best] += a;
      counts[best]++;
    }
    let moved = 0;
    for (let j = 0; j < n; j++) {
      const c = counts[j];
      if (c === 0) continue;
      const j4 = j * 4;
      const nr = Math.round(sumR[j] / c), ng = Math.round(sumG[j] / c);
      const nb = Math.round(sumB[j] / c), na = Math.round(sumA[j] / c);
      moved += Math.abs(nr - palette[j4]) + Math.abs(ng - palette[j4 + 1])
             + Math.abs(nb - palette[j4 + 2]) + Math.abs(na - palette[j4 + 3]);
      palette[j4] = nr; palette[j4 + 1] = ng; palette[j4 + 2] = nb; palette[j4 + 3] = na;
    }
    if (moved < n) break;
  }
}

// ── 智能模式辅助：色相空间分析 ─────────────────────────────────────
function _rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rN) h = ((gN - bN) / d) % 6;
    else if (max === gN) h = (bN - rN) / d + 2;
    else h = (rN - gN) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/**
 * 检测 imagequant 给的 palette 对原图饱和色域的覆盖度。
 * 把 H 0-360° 切成 12 个 bin（每 30°），找出"原图大量出现的高饱和色相 bin"（重要 bin），
 * 检查该 bin 在 palette 中是否有对应的高饱和代表色。
 *
 * 任意一个重要 bin 在 palette 中无高饱和覆盖 → 量化会把该色相像素映射到错色相（饱和色变灰），返回 false。
 *
 * 用于在 imagequant 量化后判断结果是否会色彩失真。失真则上层应回退 True Color。
 */
function _paletteCoverageOk(
  data: Uint8ClampedArray,
  palette: Uint8Array,
  width: number,
  height: number,
): boolean {
  const BIN_COUNT = 12;
  const SAT_THRESHOLD = 0.40;        // 高饱和门槛
  const IMPORTANT_PX_RATIO = 0.005;  // 重要 bin：占总像素 0.5% 以上

  const totalPx = width * height;
  const importantThreshold = totalPx * IMPORTANT_PX_RATIO;

  // 原图：每个色相 bin 的高饱和像素数
  const pixelBins = new Uint32Array(BIN_COUNT);
  for (let i = 0; i < totalPx; i++) {
    const { h, s } = _rgbToHsv(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    if (s >= SAT_THRESHOLD) pixelBins[Math.min(BIN_COUNT - 1, Math.floor(h / 30))]++;
  }

  // palette：每个色相 bin 的高饱和色数
  const paletteBins = new Uint32Array(BIN_COUNT);
  const paletteN = palette.length / 4;
  for (let i = 0; i < paletteN; i++) {
    const { h, s } = _rgbToHsv(palette[i * 4], palette[i * 4 + 1], palette[i * 4 + 2]);
    if (s >= SAT_THRESHOLD) paletteBins[Math.min(BIN_COUNT - 1, Math.floor(h / 30))]++;
  }

  // 任意重要 bin 在 palette 中无高饱和色覆盖 → 失真风险高
  for (let i = 0; i < BIN_COUNT; i++) {
    if (pixelBins[i] > importantThreshold && paletteBins[i] === 0) return false;
  }
  return true;
}

type IqEncodeResult =
  | { kind: 'ok'; encoded: ArrayBuffer }
  | { kind: 'lowCoverage' }       // imagequant 量化色域覆盖差，应回退 True Color
  | { kind: 'panic' };             // imagequant wasm 内部 trap，应回退 _ditheredEncode

async function _iqEncode(
  imageData: ImageData,
  width: number,
  height: number,
  numColors: number,
): Promise<IqEncodeResult> {
  let result: { palette: Uint8Array; indices: Uint8Array };
  try {
    const pixels = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
    result = quantize_image(pixels, width, height, numColors) as unknown as typeof result;
  } catch {
    return { kind: 'panic' };
  }
  const pal = result.palette.slice();
  // 智能色域覆盖度检测，避免饱和少数色被量化成灰白
  if (!_paletteCoverageOk(imageData.data, pal, width, height)) {
    return { kind: 'lowCoverage' };
  }
  // 用原图 + imagequant 的 palette 做 Floyd-Steinberg dithering（替代 imagequant 的硬映射 indices）
  const idx = _floydSteinbergRemap(imageData.data, pal, width, height);
  const encoded = await _encodePng8(pal, idx, width, height);
  return { kind: 'ok', encoded };
}

// 用给定 palette 对图像做 Floyd-Steinberg dithering，返回 indices
function _floydSteinbergRemap(
  data: Uint8ClampedArray,
  palette: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const n = palette.length / 4;
  const totalPx = width * height;

  // 最近色 LUT，加速查找
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

  const indices = new Uint8Array(totalPx);
  const currErr = new Float32Array((width + 2) * 3);
  const nextErr = new Float32Array((width + 2) * 3);

  for (let y = 0; y < height; y++) {
    nextErr.fill(0);
    const rev = (y & 1) === 1; // 蛇形扫描，减少方向性伪影
    const xStart = rev ? width - 1 : 0;
    const xEnd   = rev ? -1 : width;
    const xStep  = rev ? -1 : 1;
    const fwd = rev ? -3 : 3;
    const bwd = rev ?  3 : -3;

    for (let x = xStart; x !== xEnd; x += xStep) {
      const pi = (y * width + x) * 4;
      const ei = (x + 1) * 3;
      let r = data[pi]     + currErr[ei];
      let g = data[pi + 1] + currErr[ei + 1];
      let b = data[pi + 2] + currErr[ei + 2];
      r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
      b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      const idx = lut[(r >> 2) * 4096 + (g >> 2) * 64 + (b >> 2)];
      indices[y * width + x] = idx;
      const er = r - palette[idx * 4];
      const eg = g - palette[idx * 4 + 1];
      const eb = b - palette[idx * 4 + 2];
      const ne = ei + fwd;
      currErr[ne]     += er * 0.4375; currErr[ne + 1] += eg * 0.4375; currErr[ne + 2] += eb * 0.4375;
      const bl = ei + bwd;
      nextErr[bl]     += er * 0.1875; nextErr[bl + 1] += eg * 0.1875; nextErr[bl + 2] += eb * 0.1875;
      nextErr[ei]     += er * 0.3125; nextErr[ei + 1] += eg * 0.3125; nextErr[ei + 2] += eb * 0.3125;
      nextErr[ne]     += er * 0.0625; nextErr[ne + 1] += eg * 0.0625; nextErr[ne + 2] += eb * 0.0625;
    }
    currErr.set(nextErr);
  }

  return indices;
}

async function _ditheredEncode(
  imageData: ImageData,
  width: number,
  height: number,
  numColors: number,
): Promise<ArrayBuffer> {
  const data = imageData.data;
  const totalPx = width * height;

  const exact = _tryExactPalette(data, totalPx, 256);
  if (exact) return _encodePng8(exact.palette, exact.indices, width, height);

  type UPNGPlte = { est: { rgba: number } }[];
  const qRes = (UPNG as unknown as { quantize: (b: ArrayBuffer[], n: number) => { plte: UPNGPlte } })
    .quantize([imageData.data.buffer], numColors);
  const n = qRes.plte.length;
  const palette = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const rgba = qRes.plte[i].est.rgba >>> 0;
    palette[i * 4]     = rgba         & 0xff;
    palette[i * 4 + 1] = (rgba >>>  8) & 0xff;
    palette[i * 4 + 2] = (rgba >>> 16) & 0xff;
    palette[i * 4 + 3] = (rgba >>> 24) & 0xff;
  }

  _kmeansRefine(data, palette, n, totalPx, 6);

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

  const indices = new Uint8Array(totalPx);
  const currErr = new Float32Array((width + 2) * 3);
  const nextErr = new Float32Array((width + 2) * 3);

  for (let y = 0; y < height; y++) {
    nextErr.fill(0);
    const rev = (y & 1) === 1;
    const xStart = rev ? width - 1 : 0;
    const xEnd   = rev ? -1 : width;
    const xStep  = rev ? -1 : 1;
    const fwd = rev ? -3 : 3;
    const bwd = rev ?  3 : -3;

    for (let x = xStart; x !== xEnd; x += xStep) {
      const pi = (y * width + x) * 4;
      const ei = (x + 1) * 3;
      let r = data[pi]     + currErr[ei];
      let g = data[pi + 1] + currErr[ei + 1];
      let b = data[pi + 2] + currErr[ei + 2];
      r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
      b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      const idx = lut[(r >> 2) * 4096 + (g >> 2) * 64 + (b >> 2)];
      indices[y * width + x] = idx;
      const er = r - palette[idx * 4];
      const eg = g - palette[idx * 4 + 1];
      const eb = b - palette[idx * 4 + 2];
      const ne = ei + fwd;
      currErr[ne]     += er * 0.4375; currErr[ne + 1] += eg * 0.4375; currErr[ne + 2] += eb * 0.4375;
      const bl = ei + bwd;
      nextErr[bl]     += er * 0.1875; nextErr[bl + 1] += eg * 0.1875; nextErr[bl + 2] += eb * 0.1875;
      nextErr[ei]     += er * 0.3125; nextErr[ei + 1] += eg * 0.3125; nextErr[ei + 2] += eb * 0.3125;
      nextErr[ne]     += er * 0.0625; nextErr[ne + 1] += eg * 0.0625; nextErr[ne + 2] += eb * 0.0625;
    }
    currErr.set(nextErr);
  }

  return _encodePng8(palette, indices, width, height);
}

// ── 核心压缩函数 ───────────────────────────────────────────────────────

async function compressPng(bitmap: ImageBitmap, fileSize: number, quality: number): Promise<ArrayBuffer | null> {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);

  // 智能模式：根据图像内容自动选择压缩路径，平衡 高清 / 压缩率 / 稳定性
  // - quality=100        → True Color 无损（最高保真）
  // - 颜色 ≤256          → PNG-8 无损量化（图标/低色数图，文件最小）
  // - imagequant 覆盖好  → imagequant + Floyd-Steinberg dithering（高压缩 + 色彩 OK）
  // - imagequant 覆盖差  → True Color（避免饱和色变灰，色彩优先）
  // - imagequant panic   → UPNG.quantize + dithering（保压缩率，避免 True Color 兜底过大）
  let encoded: ArrayBuffer;
  if (quality >= 100) {
    encoded = UPNG.encode([imageData.data.buffer], width, height, 0);
  } else {
    const totalPx = width * height;
    const exact = _tryExactPalette(imageData.data, totalPx, 256);
    if (exact) {
      encoded = await _encodePng8(exact.palette, exact.indices, width, height);
    } else {
      const t = quality / 100;
      const numColors = Math.max(32, Math.min(256, Math.round(256 * Math.pow(t, 0.8))));
      const iq = await getIq();
      const iqResult = iq ? await _iqEncode(imageData, width, height, numColors) : { kind: 'lowCoverage' as const };
      if (iqResult.kind === 'ok') {
        encoded = iqResult.encoded;
      } else if (iqResult.kind === 'panic') {
        // imagequant wasm 内部 trap，回退 UPNG 量化保压缩率
        try {
          encoded = await _ditheredEncode(imageData, width, height, numColors);
        } catch {
          encoded = UPNG.encode([imageData.data.buffer], width, height, 0);
        }
      } else {
        // 色域覆盖差或 imagequant 不可用，True Color 保色彩
        encoded = UPNG.encode([imageData.data.buffer], width, height, 0);
      }
    }
  }

  const oxipng = await getOxipng();
  let best: ArrayBuffer = encoded;
  if (oxipng) {
    try {
      const timeout = new Promise<null>(r => setTimeout(() => r(null), 6000));
      const result = await Promise.race([oxipng(encoded), timeout]);
      if (result && result.byteLength < encoded.byteLength) best = result;
    } catch { /* ignore */ }
  }

  if (best.byteLength < fileSize) return best;
  return null; // 表示原文件更小
}

async function compressLossy(
  bitmap: ImageBitmap,
  fileSize: number,
  targetMime: string,
  quality: number,
  preserved: PreservedExif | null,
): Promise<ArrayBuffer | null> {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  if (!supportsAlpha(targetMime)) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0);

  if (targetMime === 'image/jpeg') {
    const encode = await getJpegEncoder();
    if (encode) {
      const imageData = ctx.getImageData(0, 0, width, height);
      const mozQ = quality >= 100 ? 95 : Math.max(20, Math.round(quality * 0.8));
      const buffer = await encode(imageData, {
        quality: mozQ, trellis_multipass: true, trellis_opt_zero: true, trellis_opt_table: true,
      });
      const finalBuffer = preserved ? injectExifToJpeg(buffer, preserved) : buffer;
      if (finalBuffer.byteLength < fileSize) return finalBuffer;
      return null;
    }
  }

  if (targetMime === 'image/webp') {
    const encode = await getWebpEncoder();
    if (encode) {
      const imageData = ctx.getImageData(0, 0, width, height);
      const opts: WasmEncodeOptions = quality >= 100
        ? { quality: 100, lossless: 1, exact: 1, method: 6 }
        : { quality };
      const buffer = await encode(imageData, opts);
      if (buffer.byteLength < fileSize) return buffer;
      return null;
    }
  }

  // AVIF / WASM 回退：OffscreenCanvas.convertToBlob
  const blob = await canvas.convertToBlob({ type: targetMime, quality: quality / 100 });
  if (targetMime === 'image/jpeg' && preserved) {
    const buf = await blob.arrayBuffer();
    const injected = injectExifToJpeg(buf, preserved);
    const finalBlob = new Blob([injected], { type: 'image/jpeg' });
    if (finalBlob.size < fileSize) return injected;
    return null;
  }
  if (blob.size < fileSize) return blob.arrayBuffer();
  return null;
}

// ── 消息处理器 ────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const { type, id } = e.data;

  if (type === 'WARMUP') {
    warmupAll();
    self.postMessage({ type: 'READY' });
    return;
  }

  if (type === 'COMPRESS') {
    const { buffer, fileName, mimeType, options, preservedExif, fileSize } = e.data as {
      buffer: ArrayBuffer;
      fileName: string;
      mimeType: string;
      options: ImageCompressionOptions;
      preservedExif: PreservedExif | null;
      fileSize: number;
    };

    try {
      const inputMime = mimeType || resolveInputMime(fileName, mimeType);
      const blob = new Blob([buffer], { type: inputMime });
      const bitmap = await createImageBitmap(blob);

      let targetMime: string;
      if (options.outputFormat === 'original') {
        targetMime = inputMime;
      } else {
        targetMime = OUTPUT_MIME[options.outputFormat] ?? inputMime;
      }

      let result: ArrayBuffer | null;
      try {
        if (targetMime === 'image/png') {
          result = await compressPng(bitmap, fileSize, options.quality);
        } else {
          result = await compressLossy(bitmap, fileSize, targetMime, options.quality, preservedExif);
        }
      } finally {
        bitmap.close();
      }

      if (result) {
        self.postMessage({ type: 'DONE', id, buffer: result, outputMime: targetMime }, [result]);
      } else {
        // 压缩后体积更大，返回原始 buffer（调用方用原文件）
        self.postMessage({ type: 'ORIGINAL', id });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({ type: 'ERROR', id, message });
    }
  }
};
