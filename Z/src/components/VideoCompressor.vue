<script setup lang="ts">
import { ref, computed, watch, watchEffect, inject } from 'vue';
import type { EngineRouter } from '../engine/engine-router';
import ComparisonSlider from './ComparisonSlider.vue';
import { t, currentLocale } from '../locales/i18n';
import { logger } from '../engine/logger';
import {
  useCompressionQueue,
  fileSizeStr, statusPrefix, compressionRatio, fmtTime,
  type QueueItem,
} from '../composables/useCompressionQueue';

const props = defineProps<{ showSettings: boolean }>();
const emit = defineEmits<{ (e: 'update:showSettings', v: boolean): void }>();

const router = inject<EngineRouter>('engineRouter')!;

// ── 文件验证 ─────────────────────────────────────────────────────
const VALID_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/avi', 'video/webm', 'video/x-flv', 'video/x-ms-wmv', 'video/x-msvideo', 'video/3gpp', 'video/ogg']);
const VALID_VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', '3gp', 'ogv', 'm4v', 'ts', 'mts']);
const getExt = (f: File) => f.name.split('.').pop()?.toLowerCase() ?? '';
const isValidFile = (f: File) => VALID_VIDEO_TYPES.has(f.type) || VALID_VIDEO_EXT.has(getExt(f));

// ── Settings（视频独有）──────────────────────────────────────────
const SETTINGS_KEY = 'titan-video-settings';
const _saved = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'); } catch { return null; } })();
const VALID_CODECS = new Set(['libx264', 'libx265', 'av1']);
const VALID_PRESETS = new Set(['ultrafast', 'fast', 'medium', 'slow']);
const codec = ref<'libx264' | 'libx265' | 'av1'>(VALID_CODECS.has(_saved?.codec) ? _saved.codec : 'libx264');
const crf = ref<number>(typeof _saved?.crf === 'number' && _saved.crf >= 18 && _saved.crf <= 40 ? _saved.crf : 28);
const preset = ref<'ultrafast' | 'fast' | 'medium' | 'slow'>(VALID_PRESETS.has(_saved?.preset) ? _saved.preset : 'fast');

watch([codec, crf, preset], () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ codec: codec.value, crf: crf.value, preset: preset.value }));
});

const codecOptions = [
  { value: 'libx264', label: 'H.264', badge: 'AVC' },
  { value: 'libx265', label: 'H.265', badge: 'HEVC' },
  { value: 'av1', label: 'AV1', badge: 'AV1' },
] as const;

const presetOptions = [
  { value: 'ultrafast', bars: 1 },
  { value: 'fast', bars: 2 },
  { value: 'medium', bars: 3 },
  { value: 'slow', bars: 4 },
] as const;

const qualityLabel = computed(() => {
  if (crf.value <= 20) return { text: t.value('config.visuallyLossless'), color: '#22c55e' };
  if (crf.value <= 26) return { text: t.value('config.highQuality'), color: '#f97316' };
  if (crf.value <= 32) return { text: t.value('config.balanced'), color: '#f59e0b' };
  return { text: t.value('config.highCompressRate'), color: '#ef4444' };
});
const crfSliderStyle = computed(() => {
  const pct = ((crf.value - 18) / (40 - 18)) * 100;
  return { background: `linear-gradient(to right, var(--c-accent) ${pct}%, var(--c-bg-elevated) ${pct}%)` };
});

// ── 引擎状态 ──────────────────────────────────────────────────────
const engineLoading = ref(false);
const routeInfo = ref('');

const processItem = async (item: QueueItem) => {
  item.status = 'processing';
  q.activeItemId.value = item.id;
  item.progress = 0;
  item.startTime = Date.now();

  try {
    engineLoading.value = true;
    const resultBlob = await router.compress(
      item.file,
      { codec: codec.value, crf: crf.value, preset: preset.value },
      (pct) => {
        item.progress = Math.min(pct, 99.9);
        const elapsed = (Date.now() - item.startTime) / 1000;
        if (elapsed > 0) item.throughput = (item.file.size * (pct / 100)) / 1048576 / elapsed;
        item.elapsed = elapsed;
        item.remaining = pct > 2 ? (elapsed / pct) * (100 - pct) : 0;
      },
      (decision) => {
        item.engineUsed = decision.engine === 'ffmpeg' ? 'FFmpeg WASM' : 'WebCodecs';
        routeInfo.value = decision.reason;
        engineLoading.value = false;
      },
      'video',
    );
    item.compressedSize = resultBlob.size;
    if (item.compressedUrl) URL.revokeObjectURL(item.compressedUrl);
    item.compressedUrl = URL.createObjectURL(resultBlob);
    item.elapsed = (Date.now() - item.startTime) / 1000;
    item.progress = 100;
    item.status = 'done';

    const originalMB = (item.file.size / 1048576).toFixed(2);
    const compressedMB = (item.compressedSize / 1048576).toFixed(2);
    const ratio = ((item.compressedSize / item.file.size) * 100).toFixed(1);
    const avgSpeed = (item.file.size / 1048576 / item.elapsed).toFixed(2);
    logger.info('system', `[video][Benchmark] ${item.file.name} | ${originalMB}MB -> ${compressedMB}MB | ${item.elapsed.toFixed(1)}s | ${avgSpeed} MB/s | Ratio: ${ratio}% | Engine: ${item.engineUsed}`);
  } catch (e: any) {
    item.status = 'error';
    item.errorMsg = e.message || t.value('process.encodingFailed');
    engineLoading.value = false;
  }
};

