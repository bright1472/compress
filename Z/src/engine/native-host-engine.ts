/**
 * src/engine/native-host-engine.ts
 * 网站 ↔ Chrome Extension ↔ Rust Native Host 桥接层
 *
 * 通信路径：
 *   网站 JS → chrome.runtime.sendMessage(extensionId, msg)
 *          → background.js (Native Messaging)
 *          → Rust 二进制（系统 FFmpeg，NVENC/QSV 硬件编码）
 *
 * 前置条件：
 *   1. 用户在 Chrome 安装了 Titan 扩展（native-bridge/）
 *   2. 扩展 ID 已通过 setExtensionId() 保存（或读自 localStorage）
 *   3. Rust native host 已安装（install-titan-host.ps1 已执行）
 */

const STORAGE_KEY = 'titan-extension-id';

export interface NativeCompressOptions {
  codec: string;   // 'libx264' | 'libx265' | 'av1'
  crf: number;
  preset: string;
}

export interface NativeProgress {
  file: string;
  percent: number;
  fps: number;
  eta: string;
}

export interface NativeResult {
  total: number;
  durationSec: number;
}

// chrome.runtime 类型声明（浏览器注入，不打包）
declare const chrome: {
  runtime: {
    sendMessage: (
      extensionId: string,
      message: unknown,
      callback?: (response: unknown) => void,
    ) => void;
    connect: (
      extensionId: string,
      connectInfo?: { name?: string },
    ) => {
      postMessage: (message: unknown) => void;
      onMessage: { addListener: (cb: (msg: unknown) => void) => void };
      onDisconnect: { addListener: (cb: () => void) => void };
      disconnect: () => void;
    };
    lastError?: { message: string };
  };
};

export class NativeHostEngine {
  private _extensionId: string | null;

  constructor() {
    this._extensionId = localStorage.getItem(STORAGE_KEY);
  }

  get extensionId(): string | null { return this._extensionId; }

  setExtensionId(id: string): void {
    this._extensionId = id.trim() || null;
    if (this._extensionId) localStorage.setItem(STORAGE_KEY, this._extensionId);
    else localStorage.removeItem(STORAGE_KEY);
  }

  /** 检查扩展是否安装且 Native Host 可连接。 */
  async isAvailable(): Promise<boolean> {
    const id = this._extensionId;
    if (!id || typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return false;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(id, { type: 'DETECT_NATIVE' }, (res: unknown) => {
          if (chrome.runtime.lastError) { resolve(false); return; }
          resolve((res as { available?: boolean })?.available === true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  /** 弹出系统原生文件选择器（由 Native Host 触发），返回选中的目录路径。 */
  async pickDir(): Promise<string | null> {
    const id = this._extensionId;
    if (!id) return null;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(id, { type: 'PICK_DIR' }, (res: unknown) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve((res as { path?: string })?.path ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /** 列出目录中的视频文件。 */
  async listFiles(dir: string): Promise<string[]> {
    const id = this._extensionId;
    if (!id) return [];
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(id, { type: 'LIST_FILES', dir }, (res: unknown) => {
          if (chrome.runtime.lastError) { resolve([]); return; }
          resolve((res as { files?: string[] })?.files ?? []);
        });
      } catch {
        resolve([]);
      }
    });
  }

  /** 压缩 inputDir 内的视频文件，输出到 outputDir。使用 Port 长连接以支持流式 progress 回调。 */
  async compress(
    inputDir: string,
    outputDir: string,
    options: NativeCompressOptions,
    onProgress?: (p: NativeProgress) => void,
  ): Promise<NativeResult> {
    const id = this._extensionId;
    if (!id) throw new Error('未配置 Extension ID');

    return new Promise((resolve, reject) => {
      try {
        const port = chrome.runtime.connect(id, { name: 'titan-compress' });
        let settled = false;

        port.onMessage.addListener((res: unknown) => {
          const r = res as { type?: string; total?: number; durationSec?: number;
                             percent?: number; fps?: number; eta?: string; file?: string;
                             message?: string };
          if (r.type === 'complete' && !settled) {
            settled = true;
            port.disconnect();
            resolve({ total: r.total ?? 0, durationSec: r.durationSec ?? 0 });
          } else if (r.type === 'progress') {
            onProgress?.({ file: r.file ?? '', percent: r.percent ?? 0, fps: r.fps ?? 0, eta: r.eta ?? '' });
          } else if (r.type === 'error' && !settled) {
            settled = true;
            port.disconnect();
            reject(new Error(r.message ?? '压缩失败'));
          }
        });

        port.onDisconnect.addListener(() => {
          if (!settled) {
            settled = true;
            reject(new Error(chrome.runtime.lastError?.message ?? '扩展连接断开'));
          }
        });

        port.postMessage({ type: 'COMPRESS_REQUEST', inputDir, outputDir, ...options });
      } catch (e) {
        reject(e);
      }
    });
  }

  /** 在文件管理器中打开输出目录。 */
  openOutputDir(path: string): void {
    const id = this._extensionId;
    if (!id) return;
    try {
      chrome.runtime.sendMessage(id, { type: 'OPEN_OUTPUT_DIR', path });
    } catch { /* fire-and-forget */ }
  }
}
