<script setup lang="ts">
import { ref, computed, onUnmounted, onMounted, watch } from 'vue';
import { EngineRouter } from '../engine/engine-router';
import ComparisonSlider from './ComparisonSlider.vue';
import LoggerConsole from './LoggerConsole.vue';
import { t, currentLocale, setLocale } from '../locales/i18n';
import { logger } from '../engine/logger';

// ── Theme ─────────────────────────────────────────────────────────
const THEME_KEY = 'titan-theme';
const savedTheme = localStorage.getItem(THEME_KEY);
const isDark = ref(savedTheme ? savedTheme === 'dark' : true);
const applyTheme = () => document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
const toggleTheme = () => { isDark.value = !isDark.value; };
watch(isDark, (v) => { applyTheme(); localStorage.setItem(THEME_KEY, v ? 'dark' : 'light'); }, { immediate: true });

// ── Settings Panel ────────────────────────────────────────────────
const showSettings = ref(false);
const openSettings = () => { showSettings.value = true; };
const closeSettings = () => { showSettings.value = false; };

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') { showSettings.value = false; showLogger.value = false; }
};
onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));

// ── Queue Types ───────────────────────────────────────────────────
interface QueueItem {
  id: string; file: File; status: 'pending' | 'processing' | 'done' | 'error';
  progress: number; throughput: number; originalUrl: string;
  compressedUrl: string; compressedSize: number; errorMsg: string;
  engineUsed: string; startTime: number; elapsed: number; remaining: number;
}

// ── 文件格式验证 ─────────────────────────────────────────────────
const VALID_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/avi', 'video/webm', 'video/x-flv', 'video/x-ms-wmv', 'video/x-msvideo', 'video/3gpp', 'video/ogg']);
const VALID_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', '3gp', 'ogv', 'm4v', 'ts', 'mts']);
const rejectedFiles = ref<string[]>([]);

const isVideoFile = (f: File): boolean => {
  if (VALID_VIDEO_TYPES.has(f.type)) return true;
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  return VALID_EXTENSIONS.has(ext);
};

// ── State ─────────────────────────────────────────────────────────
const queue = ref<QueueItem[]>([]);
const activeItemId = ref<string | null>(null);
const isRunning = ref(false);
const isDragging = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

// ── Config ────────────────────────────────────────────────────────
const codec = ref<'libx264' | 'libx265' | 'av1'>('libx264');
const crf = ref(28);
const preset = ref<'ultrafast' | 'fast' | 'medium' | 'slow'>('fast');

const codecOptions = [
  { value: 'libx264', label: 'H.264', badge: 'AVC',  desc: '兼容性最佳' },
  { value: 'libx265', label: 'H.265', badge: 'HEVC', desc: '高效压缩' },
  { value: 'av1',     label: 'AV1',   badge: 'AV1',  desc: '次世代格式' },
] as const;

const presetOptions = [
  { value: 'ultrafast', label: '极速',  bars: 1, desc: '文件稍大' },
  { value: 'fast',      label: '快速',  bars: 2, desc: '均衡推荐' },
  { value: 'medium',    label: '标准',  bars: 3, desc: '更高压缩' },
  { value: 'slow',      label: '精细',  bars: 4, desc: '最优质量' },
] as const;

// ── Computed ──────────────────────────────────────────────────────
const activeItem = computed(() => queue.value.find(i => i.id === activeItemId.value) ?? null);
const pendingCount = computed(() => queue.value.filter(i => i.status === 'pending').length);
const doneCount = computed(() => queue.value.filter(i => i.status === 'done').length);
const totalCount = computed(() => queue.value.length);
const currentProcessing = computed(() => queue.value.find(i => i.status === 'processing') ?? null);
const canStart = computed(() => pendingCount.value > 0 && !isRunning.value);

const totalSavedMB = computed(() => {
  return queue.value
    .filter(i => i.status === 'done')
    .reduce((acc, i) => acc + (i.file.size - i.compressedSize), 0) / 1048576;
});

const qualityLabel = computed(() => {
  if (crf.value <= 20) return { text: t.value('config.visuallyLossless'), color: '#22c55e' };
  if (crf.value <= 26) return { text: t.value('config.highQuality'),       color: '#f97316' };
  if (crf.value <= 32) return { text: t.value('config.balanced'),          color: '#f59e0b' };
  return { text: t.value('config.highCompressRate'), color: '#ef4444' };
});

const crfSliderStyle = computed(() => {
  const pct = ((crf.value - 18) / (40 - 18)) * 100;
  return { background: `linear-gradient(to right, var(--c-accent) ${pct}%, var(--c-bg-elevated) ${pct}%)` };
});

const fileSizeMB = (bytes: number) => (bytes / 1048576).toFixed(1);
const statusPrefix = (item: QueueItem) => {
  if (item.status === 'processing') return '◌';
  if (item.status === 'done') return '✓';
  if (item.status === 'error') return '✕';
  return '○';
};
const compressionRatio = (item: QueueItem) =>
  item.compressedSize ? Math.round((1 - item.compressedSize / item.file.size) * 100) : 0;

// ── File Management ───────────────────────────────────────────────
const addFiles = (files: FileList | File[]) => {
  rejectedFiles.value = [];
  const all = Array.from(files);
  const valid = all.filter(isVideoFile);
  const invalid = all.filter(f => !isVideoFile(f));
  if (invalid.length > 0) {
    rejectedFiles.value = invalid.map(f => f.name);
    setTimeout(() => { rejectedFiles.value = []; }, 4000);
  }
  valid.forEach(file => {
    const item: QueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file, status: 'pending', progress: 0, throughput: 0,
      originalUrl: URL.createObjectURL(file),
      compressedUrl: '', compressedSize: 0, errorMsg: '', engineUsed: '',
      startTime: 0, elapsed: 0, remaining: 0,
    };
    queue.value.push(item);
    if (!activeItemId.value) activeItemId.value = item.id;
  });
};

const onFileInput = (e: Event) => {
  const files = (e.target as HTMLInputElement).files;
  if (files) addFiles(files);
  (e.target as HTMLInputElement).value = '';
};

const onDrop = (e: DragEvent) => {
  isDragging.value = false;
  e.preventDefault();
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
};

const onDragOver = (e: DragEvent) => { e.preventDefault(); isDragging.value = true; };
const onDragLeave = () => { isDragging.value = false; };

