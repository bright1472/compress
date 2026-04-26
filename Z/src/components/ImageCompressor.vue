<script setup lang="ts">
import { ref, watch, inject, watchEffect, onMounted } from 'vue';
import ImageComparison from './ImageComparison.vue';
import type { EngineRouter } from '../engine/engine-router';
import { t } from '../locales/i18n';
import { logger } from '../engine/logger';
import {
  useCompressionQueue,
  fileSizeStr, statusPrefix, compressionRatio, fmtTime,
  type QueueItem,
} from '../composables/useCompressionQueue';
import { isLoggedIn } from '../composables/useAuth';
import { canCompress, afterCompress } from '../composables/useUsageLimit';
import { checkAndGate, limitToastVisible, limitToastMsg } from '../composables/useCompressGate';
import { fetchGlobalStats, reportStats, globalSavedBytes, globalTotalFiles, formatBytes } from '../composables/useGlobalStats';
import { isOutputDirSupported, autoSaveEnabled, dirName, pickDir, clearDir, autoSave } from '../composables/useOutputDir';

type ImageFmt = 'original' | 'png' | 'jpg' | 'webp' | 'avif';

const props = defineProps<{ showSettings: boolean }>();
const emit = defineEmits<{ (e: 'update:showSettings', v: boolean): void }>();

const router = inject<EngineRouter>('engineRouter')!;
const openAuthModal = inject<() => void>('openAuthModal', () => {});
const openActivationModal = inject<() => void>('openActivationModal', () => {});

const handleStart = () => {
  if (!checkAndGate(openAuthModal, openActivationModal)) return;
  q.processQueue();
};

// ── 文件验证 ─────────────────────────────────────────────────────
const VALID_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp', 'image/tiff', 'image/x-icon', 'image/heic', 'image/heif']);
const VALID_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif']);
const getExt = (f: File) => f.name.split('.').pop()?.toLowerCase() ?? '';
const isValidFile = (f: File) => VALID_IMAGE_TYPES.has(f.type) || VALID_IMAGE_EXT.has(getExt(f));

// ── Settings（图片独有）──────────────────────────────────────────
const SETTINGS_KEY = 'titan-image-settings';
const _saved = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'); } catch { return null; } })();
const VALID_FMTS: ImageFmt[] = ['original','png','jpg','webp','avif'];
const imageOutputFormat = ref<ImageFmt>(VALID_FMTS.includes(_saved?.imageOutputFormat) ? _saved.imageOutputFormat : 'original');
const imageQuality = ref<number>(typeof _saved?.imageQuality === 'number' ? _saved.imageQuality : 85);

watch([imageOutputFormat, imageQuality], () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    imageOutputFormat: imageOutputFormat.value,
    imageQuality: imageQuality.value,
  }));
});

const imageFormatOptions: { value: ImageFmt; label: string }[] = [
  { value: 'original', label: t.value('image.original') },
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'webp', label: 'WebP' },
  { value: 'avif', label: 'AVIF' },
];

