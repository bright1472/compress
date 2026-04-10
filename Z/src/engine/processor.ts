// @ts-ignore - Vite worker inline import
import MediaWorker from './workers/media-worker?worker&inline';
import { storage } from './storage-service';

export class MediaEngine {
  private worker: Worker | null = null;

  /**
   * 处理大规模视频文件
   * 基于 First-Principles 设计，支持 10GB+ 文件的流式处理
   */
  async processLargeVideo(
    file: File, 
    config: { codec: string; bitrate?: number; crf?: number; preset?: string }, 
    onProgress: (data: { loaded: number; total: number; progress: number }) => void
  ): Promise<File> {
    
    // 1. 预检与资源初始化
    console.group('📁 [Processor] Initialization');
    try {
      await storage.init();
      // 在 OPFS 预留输出文件位 (无内存占用)
      const outputHandle = await storage.createDiskStream(`titan_opt_${Date.now()}.mp4`);
      console.log('✅ OPFS Storage Ready');
      console.groupEnd();

      // 2. 启动 Worker 线程 (内联模式，消除网络加载不确定性)
      this.worker = new MediaWorker();

      return new Promise((resolve, reject) => {
        if (!this.worker) return reject(new Error('Worker initialization failed internally.'));

        // 设置安全超时：如果 3 秒内 Worker 没响应 PING，说明加载失败
        const initTimeout = setTimeout(() => {
          reject(new Error('Worker Initialization Timeout. Possible network or proxy block.'));
          this.stop();
        }, 3000);

        this.worker.onmessage = async (e: MessageEvent) => {
          const { type, data } = e.data;

          switch (type) {
            case 'PONG':
              console.log('✅ [Processor] Worker Handshake Successful.');
              clearTimeout(initTimeout);
              // 握手成功后再发送大数据包
              console.info('📡 [Processor] Dispatching START_PROCESS command...');
              this.worker!.postMessage({
                type: 'START_PROCESS',
                data: { file, config, outputHandle }
              });
              break;
            case 'PROGRESS':
              onProgress(data);
              break;
            case 'DONE':
              console.log('🎉 [Processor] Optimization Successfully Completed.');
              // 从磁盘提取最终成品
              try {
                const finalFile = await (outputHandle as any).getFile();
                resolve(finalFile);
              } catch (resErr) {
                reject(new Error(`Failed to retrieve file from OPFS: ${resErr}`));
              }
              break;
            case 'ERROR':
              console.error('🔥 [Processor] Worker Pipe Burst:', data);
              reject(new Error(data));
              break;
          }
        };

        this.worker.onerror = (err) => {
          console.error('🚨 [Processor] Worker Thread Crash:', err);
          reject(new Error('Background processing thread crashed unexpectedly.'));
        };

        // 3. 核心：链路握手探测
        console.info('📡 [Processor] Pinging Worker to verify liveness...');
        this.worker.postMessage({ type: 'PING' });
      });

    } catch (headErr: any) {
      console.error('🚫 [Processor] Pipeline Pre-flight Failure:', headErr);
      throw headErr;
    }
  }

  /**
   * 强制终止处理任务
   */
  stop() {
    console.warn('🛑 [Processor] Terminating current optimization task.');
    this.worker?.postMessage({ type: 'STOP' });
    this.worker?.terminate();
    this.worker = null;
  }
}
