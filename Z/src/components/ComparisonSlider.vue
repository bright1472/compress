<script setup lang="ts">
import { ref, onUnmounted } from 'vue';

const props = defineProps<{
  originalUrl: string;
  compressedUrl: string;
}>();

const sliderRef = ref<HTMLDivElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);
const sliderX = ref(50); // 百分比

let isDragging = false;

const onMouseDown = () => { isDragging = true; };

const onMouseMove = (e: MouseEvent | TouchEvent) => {
  if (!isDragging || !containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
  sliderX.value = (x / rect.width) * 100;
};

const onMouseUp = () => { isDragging = false; };

onUnmounted(() => {
  window.removeEventListener('mouseup', onMouseUp);
  window.removeEventListener('mousemove', onMouseMove as any);
});

// 全局事件绑定
window.addEventListener('mouseup', onMouseUp, { passive: true });
window.addEventListener('mousemove', onMouseMove as any, { passive: true });
window.addEventListener('touchend', onMouseUp, { passive: true });
window.addEventListener('touchmove', onMouseMove as any, { passive: true });
</script>

<template>
  <div
    ref="containerRef"
    class="comparison-slider"
    @touchstart.prevent="onMouseDown"
    @mousedown="onMouseDown"
  >
    <!-- 原始视频 (左侧) -->
    <div class="layer layer-original">
      <video :src="originalUrl" muted loop autoplay playsinline class="preview-video" />
      <span class="label label-left">ORIGINAL</span>
    </div>

    <!-- 压缩后视频 (右侧，用 clip-path 遮住左半部分) -->
    <div class="layer layer-compressed" :style="{ clipPath: `inset(0 0 0 ${sliderX}%)` }">
      <video :src="compressedUrl" muted loop autoplay playsinline class="preview-video" />
      <span class="label label-right">COMPRESSED</span>
    </div>

    <!-- 中间分割线 -->
    <div class="divider" :style="{ left: `${sliderX}%` }">
      <div ref="sliderRef" class="handle" @mousedown.stop="onMouseDown" @touchstart.stop.prevent="onMouseDown">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 5L3 12L8 19M16 5L21 12L16 19" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comparison-slider {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 16px;
  cursor: col-resize;
  background: #000;
  user-select: none;
}

.layer {
  position: absolute;
  inset: 0;
}

.preview-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.label {
  position: absolute;
  top: 1rem;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: white;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  padding: 4px 10px;
  border-radius: 20px;
  pointer-events: none;
}

.label-left { left: 1rem; }
.label-right { right: 1rem; }

.layer-compressed { transition: clip-path 0.05s linear; }

.divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(255, 255, 255, 0.9);
  transform: translateX(-50%);
  pointer-events: none;
}

.handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: all;
  cursor: col-resize;
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  background: #007AFF;
}

.handle:hover { transform: translate(-50%, -50%) scale(1.1); }
</style>
