/**
 * src/engine/image-engine.ts
 * 图片压缩引擎（主线程代理层）
 *
 * 重量级 CPU/WASM 运算全部在 image-worker.ts 内执行，不阻塞主线程 UI。
 * 主线程仅负责：读 EXIF、传 ArrayBuffer 给 Worker、收结果。
 */

import { readPreservedExif } from './exif-preserve';
import type { PreservedExif } from './exif-preserve';

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

export const resolveOriginalMime = (file: File): string => {
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

// ── Worker 管理 ────────────────────────────────────────────────────────

type PendingEntry = {
  resolve: (buf: ArrayBuffer | null, mime: string) => void;
  reject: (e: Error) => void;
};

export class ImageEngine {
  private _worker: Worker | null = null;
  private _pending = new Map<number, PendingEntry>();
  private _nextId = 1;

  private _getWorker(): Worker {
    if (this._worker) return this._worker;
    const w = new Worker(
      new URL('./workers/image-worker.ts', import.meta.url),
      { type: 'module' },
    );
    w.onmessage = (e: MessageEvent) => {
      const { type, id, buffer, outputMime, message } = e.data;
      if (type === 'READY') return;
      const pending = this._pending.get(id);
      if (!pending) return;
      this._pending.delete(id);
      if (type === 'DONE') {
        pending.resolve(buffer as ArrayBuffer, outputMime as string);
      } else if (type === 'ORIGINAL') {
        pending.resolve(null, '');
      } else {
        pending.reject(new Error(message ?? '图片压缩 Worker 错误'));
      }
    };
    w.onerror = (e) => {
      for (const p of this._pending.values()) p.reject(new Error(e.message));
      this._pending.clear();
      this._worker = null; // allow recovery: next compress() will spawn a fresh worker
    };
    this._worker = w;
    return w;
  }

  async compress(file: File, options: ImageCompressionOptions): Promise<Blob> {
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

    // EXIF 读取在主线程完成（需要 File 对象），结果序列化传入 Worker
    const preserved: PreservedExif | null =
      targetMime === 'image/jpeg' ? await readPreservedExif(file) : null;

    const buffer = await file.arrayBuffer();
    const id = this._nextId++;

    return new Promise<Blob>((resolve, reject) => {
      this._pending.set(id, {
        resolve: (buf, mime) => {
          if (buf === null) { resolve(file); return; }
          resolve(new Blob([buf], { type: mime || targetMime }));
        },
        reject,
      });
      this._getWorker().postMessage(
        { type: 'COMPRESS', id, buffer, fileName: file.name, mimeType: file.type,
          options, preservedExif: preserved, fileSize: file.size },
        [buffer],
      );
    });
  }

  warmupEncoders(): void {
    this._getWorker().postMessage({ type: 'WARMUP' });
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
}

// 向后兼容 — EngineRouter 在构造时调用此函数预热
export function warmupEncoders(): void {
  // Worker 在首次 compress() 时懒创建，此处为 no-op
  // 如需提前预热，调用 new ImageEngine().warmupEncoders()
}