const removeItem = (id: string) => {
  const item = queue.value.find(i => i.id === id);
  if (!item || item.status === 'processing') return;
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

// ── Processing ────────────────────────────────────────────────────
const router = new EngineRouter();
const engineLoading = ref(false);
const routeInfo = ref('');

const fmtTime = (sec: number): string => {
  if (sec <= 0) return '--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`;
};

const processItem = async (item: QueueItem) => {
  item.status = 'processing';
  activeItemId.value = item.id;
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
      }
    );
    item.compressedSize = resultBlob.size;
    if (item.compressedUrl) URL.revokeObjectURL(item.compressedUrl);
    item.compressedUrl = URL.createObjectURL(resultBlob);
    item.elapsed = (Date.now() - item.startTime) / 1000;
    item.progress = 100;
    item.elapsedSec = Math.round((Date.now() - startTime) / 1000);
    item.status = 'done';
  } catch (e: any) {
    item.status = 'error';
    item.errorMsg = e.message || '处理失败';
    engineLoading.value = false;
  }
};

const processQueue = async () => {
  isRunning.value = true;
  for (const item of queue.value) {
    if (item.status !== 'pending') continue;
    await processItem(item);
    activeItemId.value = item.id;
  }
  isRunning.value = false;
};

const downloadItem = (item: QueueItem) => {
  if (!item.compressedUrl) return;
  const a = document.createElement('a');
  a.href = item.compressedUrl;
  a.download = `titan_${item.file.name}`;
  a.click();
};

const downloadAll = () => queue.value.filter(i => i.status === 'done').forEach(downloadItem);

const showLogger = ref(false);
const openDiagnosticLogs = () => {
  logger.info('system', 'User opened diagnostic console');
  showLogger.value = true;
};

onUnmounted(() => { router.terminate(); });
</script>

