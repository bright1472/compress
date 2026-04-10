/**
 * src/engine/storage-service.ts
 * 2026 Elite Storage Service - 处理 10GB+ 级超大视频的磁盘缓冲区
 * 基于 OPFS (Origin Private File System) 实现
 * 符合 Silicon Valley 极简与健壮性标准
 */

export class StorageService {
  private root: FileSystemDirectoryHandle | null = null;

  /**
   * 初始化存储根目录句柄
   */
  async init(): Promise<void> {
    if (this.root) return;
    try {
      this.root = await navigator.storage.getDirectory();
      console.log('✅ [Storage] OPFS Access Granted.');
    } catch (err) {
      console.error('❌ [Storage] Failed to access OPFS:', err);
      throw new Error('FileSystem Access Denied. Optimization cannot proceed.');
    }
  }

  /**
   * 创建一个磁盘文件句柄，用于流式写入
   * @param filename 目标文件名
   */
  async createDiskStream(filename: string): Promise<FileSystemFileHandle> {
    if (!this.root) await this.init();
    
    // 在 OPFS 沙盒中创建/打开文件
    // 返回 FileSystemFileHandle，它是可克隆的 (Cloneable)，可以安全传给 Worker
    return await this.root!.getFileHandle(filename, { create: true });
  }

  /**
   * 彻底清理存储空间
   */
  async clear(): Promise<void> {
    if (!this.root) await this.init();
    
    // 迭代删除所有文件
    const entries = (this.root as any).entries();
    for await (const [name] of entries) {
      await this.root!.removeEntry(name, { recursive: true });
    }
    console.log('🧹 [Storage] Workspace cleared.');
  }
}

export const storage = new StorageService();
