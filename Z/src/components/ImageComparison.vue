<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  originalUrl: string;
  compressedUrl: string;
  originalLabel: string;
  compressedLabel: string;
}>();

const rootRef = ref<HTMLDivElement | null>(null);

// ── Image loading state ──────────────────────────────────────────
const origLoaded = ref(false);
const compLoaded = ref(false);
const isReady = computed(() => origLoaded.value && compLoaded.value);
watch([() => props.originalUrl, () => props.compressedUrl], () => {
  origLoaded.value = false;
  compLoaded.value = false;
  zoom.value = 1; panX.value = 0; panY.value = 0;
});

// ── Slider (screen-space %) ─────────────────────────────────────────
const sliderPct = ref(50);

// ── Zoom + Pan (pan stored as screen px) ────────────────────────────
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

const clampPan = () => {
  if (!rootRef.value) return;
  const { clientWidth: w, clientHeight: h } = rootRef.value;
  const maxX = (w * (zoom.value - 1)) / 2;
  const maxY = (h * (zoom.value - 1)) / 2;
  panX.value = Math.max(-maxX, Math.min(maxX, panX.value));
  panY.value = Math.max(-maxY, Math.min(maxY, panY.value));
};

const applyZoom = (newZoom: number) => {
  zoom.value = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
  if (zoom.value <= MIN_ZOOM) { panX.value = 0; panY.value = 0; }
  else clampPan();
};

// ── Canvas transform: scale from center, then translate (screen px) ─
// CSS: scale(z) translate(px/z, py/z) → translates by (px,py) in screen space
const canvasStyle = computed(() => ({
  transform: `scale(${zoom.value}) translate(${panX.value / zoom.value}px, ${panY.value / zoom.value}px)`,
  transformOrigin: 'center center',
  cursor: isPanDragging ? 'grabbing' : zoom.value > 1 ? 'grab' : 'default',
}));

// ── Clip-path: original image shows left side up to divider ─────────
// Divider is at sliderPct% of container (screen space).
// Convert to image-space percentage accounting for zoom + pan.
const origClipRight = computed((): number => {
  if (!rootRef.value) return 100 - sliderPct.value;
  const w = rootRef.value.clientWidth;
  const screenX = (sliderPct.value / 100) * w;
  // Left edge of image on screen: center + panX - half_scaled_width
  const imgLeftScreen = w / 2 + panX.value - (w * zoom.value) / 2;
  const imgPct = ((screenX - imgLeftScreen) / (w * zoom.value)) * 100;
  const showLeft = Math.max(0, Math.min(100, imgPct));
  return 100 - showLeft; // clip-path inset from right
});

// ── Divider drag ────────────────────────────────────────────────────
let isDividerDragging = false;

const onDividerPointerDown = (e: PointerEvent) => {
  isDividerDragging = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  e.stopPropagation();
};

const onDividerPointerMove = (e: PointerEvent) => {
  if (!isDividerDragging || !rootRef.value) return;
  const rect = rootRef.value.getBoundingClientRect();
  sliderPct.value = Math.max(2, Math.min(98, ((e.clientX - rect.left) / rect.width) * 100));
};

const onDividerPointerUp = () => { isDividerDragging = false; };

// ── Pan drag ────────────────────────────────────────────────────────
let isPanDragging = false;
let lastMX = 0;
let lastMY = 0;

const onRootPointerDown = (e: PointerEvent) => {
  if (isDividerDragging || zoom.value <= 1) return;
  isPanDragging = true;
  lastMX = e.clientX;
  lastMY = e.clientY;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
};

const onRootPointerMove = (e: PointerEvent) => {
  if (!isPanDragging) return;
  panX.value += e.clientX - lastMX;
  panY.value += e.clientY - lastMY;
  lastMX = e.clientX;
  lastMY = e.clientY;
  clampPan();
};

const onRootPointerUp = () => { isPanDragging = false; };

// ── Wheel / Mac trackpad pinch ───────────────────────────────────────
// Mac pinch gesture → wheel event with ctrlKey=true
const onWheel = (e: WheelEvent) => {
  e.preventDefault();
  if (e.ctrlKey) {
    const delta = e.deltaMode === 0 ? e.deltaY * 0.005 : e.deltaY * 0.05;
    applyZoom(zoom.value * (1 - delta));
  } else if (zoom.value > 1) {
    panX.value -= e.deltaX;
    panY.value -= e.deltaY;
    clampPan();
  }
};

// ── Touch pinch ─────────────────────────────────────────────────────
let pinchDist0 = 0;
let pinchZoom0 = 1;

const touchDist = (e: TouchEvent) =>
  Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);

const onTouchStart = (e: TouchEvent) => {
  if (e.touches.length === 2) { pinchDist0 = touchDist(e); pinchZoom0 = zoom.value; }
};

const onTouchMove = (e: TouchEvent) => {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  applyZoom(pinchZoom0 * (touchDist(e) / pinchDist0));
};

const resetView = () => { zoom.value = 1; panX.value = 0; panY.value = 0; sliderPct.value = 50; };

// prevent context menu when right-clicking divider
const onContextMenu = (e: Event) => e.preventDefault();