<template>
  <div class="app-shell">

    <!-- ═══ REJECTED FILES TOAST ════════════════════════════ -->
    <Transition name="toast">
      <div v-if="rejectedFiles.length > 0" class="toast-reject">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <span>{{ t('queue.unsupportedFormat') }}: {{ rejectedFiles.join(', ') }}</span>
      </div>
    </Transition>

    <!-- ═══ GLOBAL PROGRESS BAR ══════════════════════════════ -->
    <div class="global-bar" v-if="isRunning">
      <div class="global-bar-fill" :style="{ width: (currentProcessing?.progress ?? 0) + '%' }"></div>
    </div>

    <!-- ═══ HEADER ═══════════════════════════════════════════════ -->
    <header class="app-header">
      <div class="header-brand">
        <div class="brand-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/></svg>
        </div>
        <div>
          <span class="brand-name">TITAN COMPRESS</span>
          <span class="brand-sub">GPU ACCELERATED</span>
        </div>
      </div>

      <div class="header-center" v-if="isRunning && currentProcessing">
        <div class="hc-dot"></div>
        <span class="hc-label">{{ t('process.compressing') }}</span>
        <span class="hc-file">{{ currentProcessing.file.name }}</span>
        <span class="hc-sep">·</span>
        <span class="hc-rate">{{ currentProcessing.throughput.toFixed(1) }} MB/s</span>
        <span class="hc-sep">·</span>
        <span class="hc-prog">{{ currentProcessing.progress.toFixed(1) }}%</span>
        <span class="hc-sep">·</span>
        <span class="hc-prog">剩余 {{ fmtTime(currentProcessing.remaining) }}</span>
      </div>

      <div class="header-right">
        <!-- Utility buttons -->
        <button class="hdr-icon-btn" @click="openDiagnosticLogs" title="Diagnostic Logs">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 17l6-6-6-6m8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="hdr-icon-btn" @click="openSettings" title="Compression Settings" :class="{ active: showSettings }">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.8"/></svg>
        </button>

        <div class="hdr-divider"></div>

        <span class="header-badge">WebCodecs</span>
        <span class="header-badge accent-badge">10GB+</span>

        <div class="hdr-divider"></div>

        <!-- Theme toggle -->
        <button class="theme-switch" @click="toggleTheme" :title="isDark ? '切换亮色' : '切换暗色'">
          <div class="ts-track" :class="{ light: !isDark }">
            <div class="ts-thumb" :class="{ light: !isDark }">
              <svg v-if="isDark" width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/></svg>
              <svg v-else width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" fill="currentColor"/><line x1="12" y1="1" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="21" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="12" x2="3" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="21" y1="12" x2="23" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </div>
          </div>
        </button>
        <button class="hdr-locale-btn" @click="setLocale(currentLocale === 'en' ? 'zh' : 'en')">
          {{ currentLocale === 'en' ? '中' : 'EN' }}
        </button>
      </div>
    </header>

    <!-- Hidden file input lives outside sidebar so it persists when sidebar is hidden -->
    <input type="file" accept="video/*" multiple hidden ref="fileInputRef" @change="onFileInput" />

    <!-- ═══ BODY ══════════════════════════════════════════════════ -->
    <div class="app-body">

      <!-- ─── SIDEBAR ──────────────────────────────────────────── -->
      <aside v-if="totalCount > 0" class="sidebar">

        <!-- Session stats bar -->
        <div class="session-stats" v-if="totalCount > 0">
          <div class="stat-pill">
            <span class="stat-val">{{ totalCount }}</span>
            <span class="stat-key">FILES</span>
          </div>
          <div class="stat-pill" v-if="doneCount > 0">
            <span class="stat-val accent">{{ doneCount }}</span>
            <span class="stat-key">DONE</span>
          </div>
          <div class="stat-pill" v-if="doneCount > 0">
            <span class="stat-val accent">{{ totalSavedMB.toFixed(0) }}</span>
            <span class="stat-key">MB SAVED</span>
          </div>
        </div>

        <!-- Queue list -->
        <div class="queue-wrap">
          <div class="queue-header" v-if="totalCount > 0">
            <span class="queue-label">QUEUE</span>
            <div class="queue-badges">
              <span v-if="pendingCount > 0" class="q-badge pending">{{ pendingCount }} {{ t('queue.pending') }}</span>
            </div>
          </div>

          <div class="queue-list" v-if="totalCount > 0">
            <div
              v-for="item in queue"
              :key="item.id"
              class="queue-item"
              :class="{ active: activeItemId === item.id, [item.status]: true }"
              @click="activeItemId = item.id"
            >
              <div class="qi-info">
                <p class="qi-name">
                  <span class="qi-prefix" :class="item.status">{{ statusPrefix(item) }}</span>{{ item.file.name }}
                </p>
                <div class="qi-meta">
                  <template v-if="item.status === 'done'">
                    <span>{{ fileSizeMB(item.file.size) }}</span>
                    <span class="qi-arrow">→</span>
                    <span class="qi-size-comp">{{ fileSizeMB(item.compressedSize) }} MB</span>
                    <span class="qi-ratio">↓{{ compressionRatio(item) }}%</span>
                    <span v-if="item.elapsedSec" class="qi-time">{{ item.elapsedSec }}s</span>
                  </template>
                  <template v-else>
                    <span>{{ fileSizeMB(item.file.size) }} MB</span>
                    <span v-if="item.status === 'error'" class="qi-err">ERR</span>
                  </template>
                </div>
                <div v-if="item.status === 'processing'" class="qi-progress-bar">
                  <div class="qi-progress-fill" :style="{ width: item.progress + '%' }"></div>
                </div>
              </div>
              <div class="qi-actions">
                <button v-if="item.status === 'done'" class="qi-btn dl" @click.stop="downloadItem(item)" title="下载">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button v-if="item.status !== 'processing'" class="qi-btn rm" @click.stop="removeItem(item.id)" title="移除">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- Empty state inside queue wrap -->
          <div v-if="totalCount === 0" class="queue-empty">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" opacity="0.2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" stroke="currentColor" stroke-width="1.5"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5"/></svg>
            <span>{{ t('queue.empty') }}</span>
          </div>
        </div>

        <!-- Sidebar footer -->
        <div class="sb-footer">
          <button class="add-files-btn" @click="fileInputRef?.click()" :disabled="isRunning">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            {{ t('queue.addFiles') }}
          </button>

          <button v-if="canStart" class="btn-primary" @click="processQueue">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
            {{ t('process.start') }}{{ pendingCount > 1 ? ` (${pendingCount})` : '' }}
          </button>

          <div v-if="isRunning" class="running-info">
            <div class="running-dot"></div>
            <span>{{ t('queue.processing') }}</span>
          </div>

          <div v-if="doneCount > 0 && !isRunning" class="footer-done-actions">
            <button class="btn-dl-all" @click="downloadAll">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {{ t('process.downloadAll', { n: doneCount }) }}
            </button>
            <button class="btn-clear" @click="clearAll">{{ t('queue.clearQueue') }}</button>
          </div>
        </div>
      </aside>

      <!-- ─── MAIN STAGE ─────────────────────────────────────── -->
      <main class="stage" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">

        <!-- Empty: drop zone -->
        <div v-if="totalCount === 0" class="drop-zone" :class="{ dragging: isDragging }" @click="fileInputRef?.click()">
          <div class="drop-content">
            <div class="drop-icon-wrap">
              <div class="drop-ring-outer"></div>
              <div class="drop-ring"></div>
              <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
                <line x1="17" y1="2" x2="17" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="17" y1="25" x2="17" y2="32" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="2" y1="17" x2="9" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="25" y1="17" x2="32" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <circle cx="17" cy="17" r="6" stroke="currentColor" stroke-width="1.5"/>
                <circle cx="17" cy="17" r="2" fill="currentColor"/>
              </svg>
            </div>
            <h2 class="drop-title">{{ t('process.dragToArea') }}</h2>
            <p class="drop-sub">{{ t('process.supportBatch') }}</p>
            <div class="drop-formats">
              <span v-for="f in ['MP4','MOV','MKV','AVI','WebM','FLV','WMV']" :key="f" class="fmt-tag">{{ f }}</span>
            </div>
            <button class="btn-ghost" @click.stop="fileInputRef?.click()">{{ t('process.orClick') }}</button>
          </div>
        </div>

        <!-- Drag overlay when queue has items -->
        <div v-if="totalCount > 0 && isDragging" class="drag-overlay">
          <div class="drag-overlay-inner">
            <svg width="32" height="32" viewBox="0 0 34 34" fill="none">
              <line x1="17" y1="2" x2="17" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="17" y1="25" x2="17" y2="32" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="2" y1="17" x2="9" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="25" y1="17" x2="32" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="17" cy="17" r="6" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="17" cy="17" r="2" fill="currentColor"/>
            </svg>
            <p>{{ t('queue.dropToAdd') }}</p>
          </div>
        </div>

        <!-- No active item -->
        <div v-if="totalCount > 0 && !activeItem && !isDragging" class="stage-hint">
          <p>{{ t('process.clickToPreview') }}</p>
        </div>

        <!-- Pending: preview original -->
        <div v-if="activeItem && activeItem.status === 'pending'" class="preview-stage">
          <div class="preview-header">
            <span class="preview-badge">{{ t('slider.original') }}</span>
            <span class="preview-meta">{{ activeItem.file.name }} · {{ fileSizeMB(activeItem.file.size) }} MB</span>
          </div>
          <video :src="activeItem.originalUrl" class="preview-video" controls muted loop autoplay></video>
          <div class="preview-tip">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v4l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            {{ t('process.configAndStart') }}
          </div>
        </div>

        <!-- Processing -->
        <div v-if="activeItem && activeItem.status === 'processing'" class="processing-stage">
          <div class="proc-center">
            <div class="proc-ring-outer">
              <div class="proc-ring-inner">
                <svg class="proc-spin" width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </div>
            </div>
            <div class="proc-info">
              <h2 class="proc-title">{{ engineLoading ? t('process.loadingEngine') : t('process.compressing') }}</h2>
              <p class="proc-file">{{ activeItem.file.name }}</p>
              <p class="proc-queue-hint" v-if="pendingCount > 0">{{ t('process.filesInQueue', { n: pendingCount }) }}</p>
            </div>
            <div class="prog-wrap">
              <div class="prog-track">
                <div class="prog-fill" :style="{ width: activeItem.progress + '%' }">
                  <div class="prog-shine"></div>
                </div>
              </div>
              <div class="prog-labels">
                <span class="prog-pct">{{ activeItem.progress.toFixed(1) }}%</span>
                <span class="prog-rate">{{ activeItem.throughput.toFixed(1) }} MB/s</span>
              </div>
            </div>
            <div class="metrics-row">
              <div class="mc">
                <span class="mc-val">{{ codec.toUpperCase() }}</span>
                <span class="mc-unit">CODEC</span>
              </div>
              <div class="mc">
                <span class="mc-val">CRF {{ crf }}</span>
                <span class="mc-unit">QUALITY</span>
              </div>
              <div class="mc">
                <span class="mc-val accent">{{ activeItem.throughput.toFixed(1) }}</span>
                <span class="mc-unit">MB/s</span>
              </div>
              <div class="mc">
                <span class="mc-val">{{ fmtTime(activeItem.remaining) }}</span>
                <span class="mc-unit">剩余时间</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Done: comparison slider -->
        <div v-if="activeItem && activeItem.status === 'done'" class="result-stage">
<<<<<<< HEAD
          <div class="result-header">
            <div class="result-stats">
              <span class="rs-item original">原始 {{ fileSizeMB(activeItem.file.size) }} MB</span>
              <span class="rs-arrow">→</span>
              <span class="rs-item compressed">压缩后 {{ fileSizeMB(activeItem.compressedSize) }} MB</span>
              <span class="rs-badge">节省 {{ compressionRatio(activeItem) }}%</span>
              <span class="rs-badge">耗时 {{ fmtTime(activeItem.elapsed) }}</span>
            </div>
            <button class="btn-dl-single" @click="downloadItem(activeItem)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              下载此文件
            </button>
          </div>
