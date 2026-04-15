<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { t } from '../locales/i18n';

const props = defineProps<{ originalUrl: string; compressedUrl: string }>();

const containerRef = ref<HTMLDivElement | null>(null);
const originalVideoRef = ref<HTMLVideoElement | null>(null);
const compressedVideoRef = ref<HTMLVideoElement | null>(null);
const sliderX = ref(50);
let isDragging = false;
let rafId = 0;
let pendingX = 50;
let syncing = false;

// ── 滑块拖动 ──────────────────────────────────────────────────────
const updateSlider = (clientX: number) => {
  if (!containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  pendingX = Math.max(2, Math.min(98, ((clientX - rect.left) / rect.width) * 100));
};

const onMove = (e: MouseEvent | TouchEvent) => {
  if (!isDragging) return;
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  updateSlider(clientX);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => { sliderX.value = pendingX; });
};

const onDown = (e: MouseEvent | TouchEvent) => {
  isDragging = true;
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  updateSlider(clientX);
  sliderX.value = pendingX;
};
const onUp = () => { isDragging = false; };

// ── 双流时间轴同步 ────────────────────────────────────────────────
const syncVideos = () => {
  const orig = originalVideoRef.value;
  const comp = compressedVideoRef.value;
  if (!orig || !comp || syncing) return;

  syncing = true;
  // 以原始视频为基准同步压缩视频
  const drift = Math.abs(orig.currentTime - comp.currentTime);
  if (drift > 0.1) comp.currentTime = orig.currentTime;

  // 同步播放/暂停状态
  if (!orig.paused && comp.paused) comp.play().catch(() => {});
  if (orig.paused && !comp.paused) comp.pause();
  syncing = false;
};

let syncInterval: ReturnType<typeof setInterval> | null = null;

const startSync = () => {
  if (syncInterval) return;
  syncInterval = setInterval(syncVideos, 200);
};

const stopSync = () => {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
};

// 原始视频 seek 时同步
const onOriginalSeeked = () => {
  const comp = compressedVideoRef.value;
  const orig = originalVideoRef.value;
  if (comp && orig) comp.currentTime = orig.currentTime;
};

const onOriginalPlay = () => { compressedVideoRef.value?.play().catch(() => {}); startSync(); };
const onOriginalPause = () => { compressedVideoRef.value?.pause(); };

onMounted(() => {
  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('mouseup', onUp, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: true });
  window.addEventListener('touchend', onUp, { passive: true });
  startSync();
});

onUnmounted(() => {
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
  window.removeEventListener('touchmove', onMove);
  window.removeEventListener('touchend', onUp);
  cancelAnimationFrame(rafId);
  stopSync();
});
</script>

<template>
  <div
    ref="containerRef"
    class="cs-root"
    @mousedown="onDown"
    @touchstart.prevent="onDown"
  >
    <!-- 原片层 -->
    <div class="cs-layer">
      <video ref="originalVideoRef" :src="props.originalUrl" class="cs-video" muted loop autoplay playsinline @seeked="onOriginalSeeked" @play="onOriginalPlay" @pause="onOriginalPause" />
      <div class="cs-label cs-label-left">
        <span class="cs-dot original"></span>
        {{ t('slider.original') }}
      </div>
    </div>

    <!-- 压缩层 -->
    <div class="cs-layer cs-top" :style="{ clipPath: `inset(0 0 0 ${sliderX}%)` }">
      <video ref="compressedVideoRef" :src="props.compressedUrl" class="cs-video" muted loop autoplay playsinline />
      <div class="cs-label cs-label-right">
        <span class="cs-dot compressed"></span>
        {{ t('slider.compressed') }}
      </div>
    </div>

    <!-- 分割线 -->
    <div class="cs-divider" :style="{ left: `${sliderX}%` }">
      <div class="cs-handle" @mousedown.stop="onDown" @touchstart.stop.prevent="onDown">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M8 5L3 12L8 19M16 5L21 12L16 19" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>

    <!-- 提示 -->
    <div class="cs-hint" :style="{ opacity: isDragging ? 0 : 1 }">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 9l-3 3 3 3M19 9l3 3-3 3M9 5l3-3 3 3M9 19l3 3 3-3" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      {{ t('slider.dragToCompare') }}
    </div>
  </div>
</template>

<style scoped>
.cs-root { position: relative; width: 100%; height: 100%; overflow: hidden; border-radius: 16px; cursor: col-resize; user-select: none; background: #000; flex: 1; }
.cs-layer { position: absolute; inset: 0; }
.cs-top { z-index: 2; }
.cs-video { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
.cs-label { position: absolute; top: 16px; display: flex; align-items: center; gap: 6px; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.12em; color: white; background: rgba(0,0,0,0.55); backdrop-filter: blur(12px); padding: 5px 12px; border-radius: 999px; pointer-events: none; border: 1px solid rgba(255,255,255,0.12); }
.cs-label-left { left: 16px; }
.cs-label-right { right: 16px; }
.cs-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.cs-dot.original { background: #f59e0b; }
.cs-dot.compressed { background: #22c55e; }
.cs-divider { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255,255,255,0.85); transform: translateX(-50%); z-index: 10; pointer-events: none; }
.cs-handle { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 48px; height: 48px; border-radius: 50%; background: rgba(255,255,255,0.12); backdrop-filter: blur(16px); border: 1.5px solid rgba(255,255,255,0.3); display: flex; align-items: center; justify-content: center; pointer-events: all; cursor: col-resize; transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1), background 0.2s; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
.cs-handle:hover { transform: translate(-50%, -50%) scale(1.15); background: rgba(99,102,241,0.5); }
.cs-hint { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; font-size: 0.72rem; font-weight: 600; color: rgba(255,255,255,0.6); background: rgba(0,0,0,0.45); backdrop-filter: blur(12px); padding: 6px 14px; border-radius: 999px; pointer-events: none; transition: opacity 0.3s ease; z-index: 20; border: 1px solid rgba(255,255,255,0.1); }
</style>
