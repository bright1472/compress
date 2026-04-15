<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue';
import { EngineRouter } from '../engine/engine-router';
import ComparisonSlider from './ComparisonSlider.vue';
import { t, currentLocale, setLocale } from '../locales/i18n';

// ── Theme (持久化) ────────────────────────────────────────────────
const THEME_KEY = 'titan-theme';
const savedTheme = localStorage.getItem(THEME_KEY);
const isDark = ref(savedTheme ? savedTheme === 'dark' : true);
const applyTheme = () => document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
const toggleTheme = () => { isDark.value = !isDark.value; };
watch(isDark, (v) => { applyTheme(); localStorage.setItem(THEME_KEY, v ? 'dark' : 'light'); }, { immediate: true });

// ── Queue Types ───────────────────────────────────────────────────
interface QueueItem {
  id: string; file: File; status: 'pending' | 'processing' | 'done' | 'error';
  progress: number; throughput: number; originalUrl: string;
  compressedUrl: string; compressedSize: number; errorMsg: string;
  engineUsed: string;
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
  { value: 'libx264', label: 'H.264', badge: 'AVC', desc: '兼容性最佳' },
  { value: 'libx265', label: 'H.265', badge: 'HEVC', desc: '高效压缩' },
  { value: 'av1',     label: 'AV1',   badge: 'AV1',  desc: '次世代格式' },
] as const;

const presetOptions = [
  { value: 'ultrafast', label: '极速', desc: '文件稍大' },
  { value: 'fast',      label: '快速', desc: '均衡推荐' },
  { value: 'medium',    label: '标准', desc: '更高压缩' },
  { value: 'slow',      label: '精细', desc: '最优质量' },
] as const;

// ── Computed ──────────────────────────────────────────────────────
const activeItem = computed(() => queue.value.find(i => i.id === activeItemId.value) ?? null);
const pendingCount = computed(() => queue.value.filter(i => i.status === 'pending').length);
const doneCount = computed(() => queue.value.filter(i => i.status === 'done').length);
const totalCount = computed(() => queue.value.length);
const currentProcessing = computed(() => queue.value.find(i => i.status === 'processing') ?? null);
const canStart = computed(() => pendingCount.value > 0 && !isRunning.value);
const qualityLabel = computed(() => {
  if (crf.value <= 20) return { text: t.value('config.visuallyLossless'), color: '#22c55e' };
  if (crf.value <= 26) return { text: t.value('config.highQuality'), color: '#6366f1' };
  if (crf.value <= 32) return { text: t.value('config.balanced'), color: '#f59e0b' };
  return { text: t.value('config.highCompressRate'), color: '#ef4444' };
});

// CRF slider 轨道背景动态计算
const crfSliderStyle = computed(() => {
  const pct = ((crf.value - 18) / (40 - 18)) * 100;
  return { background: `linear-gradient(to right, var(--c-accent) ${pct}%, var(--c-bg-elevated) ${pct}%)` };
});

const fileSizeMB = (bytes: number) => (bytes / 1048576).toFixed(1);
const compressionRatio = (item: QueueItem) =>
  item.compressedSize ? Math.round((1 - item.compressedSize / item.file.size) * 100) : 0;

const statusIcon = (status: QueueItem['status']) => {
  const map = { pending: '○', processing: '◌', done: '✓', error: '✕' };
  return map[status];
};

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

// ── Processing (双引擎路由：≤ 2GB → FFmpeg WASM · > 2GB → WebCodecs) ───
const router = new EngineRouter();
const engineLoading = ref(false);
const routeInfo = ref('');

