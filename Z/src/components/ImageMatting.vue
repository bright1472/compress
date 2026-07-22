<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { removeBackground } from '@imgly/background-removal';
import type { Config } from '@imgly/background-removal';
import { t } from '../locales/i18n';
import { logger } from '../engine/logger';

const props = defineProps<{ showSettings: boolean }>();
const emit = defineEmits<{ (e: 'update:showSettings', v: boolean): void }>();

type MattingStage = 'empty' | 'ready' | 'processing' | 'done' | 'error';

const fileInputRef = ref<HTMLInputElement | null>(null);
const previewCanvasRef = ref<HTMLCanvasElement | null>(null);
const stage = ref<MattingStage>('empty');
const isDragging = ref(false);
const originalFile = ref<File | null>(null);
const originalUrl = ref('');
const mattedBlob = ref<Blob | null>(null);
const resultUrl = ref('');
const errorMsg = ref('');
const progressText = ref('');
const progressPct = ref(0);
const padding = ref(4);
const outputSize = ref(1024);
const radius = ref(160);
const outputBytes = ref(0);
const elapsedMs = ref(0);

const totalCount = computed(() => (originalFile.value ? 1 : 0));
const isRunning = computed(() => stage.value === 'processing');
const currentProcessing = computed(() => (isRunning.value ? originalFile.value : null));
const canProcess = computed(() => !!originalFile.value && !isRunning.value);
const downloadName = computed(() => {
  const base = originalFile.value?.name.replace(/\.[^.]+$/, '') || 'image';
  return `titan_matting_${base}.png`;
});

const validTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']);
const validExt = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp']);
const isValidFile = (file: File) => validTypes.has(file.type) || validExt.has(file.name.split('.').pop()?.toLowerCase() ?? '');
const fileSizeStr = (bytes: number) => {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

const revoke = () => {
  if (originalUrl.value) URL.revokeObjectURL(originalUrl.value);
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value);
  originalUrl.value = '';
  resultUrl.value = '';
};

const resetResult = () => {
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value);
  resultUrl.value = '';
  mattedBlob.value = null;
  outputBytes.value = 0;
  elapsedMs.value = 0;
  progressPct.value = 0;
  progressText.value = '';
};

const loadFile = (file: File) => {
  if (!isValidFile(file)) {
    revoke();
    resetResult();
    originalFile.value = null;
    errorMsg.value = t.value('queue.unsupportedFormat');
    stage.value = 'error';
    return;
  }
  revoke();
  resetResult();
  originalFile.value = file;
  originalUrl.value = URL.createObjectURL(file);
  errorMsg.value = '';
  stage.value = 'ready';
};

const onFileInput = (e: Event) => {
  const files = (e.target as HTMLInputElement).files;
  if (files?.[0]) loadFile(files[0]);
  (e.target as HTMLInputElement).value = '';
};

const onDrop = (e: DragEvent) => {
  e.preventDefault();
  isDragging.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
};

const onDragOver = (e: DragEvent) => {
  e.preventDefault();
  isDragging.value = true;
};

const onDragLeave = () => {
  isDragging.value = false;
};

const imageFromBlob = async (blob: Blob): Promise<HTMLImageElement> => {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  const safeR = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeR, y);
  ctx.arcTo(x + w, y, x + w, y + h, safeR);
  ctx.arcTo(x + w, y + h, x, y + h, safeR);
  ctx.arcTo(x, y + h, x, y, safeR);
  ctx.arcTo(x, y, x + w, y, safeR);
  ctx.closePath();
};

