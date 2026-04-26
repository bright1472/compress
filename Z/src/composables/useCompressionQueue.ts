import { ref, computed } from 'vue';
import { t } from '../locales/i18n';

export type FileKind = 'video' | 'image';

export interface QueueItem {
  id: string; file: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  fileType: FileKind;
  progress: number; throughput: number;
  originalUrl: string; compressedUrl: string;
  compressedSize: number; errorMsg: string;
  engineUsed: string;
  startTime: number; elapsed: number; remaining: number;
}

export interface UseCompressionQueueOptions {
  fileType: FileKind;
  isValidFile: (f: File) => boolean;
  processItem: (item: QueueItem) => Promise<void>;
  buildDownloadName: (item: QueueItem) => string;
  onStop?: () => void;
  onItemDone?: (item: QueueItem) => Promise<void>;
}

export function useCompressionQueue(opts: UseCompressionQueueOptions) {
  const queue = ref<QueueItem[]>([]);
  const activeItemId = ref<string | null>(null);
  const isRunning = ref(false);
  const isCancelling = ref(false);
  const isCancellingItem = ref(false);
  const rejectedFiles = ref<string[]>([]);
  const dragSrcId = ref<string | null>(null);
  const dragOverId = ref<string | null>(null);

  const pendingCount = computed(() => queue.value.filter(i => i.status === 'pending').length);
  const doneCount = computed(() => queue.value.filter(i => i.status === 'done').length);
  const totalCount = computed(() => queue.value.length);
  const currentProcessing = computed(() => queue.value.find(i => i.status === 'processing') ?? null);
  const canStart = computed(() => pendingCount.value > 0 && !isRunning.value);
  const activeItem = computed(() => queue.value.find(i => i.id === activeItemId.value) ?? null);
  const totalSavedMB = computed(() => queue.value
    .filter(i => i.status === 'done')
    .reduce((acc, i) => acc + (i.file.size - i.compressedSize), 0) / 1048576);

  const addFiles = (files: FileList | File[]) => {
    rejectedFiles.value = [];
    const all = Array.from(files);
    const valid = all.filter(opts.isValidFile);
    const invalid = all.filter(f => !opts.isValidFile(f));
    if (invalid.length > 0) {
      rejectedFiles.value = invalid.map(f => f.name);
      setTimeout(() => { rejectedFiles.value = []; }, 4000);
    }
    valid.forEach(file => {
      const item: QueueItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file, fileType: opts.fileType, status: 'pending',
        progress: 0, throughput: 0,
        originalUrl: URL.createObjectURL(file),
        compressedUrl: '', compressedSize: 0, errorMsg: '', engineUsed: '',
        startTime: 0, elapsed: 0, remaining: 0,
      };
      queue.value.push(item);
      if (!activeItemId.value) activeItemId.value = item.id;
    });
  };

  const removeItem = (id: string) => {
    const item = queue.value.find(i => i.id === id);
    if (!item) return;
    if (item.status === 'processing') {
      if (!window.confirm(t.value('queue.removeConfirm'))) return;
      opts.onStop?.();
      isRunning.value = false;
    }
    if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
    if (item.compressedUrl) URL.revokeObjectURL(item.compressedUrl);
    queue.value = queue.value.filter(i => i.id !== id);
    if (activeItemId.value === id) activeItemId.value = queue.value[0]?.id ?? null;
  };

  const clearAll = () => {
    if (isRunning.value) return;
    queue.value.forEach(i => {
      if (i.originalUrl) URL.revokeObjectURL(i.originalUrl);
      if (i.compressedUrl) URL.revokeObjectURL(i.compressedUrl);
    });
    queue.value = [];
    activeItemId.value = null;
  };

  const onQueueDragStart = (_e: DragEvent, id: string) => { dragSrcId.value = id; };
  const onQueueDragOver = (_e: DragEvent, id: string) => {
    if (dragSrcId.value && dragSrcId.value !== id) dragOverId.value = id;
  };
  const onQueueDragLeave = () => { dragOverId.value = null; };
  const onQueueDrop = (_e: DragEvent, targetId: string) => {
    const srcId = dragSrcId.value;
    if (!srcId || srcId === targetId) return;
    const q = queue.value;
    const srcIdx = q.findIndex(i => i.id === srcId);
    const tgtIdx = q.findIndex(i => i.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;
    const [moved] = q.splice(srcIdx, 1);
    q.splice(tgtIdx, 0, moved);
    dragSrcId.value = null;
    dragOverId.value = null;
  };
  const onQueueDragEnd = () => { dragSrcId.value = null; dragOverId.value = null; };

  const cancelQueue = () => {
    if (!isRunning.value) return;
    isCancelling.value = true;
    opts.onStop?.();
  };

  const cancelCurrentItem = () => {
    if (!isRunning.value) return;
    isCancellingItem.value = true;
    opts.onStop?.();
  };

  const processQueue = async () => {
    isRunning.value = true;
    isCancelling.value = false;
    isCancellingItem.value = false;
    try {
      while (true) {
        if (isCancelling.value) break;
        const next = queue.value.find(i => i.status === 'pending');
        if (!next) break;
        try {
          await opts.processItem(next);
        } catch {
          // processItem threw before updating item status (e.g. QUOTA_EXCEEDED) — stop queue
          if (next.status === 'pending') break;
        }
        if (isCancellingItem.value) {
          // 无论 processItem 以何种状态结束（含取消时 worker 返回残缺 blob 被标为 done），
          // 只要取消请求发出，就强制还原到初始待处理状态
          if (next.compressedUrl) { URL.revokeObjectURL(next.compressedUrl); next.compressedUrl = ''; }
          next.status = 'pending';
          next.progress = 0;
          next.compressedSize = 0;
          next.errorMsg = '';
          next.engineUsed = '';
          isCancellingItem.value = false;
          break;
        } else if (next.status === 'done' && opts.onItemDone) {
          await opts.onItemDone(next).catch(() => {});
        }
      }
    } finally {
      if (isCancelling.value) {
        queue.value.forEach(i => {
          if (i.status !== 'done') {
            if (i.compressedUrl) { URL.revokeObjectURL(i.compressedUrl); i.compressedUrl = ''; }
            i.status = 'pending';
            i.progress = 0;
            i.compressedSize = 0;
            i.errorMsg = '';
            i.engineUsed = '';
          }
        });
      }
      isRunning.value = false;
      isCancelling.value = false;
      isCancellingItem.value = false;
    }
  };

  const downloadItem = (item: QueueItem) => {
    if (!item.compressedUrl) return;
    const a = document.createElement('a');
    a.href = item.compressedUrl;
    a.download = opts.buildDownloadName(item);
    a.click();
  };

  const downloadAll = () => queue.value.filter(i => i.status === 'done').forEach(downloadItem);

  return {
    queue, activeItemId, isRunning, isCancelling, isCancellingItem, rejectedFiles,
    dragSrcId, dragOverId,
    pendingCount, doneCount, totalCount, currentProcessing, canStart, activeItem, totalSavedMB,
    addFiles, removeItem, clearAll,
    onQueueDragStart, onQueueDragOver, onQueueDragLeave, onQueueDrop, onQueueDragEnd,
    processQueue, cancelQueue, cancelCurrentItem, downloadItem, downloadAll,
  };
}

export const fileSizeMB = (bytes: number) => (bytes / 1048576).toFixed(1);
export const fileSizeStr = (bytes: number): string => {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};
export const statusPrefix = (item: QueueItem) => {
  if (item.status === 'processing') return '◌';
  if (item.status === 'done') return '✓';
  if (item.status === 'error') return '✕';
  return '○';
};
export const compressionRatio = (item: QueueItem) =>
  item.compressedSize ? Math.round((1 - item.compressedSize / item.file.size) * 100) : 0;
export const fmtTime = (sec: number): string => {
  if (sec <= 0) return '--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`;
};