const processItem = async (item: QueueItem) => {
  item.status = 'processing';
  activeItemId.value = item.id;
  item.progress = 0;
  const startTime = Date.now();

  try {
    engineLoading.value = true;
    const resultBlob = await router.compress(
      item.file,
      { codec: codec.value, crf: crf.value, preset: preset.value },
      (pct) => {
        item.progress = Math.min(pct, 99.9);
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed > 0) item.throughput = (item.file.size * (pct / 100)) / 1048576 / elapsed;
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
    item.progress = 100;
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

    <!-- ═══ GLOBAL PROGRESS (顶部细条) ══════════════════════════ -->
    <div class="global-bar" v-if="isRunning">
      <div class="global-bar-fill" :style="{ width: (currentProcessing?.progress ?? 0) + '%' }"></div>
    </div>

    <!-- ═══ HEADER ═══════════════════════════════════════════════ -->
    <header class="app-header">
      <div class="header-brand">
        <div class="brand-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/></svg>
        </div>
        <div>
          <span class="brand-name">{{ t('app.title') }}</span>
          <span class="brand-sub">{{ t('app.subtitle') }}</span>
        </div>
      </div>

      <div class="header-center" v-if="isRunning && currentProcessing">
        <div class="hc-dot"></div>
        <span class="hc-label">正在压缩</span>
        <span class="hc-file">{{ currentProcessing.file.name }}</span>
        <span class="hc-sep">·</span>
        <span class="hc-rate">{{ currentProcessing.throughput.toFixed(1) }} MB/s</span>
        <span class="hc-sep">·</span>
        <span class="hc-prog">{{ currentProcessing.progress.toFixed(1) }}%</span>
      </div>

      <div class="header-right">
        <span class="header-badge">WebCodecs</span>
        <span class="header-badge accent-badge">10GB+</span>

        <!-- 主题切换 Switch -->
        <button class="theme-switch" @click="toggleTheme" :title="isDark ? '切换亮色模式' : '切换暗色模式'">
          <div class="ts-track" :class="{ light: !isDark }">
            <div class="ts-thumb" :class="{ light: !isDark }">
              <!-- 月亮（暗色） -->
              <svg v-if="isDark" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/></svg>
              <!-- 太阳（亮色） -->
              <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" fill="currentColor"/><line x1="12" y1="1" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="21" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="12" x2="3" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="21" y1="12" x2="23" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </div>
          </div>
          <span class="ts-label">{{ isDark ? t('app.darkMode') : t('app.lightMode') }}</span>
        </button>
        <button class="theme-switch" @click="setLocale(currentLocale === 'en' ? 'zh' : 'en')">
          <span class="ts-label">{{ currentLocale === 'en' ? 'EN' : '中文' }}</span>
        </button>
      </div>
    </header>

    <!-- ═══ BODY ══════════════════════════════════════════════════ -->
    <div class="app-body">

      <!-- ─── SIDEBAR ──────────────────────────────────────────── -->
      <aside class="sidebar">

        <!-- 文件队列区 -->
        <div class="sb-section queue-section">
          <div class="sb-section-head">
            <span class="sb-label">{{ t('queue.title') }}</span>
            <div class="queue-badges">
              <span v-if="totalCount > 0" class="q-badge total">{{ totalCount }}</span>
              <span v-if="doneCount > 0" class="q-badge done">{{ doneCount }} {{ t('queue.done') }}</span>
            </div>
          </div>

          <!-- 队列列表 -->
          <div class="queue-list" v-if="totalCount > 0">
            <div
              v-for="item in queue"
              :key="item.id"
              class="queue-item"
              :class="{ active: activeItemId === item.id, [item.status]: true }"
              @click="activeItemId = item.id"
            >
              <div class="qi-status" :class="item.status">
                <span v-if="item.status === 'pending'" class="qi-icon">○</span>
                <span v-else-if="item.status === 'processing'" class="qi-icon spin">◌</span>
                <span v-else-if="item.status === 'done'" class="qi-icon">✓</span>
                <span v-else class="qi-icon">✕</span>
              </div>
              <div class="qi-info">
                <p class="qi-name">{{ item.file.name }}</p>
                <div class="qi-meta">
                  <span>{{ fileSizeMB(item.file.size) }} MB</span>
                  <span v-if="item.engineUsed" class="qi-engine">{{ item.engineUsed }}</span>
                  <span v-if="item.status === 'done'" class="qi-saved">↓{{ compressionRatio(item) }}%</span>
                  <span v-if="item.status === 'error'" class="qi-err">{{ t('queue.error') }}</span>
                </div>
                <div v-if="item.status === 'processing'" class="qi-progress-bar">
                  <div class="qi-progress-fill" :style="{ width: item.progress + '%' }"></div>
                </div>
              </div>
              <div class="qi-actions">
                <button v-if="item.status === 'done'" class="qi-btn dl" @click.stop="downloadItem(item)" title="下载">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button v-if="item.status !== 'processing'" class="qi-btn rm" @click.stop="removeItem(item.id)" title="移除">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- 添加文件按钮 -->
          <input type="file" accept="video/*" multiple hidden ref="fileInputRef" @change="onFileInput" />
          <button class="add-files-btn" @click="fileInputRef?.click()" :disabled="isRunning">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            {{ totalCount === 0 ? t('queue.addFiles') : t('queue.addFiles') }}
          </button>
        </div>

        <div class="sb-divider"></div>

        <!-- 编码配置区 -->
        <div class="sb-section">
          <span class="sb-label">{{ t('config.codec') }}</span>
          <div class="codec-group">
            <button v-for="opt in codecOptions" :key="opt.value" class="codec-btn" :class="{ active: codec === opt.value }" @click="codec = opt.value" :disabled="isRunning">
              <span class="codec-badge" :class="{ active: codec === opt.value }">{{ opt.badge }}</span>
              <span class="codec-name">{{ opt.label }}</span>
              <span class="codec-desc">{{ t('config.' + (opt.value === 'libx264' ? 'bestCompatibility' : opt.value === 'libx265' ? 'highCompression' : 'nextGen')) }}</span>
            </button>
          </div>
        </div>

        <div class="sb-section">
          <div class="sb-label-row">
            <span class="sb-label">{{ t('config.qualityCRF') }}</span>
            <span class="quality-tag" :style="{ color: qualityLabel.color }">{{ qualityLabel.text }}</span>
          </div>
          <div class="crf-wrap">
            <div class="crf-num">{{ crf }}</div>
            <input type="range" class="crf-slider" v-model="crf" min="18" max="40" :disabled="isRunning" :style="crfSliderStyle" />
            <div class="crf-scale"><span>{{ t('config.fine') }}</span><span>{{ t('config.compress') }}</span></div>
          </div>
        </div>

        <div class="sb-section">
          <span class="sb-label">{{ t('config.encodeSpeed') }}</span>
          <div class="preset-group">
            <button v-for="opt in presetOptions" :key="opt.value" class="preset-btn" :class="{ active: preset === opt.value }" @click="preset = opt.value" :disabled="isRunning">
              <span class="preset-name">{{ t('config.' + opt.value) }}</span>
              <span class="preset-desc">{{ t('config.' + (opt.value === 'ultrafast' ? 'largerFile' : opt.value === 'fast' ? 'recommended' : opt.value === 'medium' ? 'moreCompression' : 'bestQuality')) }}</span>
            </button>
          </div>
        </div>

        <!-- 底部操作 -->
        <div class="sb-footer">
          <button v-if="canStart" class="btn-primary" @click="processQueue">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
            {{ t('process.start') }} {{ pendingCount > 1 ? `(${pendingCount})` : '' }}
          </button>
          <div v-if="isRunning" class="running-info">
            <div class="running-dot"></div>
            <span>{{ t('queue.processing') }}</span>
          </div>
          <div v-if="doneCount > 0 && !isRunning" class="footer-actions">
            <button class="btn-dl-all" @click="downloadAll">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              全部下载 ({{ doneCount }})
            </button>
            <button class="btn-clear" @click="clearAll">清空队列</button>
          </div>
        </div>
      </aside>

      <!-- ─── MAIN STAGE ─────────────────────────────────────── -->
      <main class="stage" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">

        <!-- 【空队列】拖拽上传区 -->
        <div v-if="totalCount === 0" class="drop-zone" :class="{ dragging: isDragging }" @click="fileInputRef?.click()">
          <div class="drop-content">
            <div class="drop-icon-wrap">
              <div class="drop-ring"></div>
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" stroke="currentColor" stroke-width="1.5"/><polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polyline points="9 14 12 17 15 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <h2 class="drop-title">{{ t('process.dragToArea') }}</h2>
            <p class="drop-sub">{{ t('process.supportBatch') }}</p>
            <div class="drop-formats">
              <span v-for="f in ['MP4','MOV','MKV','AVI','WebM','FLV','WMV']" :key="f" class="fmt-tag">{{ f }}</span>
            </div>
            <button class="btn-ghost" @click.stop="fileInputRef?.click()">{{ t('process.orClick') }}</button>
          </div>
        </div>

        <!-- 【有队列，拖拽悬浮提示】 -->
        <div v-if="totalCount > 0 && isDragging" class="drag-overlay">
          <div class="drag-overlay-inner">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <p>松开鼠标以添加到队列</p>
          </div>
        </div>

        <!-- 【无激活项，队列非空】 默认选中占位 -->
        <div v-if="totalCount > 0 && !activeItem && !isDragging" class="stage-hint">
          <p>点击左侧队列中的文件以预览</p>
        </div>

        <!-- 【激活项：待处理】预览原始视频 -->
        <div v-if="activeItem && activeItem.status === 'pending'" class="preview-stage">
          <div class="preview-header">
            <span class="preview-badge">原始视频</span>
            <span class="preview-meta">{{ activeItem.file.name }} · {{ fileSizeMB(activeItem.file.size) }} MB</span>
          </div>
          <video :src="activeItem.originalUrl" class="preview-video" controls muted loop autoplay></video>
          <div class="preview-tip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v4l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            配置左侧参数后点击「开始压缩」
          </div>
        </div>

        <!-- 【激活项：处理中】进度视图 -->
        <div v-if="activeItem && activeItem.status === 'processing'" class="processing-stage">
          <div class="proc-center">
            <div class="proc-ring-outer">
              <div class="proc-ring-inner">
                <svg class="proc-spin" width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </div>
            </div>
            <div class="proc-info">
              <h2 class="proc-title">{{ engineLoading ? '加载引擎中...' : '正在压缩' }}</h2>
              <p class="proc-file">{{ activeItem.file.name }}</p>
              <p class="proc-queue-hint" v-if="pendingCount > 0">队列剩余 {{ pendingCount }} 个文件</p>
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
                <span class="mc-unit">编码格式</span>
              </div>
              <div class="mc">
                <span class="mc-val">CRF {{ crf }}</span>
                <span class="mc-unit">质量参数</span>
              </div>
              <div class="mc">
                <span class="mc-val accent">{{ activeItem.throughput.toFixed(1) }}</span>
                <span class="mc-unit">MB/s 速率</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 【激活项：完成】对比滑块 -->
        <div v-if="activeItem && activeItem.status === 'done'" class="result-stage">
          <div class="result-header">
            <div class="result-stats">
              <span class="rs-item original">原始 {{ fileSizeMB(activeItem.file.size) }} MB</span>
              <span class="rs-arrow">→</span>
              <span class="rs-item compressed">压缩后 {{ fileSizeMB(activeItem.compressedSize) }} MB</span>
              <span class="rs-badge">节省 {{ compressionRatio(activeItem) }}%</span>
            </div>
            <button class="btn-dl-single" @click="downloadItem(activeItem)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              下载此文件
            </button>
          </div>
          <div class="slider-wrap">
            <ComparisonSlider :original-url="activeItem.originalUrl" :compressed-url="activeItem.compressedUrl" />
          </div>
        </div>

        <!-- 【激活项：错误】错误卡片 -->
        <div v-if="activeItem && activeItem.status === 'error'" class="error-stage">
          <div class="error-card">
            <div class="err-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </div>
            <h3 class="err-title">处理失败</h3>
            <p class="err-msg">{{ activeItem.errorMsg }}</p>
            <p class="err-hint">请检查：浏览器是否支持 WebCodecs · 文件格式是否有效</p>
          </div>
        </div>

      </main>
    </div>
  </div>
</template>

<style scoped>
/* ── Shell ─────────────────────────────────────────────────────── */
.app-shell { width: 100vw; height: 100vh; display: flex; flex-direction: column; background: var(--c-bg-base); overflow: hidden; position: relative; transition: background var(--dur-slow) var(--ease-out); }

/* ── Global Progress Bar ────────────────────────────────────────── */
.global-bar { position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 200; background: var(--c-bg-elevated); }
.global-bar-fill { height: 100%; background: linear-gradient(90deg, var(--c-accent), #a78bfa); transition: width 0.4s var(--ease-out); box-shadow: 0 0 8px var(--c-accent); }

/* ── Header ────────────────────────────────────────────────────── */
.app-header { height: 52px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 var(--sp-lg); border-bottom: 1px solid var(--c-border); background: var(--c-bg-surface); z-index: 50; transition: background var(--dur-slow) var(--ease-out), border-color var(--dur-slow) var(--ease-out); }
.header-brand { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.brand-icon { width: 30px; height: 30px; border-radius: var(--r-sm); background: var(--c-accent); display: flex; align-items: center; justify-content: center; color: white; flex-shrink: 0; }
.brand-name { display: block; font-size: 0.88rem; font-weight: 700; letter-spacing: -0.02em; color: var(--c-text-primary); }
.brand-sub { display: block; font-size: 0.58rem; font-weight: 600; color: var(--c-text-muted); letter-spacing: 0.06em; text-transform: uppercase; }
.header-center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; min-width: 0; }
.hc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-success); box-shadow: 0 0 6px var(--c-success); animation: blink 1.5s ease-in-out infinite; flex-shrink: 0; }
.hc-label { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; color: var(--c-success); }
.hc-file { font-size: 0.75rem; color: var(--c-text-secondary); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'JetBrains Mono', monospace; }
.hc-sep { color: var(--c-text-muted); font-size: 0.65rem; }
.hc-rate, .hc-prog { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; font-weight: 600; color: var(--c-text-primary); }
.header-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.header-badge { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.06em; padding: 3px 8px; border-radius: var(--r-full); background: var(--c-bg-overlay); border: 1px solid var(--c-border); color: var(--c-text-muted); }
.header-badge.accent-badge { background: var(--c-accent-subtle); border-color: var(--c-border-accent); color: var(--c-text-accent); }

/* Theme Switch */
.theme-switch { display: flex; align-items: center; gap: 6px; background: none; border: none; cursor: pointer; padding: 4px; border-radius: var(--r-sm); transition: background var(--dur-fast); }
.theme-switch:hover { background: var(--c-bg-hover); }
.ts-track { width: 48px; height: 26px; border-radius: var(--r-full); background: var(--c-bg-elevated); border: 1px solid var(--c-border); display: flex; align-items: center; padding: 2px; transition: background var(--dur-normal) var(--ease-out), border-color var(--dur-normal) var(--ease-out); }
.ts-track.light { background: var(--c-accent-subtle); border-color: var(--c-border-accent); }
.ts-thumb { width: 20px; height: 20px; border-radius: 50%; background: var(--c-accent); color: white; display: flex; align-items: center; justify-content: center; transform: translateX(22px); transition: transform var(--dur-normal) var(--ease-spring); }
.ts-thumb.light { transform: translateX(0); }
.ts-label { font-size: 0.68rem; font-weight: 600; color: var(--c-text-muted); white-space: nowrap; }

/* ── App Body ──────────────────────────────────────────────────── */
.app-body { flex: 1; display: flex; overflow: hidden; min-height: 0; }

/* ── Sidebar ────────────────────────────────────────────────────── */
.sidebar { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; gap: 0; overflow-y: auto; border-right: 1px solid var(--c-border); background: var(--c-bg-surface); scrollbar-width: thin; scrollbar-color: var(--c-bg-elevated) transparent; transition: background var(--dur-slow) var(--ease-out), border-color var(--dur-slow) var(--ease-out); }
.sb-section { padding: var(--sp-md); display: flex; flex-direction: column; gap: 8px; }
.sb-divider { height: 1px; background: var(--c-border); flex-shrink: 0; }
.sb-label { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--c-text-muted); }
.sb-label-row { display: flex; align-items: center; justify-content: space-between; }
.sb-section-head { display: flex; align-items: center; justify-content: space-between; }
.quality-tag { font-size: 0.68rem; font-weight: 700; }

/* Queue */
.queue-section { min-height: 0; }
.queue-badges { display: flex; gap: 4px; align-items: center; }
.q-badge { font-size: 0.6rem; font-weight: 700; padding: 2px 6px; border-radius: var(--r-full); }
.q-badge.total { background: var(--c-bg-elevated); color: var(--c-text-muted); }
.q-badge.done { background: var(--c-success-subtle); color: var(--c-success); border: 1px solid rgba(34,197,94,0.25); }
.queue-list { display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--c-bg-elevated) transparent; }
.queue-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--r-md); border: 1px solid var(--c-border); background: var(--c-bg-overlay); cursor: pointer; transition: all var(--dur-fast) var(--ease-out); }
.queue-item:hover { background: var(--c-bg-hover); border-color: var(--c-border-strong); }
.queue-item.active { background: var(--c-accent-subtle); border-color: var(--c-border-accent); }
.qi-status { width: 20px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.qi-icon { font-size: 0.75rem; font-family: 'JetBrains Mono', monospace; }
.qi-icon.spin { animation: spin 1.5s linear infinite; display: inline-block; color: var(--c-accent); }
.qi-status.done .qi-icon { color: var(--c-success); }
.qi-status.error .qi-icon { color: var(--c-danger); }
.qi-status.pending .qi-icon { color: var(--c-text-muted); }
.qi-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qi-name { font-size: 0.75rem; font-weight: 600; color: var(--c-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qi-meta { display: flex; gap: 6px; font-size: 0.65rem; color: var(--c-text-muted); font-family: 'JetBrains Mono', monospace; }
.qi-saved { color: var(--c-success); font-weight: 700; }
.qi-err { color: var(--c-danger); }
.qi-progress-bar { height: 2px; background: var(--c-bg-elevated); border-radius: 2px; overflow: hidden; margin-top: 2px; }
.qi-progress-fill { height: 100%; background: var(--c-accent); border-radius: 2px; transition: width 0.3s var(--ease-out); }
.qi-actions { display: flex; gap: 2px; flex-shrink: 0; }
.qi-btn { width: 24px; height: 24px; border-radius: var(--r-sm); display: flex; align-items: center; justify-content: center; border: none; cursor: pointer; transition: all var(--dur-fast); background: none; }
.qi-btn.dl { color: var(--c-accent); }
.qi-btn.dl:hover { background: var(--c-accent-subtle); }
.qi-btn.rm { color: var(--c-text-muted); }
.qi-btn.rm:hover { background: var(--c-danger-subtle); color: var(--c-danger); }
.add-files-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 9px; border-radius: var(--r-md); background: var(--c-bg-overlay); border: 1px dashed var(--c-border-strong); color: var(--c-text-secondary); font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: all var(--dur-normal) var(--ease-out); }
.add-files-btn:hover:not(:disabled) { background: var(--c-bg-hover); border-color: var(--c-border-accent); color: var(--c-text-accent); }
.add-files-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Codec */
.codec-group { display: flex; flex-direction: column; gap: 5px; }
.codec-btn { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-radius: var(--r-md); background: var(--c-bg-overlay); border: 1px solid var(--c-border); cursor: pointer; transition: all var(--dur-normal) var(--ease-out); text-align: left; }
.codec-btn:hover:not(:disabled) { background: var(--c-bg-hover); border-color: var(--c-border-strong); }
.codec-btn.active { background: var(--c-accent-subtle); border-color: var(--c-border-accent); }
.codec-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.codec-badge { font-size: 0.58rem; font-weight: 800; letter-spacing: 0.05em; padding: 2px 5px; border-radius: 4px; background: var(--c-bg-elevated); color: var(--c-text-muted); min-width: 34px; text-align: center; }
.codec-badge.active { background: var(--c-accent); color: white; }
.codec-name { font-size: 0.8rem; font-weight: 600; color: var(--c-text-primary); flex: 1; }
.codec-desc { font-size: 0.62rem; color: var(--c-text-muted); }

/* CRF */
.crf-wrap { display: flex; flex-direction: column; gap: 6px; }
.crf-num { font-family: 'JetBrains Mono', monospace; font-size: 2rem; font-weight: 800; color: var(--c-text-primary); text-align: center; line-height: 1; }
.crf-slider { width: 100%; height: 4px; appearance: none; -webkit-appearance: none; border-radius: 2px; cursor: pointer; }
.crf-slider::-webkit-slider-thumb { appearance: none; width: 18px; height: 18px; border-radius: 50%; background: var(--c-accent); box-shadow: var(--shadow-glow-sm); cursor: pointer; transition: transform var(--dur-fast) var(--ease-spring); }
.crf-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
.crf-slider:disabled { opacity: 0.5; cursor: not-allowed; }
.crf-scale { display: flex; justify-content: space-between; font-size: 0.62rem; color: var(--c-text-muted); }

/* Preset */
.preset-group { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.preset-btn { display: flex; flex-direction: column; gap: 1px; padding: 8px 10px; border-radius: var(--r-md); background: var(--c-bg-overlay); border: 1px solid var(--c-border); cursor: pointer; transition: all var(--dur-normal) var(--ease-out); text-align: left; }
.preset-btn:hover:not(:disabled) { background: var(--c-bg-hover); border-color: var(--c-border-strong); }
.preset-btn.active { background: var(--c-accent-subtle); border-color: var(--c-border-accent); }
.preset-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.preset-name { font-size: 0.8rem; font-weight: 700; color: var(--c-text-primary); }
.preset-btn.active .preset-name { color: var(--c-text-accent); }
.preset-desc { font-size: 0.62rem; color: var(--c-text-muted); }

/* Sidebar Footer */
.sb-footer { padding: var(--sp-md); border-top: 1px solid var(--c-border); display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
.btn-primary { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 12px; border-radius: var(--r-md); background: var(--c-accent); color: white; font-size: 0.88rem; font-weight: 700; border: none; cursor: pointer; transition: all var(--dur-normal) var(--ease-out); letter-spacing: 0.01em; }
.btn-primary:hover:not(:disabled) { background: var(--c-accent-hover); box-shadow: var(--shadow-glow); transform: translateY(-1px); }
.btn-primary:active:not(:disabled) { transform: translateY(0); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
.running-info { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 10px; border-radius: var(--r-md); background: var(--c-bg-overlay); border: 1px solid var(--c-border); font-size: 0.75rem; color: var(--c-text-secondary); }
.running-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-warning); box-shadow: 0 0 6px var(--c-warning); animation: blink 1.5s ease-in-out infinite; flex-shrink: 0; }
.footer-actions { display: flex; flex-direction: column; gap: 6px; }
.btn-dl-all { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 10px; border-radius: var(--r-md); background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.3); color: var(--c-success); font-size: 0.82rem; font-weight: 700; cursor: pointer; transition: all var(--dur-normal) var(--ease-out); }
.btn-dl-all:hover { background: rgba(34,197,94,0.18); }
.btn-clear { display: flex; align-items: center; justify-content: center; width: 100%; padding: 9px; border-radius: var(--r-md); background: none; border: 1px solid var(--c-border); color: var(--c-text-muted); font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all var(--dur-normal) var(--ease-out); }
.btn-clear:hover { border-color: var(--c-danger); color: var(--c-danger); background: var(--c-danger-subtle); }

/* ── Stage ──────────────────────────────────────────────────────── */
.stage { flex: 1; display: flex; position: relative; overflow: hidden; }

/* Drop Zone */
.drop-zone { flex: 1; display: flex; align-items: center; justify-content: center; cursor: pointer; border: 2px dashed var(--c-border); margin: var(--sp-lg); border-radius: 20px; transition: all var(--dur-normal) var(--ease-out); background: var(--c-bg-surface); }
.drop-zone:hover, .drop-zone.dragging { border-color: var(--c-accent); background: var(--c-accent-subtle); }
.drop-content { display: flex; flex-direction: column; align-items: center; gap: var(--sp-md); text-align: center; padding: var(--sp-2xl); pointer-events: none; }
.drop-zone .btn-ghost { pointer-events: all; }
.drop-icon-wrap { position: relative; width: 88px; height: 88px; display: flex; align-items: center; justify-content: center; color: var(--c-accent); }
.drop-ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--c-border-accent); animation: pulse-ring 2.5s ease-in-out infinite; }
.drop-title { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.03em; color: var(--c-text-primary); }
.drop-sub { font-size: 0.85rem; color: var(--c-text-secondary); max-width: 400px; line-height: 1.6; }
.drop-formats { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
.fmt-tag { font-size: 0.65rem; font-weight: 700; padding: 3px 9px; border-radius: var(--r-full); background: var(--c-bg-elevated); border: 1px solid var(--c-border); color: var(--c-text-muted); letter-spacing: 0.05em; transition: all var(--dur-fast); }
.drop-zone:hover .fmt-tag, .drop-zone.dragging .fmt-tag { border-color: var(--c-border-accent); color: var(--c-text-accent); }
.btn-ghost { display: inline-flex; align-items: center; gap: 6px; padding: 10px 22px; border-radius: var(--r-full); background: var(--c-bg-overlay); border: 1px solid var(--c-border-strong); color: var(--c-text-secondary); font-size: 0.83rem; font-weight: 600; cursor: pointer; transition: all var(--dur-normal) var(--ease-out); }
.btn-ghost:hover { background: var(--c-bg-hover); color: var(--c-text-primary); }

/* Drag Overlay */
.drag-overlay { position: absolute; inset: 0; background: rgba(99,102,241,0.12); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 30; border: 2px dashed var(--c-accent); margin: var(--sp-md); border-radius: 20px; pointer-events: none; }
.drag-overlay-inner { display: flex; flex-direction: column; align-items: center; gap: var(--sp-md); color: var(--c-accent); }
.drag-overlay-inner p { font-size: 1rem; font-weight: 700; color: var(--c-text-accent); }

/* Stage Hint */
.stage-hint { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--c-text-muted); font-size: 0.85rem; }