=======
>>>>>>> 857c33a4a94ad43fa06d2aea368ad09766333f6d
          <div class="slider-wrap">
            <ComparisonSlider :original-url="activeItem.originalUrl" :compressed-url="activeItem.compressedUrl" />
          </div>
        </div>

        <!-- Error -->
        <div v-if="activeItem && activeItem.status === 'error'" class="error-stage">
          <div class="error-card">
            <div class="err-icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </div>
            <h3 class="err-title">{{ t('process.encodingFailed') }}</h3>
            <p class="err-msg">{{ activeItem.errorMsg }}</p>
            <p class="err-hint">{{ t('process.errorHint') }}</p>
          </div>
        </div>

      </main>
    </div>

    <!-- ═══ SETTINGS OVERLAY ══════════════════════════════════════ -->
    <Transition name="settings">
      <div v-if="showSettings" class="settings-overlay" @click.self="closeSettings">
        <div class="settings-panel">

          <!-- Panel header -->
          <div class="sp-header">
            <div class="sp-title-row">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.8"/></svg>
              <span class="sp-title">COMPRESSION SETTINGS</span>
            </div>
            <button class="sp-close" @click="closeSettings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>

          <!-- Codec -->
          <div class="sp-section">
            <div class="sp-section-label">CODEC</div>
            <div class="codec-cards">
              <button
                v-for="opt in codecOptions"
                :key="opt.value"
                class="codec-card"
                :class="{ active: codec === opt.value }"
                @click="codec = opt.value"
                :disabled="isRunning"
              >
                <span class="cc-badge" :class="{ active: codec === opt.value }">{{ opt.badge }}</span>
                <span class="cc-name">{{ opt.label }}</span>
                <span class="cc-desc">{{ t('config.' + (opt.value === 'libx264' ? 'bestCompatibility' : opt.value === 'libx265' ? 'highCompression' : 'nextGen')) }}</span>
              </button>
            </div>
          </div>

          <!-- CRF -->
          <div class="sp-section">
            <div class="sp-section-label-row">
              <span class="sp-section-label">{{ t('config.qualityCRF') }}</span>
              <span class="quality-tag" :style="{ color: qualityLabel.color }">{{ qualityLabel.text }}</span>
            </div>
            <div class="crf-display">
              <span class="crf-num">{{ crf }}</span>
              <span class="crf-denom">/ 40</span>
            </div>
            <input type="range" class="crf-slider" v-model="crf" min="18" max="40" :disabled="isRunning" :style="crfSliderStyle" />
            <div class="crf-scale">
              <span>{{ t('config.fine') }}</span>
              <span>{{ t('config.compress') }}</span>
            </div>
          </div>

          <!-- Preset -->
          <div class="sp-section">
            <span class="sp-section-label">{{ t('config.encodeSpeed') }}</span>
            <div class="preset-row">
              <button
                v-for="opt in presetOptions"
                :key="opt.value"
                class="preset-card"
                :class="{ active: preset === opt.value }"
                @click="preset = opt.value"
                :disabled="isRunning"
              >
                <div class="preset-bars">
                  <div v-for="b in 4" :key="b" class="preset-bar" :class="{ lit: b <= opt.bars }"></div>
                </div>
                <span class="preset-name">{{ t('config.' + opt.value) }}</span>
                <span class="preset-desc">{{ t('config.' + (opt.value === 'ultrafast' ? 'largerFile' : opt.value === 'fast' ? 'recommended' : opt.value === 'medium' ? 'moreCompression' : 'bestQuality')) }}</span>
              </button>
            </div>
          </div>

          <!-- Coming soon -->
          <div class="sp-coming-soon">
            <div class="cs-label">COMING SOON</div>
            <div class="cs-slots">
              <div class="cs-slot">Resolution Scale</div>
              <div class="cs-slot">Audio Track</div>
              <div class="cs-slot">Metadata Strip</div>
            </div>
          </div>

        </div>
      </div>
    </Transition>

    <!-- ═══ LOGGER CONSOLE ═════════════════════════════════════ -->
    <LoggerConsole :show="showLogger" @close="showLogger = false" />
  </div>
</template>

<style scoped>
/* ── Shell ─────────────────────────────────────────────────────── */
.app-shell { width: 100vw; height: 100vh; display: flex; flex-direction: column; background: var(--c-bg-base); overflow: hidden; position: relative; }

/* ── Global Progress Bar ────────────────────────────────────────── */
.global-bar { position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 200; background: transparent; }
.global-bar-fill { height: 100%; background: linear-gradient(90deg, var(--c-accent), #fbbf24); transition: width 0.4s var(--ease-out); box-shadow: 0 0 10px var(--c-accent); }

/* ── Header ────────────────────────────────────────────────────── */
.app-header { height: 50px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 var(--sp-lg); border-bottom: 1px solid var(--c-border); background: var(--c-bg-surface); z-index: 50; }
.header-brand { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.brand-icon { width: 28px; height: 28px; border-radius: var(--r-sm); background: var(--c-accent); display: flex; align-items: center; justify-content: center; color: white; flex-shrink: 0; box-shadow: 0 0 12px rgba(249,115,22,0.4); }
.brand-name { display: block; font-family: 'Space Grotesk', sans-serif; font-size: 0.82rem; font-weight: 700; letter-spacing: 0.06em; color: var(--c-text-primary); }
.brand-sub { display: block; font-family: 'JetBrains Mono', monospace; font-size: 0.52rem; font-weight: 500; color: var(--c-text-muted); letter-spacing: 0.12em; }

.header-center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; min-width: 0; }
.hc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-accent); box-shadow: 0 0 6px var(--c-accent); animation: blink 1.2s ease-in-out infinite; flex-shrink: 0; }
.hc-label { font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.1em; color: var(--c-accent); }
.hc-file { font-size: 0.73rem; color: var(--c-text-secondary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'JetBrains Mono', monospace; }
.hc-sep { color: var(--c-text-muted); font-size: 0.6rem; }
.hc-rate, .hc-prog { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; font-weight: 600; color: var(--c-text-primary); }

.header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.hdr-divider { width: 1px; height: 16px; background: var(--c-border); margin: 0 2px; }
.header-badge { font-family: 'JetBrains Mono', monospace; font-size: 0.58rem; font-weight: 700; letter-spacing: 0.05em; padding: 3px 7px; border-radius: var(--r-sm); background: var(--c-bg-overlay); border: 1px solid var(--c-border); color: var(--c-text-muted); }
.header-badge.accent-badge { background: var(--c-accent-subtle); border-color: var(--c-border-accent); color: var(--c-text-accent); }

.hdr-icon-btn { width: 30px; height: 30px; border-radius: var(--r-sm); display: flex; align-items: center; justify-content: center; background: none; color: var(--c-text-muted); transition: all var(--dur-fast); }
.hdr-icon-btn:hover { background: var(--c-bg-hover); color: var(--c-text-secondary); }
.hdr-icon-btn.active { background: var(--c-accent-subtle); color: var(--c-accent); border: 1px solid var(--c-border-accent); }

.hdr-locale-btn { font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; font-weight: 700; padding: 4px 8px; border-radius: var(--r-sm); background: none; color: var(--c-text-muted); transition: all var(--dur-fast); }
.hdr-locale-btn:hover { background: var(--c-bg-hover); color: var(--c-text-secondary); }

.theme-switch { display: flex; align-items: center; background: none; border: none; cursor: pointer; padding: 4px; border-radius: var(--r-sm); transition: background var(--dur-fast); }
.theme-switch:hover { background: var(--c-bg-hover); }
.ts-track { width: 42px; height: 22px; border-radius: var(--r-full); background: var(--c-bg-elevated); border: 1px solid var(--c-border); display: flex; align-items: center; padding: 2px; transition: all var(--dur-normal) var(--ease-out); }
.ts-track.light { background: var(--c-accent-subtle); border-color: var(--c-border-accent); }
.ts-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--c-accent); color: white; display: flex; align-items: center; justify-content: center; transform: translateX(20px); transition: transform var(--dur-normal) var(--ease-spring); }
.ts-thumb.light { transform: translateX(0); }

