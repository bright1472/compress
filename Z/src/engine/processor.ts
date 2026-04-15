// @ts-ignore - Vite worker inline import
import MediaWorker from './workers/media-worker?worker&inline';
import { storage } from './storage-service';

export class MediaEngine {
  private worker: Worker | null = null;
  private abortController: AbortController | null = null;

  /**
   * 处理大规模视频文件（WebCodecs 管线）
   * 注意：当前 Dashboard 默认使用 FfmpegEngine 进行压缩
   * 此类保留用于未来 WebCodecs 流式处理 10GB+ 文件
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

      this.worker = new MediaWorker();
      this.abortController = new AbortController();

      return new Promise((resolve, reject) => {
        if (!this.worker) return reject(new Error('Worker 初始化失败'));

        const initTimeout = setTimeout(() => {
          reject(new Error('Worker 初始化超时，可能被网络代理阻断'));
          this.stop();
        }, 5000);

        this.worker.onmessage = async (e: MessageEvent) => {
          const { type, data } = e.data;

          switch (type) {
            case 'PONG':
              clearTimeout(initTimeout);
              console.log('✅ [Processor] Worker Handshake OK');
              this.worker!.postMessage({
                type: 'START_PROCESS',
                data: { file, config, outputHandle }
              });
              break;
            case 'PROGRESS':
              onProgress(data);
              break;
            case 'DONE':
              console.log('🎉 [Processor] Complete');
              try {
                const finalFile = await (outputHandle as any).getFile();
                resolve(finalFile);
              } catch (err) {
                reject(new Error(`OPFS 文件读取失败: ${err}`));
              }
              break;
            case 'ERROR':
              console.error('🔥 [Processor] Worker Error:', data);
              reject(new Error(data));
              break;
          }
        };

        this.worker.onerror = (err: any) => {
          clearTimeout(initTimeout);
          const realError = err && err.message ? err.message : '后台处理线程彻底崩溃 (Fatal Error)';
          console.error('🚨 [Processor] Worker Crash:', realError, err);
          reject(new Error(`Worker Crash: ${realError}`));
        };

        // 握手
        this.worker.postMessage({ type: 'PING' });
      });

    } catch (err: any) {
      console.error('🚫 [Processor] Pre-flight Failure:', err);
      console.groupEnd();
      throw err;
    }
  }

  /**
   * 安全终止：先通知 Worker 清理资源，再 terminate
   */
  stop() {
    if (!this.worker) return;
    // 通知 worker 优雅清理
    try { this.worker.postMessage({ type: 'STOP' }); } catch {}
    // 给 Worker 200ms 完成 cleanup，然后强制终止
    const w = this.worker;
    setTimeout(() => { try { w.terminate(); } catch {} }, 200);
    this.worker = null;
    this.abortController = null;
  }
}