const buildDownloadName = (item: QueueItem) => `titan_${item.file.name}`;

const q = useCompressionQueue({
  fileType: 'video',
  isValidFile,
  processItem,
  buildDownloadName,
  onStop: () => { /* EngineRouter has no stop(); best-effort */ },
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

// ── 浏览器兼容检测 ────────────────────────────────────────────────
const webCodecsSupported = typeof window !== 'undefined' && 'VideoEncoder' in window;

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
  <div class="compressor-root video-compressor">
    <!-- Rejected toast -->
    <Transition name="toast">
      <div v-if="q.rejectedFiles.value.length > 0" class="toast-reject">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <span>{{ t('queue.unsupportedFormat') }}: {{ q.rejectedFiles.value.join(', ') }}</span>
      </div>
    </Transition>

    <input type="file" accept="video/*" multiple hidden ref="fileInputRef" @change="onFileInput" />

    <div class="app-body" :class="q.totalCount.value > 0 ? `mob-${mobileTab}` : ''">
      <!-- Sidebar -->
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
                    <span class="m-capsule time">{{ fmtTime(item.elapsed) }}</span>
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
                <button v-if="item.status !== 'processing'" class="qi-btn rm" @click.stop="q.removeItem(item.id)" :title="t('queue.remove')">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="sb-footer">
          <button class="add-files-btn" @click="fileInputRef?.click()" :disabled="q.isRunning.value">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            {{ t('queue.addFiles') }}
          </button>
          <button v-if="q.canStart.value" class="btn-primary" @click="q.processQueue">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
            {{ t('process.start') }}{{ q.pendingCount.value > 1 ? ` (${q.pendingCount.value})` : '' }}
          </button>
          <div v-if="q.isRunning.value" class="running-info">
            <div class="running-dot"></div>
            <span>{{ t('queue.processing') }}</span>
          </div>
          <div v-if="q.doneCount.value > 0 && !q.isRunning.value" class="footer-done-actions">
            <button class="btn-dl-all" @click="q.downloadAll">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {{ t('process.downloadAll', { n: q.doneCount.value }) }}
            </button>
            <button class="btn-clear" @click="q.clearAll">{{ t('queue.clearQueue') }}</button>
          </div>
        </div>
      </aside>

      <!-- Main stage -->
      <main class="stage" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
        <!-- 浏览器不支持 WebCodecs 时的前置提示 -->
        <div v-if="!webCodecsSupported" class="browser-compat-banner">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.8"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          <div class="bcb-text">
            <strong>{{ t('process.browserUnsupported') }}</strong>
            <span>{{ t('process.browserUnsupportedHint') }}</span>
          </div>
          <a href="https://www.google.com/chrome/" target="_blank" rel="noopener" class="bcb-cta">
            {{ currentLocale === 'zh' ? '下载 Chrome' : 'Get Chrome' }}
          </a>
        </div>
        <div v-if="q.totalCount.value === 0" class="drop-zone" :class="{ dragging: isDragging }" @click="fileInputRef?.click()">
          <div class="drop-content">
            <div class="drop-icon-wrap">
              <div class="drop-ring-outer"></div><div class="drop-ring"></div>
              <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
                <rect x="2" y="9" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/>
                <polygon points="22,13 32,8 32,26 22,21" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/>
              </svg>
            </div>
            <h2 class="drop-title">{{ t('process.dragToArea') }}</h2>
            <p class="drop-sub">{{ t('process.supportBatch') }}</p>
            <div class="drop-formats">
              <span v-for="f in ['MP4','MOV','MKV','AVI','WebM','FLV','WMV']" :key="f" class="fmt-tag">{{ f }}</span>
            </div>
            <div class="drop-features">
              <div class="feat-card">
                <div class="feat-icon-sm gpu"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/></svg></div>
                <div class="feat-txt"><div class="feat-title">{{ t('features.gpu.title') }}</div><div class="feat-desc">{{ t('features.gpu.desc') }}</div></div>
              </div>
              <div class="feat-divider"></div>
              <div class="feat-card">
                <div class="feat-icon-sm size"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
                <div class="feat-txt"><div class="feat-title">{{ t('features.size.title') }}</div><div class="feat-desc">{{ t('features.size.desc') }}</div></div>
              </div>
              <div class="feat-divider"></div>
              <div class="feat-card">
                <div class="feat-icon-sm privacy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
                <div class="feat-txt"><div class="feat-title">{{ t('features.privacy.title') }}</div><div class="feat-desc">{{ t('features.privacy.desc') }}</div></div>
              </div>
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
          <video :src="q.activeItem.value.originalUrl" class="preview-video" controls muted loop autoplay></video>
          <div v-if="q.activeItem.value.status === 'pending'" class="preview-tip">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v4l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            {{ t('process.configAndStart') }}
          </div>
        </div>

        <div v-if="q.activeItem.value && q.activeItem.value.status === 'done'" class="result-stage">
          <div class="slider-wrap">
            <ComparisonSlider :original-url="q.activeItem.value.originalUrl" :compressed-url="q.activeItem.value.compressedUrl" />
          </div>
        </div>

        <div v-if="q.activeItem.value && q.activeItem.value.status === 'error'" class="error-stage">
          <div class="error-card">
            <div class="err-icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </div>
            <h3 class="err-title">{{ t('process.encodingFailed') }}</h3>
            <p class="err-msg">{{ q.activeItem.value.errorMsg }}</p>
            <p class="err-hint">{{ t('process.errorHint') }}</p>
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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><polygon points="23 7 16 12 23 17 23 7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><rect x="1" y="5" width="15" height="14" rx="2" stroke="currentColor" stroke-width="2"/></svg>
        <span>{{ t('mode.video') }}</span>
        <span v-if="q.activeItem.value?.status === 'done'" class="mob-tab-dot"></span>
      </button>
    </nav>

    <!-- ═══ Settings overlay（视频独立）══════════════════════════════ -->
    <Transition name="settings">
      <div v-if="props.showSettings" class="settings-overlay" @click.self="closeSettings">
        <div class="settings-panel">
          <div class="sp-header">
            <div class="sp-title-row">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/></svg>
              <span class="sp-title">{{ t('config.title') }}</span>
            </div>
            <button class="sp-close" @click="closeSettings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>

          <div class="sp-section">
            <div class="sp-section-label">{{ t('config.codec') }}</div>
            <div class="codec-cards">
              <button v-for="opt in codecOptions" :key="opt.value" class="codec-card"
                :class="{ active: codec === opt.value }"
                @click="codec = opt.value" :disabled="q.isRunning.value">
                <span class="cc-badge" :class="{ active: codec === opt.value }">{{ opt.badge }}</span>
                <span class="cc-name">{{ opt.label }}</span>
                <span class="cc-desc">{{ t('config.' + (opt.value === 'libx264' ? 'bestCompatibility' : opt.value === 'libx265' ? 'highCompression' : 'nextGen')) }}</span>
              </button>
            </div>
          </div>

          <div class="sp-section">
            <div class="sp-section-label-row">
              <span class="sp-section-label">{{ t('config.qualityCRF') }}</span>
              <span class="quality-tag" :style="{ color: qualityLabel.color }">{{ qualityLabel.text }}</span>
            </div>
            <div class="crf-display">
              <span class="crf-num">{{ crf }}</span>
              <span class="crf-denom">/ 40</span>
            </div>
            <input type="range" class="crf-slider" v-model="crf" min="18" max="40" :disabled="q.isRunning.value" :style="crfSliderStyle" />
            <div class="crf-scale"><span>{{ t('config.fine') }}</span><span>{{ t('config.compress') }}</span></div>
          </div>

          <div class="sp-section">
            <span class="sp-section-label">{{ t('config.encodeSpeed') }}</span>
            <div class="preset-row">
              <button v-for="opt in presetOptions" :key="opt.value" class="preset-card"
                :class="{ active: preset === opt.value }"
                @click="preset = opt.value" :disabled="q.isRunning.value">
                <div class="preset-bars">
                  <div v-for="b in 4" :key="b" class="preset-bar" :class="{ lit: b <= opt.bars }"></div>
                </div>
                <span class="preset-name">{{ t('config.' + opt.value) }}</span>
                <span class="preset-desc">{{ t('config.' + (opt.value === 'ultrafast' ? 'largerFile' : opt.value === 'fast' ? 'recommended' : opt.value === 'medium' ? 'moreCompression' : 'bestQuality')) }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped src="./Dashboard.css"></style>