/* ── App Body ──────────────────────────────────────────────────── */
.app-body { flex: 1; display: flex; overflow: hidden; min-height: 0; }

/* ── Sidebar ────────────────────────────────────────────────────── */
.sidebar { width: 272px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--c-border); background: var(--c-bg-surface); }

/* Session stats */
.session-stats { display: flex; gap: 6px; padding: var(--sp-md) var(--sp-md) var(--sp-sm); flex-shrink: 0; }
.stat-pill { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 12px; border-radius: var(--r-sm); background: var(--c-bg-elevated); border: 1px solid var(--c-border); flex: 1; }
.stat-val { font-family: 'JetBrains Mono', monospace; font-size: 1rem; font-weight: 700; color: var(--c-text-primary); line-height: 1; }
.stat-val.accent { color: var(--c-accent); }
.stat-key { font-family: 'JetBrains Mono', monospace; font-size: 0.5rem; font-weight: 700; letter-spacing: 0.1em; color: var(--c-text-muted); }

/* Queue wrap */
.queue-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 var(--sp-sm) var(--sp-sm); overflow: hidden; }
.queue-header { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-sm) var(--sp-sm) 6px; flex-shrink: 0; }
.queue-label { font-family: 'JetBrains Mono', monospace; font-size: 0.58rem; font-weight: 700; letter-spacing: 0.12em; color: var(--c-text-muted); }
.queue-badges { display: flex; gap: 4px; }
.q-badge { font-size: 0.58rem; font-weight: 700; padding: 2px 7px; border-radius: var(--r-full); font-family: 'JetBrains Mono', monospace; }
.q-badge.pending { background: var(--c-bg-elevated); color: var(--c-text-muted); border: 1px solid var(--c-border); }

.queue-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; scrollbar-width: thin; scrollbar-color: var(--c-bg-elevated) transparent; }
.queue-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--r-md); border: 1px solid var(--c-border); background: var(--c-bg-overlay); cursor: pointer; transition: all var(--dur-fast) var(--ease-out); flex-shrink: 0; }
.queue-item:hover { background: var(--c-bg-hover); border-color: var(--c-border-strong); }
.queue-item.active { background: var(--c-accent-subtle); border-color: var(--c-border-accent); }

.qi-prefix { font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; flex-shrink: 0; margin-right: 3px; }
.qi-prefix.pending { color: var(--c-text-muted); }
.qi-prefix.processing { color: var(--c-accent); display: inline-block; animation: spin 1.5s linear infinite; }
.qi-prefix.done { color: var(--c-success); }
.qi-prefix.error { color: var(--c-danger); }

.qi-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qi-name { font-size: 0.73rem; font-weight: 600; color: var(--c-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qi-meta { display: flex; gap: 5px; align-items: center; font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; color: var(--c-text-muted); flex-wrap: wrap; }
.qi-arrow { color: var(--c-text-muted); }
.qi-size-comp { color: var(--c-success); font-weight: 600; }
.qi-ratio { color: var(--c-accent); font-weight: 700; }
.qi-time { color: var(--c-text-muted); }
.qi-err { color: var(--c-danger); font-weight: 700; }
.qi-progress-bar { height: 2px; background: var(--c-bg-elevated); border-radius: 2px; overflow: hidden; margin-top: 2px; }
.qi-progress-fill { height: 100%; background: var(--c-accent); border-radius: 2px; transition: width 0.3s var(--ease-out); }

.qi-actions { display: flex; gap: 2px; flex-shrink: 0; }
.qi-btn { width: 22px; height: 22px; border-radius: var(--r-sm); display: flex; align-items: center; justify-content: center; background: none; transition: all var(--dur-fast); }
.qi-btn.dl { color: var(--c-text-muted); }
.qi-btn.dl:hover { background: var(--c-accent-subtle); color: var(--c-accent); }
.qi-btn.rm { color: var(--c-text-muted); }
.qi-btn.rm:hover { background: var(--c-danger-subtle); color: var(--c-danger); }

/* Queue empty */
.queue-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--c-text-muted); font-size: 0.75rem; font-family: 'JetBrains Mono', monospace; }

/* Sidebar Footer */
.sb-footer { padding: var(--sp-sm) var(--sp-md) var(--sp-md); border-top: 1px solid var(--c-border); display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.add-files-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 8px; border-radius: var(--r-md); background: var(--c-bg-overlay); border: 1px dashed var(--c-border-strong); color: var(--c-text-secondary); font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all var(--dur-normal) var(--ease-out); }
.add-files-btn:hover:not(:disabled) { background: var(--c-bg-hover); border-color: var(--c-border-accent); color: var(--c-text-accent); }
.add-files-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-primary { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 11px; border-radius: var(--r-md); background: var(--c-accent); color: white; font-family: 'Space Grotesk', sans-serif; font-size: 0.88rem; font-weight: 700; letter-spacing: 0.02em; border: none; cursor: pointer; transition: all var(--dur-normal) var(--ease-out); }
.btn-primary:hover:not(:disabled) { background: var(--c-accent-hover); box-shadow: var(--shadow-glow); transform: translateY(-1px); }
.btn-primary:active:not(:disabled) { transform: translateY(0); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

.running-info { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 10px; border-radius: var(--r-md); background: var(--c-bg-overlay); border: 1px solid var(--c-border); font-size: 0.73rem; color: var(--c-text-secondary); font-family: 'JetBrains Mono', monospace; }
.running-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-accent); box-shadow: 0 0 6px var(--c-accent); animation: blink 1.2s ease-in-out infinite; flex-shrink: 0; }