// ── 处理 ──────────────────────────────────────────────────────────
const processItem = async (item: QueueItem) => {
  if (!checkAndGate(openAuthModal, openActivationModal)) {
    throw new Error('QUOTA_EXCEEDED');
  }
  item.status = 'processing';
  q.activeItemId.value = item.id;
  item.progress = 0;
  item.startTime = Date.now();

  try {
    item.engineUsed = 'Canvas API';
    const resultBlob = await router.compress(
      item.file,
      { codec: 'libx264', crf: 28, preset: 'fast' }, // ignored for image path
      (pct) => {
        item.progress = Math.min(pct, 99.9);
        const elapsed = (Date.now() - item.startTime) / 1000;
        if (elapsed > 0) item.throughput = (item.file.size * (pct / 100)) / 1048576 / elapsed;
        item.elapsed = elapsed;
        item.remaining = pct > 2 ? (elapsed / pct) * (100 - pct) : 0;
      },
      undefined,
      'image',
      { outputFormat: imageOutputFormat.value, quality: imageQuality.value },
    );
    item.compressedSize = resultBlob.size;
    if (item.compressedUrl) URL.revokeObjectURL(item.compressedUrl);
    item.compressedUrl = URL.createObjectURL(resultBlob);
    item.elapsed = (Date.now() - item.startTime) / 1000;
    item.progress = 100;
    item.status = 'done';
    afterCompress();
    reportStats(Math.max(0, item.file.size - item.compressedSize), 'image');

    const originalMB = (item.file.size / 1048576).toFixed(2);
    const compressedMB = (item.compressedSize / 1048576).toFixed(2);
    const ratio = ((item.compressedSize / item.file.size) * 100).toFixed(1);
    logger.info('system', `[image][Benchmark] ${item.file.name} | ${originalMB}MB -> ${compressedMB}MB | ${item.elapsed.toFixed(2)}s | Ratio: ${ratio}% | Engine: Canvas API`);
  } catch (e: any) {
    item.status = 'error';
    const msg = e.message || t.value('process.encodingFailed');
    if (msg.startsWith('FORMAT_UNSUPPORTED:')) {
      const fmt = msg.split(':')[1];
      item.errorMsg = fmt === 'avif' ? t.value('image.avifNotSupported') : t.value('image.webpNotSupported');
    } else if (/heic|heif/i.test(item.file.name) || /heic|heif/i.test(item.file.type)) {
      item.errorMsg = t.value('image.heicNotSupported');
    } else {
      item.errorMsg = msg;
    }
  }
};

const buildDownloadName = (item: QueueItem) => {
  if (imageOutputFormat.value !== 'original') {
    const baseName = item.file.name.replace(/\.[^.]+$/, '');
    return `titan_${baseName}.${imageOutputFormat.value === 'jpg' ? 'jpg' : imageOutputFormat.value}`;
  }
  return `titan_${item.file.name}`;
};

const onItemDone = async (item: QueueItem) => {
  if (!autoSaveEnabled.value) return;
  try {
    const blob = await fetch(item.compressedUrl).then(r => r.blob());
    const ok = await autoSave(blob, buildDownloadName(item));
    if (!ok) logger.warn('system', `[autoSave] Failed to write ${item.file.name} — check directory permission`);
  } catch (e) {
    logger.warn('system', `[autoSave] Error saving ${item.file.name}: ${e instanceof Error ? e.message : e}`);
  }
};

const q = useCompressionQueue({
  fileType: 'image',
  isValidFile,
  processItem,
  buildDownloadName,
  onStop: () => { router.terminate(); },
  onItemDone,
});

// ── 拖放 ──────────────────────────────────────────────────────────
const isDragging = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const onFileInput = (e: Event) => {
  const files = (e.target as HTMLInputElement).files;
  if (files) q.addFiles(files);
  (e.target as HTMLInputElement).value = '';
};
const onDrop = (e: DragEvent) => { isDragging.value = false; e.preventDefault(); if (e.dataTransfer?.files) q.addFiles(e.dataTransfer.files); };
const onDragOver = (e: DragEvent) => { e.preventDefault(); isDragging.value = true; };
const onDragLeave = () => { isDragging.value = false; };

const closeSettings = () => emit('update:showSettings', false);

onMounted(fetchGlobalStats);

// ── Mobile tab ────────────────────────────────────────────────────
const mobileTab = ref<'queue' | 'stage'>('queue');
watchEffect(() => {
  if (q.activeItem.value?.status === 'done') mobileTab.value = 'stage';
});

defineExpose({
  isRunning: q.isRunning,
  pendingCount: q.pendingCount,
  totalCount: q.totalCount,
  currentProcessing: q.currentProcessing,
  queue: q.queue,
});
</script>

