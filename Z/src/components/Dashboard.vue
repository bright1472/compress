<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { MediaEngine } from '../engine/processor';
import ComparisonSlider from './ComparisonSlider.vue';

// ============================================================
// Titan V4 Elite 状态机 - 融合了 V3 的美学与 V4 的吞吐量
// ============================================================
type State = 'idle' | 'loading' | 'compressing' | 'done' | 'error';
const state = ref<State>('idle');
const errorMsg = ref('');

const originalFile = ref<File | null>(null);
const originalUrl = ref('');
const compressedUrl = ref('');
const compressedBlob = ref<Blob | null>(null);

// 核心参数 (恢复 V3 控制权)
const codec = ref('libx264');
const crf = ref(28);
const preset = ref('fast');

// 实时指标
const throughput = ref(0);
const processedBytes = ref(0);
const progress = ref(0);

const engine = new MediaEngine();

// ============================================================
// 控制逻辑
// ============================================================
const onFileInput = (e: Event) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    if (originalUrl.value) URL.revokeObjectURL(originalUrl.value);
    originalFile.value = file;
    originalUrl.value = URL.createObjectURL(file);
    state.value = 'idle';
    progress.value = 0;
  }
};

const startCompression = async () => {
  if (!originalFile.value) return;
  state.value = 'compressing';
  
  const startTime = Date.now();

  try {
    const resultFile = await engine.processLargeVideo(
      originalFile.value,
      { bitrate: 5000000, codec: codec.value, crf: crf.value, preset: preset.value },
      (data) => {
        processedBytes.value = data.loaded;
        progress.value = data.progress;
        const now = Date.now();
        const elapsed = (now - startTime) / 1000;
        if (elapsed > 0) throughput.value = (data.loaded / 1024 / 1024) / elapsed;
      }
    ) as File;

    compressedBlob.value = resultFile;
    compressedUrl.value = URL.createObjectURL(resultFile);
    state.value = 'done';
  } catch (e: any) {
    state.value = 'error';
    errorMsg.value = e.message;
  }
};

const download = () => {
  if (!compressedUrl.value) return;
  const a = document.createElement('a');
  a.href = compressedUrl.value;
  a.download = `titan_${originalFile.value?.name || 'video'}.mp4`;
  a.click();
};

const reset = () => {
  state.value = 'idle';
  originalFile.value = null;
  compressedBlob.value = null;
  progress.value = 0;
};

onUnmounted(() => engine.stop());
</script>

<template>
  <div class="titan-dashboard">
    <!-- Header: 恢复大厂级身份感 -->
    <header class="titan-nav glass-panel">
      <div class="logo">
        <div class="logo-box">T</div>
        <div class="logo-text">
          <h1>Project Titan</h1>
          <span>ELITE MEDIA ENGINE</span>
        </div>
      </div>
      
      <div v-if="state === 'compressing'" class="live-status">
        <div class="status-item">
          <span class="label">RATE</span>
          <span class="value">{{ throughput.toFixed(1) }} MB/s</span>
        </div>
        <div class="status-item">
          <span class="label">ACCEL</span>
          <span class="value active">GPU-HW</span>
        </div>
      </div>
    </header>

    <main class="titan-main">
      <!-- 1. 配置区域 (找回消失的功能) -->
      <section v-if="state === 'idle'" class="config-panel glass-panel">
        <div class="control-grid">
          <div class="control-group">
            <label>Encoder</label>
            <select v-model="codec">
              <option value="libx264">H.264 (Standard)</option>
              <option value="libx265">HEVC (Efficient)</option>
              <option value="av1">AV1 (Next-Gen)</option>
            </select>
          </div>
          <div class="control-group">
            <label>Quality (CRF: {{ crf }})</label>
            <input type="range" v-model="crf" min="18" max="35" />
          </div>
          <div class="control-group">
            <label>Preset</label>
            <select v-model="preset">
              <option value="ultrafast">Ultrafast</option>
              <option value="fast">Fast</option>
              <option value="medium">Medium</option>
            </select>
          </div>
        </div>
      </section>

      <!-- 2. 中央工作区 -->
      <div class="workspace">
        <!-- 待机/上传 -->
        <div v-if="state === 'idle'" class="drop-area glass-panel">
          <input type="file" @change="onFileInput" hidden id="file-input" />
          
          <div v-if="!originalFile" class="empty-state">
            <label for="file-input" class="upload-trigger">
              <div class="plus">+</div>
              <p>Drag your 10GB+ masterpiece here</p>
            </label>
          </div>

          <div v-else class="preview-card">
            <video :src="originalUrl" muted loop autoplay class="mini-preview"></video>
            <div class="file-info">
              <h3>{{ originalFile.name }}</h3>
              <p>{{ (originalFile.size / 1024 / 1024).toFixed(2) }} MB</p>
            </div>
            <button @click="startCompression" class="btn-primary">START OPTIMIZATION</button>
          </div>
        </div>

        <!-- 压缩中 (保持专业感) -->
        <div v-if="state === 'compressing'" class="processing-card glass-panel">
          <div class="v4-spinner"></div>
          <h2>Optimizing Stream...</h2>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: progress + '%' }"></div>
          </div>
          <p class="progress-text">{{ progress.toFixed(1) }}%</p>
        </div>

        <!-- 完成 (恢复对比功能) -->
        <div v-if="state === 'done'" class="result-area">
          <ComparisonSlider :original-url="originalUrl" :compressed-url="compressedUrl" />
          <div class="result-toolbar glass-panel">
            <div class="result-meta">
              <span>Original: {{ (originalFile!.size / 1024 / 1024).toFixed(2) }}MB</span>
              <span class="arrow">→</span>
              <span class="savings">Reduced: {{ (100 - (compressedBlob!.size / originalFile!.size * 100)).toFixed(1) }}%</span>
            </div>
            <div class="actions">
              <button @click="download" class="btn-download">Download MP4</button>
              <button @click="reset" class="btn-reset">New File</button>
            </div>
          </div>
        </div>

        <!-- 错误处理 (关键修复：防止页面空白) -->
        <div v-if="state === 'error'" class="error-card glass-panel">
          <div class="error-icon">⚠️</div>
          <h2>Pipeline Collapse</h2>
          <p class="error-detail">{{ errorMsg }}</p>
          <button @click="reset" class="btn-primary">TRY AGAIN</button>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.titan-dashboard { padding: 2rem; max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 2rem; }