.footer-done-actions { display: flex; flex-direction: column; gap: 5px; }
.btn-dl-all { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; padding: 9px; border-radius: var(--r-md); background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.3); color: var(--c-success); font-size: 0.78rem; font-weight: 700; cursor: pointer; transition: all var(--dur-normal); }
.btn-dl-all:hover { background: rgba(34,197,94,0.16); }
.btn-clear { display: flex; align-items: center; justify-content: center; width: 100%; padding: 8px; border-radius: var(--r-md); background: none; border: 1px solid var(--c-border); color: var(--c-text-muted); font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: all var(--dur-normal); }
.btn-clear:hover { border-color: var(--c-danger); color: var(--c-danger); background: var(--c-danger-subtle); }

/* ── Stage ──────────────────────────────────────────────────────── */
.stage {
  flex: 1; display: flex; position: relative; overflow: hidden;
  background-image: radial-gradient(circle, rgba(249,115,22,0.09) 1px, transparent 1px);
  background-size: 24px 24px;
}

/* Drop Zone — edge-to-edge, no border, no radius */
.drop-zone {
  flex: 1; display: flex; align-items: center; justify-content: center;
  cursor: pointer; position: relative; overflow: hidden;
  transition: background var(--dur-normal) var(--ease-out);
}

/* Corner bracket marks */
.drop-zone::before {
  content: '';
  position: absolute;
  inset: 20px;
  background:
    linear-gradient(var(--c-accent) 0 0) top left    / 28px 1.5px no-repeat,
    linear-gradient(var(--c-accent) 0 0) top left    / 1.5px 28px no-repeat,
    linear-gradient(var(--c-accent) 0 0) top right   / 28px 1.5px no-repeat,
    linear-gradient(var(--c-accent) 0 0) top right   / 1.5px 28px no-repeat,
    linear-gradient(var(--c-accent) 0 0) bottom left  / 28px 1.5px no-repeat,
    linear-gradient(var(--c-accent) 0 0) bottom left  / 1.5px 28px no-repeat,
    linear-gradient(var(--c-accent) 0 0) bottom right / 28px 1.5px no-repeat,
    linear-gradient(var(--c-accent) 0 0) bottom right / 1.5px 28px no-repeat;
  pointer-events: none;
  opacity: 0.22;
  transition: opacity var(--dur-normal) var(--ease-out);
}

/* Center radial glow — hidden by default */
.drop-zone::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 50% 50%, rgba(249,115,22,0.13) 0%, rgba(249,115,22,0.05) 38%, transparent 68%);
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--dur-normal) var(--ease-out);
}

.drop-zone:hover::before { opacity: 0.9; }
.drop-zone:hover::after  { opacity: 1; }
.drop-zone.dragging::before { opacity: 1; }
.drop-zone.dragging::after {
  background: radial-gradient(ellipse at 50% 50%, rgba(249,115,22,0.22) 0%, rgba(249,115,22,0.08) 40%, transparent 68%);
  opacity: 1;
  animation: dz-breathe 1.4s ease-in-out infinite;
}

.drop-content { display: flex; flex-direction: column; align-items: center; gap: var(--sp-md); text-align: center; padding: var(--sp-2xl); pointer-events: none; position: relative; z-index: 1; }
.drop-zone .btn-ghost { pointer-events: all; }
.drop-icon-wrap { position: relative; width: 88px; height: 88px; display: flex; align-items: center; justify-content: center; color: var(--c-accent); }
.drop-ring-outer { position: absolute; inset: -18px; border-radius: 50%; border: 1px solid rgba(249,115,22,0.18); animation: pulse-ring 3.8s ease-in-out infinite reverse; }
.drop-ring { position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid rgba(249,115,22,0.55); animation: pulse-ring 2.4s ease-in-out infinite; box-shadow: 0 0 18px rgba(249,115,22,0.18); }
.drop-zone:hover .drop-ring { border-color: rgba(249,115,22,0.9); box-shadow: 0 0 28px rgba(249,115,22,0.45), 0 0 8px rgba(249,115,22,0.3); }
.drop-title { font-family: 'Space Grotesk', sans-serif; font-size: 1.4rem; font-weight: 700; letter-spacing: -0.02em; color: var(--c-text-primary); }
.drop-sub { font-size: 0.83rem; color: var(--c-text-secondary); max-width: 380px; line-height: 1.6; }
.drop-formats { display: flex; gap: 5px; flex-wrap: wrap; justify-content: center; }
.fmt-tag { font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; font-weight: 700; padding: 3px 8px; border-radius: var(--r-sm); background: var(--c-bg-elevated); border: 1px solid var(--c-border); color: var(--c-text-muted); letter-spacing: 0.05em; transition: all var(--dur-fast); }
.drop-zone:hover .fmt-tag, .drop-zone.dragging .fmt-tag { border-color: var(--c-border-accent); color: var(--c-text-accent); background: var(--c-accent-subtle); }
.btn-ghost { display: inline-flex; align-items: center; gap: 6px; padding: 9px 20px; border-radius: var(--r-full); background: var(--c-bg-overlay); border: 1px solid var(--c-border-strong); color: var(--c-text-secondary); font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: all var(--dur-normal); }
.btn-ghost:hover { background: var(--c-accent-subtle); border-color: var(--c-border-accent); color: var(--c-text-accent); }

/* Drag Overlay — full bleed, no radius */
.drag-overlay { position: absolute; inset: 0; z-index: 30; pointer-events: none; display: flex; align-items: center; justify-content: center; }
.drag-overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(249,115,22,0.07);
  backdrop-filter: blur(2px);
}
.drag-overlay::after {
  content: '';
  position: absolute;
  inset: 16px;
  background:
    linear-gradient(var(--c-accent) 0 0) top left    / 32px 2px no-repeat,
    linear-gradient(var(--c-accent) 0 0) top left    / 2px 32px no-repeat,
    linear-gradient(var(--c-accent) 0 0) top right   / 32px 2px no-repeat,
    linear-gradient(var(--c-accent) 0 0) top right   / 2px 32px no-repeat,
    linear-gradient(var(--c-accent) 0 0) bottom left  / 32px 2px no-repeat,
    linear-gradient(var(--c-accent) 0 0) bottom left  / 2px 32px no-repeat,
    linear-gradient(var(--c-accent) 0 0) bottom right / 32px 2px no-repeat,
    linear-gradient(var(--c-accent) 0 0) bottom right / 2px 32px no-repeat;
  animation: dz-breathe 1.2s ease-in-out infinite;
}
.drag-overlay-inner { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: var(--sp-md); color: var(--c-accent); }
.drag-overlay-inner p { font-family: 'JetBrains Mono', monospace; font-size: 0.88rem; font-weight: 600; color: var(--c-text-accent); letter-spacing: 0.05em; }