// attach wheel as non-passive so preventDefault works
let wheelCleanup: (() => void) | null = null;
onMounted(() => {
  const el = rootRef.value;
  if (!el) return;
  const handler = (e: WheelEvent) => onWheel(e);
  el.addEventListener('wheel', handler, { passive: false });
  wheelCleanup = () => el.removeEventListener('wheel', handler);
});
onUnmounted(() => { wheelCleanup?.(); });
</script>

<template>
  <div
    class="ic-root"
    ref="rootRef"
    @pointerdown="onRootPointerDown"
    @pointermove="onRootPointerMove"
    @pointerup="onRootPointerUp"
    @touchstart.passive="onTouchStart"
    @touchmove.prevent="onTouchMove"
    @contextmenu="onContextMenu"
  >
    <!-- Loading skeleton while images decode -->
    <div v-if="!isReady" class="ic-skeleton">
      <div class="ic-skeleton-spinner"></div>
    </div>

    <!-- Zoomable canvas: both images stacked -->
    <div class="ic-canvas" :style="canvasStyle" :class="{ 'ic-hidden': !isReady }">
      <!-- Compressed image (always full visible) -->
      <img class="ic-img" :src="props.compressedUrl" draggable="false" decoding="async" @load="compLoaded = true" />
      <!-- Original image (clipped to left side of divider) -->
      <img
        class="ic-img ic-img-orig"
        :src="props.originalUrl"
        draggable="false"
        decoding="async"
        @load="origLoaded = true"
        :style="{ clipPath: `inset(0 ${origClipRight}% 0 0)` }"
      />
    </div>

    <!-- Divider line — lives in screen space (outside canvas) -->
    <div
      class="ic-divider"
      :style="{ left: sliderPct + '%' }"
      @pointerdown="onDividerPointerDown"
      @pointermove="onDividerPointerMove"
      @pointerup="onDividerPointerUp"
    >
      <div class="ic-handle">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M7 4l-4 6 4 6M13 4l4 6-4 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>

    <!-- Labels -->
    <div class="ic-label ic-label-orig">{{ props.originalLabel }}</div>
    <div class="ic-label ic-label-comp">{{ props.compressedLabel }}</div>

    <!-- Zoom indicator + reset (appears when zoomed) -->
    <Transition name="ic-fade">
      <div class="ic-zoom-overlay" v-if="zoom !== 1">
        <span class="ic-zoom-badge">{{ Math.round(zoom * 100) }}%</span>
        <button class="ic-reset-btn" @click.stop="resetView">重置</button>
      </div>
    </Transition>

    <!-- Usage hint (only at default view) -->
    <div class="ic-hint" v-if="zoom === 1">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
        <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M8 11h6M11 8v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      捏合 / Ctrl+滚轮 缩放 · 拖动竖线对比
    </div>
  </div>
</template>

<style scoped>
.ic-root {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--c-bg-overlay, #0a0a0a);
  user-select: none;
  -webkit-user-select: none;
}

/* Loading skeleton */
.ic-skeleton {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  background: var(--c-bg-overlay, #0a0a0a);
}
.ic-skeleton-spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.12);
  border-top-color: rgba(255,255,255,0.6);
  animation: ic-spin 0.7s linear infinite;
}
@keyframes ic-spin { to { transform: rotate(360deg); } }

/* Zoomable canvas */
.ic-canvas {
  position: absolute;
  inset: 0;
  will-change: transform;
}
.ic-hidden { visibility: hidden; }

.ic-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  pointer-events: none;
}

/* Divider */
.ic-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 40px;
  transform: translateX(-50%);
  cursor: ew-resize;
  z-index: 10;
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ic-divider::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 6px rgba(0, 0, 0, 0.4);
}

.ic-handle {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #333;
  position: relative;
  z-index: 1;
  flex-shrink: 0;
}

/* Labels */
.ic-label {
  position: absolute;
  top: 10px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 3px 9px;
  border-radius: 3px;
  pointer-events: none;
  z-index: 8;
  backdrop-filter: blur(6px);
}

.ic-label-orig {
  left: 10px;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.18);
  border: 1px solid rgba(245, 158, 11, 0.35);
}

.ic-label-comp {
  right: 10px;
  color: #22c55e;
  background: rgba(34, 197, 94, 0.14);
  border: 1px solid rgba(34, 197, 94, 0.3);
}

/* Zoom overlay */
.ic-zoom-overlay {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 15;
}

.ic-zoom-badge {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.65rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255,255,255,0.12);
}

.ic-reset-btn {
  font-size: 0.65rem;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.5);
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: background 0.15s;
}

.ic-reset-btn:hover { background: rgba(255, 255, 255, 0.15); }

/* Hint */
.ic-hint {
  position: absolute;
  bottom: 10px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.58rem;
  color: rgba(255, 255, 255, 0.3);
  pointer-events: none;
  z-index: 5;
}

/* Fade transition */
.ic-fade-enter-active,
.ic-fade-leave-active { transition: opacity 0.2s; }
.ic-fade-enter-from,
.ic-fade-leave-to { opacity: 0; }
</style>