.titan-nav { display: flex; justify-content: space-between; align-items: center; padding: 1.5rem 2rem; }
.logo { display: flex; align-items: center; gap: 1rem; }
.logo-box { width: 44px; height: 44px; background: var(--accent-primary); border-radius: 12px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 900; font-size: 1.5rem; }
.logo-text h1 { font-size: 1.2rem; margin: 0; font-weight: 800; }
.logo-text span { font-size: 0.65rem; color: var(--accent-primary); font-weight: 800; letter-spacing: 0.15em; }

.live-status { display: flex; gap: 2rem; }
.status-item { display: flex; flex-direction: column; align-items: flex-end; }
.label { font-size: 0.6rem; color: var(--text-secondary); font-weight: 700; }
.value { font-size: 0.95rem; font-weight: 800; }
.value.active { color: #34c759; }

.config-panel { padding: 1.5rem; }
.control-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2rem; }
.control-group { display: flex; flex-direction: column; gap: 0.5rem; }
.control-group label { font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); }
.control-group select, .control-group input { background: rgba(0,0,0,0.05); border: none; padding: 0.5rem; border-radius: 8px; font-weight: 600; }

.drop-area { min-height: 400px; display: flex; align-items: center; justify-content: center; }
.plus { width: 60px; height: 60px; background: rgba(0,122,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2rem; color: var(--accent-primary); margin: 0 auto 1.5rem; }
.upload-trigger { cursor: pointer; text-align: center; }
.upload-trigger p { font-weight: 600; color: var(--text-secondary); }

.preview-card { display: flex; flex-direction: column; align-items: center; gap: 1.5rem; }
.mini-preview { width: 320px; border-radius: 16px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
.btn-primary { background: var(--text-main); color: white; border: none; padding: 1rem 3rem; border-radius: 14px; font-weight: 800; cursor: pointer; transition: transform 0.2s; }
.btn-primary:active { transform: scale(0.98); }

.processing-card { text-align: center; padding: 4rem; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 2rem; }
.progress-bar { width: 100%; height: 8px; background: rgba(0,0,0,0.05); border-radius: 999px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent-primary); transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); }

.result-area { width: 100%; }
.result-toolbar { margin-top: 1.5rem; display: flex; justify-content: space-between; align-items: center; padding: 1rem 2rem; }
.result-meta { display: flex; align-items: center; gap: 1.5rem; font-weight: 800; font-size: 0.9rem; }
.savings { color: #34c759; }
.actions { display: flex; gap: 1rem; }
.btn-download { background: var(--accent-primary); color: white; border: none; padding: 0.8rem 2rem; border-radius: 12px; font-weight: 800; cursor: pointer; }
.btn-reset { opacity: 0.5; background: none; border: none; font-weight: 700; cursor: pointer; }

/* Spinner */
.v4-spinner { width: 60px; height: 60px; border: 4px solid rgba(0,122,255,0.1); border-top-color: var(--accent-primary); border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