/* Stage Hint */
.stage-hint { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--c-text-muted); font-size: 0.82rem; }

/* Preview Stage */
.preview-stage { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: var(--sp-lg); overflow: hidden; }
.preview-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.preview-badge { font-family: 'JetBrains Mono', monospace; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.1em; padding: 4px 9px; border-radius: var(--r-sm); background: var(--c-bg-elevated); border: 1px solid var(--c-border); color: var(--c-text-muted); }
.preview-meta { font-family: 'JetBrains Mono', monospace; font-size: 0.73rem; color: var(--c-text-muted); }
.preview-video { flex: 1; width: 100%; min-height: 0; object-fit: contain; background: #000; }
.preview-tip { display: flex; align-items: center; gap: 6px; justify-content: center; font-size: 0.73rem; color: var(--c-text-muted); padding: 4px; flex-shrink: 0; }

/* Processing Stage */
.processing-stage { flex: 1; display: flex; align-items: center; justify-content: center; }
.proc-center { display: flex; flex-direction: column; align-items: center; gap: var(--sp-xl); text-align: center; width: 100%; max-width: 480px; padding: var(--sp-2xl); }
.proc-ring-outer { width: 100px; height: 100px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1.5px solid rgba(249,115,22,0.4); animation: pulse-ring 2.5s ease-in-out infinite; }
.proc-ring-inner { width: 68px; height: 68px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--c-accent-subtle); color: var(--c-accent); border: 1px solid var(--c-border-accent); }
.proc-spin { animation: spin 3s linear infinite; }
.proc-title { font-family: 'Space Grotesk', sans-serif; font-size: 1.6rem; font-weight: 700; letter-spacing: 0.06em; color: var(--c-text-primary); }
.proc-file { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--c-text-muted); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proc-queue-hint { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; color: var(--c-text-muted); padding: 4px 12px; border-radius: var(--r-full); background: var(--c-bg-elevated); border: 1px solid var(--c-border); }
.prog-wrap { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.prog-track { width: 100%; height: 5px; background: var(--c-bg-elevated); border-radius: var(--r-full); overflow: hidden; }
.prog-fill { height: 100%; background: linear-gradient(90deg, var(--c-accent), #fbbf24); border-radius: var(--r-full); transition: width 0.4s var(--ease-out); position: relative; overflow: hidden; }
.prog-shine { position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent); animation: shine 2s ease-in-out infinite; }
.prog-labels { display: flex; justify-content: space-between; }
.prog-pct { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; font-weight: 700; color: var(--c-text-primary); }
.prog-rate { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--c-text-muted); }
.metrics-row { display: flex; gap: var(--sp-sm); width: 100%; }
.mc { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: var(--sp-md); border-radius: var(--r-md); background: var(--c-bg-elevated); border: 1px solid var(--c-border); }
.mc-val { font-family: 'JetBrains Mono', monospace; font-size: 0.95rem; font-weight: 700; color: var(--c-text-primary); }
.mc-val.accent { color: var(--c-accent); }
.mc-unit { font-family: 'JetBrains Mono', monospace; font-size: 0.55rem; color: var(--c-text-muted); font-weight: 600; letter-spacing: 0.08em; }

/* Result Stage */
.result-stage { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.slider-wrap { flex: 1; min-height: 0; overflow: hidden; }

/* Error Stage */
.error-stage { flex: 1; display: flex; align-items: center; justify-content: center; }
.error-card { display: flex; flex-direction: column; align-items: center; gap: var(--sp-md); padding: var(--sp-2xl); border-radius: var(--r-xl); background: var(--c-bg-elevated); border: 1px solid rgba(239,68,68,0.25); max-width: 360px; text-align: center; }
.err-icon { width: 56px; height: 56px; border-radius: 50%; background: var(--c-danger-subtle); color: var(--c-danger); display: flex; align-items: center; justify-content: center; }
.err-title { font-family: 'Space Grotesk', sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.04em; color: var(--c-text-primary); }
.err-msg { font-size: 0.8rem; color: var(--c-text-secondary); line-height: 1.6; word-break: break-all; font-family: 'JetBrains Mono', monospace; }
.err-hint { font-size: 0.7rem; color: var(--c-text-muted); line-height: 1.6; padding: 10px 14px; border-radius: var(--r-sm); background: var(--c-bg-overlay); border: 1px solid var(--c-border); }

/* ── Settings Overlay ───────────────────────────────────────────── */
.settings-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
}

.settings-panel {
  width: 520px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  background: var(--c-bg-surface);
  border: 1px solid var(--c-border-accent);
  border-radius: var(--r-xl);
  box-shadow: 0 32px 80px rgba(0,0,0,0.5), 0 0 40px rgba(249,115,22,0.1);
  scrollbar-width: thin;
  scrollbar-color: var(--c-bg-elevated) transparent;
}

/* Panel header */
.sp-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--c-border);
  position: sticky; top: 0; background: var(--c-bg-surface); z-index: 1;
}
.sp-title-row { display: flex; align-items: center; gap: 8px; color: var(--c-accent); }
.sp-title { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; color: var(--c-text-secondary); }
.sp-close { width: 28px; height: 28px; border-radius: var(--r-sm); display: flex; align-items: center; justify-content: center; background: none; color: var(--c-text-muted); transition: all var(--dur-fast); }
.sp-close:hover { background: var(--c-bg-elevated); color: var(--c-text-primary); }

/* Panel sections */
.sp-section { padding: 20px; border-bottom: 1px solid var(--c-border); display: flex; flex-direction: column; gap: 12px; }
.sp-section-label { font-family: 'JetBrains Mono', monospace; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.14em; color: var(--c-text-muted); }
.sp-section-label-row { display: flex; align-items: center; justify-content: space-between; }
.quality-tag { font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; font-weight: 700; }