const redrawResult = async (shouldCommit?: () => boolean) => {
  if (!mattedBlob.value) return;
  const img = await imageFromBlob(mattedBlob.value);
  const scanCanvas = document.createElement('canvas');
  scanCanvas.width = img.naturalWidth;
  scanCanvas.height = img.naturalHeight;
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
  if (!scanCtx) throw new Error('Canvas unavailable');
  scanCtx.drawImage(img, 0, 0);

  const { data, width, height } = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    minX = 0; minY = 0; maxX = width - 1; maxY = height - 1;
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const size = outputSize.value;
  const pad = Math.round(size * (padding.value / 100));
  const drawBox = Math.max(1, size - pad * 2);
  const scale = Math.min(drawBox / cropW, drawBox / cropH);
  const drawW = Math.round(cropW * scale);
  const drawH = Math.round(cropH * scale);
  const dx = Math.round((size - drawW) / 2);
  const dy = Math.round((size - drawH) / 2);

  const canvas = previewCanvasRef.value ?? document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  if (radius.value > 0) {
    roundRect(ctx, 0, 0, size, size, radius.value);
    ctx.clip();
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scanCanvas, minX, minY, cropW, cropH, dx, dy, drawW, drawH);
  ctx.restore();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('PNG export failed')), 'image/png');
  });
  const nextUrl = URL.createObjectURL(blob);
  if (shouldCommit && !shouldCommit()) {
    URL.revokeObjectURL(nextUrl);
    return;
  }
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value);
  resultUrl.value = nextUrl;
  outputBytes.value = blob.size;
};

const processImage = async () => {
  if (!originalFile.value || isRunning.value) return;
  stage.value = 'processing';
  errorMsg.value = '';
  progressPct.value = 4;
  progressText.value = 'Loading AI model';
  const startedAt = performance.now();

  try {
    const config: Config = {
      publicPath: `${window.location.origin}${import.meta.env.BASE_URL}background-removal/`,
      model: 'isnet_fp16',
      output: { format: 'image/png', quality: 1 },
      progress: (key, current, total) => {
        if (key.startsWith('fetch:')) {
          progressText.value = 'Loading local model';
          progressPct.value = Math.min(42, Math.round((current / Math.max(total, 1)) * 42));
        } else if (key === 'compute:inference') {
          progressText.value = 'Segmenting foreground';
          progressPct.value = 68;
        } else if (key === 'compute:mask') {
          progressText.value = 'Refining alpha mask';
          progressPct.value = 82;
        } else if (key === 'compute:encode') {
          progressText.value = 'Encoding transparent PNG';
          progressPct.value = current >= total ? 92 : 88;
        }
      },
    };

    mattedBlob.value = await removeBackground(originalFile.value, config);
    progressText.value = 'Cropping transparent bounds';
    progressPct.value = 96;
    await redrawResult();
    elapsedMs.value = performance.now() - startedAt;
    progressPct.value = 100;
    progressText.value = 'Ready';
    stage.value = 'done';
    logger.info('system', `[matting][Benchmark] ${originalFile.value.name} | ${fileSizeStr(originalFile.value.size)} -> ${fileSizeStr(outputBytes.value)} | ${(elapsedMs.value / 1000).toFixed(2)}s | Engine: IMG.LY Wasm + Canvas`);
  } catch (e) {
    stage.value = 'error';
    errorMsg.value = e instanceof Error ? e.message : 'AI matting failed';
    logger.error('system', `[matting] ${errorMsg.value}`);
  }
};

let redrawToken = 0;
watch([padding, outputSize, radius], async () => {
  if (!mattedBlob.value || stage.value !== 'done') return;
  const token = ++redrawToken;
  try {
    await redrawResult(() => token === redrawToken);
  } catch (e) {
    if (token === redrawToken) errorMsg.value = e instanceof Error ? e.message : 'Canvas redraw failed';
  }
});

const downloadResult = () => {
  if (!resultUrl.value) return;
  const a = document.createElement('a');
  a.href = resultUrl.value;
  a.download = downloadName.value;
  a.click();
};

const clearAll = () => {
  revoke();
  originalFile.value = null;
  mattedBlob.value = null;
  errorMsg.value = '';
  stage.value = 'empty';
};

onBeforeUnmount(revoke);

defineExpose({
  isRunning,
  totalCount,
  currentProcessing,
});
</script>