<template>
  <div class="compressor-root image-compressor">
    <Transition name="toast">
      <div v-if="q.rejectedFiles.value.length > 0" class="toast-reject">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.5"/></svg>
        <span>{{ t('queue.unsupportedFormat') }}: {{ q.rejectedFiles.value.join(', ') }}</span>
      </div>
    </Transition>

    <input type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp,image/tiff,image/heic,image/heif,.heic,.heif" multiple hidden ref="fileInputRef" @change="onFileInput" />

    <div class="app-body" :class="q.totalCount.value > 0 ? `mob-${mobileTab}` : ''">
      <aside v-if="q.totalCount.value > 0" class="sidebar">
        <div class="queue-wrap">
          <div class="queue-header">
            <div class="qh-left">
              <span class="queue-label">{{ t('queue.header') }}</span>
              <span class="qh-count">{{ q.doneCount.value }}/{{ q.totalCount.value }}</span>
            </div>
            <div class="qh-right" v-if="q.doneCount.value > 0">
              <span class="qh-saved-pill">↓ {{ q.totalSavedMB.value.toFixed(1) }} MB</span>
            </div>
          </div>

          <div class="queue-list">
            <div
              v-for="item in q.queue.value"
              :key="item.id"
              class="queue-item"
              :class="{ active: q.activeItemId.value === item.id, [item.status]: true,
                        'drag-over': q.dragOverId.value === item.id,
                        'is-dragging': q.dragSrcId.value === item.id }"
              :draggable="item.status === 'pending'"
              @click="q.activeItemId.value = item.id"
              @dragstart="q.onQueueDragStart($event, item.id)"
              @dragover.prevent="q.onQueueDragOver($event, item.id)"
              @dragleave.self="q.onQueueDragLeave"
              @drop.prevent="q.onQueueDrop($event, item.id)"
              @dragend="q.onQueueDragEnd"
            >
              <div v-if="item.status === 'pending'" class="qi-drag-handle" :title="t('queue.dragToSort')">
                <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                  <circle cx="3" cy="2" r="1.5" fill="currentColor"/><circle cx="7" cy="2" r="1.5" fill="currentColor"/>
                  <circle cx="3" cy="7" r="1.5" fill="currentColor"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/>
                  <circle cx="3" cy="12" r="1.5" fill="currentColor"/><circle cx="7" cy="12" r="1.5" fill="currentColor"/>
                </svg>
              </div>
              <div class="qi-info">
                <p class="qi-name">
                  <span class="qi-prefix" :class="item.status">{{ statusPrefix(item) }}</span>{{ item.file.name }}
                </p>
                <div class="qi-meta">
                  <span class="m-capsule img-type">{{ getExt(item.file).toUpperCase() || 'IMG' }}</span>
                  <template v-if="item.status === 'done'">
                    <span class="m-capsule size-group">
                      <span class="src-val">{{ fileSizeStr(item.file.size) }}</span>
                      <span class="size-arrow">→</span>
                      <span class="res-val">{{ fileSizeStr(item.compressedSize) }}</span>
                    </span>
                    <span class="m-capsule ratio">↓{{ compressionRatio(item) }}%</span>
                    <span class="m-capsule time">{{ fmtTime(item.elapsed) }}</span>
                  </template>
                  <template v-else-if="item.status === 'processing'">
                    <span class="m-capsule src">{{ fileSizeStr(item.file.size) }}</span>
                  </template>
                  <template v-else>
                    <span class="m-capsule src">{{ fileSizeStr(item.file.size) }}</span>
                    <span v-if="item.status === 'error'" class="m-capsule err">ERR</span>
                  </template>
                </div>
                <div v-if="item.status === 'processing'" class="qi-progress-bar">
                  <div class="qi-progress-fill" :style="{ width: item.progress + '%' }"></div>
                </div>
              </div>
              <div class="qi-actions">
                <button v-if="item.status === 'done'" class="qi-btn dl" @click.stop="q.downloadItem(item)" :title="t('queue.download')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button v-if="item.status === 'processing' && !q.isCancellingItem.value" class="qi-btn cancel" @click.stop="q.cancelCurrentItem()" :title="t('queue.cancelItem')">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>
                </button>
                <button v-if="item.status !== 'processing'" class="qi-btn rm" @click.stop="q.removeItem(item.id)" :title="t('queue.remove')">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="sb-footer">
          <Transition name="limit-toast">
            <div v-if="limitToastVisible" class="limit-toast-tip">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="flex-shrink:0"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8"/><line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="currentColor"/></svg>
              {{ limitToastMsg }}
            </div>
          </Transition>
          <button class="add-files-btn" @click="fileInputRef?.click()" :disabled="q.isRunning.value">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            {{ t('image.addFiles') }}
          </button>
          <button v-if="q.canStart.value" class="btn-primary" @click="handleStart">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
            {{ t('process.start') }}{{ q.pendingCount.value > 1 ? ` (${q.pendingCount.value})` : '' }}
          </button>
          <button v-if="q.isRunning.value" class="btn-cancel" @click="q.cancelQueue()" :disabled="q.isCancelling.value">
            <svg v-if="!q.isCancelling.value" width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>
            <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" class="spin-svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-dasharray="28 56" stroke-linecap="round"/></svg>
            {{ q.isCancelling.value ? t('queue.cancelling') : t('queue.cancel') }}
          </button>
          <div v-if="q.doneCount.value > 0 && !q.isRunning.value" class="footer-done-actions">
            <button class="btn-dl-all" @click="q.downloadAll">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {{ t('process.downloadAll', { n: q.doneCount.value }) }}
            </button>
            <button class="btn-clear" @click="q.clearAll">{{ t('queue.clearQueue') }}</button>
          </div>
        </div>
      </aside>

      <main class="stage" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
        <div v-if="q.totalCount.value === 0" class="drop-zone" :class="{ dragging: isDragging }" @click="fileInputRef?.click()">
          <div class="drop-content">
            <div class="drop-icon-wrap">
              <div class="drop-ring-outer"></div><div class="drop-ring"></div>
              <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
                <rect x="3" y="5" width="28" height="24" rx="2" stroke="currentColor" stroke-width="1.5"/>
                <circle cx="11" cy="13" r="2" fill="currentColor"/>
                <path d="M31 21l-7-7-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h2 class="drop-title">{{ t('image.dragToArea') }}</h2>
            <p class="drop-sub">{{ t('image.supportBatch') }}</p>
            <div class="drop-formats">
              <span v-for="f in ['PNG','JPG','WebP','AVIF','GIF','BMP']" :key="f" class="fmt-tag">{{ f }}</span>
            </div>
            <div v-if="globalTotalFiles > 0" class="global-stats-bar">
              <span class="gs-item">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/></svg>
                累计节省 <strong>{{ formatBytes(globalSavedBytes) }}</strong>
              </span>
              <span class="gs-sep">·</span>
              <span class="gs-item">共 <strong>{{ globalTotalFiles.toLocaleString() }}</strong> 个文件</span>
            </div>
          </div>
        </div>

        <div v-if="q.totalCount.value > 0 && isDragging" class="drag-overlay">
          <div class="drag-overlay-inner">
            <svg width="32" height="32" viewBox="0 0 34 34" fill="none">
              <circle cx="17" cy="17" r="6" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="17" cy="17" r="2" fill="currentColor"/>
            </svg>
            <p>{{ t('queue.dropToAdd') }}</p>
          </div>
        </div>

        <div v-if="q.totalCount.value > 0 && !q.activeItem.value && !isDragging" class="stage-hint">
          <p>{{ t('process.clickToPreview') }}</p>
        </div>

        <div v-if="q.activeItem.value && (q.activeItem.value.status === 'pending' || q.activeItem.value.status === 'processing')" class="preview-stage" :class="{ 'is-processing': q.activeItem.value.status === 'processing' }">
          <div class="preview-image-wrap">
            <img :src="q.activeItem.value.originalUrl" class="preview-image" draggable="false" />
          </div>
          <div v-if="q.activeItem.value.status === 'pending'" class="preview-tip">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v4l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            {{ t('process.configAndStart') }}
          </div>
        </div>

        <div v-if="q.activeItem.value && q.activeItem.value.status === 'done'" class="result-stage">
          <ImageComparison
            :original-url="q.activeItem.value.originalUrl"
            :compressed-url="q.activeItem.value.compressedUrl ?? ''"
            :original-label="`ORIGINAL · ${fileSizeStr(q.activeItem.value.file.size)}`"
            :compressed-label="`COMPRESSED · ${fileSizeStr(q.activeItem.value.compressedSize)} · ↓${compressionRatio(q.activeItem.value)}%`"
          />
        </div>

        <div v-if="q.activeItem.value && q.activeItem.value.status === 'error'" class="error-stage">
          <div class="error-card">
            <div class="err-icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.5"/></svg>
            </div>
            <h3 class="err-title">{{ t('process.encodingFailed') }}</h3>
            <p class="err-msg">{{ q.activeItem.value.errorMsg }}</p>
          </div>
        </div>
      </main>
    </div>

    <!-- Mobile tab bar -->
    <nav v-if="q.totalCount.value > 0" class="mob-tabbar">
      <button class="mob-tab" :class="{ active: mobileTab === 'queue' }" @click="mobileTab = 'queue'">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="8" y1="6" x2="21" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="18" x2="21" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="6" x2="3.01" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="12" x2="3.01" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="18" x2="3.01" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <span>{{ t('queue.header') }} · {{ q.doneCount.value }}/{{ q.totalCount.value }}</span>
      </button>
      <button class="mob-tab" :class="{ active: mobileTab === 'stage' }" @click="mobileTab = 'stage'">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="9" r="2" stroke="currentColor" stroke-width="2"/><path d="M21 15l-5-5-10 10" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        <span>{{ t('mode.image') }}</span>
        <span v-if="q.activeItem.value?.status === 'done'" class="mob-tab-dot"></span>
      </button>
    </nav>

    <!-- ═══ Settings overlay（图片独立）══════════════════════════════ -->
    <Transition name="settings">
      <div v-if="props.showSettings" class="settings-overlay" @click.self="closeSettings">
        <div class="settings-panel">
          <div class="sp-header">
            <div class="sp-title-row">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/></svg>
              <span class="sp-title">{{ t('image.sectionLabel') }}</span>
            </div>
            <button class="sp-close" @click="closeSettings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>

          <div v-if="isOutputDirSupported" class="sp-section">
            <div class="sp-section-label">{{ t('outputDir.label') }}</div>
            <div v-if="autoSaveEnabled" class="output-dir-active">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
              <span class="output-dir-name">{{ dirName }}</span>
              <button class="output-dir-clear-btn" @click="clearDir">{{ t('outputDir.clear') }}</button>
            </div>
            <button v-else class="output-dir-pick-btn" @click="pickDir">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="9" y1="14" x2="15" y2="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              {{ t('outputDir.pick') }}
            </button>
            <p class="sp-hint">{{ t('outputDir.hint') }}</p>
          </div>

          <div class="sp-section">
            <div class="sp-section-label">{{ t('image.outputFormat') }}</div>
            <div class="img-fmt-pills">
              <button
                v-for="fmt in imageFormatOptions"
                :key="fmt.value"
                class="img-fmt-pill"
                :class="{ active: imageOutputFormat === fmt.value }"
                @click="imageOutputFormat = fmt.value"
                :disabled="q.isRunning.value"
              >{{ fmt.label }}</button>
            </div>
            <template v-if="imageOutputFormat !== 'original'">
              <div class="sp-section-label-row" style="margin-top: 16px;">
                <span class="sp-subsection-label">{{ t('image.quality') }}</span>
                <span class="quality-tag" style="color: var(--c-accent)">{{ imageQuality }}%</span>
              </div>
              <input type="range" class="crf-slider" v-model="imageQuality" min="10" max="100" step="5" :disabled="q.isRunning.value" :style="{ background: `linear-gradient(to right, var(--c-accent) ${imageQuality}%, var(--c-bg-elevated) ${imageQuality}%)` }" />
              <div class="crf-scale"><span>{{ t('config.compress') }}</span><span>{{ t('config.fine') }}</span></div>
            </template>
            <div class="sp-hint">{{ t('image.qualityHint') }}</div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped src="./Dashboard.css"></style>