/* Preview Stage */
.preview-stage { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: var(--sp-lg); overflow: hidden; }
.preview-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.preview-badge { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 4px 10px; border-radius: var(--r-full); background: var(--c-bg-elevated); border: 1px solid var(--c-border); color: var(--c-text-muted); }
.preview-meta { font-size: 0.75rem; color: var(--c-text-muted); font-family: 'JetBrains Mono', monospace; }
.preview-video { flex: 1; width: 100%; min-height: 0; object-fit: contain; border-radius: var(--r-lg); background: #000; }
.preview-tip { display: flex; align-items: center; gap: 6px; justify-content: center; font-size: 0.75rem; color: var(--c-text-muted); padding: 4px; flex-shrink: 0; }

/* Processing Stage */
.processing-stage { flex: 1; display: flex; align-items: center; justify-content: center; }
.proc-center { display: flex; flex-direction: column; align-items: center; gap: var(--sp-xl); text-align: center; width: 100%; max-width: 500px; padding: var(--sp-2xl); }
.proc-ring-outer { width: 112px; height: 112px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid var(--c-border-accent); animation: pulse-ring 2.5s ease-in-out infinite; }
.proc-ring-inner { width: 74px; height: 74px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--c-accent-subtle); color: var(--c-accent); border: 1px solid var(--c-border-accent); }
.proc-spin { animation: spin 3s linear infinite; }
.proc-title { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.04em; color: var(--c-text-primary); }
.proc-file { font-size: 0.82rem; color: var(--c-text-muted); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'JetBrains Mono', monospace; }
.proc-queue-hint { font-size: 0.72rem; color: var(--c-text-muted); padding: 4px 12px; border-radius: var(--r-full); background: var(--c-bg-elevated); border: 1px solid var(--c-border); }
.prog-wrap { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.prog-track { width: 100%; height: 6px; background: var(--c-bg-elevated); border-radius: var(--r-full); overflow: hidden; }
.prog-fill { height: 100%; background: linear-gradient(90deg, var(--c-accent), #a78bfa); border-radius: var(--r-full); transition: width 0.4s var(--ease-out); position: relative; overflow: hidden; }
.prog-shine { position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent); animation: shine 2s ease-in-out infinite; }
.prog-labels { display: flex; justify-content: space-between; }
.prog-pct { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; font-weight: 700; color: var(--c-text-primary); }
.prog-rate { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--c-text-muted); }
.metrics-row { display: flex; gap: var(--sp-md); width: 100%; }
.mc { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: var(--sp-md); border-radius: var(--r-md); background: var(--c-bg-elevated); border: 1px solid var(--c-border); }
.mc-val { font-family: 'JetBrains Mono', monospace; font-size: 1rem; font-weight: 700; color: var(--c-text-primary); }
.mc-val.accent { color: var(--c-text-accent); }
.mc-unit { font-size: 0.6rem; color: var(--c-text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

/* Result Stage */
.result-stage { flex: 1; display: flex; flex-direction: column; padding: var(--sp-md); gap: var(--sp-sm); overflow: hidden; }
.result-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.result-stats { display: flex; align-items: center; gap: 10px; }
.rs-item { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; font-weight: 600; color: var(--c-text-secondary); }
.rs-arrow { color: var(--c-text-muted); }
.rs-item.compressed { color: var(--c-success); }
.rs-badge { font-size: 0.7rem; font-weight: 800; padding: 3px 10px; border-radius: var(--r-full); background: var(--c-success-subtle); color: var(--c-success); border: 1px solid rgba(34,197,94,0.25); }
.btn-dl-single { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--r-md); background: var(--c-accent); color: white; font-size: 0.8rem; font-weight: 700; border: none; cursor: pointer; transition: all var(--dur-normal); }
.btn-dl-single:hover { background: var(--c-accent-hover); box-shadow: var(--shadow-glow-sm); }
.slider-wrap { flex: 1; min-height: 0; border-radius: var(--r-lg); overflow: hidden; }

/* Error Stage */
.error-stage { flex: 1; display: flex; align-items: center; justify-content: center; }
.error-card { display: flex; flex-direction: column; align-items: center; gap: var(--sp-md); padding: var(--sp-2xl); border-radius: var(--r-xl); background: var(--c-bg-elevated); border: 1px solid rgba(239,68,68,0.25); max-width: 380px; text-align: center; }
.err-icon { width: 60px; height: 60px; border-radius: 50%; background: var(--c-danger-subtle); color: var(--c-danger); display: flex; align-items: center; justify-content: center; }
.err-title { font-size: 1.1rem; font-weight: 800; color: var(--c-text-primary); }
.err-msg { font-size: 0.82rem; color: var(--c-text-secondary); line-height: 1.6; word-break: break-all; }
.err-hint { font-size: 0.72rem; color: var(--c-text-muted); line-height: 1.6; padding: 10px 14px; border-radius: var(--r-sm); background: var(--c-bg-overlay); border: 1px solid var(--c-border); }

/* ── Keyframes ──────────────────────────────────────────────────── */
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@keyframes pulse-ring { 0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 1; transform: scale(1.04); } }
@keyframes shine { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
@keyframes slide-up { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

/* Toast */
.toast-reject { position: fixed; top: 64px; right: 20px; z-index: 300; display: flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: var(--r-md); background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.35); color: var(--c-danger); font-size: 0.78rem; font-weight: 600; backdrop-filter: blur(12px); animation: slide-up 0.3s ease-out; max-width: 400px; }
.toast-enter-active { animation: slide-up 0.3s ease-out; }
.toast-leave-active { transition: all 0.2s ease-in; opacity: 0; transform: translateY(-8px); }

/* Engine badge in queue */
.qi-engine { font-size: 0.55rem; font-weight: 700; padding: 1px 5px; border-radius: var(--r-full); background: var(--c-accent-subtle); color: var(--c-text-accent); border: 1px solid var(--c-border-accent); letter-spacing: 0.02em; }

/* ── Responsive ─────────────────────────────────────────────────── */
@media (max-width: 1024px) {
  .sidebar { width: 260px; }
  .header-center { display: none; }
}

@media (max-width: 768px) {
  .app-body { flex-direction: column-reverse; }
  .sidebar { width: 100%; max-height: 45vh; border-right: none; border-top: 1px solid var(--c-border); }
  .queue-list { max-height: 120px; }
  .app-header { padding: 0 var(--sp-md); }
  .brand-sub { display: none; }
  .header-badge { display: none; }
  .drop-title { font-size: 1.1rem; }
  .drop-sub { font-size: 0.75rem; }
  .drop-content { padding: var(--sp-lg); }
  .metrics-row { flex-wrap: wrap; }
  .proc-center { padding: var(--sp-lg); }
}

@media (max-width: 480px) {
  .sidebar { max-height: 50vh; }
  .codec-group { gap: 3px; }
  .preset-group { grid-template-columns: 1fr 1fr; gap: 3px; }
  .crf-num { font-size: 1.5rem; }
  .ts-label { display: none; }
  .brand-name { font-size: 0.78rem; }
}
</style>