<template>
  <div class="compressor-root matting-root" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <input ref="fileInputRef" type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp" hidden @change="onFileInput" />

    <section class="matting-stage" :class="{ dragging: isDragging, empty: stage === 'empty' }">
      <div class="ambient"></div>

      <div v-if="stage === 'empty'" class="drop-card" @click="fileInputRef?.click()">
        <div class="matting-orbit">
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none">
            <path d="M4 19c5.2-.8 7.1-4.2 8-11 1 6.8 2.8 10.2 8 11M7 5h10M12 2.5V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <p class="eyebrow">LOCAL AI CUTOUT</p>
        <h2>拖入图片，生成透明主体</h2>
        <p class="sub">Wasm 推理去背景，Canvas 按 Alpha 通道自动裁边、留白与圆角重绘。</p>
        <div class="format-row">
          <span>PNG</span><span>JPG</span><span>WebP</span><span>AVIF</span>
        </div>
      </div>

      <div v-else class="workbench">
        <aside class="source-panel glass-panel">
          <div class="panel-head">
            <span>INPUT</span>
            <button class="icon-btn" @click="fileInputRef?.click()" title="替换图片">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="source-preview">
            <img v-if="originalUrl" :src="originalUrl" draggable="false" />
          </div>
          <div class="file-meta">
            <strong>{{ originalFile?.name }}</strong>
            <span>{{ originalFile ? fileSizeStr(originalFile.size) : '' }}</span>
          </div>
        </aside>

        <main class="result-panel glass-panel">
          <div class="panel-head">
            <span>TRANSPARENT OUTPUT</span>
            <span v-if="stage === 'done'" class="done-pill">{{ outputSize }}PX · {{ fileSizeStr(outputBytes) }}</span>
          </div>
          <div class="result-preview">
            <canvas v-show="stage === 'done'" ref="previewCanvasRef"></canvas>
            <div v-if="stage === 'ready'" class="ready-state">
              <p>图片已就绪</p>
              <span>点击开始后将在浏览器本地完成 AI 抠图。</span>
            </div>
            <div v-if="stage === 'processing'" class="processing-state">
              <svg width="42" height="42" viewBox="0 0 42 42" fill="none" class="spinner"><circle cx="21" cy="21" r="17" stroke="currentColor" stroke-width="3" stroke-dasharray="40 80" stroke-linecap="round"/></svg>
              <p>{{ progressText }}</p>
              <div class="progress-track"><div :style="{ width: progressPct + '%' }"></div></div>
            </div>
            <div v-if="stage === 'error'" class="error-state">
              <p>处理失败</p>
              <span>{{ errorMsg }}</span>
            </div>
          </div>
        </main>

        <aside class="control-panel glass-panel">
          <div class="panel-head">
            <span>EXPORT</span>
            <button class="icon-btn danger" @click="clearAll" title="清空">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>

          <div class="control-group">
            <label><span>Padding</span><b>{{ padding }}%</b></label>
            <input v-model="padding" type="range" min="0" max="30" step="1" :disabled="isRunning" />
          </div>
          <div class="control-group">
            <label><span>Size</span><b>{{ outputSize }}px</b></label>
            <input v-model="outputSize" type="range" min="512" max="2048" step="128" :disabled="isRunning" />
          </div>
          <div class="control-group">
            <label><span>Radius</span><b>{{ radius }}px</b></label>
            <input v-model="radius" type="range" min="0" :max="outputSize / 2" step="8" :disabled="isRunning" />
          </div>

          <button class="primary-action" :disabled="!canProcess" @click="processImage">
            <svg v-if="!isRunning" width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h7l-1 8 10-13h-7l1-7z" fill="currentColor"/></svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" class="spinner"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-dasharray="28 56" stroke-linecap="round"/></svg>
            {{ isRunning ? 'AI 抠图中' : stage === 'done' ? '重新抠图' : '开始智能抠图' }}
          </button>
          <button class="download-action" :disabled="stage !== 'done'" @click="downloadResult">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            下载透明 PNG
          </button>
        </aside>
      </div>

      <div v-if="isDragging" class="drop-overlay">
        <span>{{ stage === 'empty' ? '松开开始上传' : '松开替换当前图片' }}</span>
      </div>
    </section>

    <Transition name="settings">
      <div v-if="props.showSettings" class="settings-overlay" @click.self="emit('update:showSettings', false)">
        <div class="settings-panel mini">
          <div class="sp-header">
            <div class="sp-title-row"><span class="sp-title">{{ t('mode.matting') }}</span></div>
            <button class="sp-close" @click="emit('update:showSettings', false)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="sp-section">
            <div class="sp-section-label">CANVAS EXPORT</div>
            <p class="sp-hint">当前抠图面板的 Padding、Size、Radius 会实时应用到透明 PNG 导出。</p>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped src="./Dashboard.css"></style>