/* Codec cards */
.codec-cards { display: flex; gap: 8px; }
.codec-card {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 14px 10px; border-radius: var(--r-md);
  background: var(--c-bg-overlay); border: 1px solid var(--c-border);
  cursor: pointer; transition: all var(--dur-normal) var(--ease-out);
}
.codec-card:hover:not(:disabled) { background: var(--c-bg-hover); border-color: var(--c-border-strong); }
.codec-card.active { background: var(--c-accent-subtle); border-color: var(--c-border-accent); box-shadow: 0 0 16px rgba(249,115,22,0.12); }
.codec-card:disabled { opacity: 0.4; cursor: not-allowed; }
.cc-badge { font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; font-weight: 800; letter-spacing: 0.06em; padding: 3px 8px; border-radius: var(--r-sm); background: var(--c-bg-elevated); color: var(--c-text-muted); border: 1px solid var(--c-border); }
.cc-badge.active { background: var(--c-accent); color: white; border-color: var(--c-accent); }
.cc-name { font-size: 0.85rem; font-weight: 700; color: var(--c-text-primary); }
.cc-desc { font-size: 0.65rem; color: var(--c-text-muted); text-align: center; }

/* CRF */
.crf-display { display: flex; align-items: baseline; justify-content: center; gap: 4px; }
.crf-num { font-family: 'JetBrains Mono', monospace; font-size: 3.5rem; font-weight: 800; color: var(--c-text-primary); line-height: 1; }
.crf-denom { font-family: 'JetBrains Mono', monospace; font-size: 1rem; font-weight: 500; color: var(--c-text-muted); }
.crf-slider { width: 100%; height: 4px; appearance: none; -webkit-appearance: none; border-radius: 2px; cursor: pointer; }
.crf-slider::-webkit-slider-thumb { appearance: none; width: 18px; height: 18px; border-radius: 50%; background: var(--c-accent); box-shadow: var(--shadow-glow-sm); cursor: pointer; transition: transform var(--dur-fast) var(--ease-spring); }
.crf-slider::-webkit-slider-thumb:hover { transform: scale(1.25); }
.crf-slider:disabled { opacity: 0.5; cursor: not-allowed; }
.crf-scale { display: flex; justify-content: space-between; font-family: 'JetBrains Mono', monospace; font-size: 0.6rem; color: var(--c-text-muted); margin-top: -4px; }

/* Preset */
.preset-row { display: flex; gap: 6px; }
.preset-card {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 12px 8px; border-radius: var(--r-md);
  background: var(--c-bg-overlay); border: 1px solid var(--c-border);
  cursor: pointer; transition: all var(--dur-normal) var(--ease-out);
}
.preset-card:hover:not(:disabled) { background: var(--c-bg-hover); border-color: var(--c-border-strong); }
.preset-card.active { background: var(--c-accent-subtle); border-color: var(--c-border-accent); }
.preset-card:disabled { opacity: 0.4; cursor: not-allowed; }
.preset-bars { display: flex; gap: 2px; align-items: flex-end; height: 16px; }
.preset-bar { width: 4px; border-radius: 2px; background: var(--c-bg-elevated); transition: background var(--dur-fast); }
.preset-bar:nth-child(1) { height: 5px; }
.preset-bar:nth-child(2) { height: 8px; }
.preset-bar:nth-child(3) { height: 11px; }
.preset-bar:nth-child(4) { height: 15px; }
.preset-bar.lit { background: var(--c-accent); }
.preset-card.active .preset-bar.lit { background: var(--c-accent); box-shadow: 0 0 4px rgba(249,115,22,0.5); }
.preset-name { font-size: 0.8rem; font-weight: 700; color: var(--c-text-primary); }
.preset-card.active .preset-name { color: var(--c-text-accent); }
.preset-desc { font-size: 0.6rem; color: var(--c-text-muted); text-align: center; }

/* Coming soon */
.sp-coming-soon { padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 10px; }
.cs-label { font-family: 'JetBrains Mono', monospace; font-size: 0.58rem; font-weight: 700; letter-spacing: 0.14em; color: var(--c-text-muted); }
.cs-slots { display: flex; gap: 6px; }
.cs-slot { flex: 1; padding: 10px 8px; border-radius: var(--r-md); border: 1px dashed rgba(255,255,255,0.08); color: var(--c-text-muted); font-size: 0.68rem; text-align: center; opacity: 0.5; font-family: 'JetBrains Mono', monospace; }

/* Settings panel animation */
.settings-enter-active { transition: opacity 0.2s var(--ease-out); }
.settings-leave-active { transition: opacity 0.15s var(--ease-in-out); }
.settings-enter-from, .settings-leave-to { opacity: 0; }
.settings-enter-active .settings-panel { animation: sp-in 0.22s var(--ease-spring) forwards; }
.settings-leave-active .settings-panel { animation: sp-out 0.15s var(--ease-in-out) forwards; }
@keyframes sp-in { from { transform: scale(0.92) translateY(8px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }
@keyframes sp-out { from { transform: scale(1); opacity: 1; } to { transform: scale(0.94); opacity: 0; } }

/* ── Toast ──────────────────────────────────────────────────────── */
.toast-reject { position: fixed; top: 60px; right: 20px; z-index: 300; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: var(--r-md); background: rgba(239,68,68,0.14); border: 1px solid rgba(239,68,68,0.35); color: var(--c-danger); font-size: 0.75rem; font-weight: 600; backdrop-filter: blur(12px); max-width: 380px; }
.toast-enter-active { animation: slide-up 0.28s ease-out; }
.toast-leave-active { transition: all 0.18s ease-in; opacity: 0; transform: translateY(-8px); }

/* ── Keyframes ──────────────────────────────────────────────────── */
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
@keyframes pulse-ring { 0%, 100% { opacity: 0.3; transform: scale(1); } 50% { opacity: 1; transform: scale(1.06); } }
@keyframes shine { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes dz-breathe { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }

/* ── Responsive ─────────────────────────────────────────────────── */
@media (max-width: 1024px) {
  .sidebar { width: 240px; }
  .header-center { display: none; }
}
@media (max-width: 768px) {
  .app-body { flex-direction: column-reverse; }
  .sidebar { width: 100%; max-height: 44vh; border-right: none; border-top: 1px solid var(--c-border); }
  .app-header { padding: 0 var(--sp-md); }
  .brand-sub { display: none; }
  .header-badge { display: none; }
  .drop-title { font-size: 1.1rem; }
  .drop-content { padding: var(--sp-lg); }
  .metrics-row { flex-wrap: wrap; }
  .proc-center { padding: var(--sp-lg); }
  .codec-cards { gap: 5px; }
  .preset-row { gap: 4px; }
}
@media (max-width: 480px) {
  .sidebar { max-height: 48vh; }
  .crf-num { font-size: 2.5rem; }
  .brand-name { font-size: 0.72rem; }
  .hdr-locale-btn span { display: none; }
}
</style>
