// @ts-ignore - Vite worker inline import
import MediaWorker from './workers/media-worker?worker&inline';
import { storage } from './storage-service';

export class MediaEngine {
  private worker: Worker | null = null;
  private workerReady = false;
  private abortController: AbortController | null = null;
  private warmupPromise: Promise<void> | null = null;
  private currentReject: ((err: Error) => void) | null = null;

  /**
   * 预热 Worker：预创建并等待握手完成，减少首次压缩启动延迟。
   * 可安全重复调用，已预热后返回即就绪状态。
   */
  async warmup(): Promise<void> {
    if (this.workerReady) return;
    if (this.warmupPromise) return this.warmupPromise;

    this.warmupPromise = (async () => {
      await storage.init();
      this.worker = new MediaWorker();
      this.abortController = new AbortController();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Worker 预热超时'));
          this.worker?.terminate();
          this.worker = null;
        }, 5000);

        const handler = (e: MessageEvent) => {
          if (e.data?.type === 'PONG') {
            clearTimeout(timeout);
            this.worker!.onmessage = null;
            this.worker!.onerror = null;
            this.workerReady = true;
            this.warmupPromise = null;
            resolve();
          }
        };
        this.worker!.onmessage = handler;
        this.worker!.onerror = (err: any) => {
          clearTimeout(timeout);
          const realError = err?.message || 'Worker 崩溃';
          reject(new Error(`Worker Crash: ${realError}`));
        };
        this.worker!.postMessage({ type: 'PING' });
      });
    })();

    return this.warmupPromise;
  }

  /**
   * 处理大规模视频文件（WebCodecs 管线）
   * 复用已预热的 Worker，避免重复创建和握手开销。
   */
  async processLargeVideo(
    file: File,
    config: { codec: string; bitrate?: number; crf?: number; preset?: string },
    onProgress: (data: { loaded: number; total: number; progress: number }) => void
  ): Promise<File> {
    console.group('📁 [Processor] Init');
    try {
      await storage.init();
      const outputHandle = await storage.createDiskStream(`titan_opt_${Date.now()}.mp4`);
      console.log('✅ OPFS Ready');
      console.groupEnd();

      await this.warmup();

      if (!this.worker) {
        throw new Error('Worker 未就绪');
      }

      return new Promise((resolve, reject) => {
        this.currentReject = reject;
        // 根据文件大小动态计算超时：按最低 0.5 MB/s 估算 + 5 分钟缓冲
        const estimatedMin = Math.max(file.size / (0.5 * 1024 * 1024) * 60 * 1000, 10 * 60 * 1000);
        const timeoutMs = Math.min(estimatedMin + 5 * 60 * 1000, 60 * 60 * 1000); // 最大 60 分钟
        console.log(`⏱️ [Processor] Timeout set to ${Math.round(timeoutMs / 1000)}s (file: ${(file.size / 1048576).toFixed(0)}MB)`);
        const timeout = setTimeout(() => {
          this.currentReject?.(new Error('Worker 处理超时'));
          this.stop();
        }, timeoutMs);

        const handler = (e: MessageEvent) => {
          const { type, data } = e.data;

          switch (type) {
            case 'PROGRESS':
              onProgress(data);
              break;
            case 'DONE':
              clearTimeout(timeout);
              this.currentReject = null;
              this.workerReady = true;
              console.log('🎉 [Processor] Complete');
              (outputHandle as any).getFile()
                .then((f: File) => resolve(f))
                .catch((err: Error) => reject(new Error(`OPFS 文件读取失败: ${err}`)));
              break;
            case 'ERROR':
              clearTimeout(timeout);
              this.currentReject = null;
              console.error('🔥 [Processor] Worker Error:', data);
              reject(new Error(data));
              break;
          }
        };

        this.worker!.onmessage = handler;
        this.worker!.onerror = (err: any) => {
          clearTimeout(timeout);
          this.currentReject = null;
          const realError = err?.message || 'Worker 崩溃';
          console.error('🚨 [Processor] Worker Crash:', realError, err);
          reject(new Error(`Worker Crash: ${realError}`));
        };

        this.worker!.postMessage({
          type: 'START_PROCESS',
          data: { file, config, outputHandle }
        });
      });

    } catch (err: any) {
      console.error('🚫 [Processor] Pre-flight Failure:', err);
      console.groupEnd();
      throw err;
    }
  }

  stop() {
    if (this.currentReject) {
      this.currentReject(new Error('AbortError: 压缩任务已取消'));
      this.currentReject = null;
    }
    if (!this.worker) return;
    try { this.worker.postMessage({ type: 'STOP' }); } catch {}
    const w = this.worker;
    setTimeout(() => { try { w.terminate(); } catch {} }, 200);
    this.worker = null;
    this.workerReady = false;
    this.warmupPromise = null;
    this.abortController = null;
  }
}