<style scoped>
.matting-root { background: var(--c-bg-base); }
.matting-stage { flex: 1; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; padding: 28px; background: radial-gradient(circle at 50% 20%, rgba(255,255,255,0.05), transparent 34%), radial-gradient(circle at 20% 80%, rgba(6,182,212,0.08), transparent 28%), var(--c-bg-base); }
.ambient { position: absolute; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px); background-size: 38px 38px; mask-image: radial-gradient(circle at center, #000 0%, transparent 78%); opacity: 0.8; }
.drop-card { position: relative; z-index: 1; width: min(620px, 92vw); display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 52px 42px; border: 1px solid rgba(255,255,255,0.16); border-radius: 26px; background: color-mix(in srgb, var(--c-bg-surface) 72%, transparent); box-shadow: 0 30px 80px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.12); backdrop-filter: blur(30px) saturate(1.35); -webkit-backdrop-filter: blur(30px) saturate(1.35); text-align: center; cursor: pointer; transition: transform var(--dur-normal) var(--ease-out), border-color var(--dur-normal); }
.drop-card:hover { transform: translateY(-3px); border-color: var(--c-border-accent); }
.matting-orbit { width: 104px; height: 104px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--c-accent); background: radial-gradient(circle, var(--c-accent-subtle), transparent 68%); border: 1px solid var(--c-border-accent); box-shadow: var(--shadow-glow-sm); }
.eyebrow, .panel-head span { font-family: 'JetBrains Mono', monospace; font-size: 0.64rem; font-weight: 800; letter-spacing: 0.14em; color: var(--c-text-muted); }
.drop-card h2 { font-family: 'Space Grotesk', sans-serif; font-size: clamp(1.6rem, 4vw, 2.8rem); line-height: 1.08; color: var(--c-text-primary); letter-spacing: 0; }
.sub { max-width: 500px; color: var(--c-text-secondary); font-size: 0.92rem; line-height: 1.65; }
.format-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.format-row span { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; font-weight: 800; color: var(--c-text-accent); background: var(--c-accent-subtle); border: 1px solid var(--c-border-accent); border-radius: var(--r-full); padding: 5px 12px; }
.workbench { position: relative; z-index: 1; width: min(1440px, 100%); height: min(760px, 100%); display: grid; grid-template-columns: minmax(220px, 300px) minmax(360px, 1fr) minmax(240px, 320px); gap: 16px; }
.glass-panel { min-width: 0; min-height: 0; border: 1px solid rgba(255,255,255,0.13); border-radius: 18px; background: color-mix(in srgb, var(--c-bg-surface) 68%, transparent); box-shadow: 0 22px 54px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.08); backdrop-filter: blur(24px) saturate(1.3); -webkit-backdrop-filter: blur(24px) saturate(1.3); overflow: hidden; }
.panel-head { height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid var(--c-border); }
.icon-btn { width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--c-text-muted); background: var(--c-bg-overlay); border: 1px solid var(--c-border); transition: all var(--dur-fast); }
.icon-btn:hover { color: var(--c-accent); border-color: var(--c-border-accent); background: var(--c-accent-subtle); }
.icon-btn.danger:hover { color: var(--c-danger); border-color: rgba(239,68,68,0.45); background: var(--c-danger-subtle); }
.source-panel, .control-panel { display: flex; flex-direction: column; }
.source-preview { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,0.12); }
.source-preview img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 12px; box-shadow: var(--shadow-md); }
.file-meta { padding: 14px 16px 18px; border-top: 1px solid var(--c-border); display: flex; flex-direction: column; gap: 4px; }
.file-meta strong { color: var(--c-text-primary); font-size: 0.82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-meta span, .ready-state span, .error-state span { color: var(--c-text-muted); font-size: 0.72rem; }
.result-panel { display: flex; flex-direction: column; }
.done-pill { color: var(--c-success) !important; background: var(--c-success-subtle); border: 1px solid rgba(34,197,94,0.25); border-radius: var(--r-full); padding: 3px 8px; }
.result-preview { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; padding: 24px; background-color: rgba(255,255,255,0.025); background-image: linear-gradient(45deg, rgba(255,255,255,0.07) 25%, transparent 25%), linear-gradient(-45deg, rgba(255,255,255,0.07) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.07) 75%), linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.07) 75%); background-size: 28px 28px; background-position: 0 0, 0 14px, 14px -14px, -14px 0; }
.result-preview canvas { width: min(100%, 620px); height: auto; max-height: 100%; aspect-ratio: 1; object-fit: contain; filter: drop-shadow(0 20px 40px rgba(0,0,0,0.32)); }
.ready-state, .processing-state, .error-state { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; color: var(--c-text-secondary); }
.ready-state p, .processing-state p, .error-state p { color: var(--c-text-primary); font-weight: 700; }
.spinner { animation: mat-spin 1s linear infinite; color: var(--c-accent); }
.progress-track { width: min(320px, 60vw); height: 5px; border-radius: var(--r-full); background: var(--c-bg-elevated); overflow: hidden; border: 1px solid var(--c-border); }
.progress-track div { height: 100%; background: var(--c-accent); border-radius: inherit; transition: width var(--dur-normal) var(--ease-out); }
.control-panel { padding-bottom: 16px; }
.control-group { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px 4px; }
.control-group label { display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem; color: var(--c-text-secondary); font-weight: 700; }
.control-group b { font-family: 'JetBrains Mono', monospace; color: var(--c-text-accent); font-size: 0.72rem; }
.control-group input { width: 100%; height: 4px; appearance: none; border-radius: var(--r-full); background: var(--c-bg-elevated); }
.control-group input::-webkit-slider-thumb { appearance: none; width: 17px; height: 17px; border-radius: 50%; background: var(--c-accent); box-shadow: var(--shadow-glow-sm); }
.primary-action, .download-action { width: calc(100% - 36px); margin: 18px 18px 0; min-height: 42px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-size: 0.84rem; font-weight: 800; transition: all var(--dur-normal) var(--ease-out); }
.primary-action { color: #fff; background: var(--c-accent); box-shadow: var(--shadow-glow-sm); }
.download-action { color: var(--c-success); background: var(--c-success-subtle); border: 1px solid rgba(34,197,94,0.28); }
.primary-action:hover:not(:disabled), .download-action:hover:not(:disabled) { transform: translateY(-1px); }
.primary-action:disabled, .download-action:disabled { opacity: 0.42; cursor: not-allowed; transform: none; box-shadow: none; }
.drop-overlay { position: absolute; inset: 18px; z-index: 4; border: 1px dashed var(--c-border-accent); border-radius: 22px; display: flex; align-items: center; justify-content: center; background: rgba(249,115,22,0.12); color: var(--c-text-accent); font-weight: 800; backdrop-filter: blur(10px); }
.settings-panel.mini { width: min(360px, 92vw); }
@keyframes mat-spin { to { transform: rotate(360deg); } }
@media (max-width: 1020px) {
  .matting-stage { padding: 14px; }
  .workbench { height: 100%; grid-template-columns: 1fr; grid-template-rows: 180px minmax(260px, 1fr) auto; overflow-y: auto; }
  .control-panel { min-height: 320px; }
}
@media (max-width: 620px) {
  .drop-card { padding: 36px 22px; border-radius: 20px; }
  .matting-orbit { width: 78px; height: 78px; }
  .workbench { gap: 10px; }
  .panel-head { height: 42px; padding: 0 12px; }
  .source-preview, .result-preview { padding: 12px; }
}
</style>
