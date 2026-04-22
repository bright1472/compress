<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, provide } from 'vue';
import { EngineRouter } from '../engine/engine-router';
import VideoCompressor from './VideoCompressor.vue';
import ImageCompressor from './ImageCompressor.vue';
import LoggerConsole from './LoggerConsole.vue';
import { t, currentLocale, setLocale } from '../locales/i18n';
import { logger } from '../engine/logger';
import { mode, setMode } from '../composables/useModeToggle';
import { fmtTime } from '../composables/useCompressionQueue';

// ── EngineRouter 单例，子组件通过 inject 共享 ────────────────────
const router = new EngineRouter();
provide('engineRouter', router);

// ── Theme ────────────────────────────────────────────────────────
const THEME_KEY = 'titan-theme';
const savedTheme = localStorage.getItem(THEME_KEY);
const isDark = ref(savedTheme ? savedTheme === 'dark' : true);
const applyTheme = () => document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
const toggleTheme = () => { isDark.value = !isDark.value; };
watch(isDark, (v) => { applyTheme(); localStorage.setItem(THEME_KEY, v ? 'dark' : 'light'); }, { immediate: true });

// ── Logger 开关（全局）────────────────────────────────────────────
const GLOBAL_KEY = 'titan-global-settings';
const _gs = (() => { try { return JSON.parse(localStorage.getItem(GLOBAL_KEY) ?? 'null'); } catch { return null; } })();
const showLoggerEnabled = ref<boolean>(typeof _gs?.showLoggerEnabled === 'boolean' ? _gs.showLoggerEnabled : false);
watch(showLoggerEnabled, (v) => { localStorage.setItem(GLOBAL_KEY, JSON.stringify({ showLoggerEnabled: v })); });

// ── Settings/Logger 面板 ──────────────────────────────────────────
const showSettings = ref(false);
const showLogger = ref(false);
const openSettings = () => { showSettings.value = true; };
const openDiagnosticLogs = () => { logger.info('system', 'User opened diagnostic console'); showLogger.value = true; };

// 模式切换时关闭当前设置面板，避免两个覆盖层重叠
watch(mode, () => { showSettings.value = false; });

// ── 子组件引用：读取 isRunning / pendingCount / currentProcessing ─
const videoRef = ref<InstanceType<typeof VideoCompressor> | null>(null);
const imageRef = ref<InstanceType<typeof ImageCompressor> | null>(null);

const videoRunning = computed(() => !!videoRef.value?.isRunning);
const imageRunning = computed(() => !!imageRef.value?.isRunning);
const videoTotal = computed(() => videoRef.value?.totalCount ?? 0);
const imageTotal = computed(() => imageRef.value?.totalCount ?? 0);

const activeRunning = computed(() => mode.value === 'video' ? videoRunning.value : imageRunning.value);
const activeProcessing = computed(() => mode.value === 'video'
  ? videoRef.value?.currentProcessing ?? null
  : imageRef.value?.currentProcessing ?? null);

const videoBadge = computed(() => videoRunning.value ? (videoRef.value?.currentProcessing ? 1 : 0) : 0);
const imageBadge = computed(() => imageRunning.value ? (imageRef.value?.currentProcessing ? 1 : 0) : 0);

// ── 全局事件 ──────────────────────────────────────────────────────
const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') { showSettings.value = false; showLogger.value = false; }
};
const handleBeforeUnload = (e: BeforeUnloadEvent) => {
  if (videoTotal.value > 0 || imageTotal.value > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
};

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', handleBeforeUnload);
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  router.terminate();
});
</script>

<template>
  <div class="app-shell">
    <!-- 全局进度条：当前激活模式在运行时显示 -->
    <div class="global-bar" v-if="activeRunning">
      <div class="global-bar-fill" :style="{ width: (activeProcessing?.progress ?? 0) + '%' }"></div>
    </div>

    <!-- ═══ HEADER ═══════════════════════════════════════════════ -->
    <header class="app-header">
      <div class="header-brand">
        <div class="brand-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/></svg>
        </div>
        <div>
          <span class="brand-name">{{ t('app.title') }}</span>
          <span class="brand-sub">{{ t('app.slogan') }}</span>
        </div>
      </div>

      <div class="header-center" v-if="activeRunning && activeProcessing">
        <div class="hc-dot"></div>
        <span class="hc-label">{{ t('process.compressing') }}</span>
        <span class="hc-file">{{ activeProcessing.file.name }}</span>
        <span class="hc-sep">·</span>
        <span class="hc-rate">{{ activeProcessing.throughput.toFixed(1) }} MB/s</span>
        <span class="hc-sep">·</span>
        <span class="hc-prog">{{ activeProcessing.progress.toFixed(1) }}%</span>
        <span class="hc-sep">·</span>
        <span class="hc-prog">{{ t('process.remainingTime', { t: fmtTime(activeProcessing.remaining) }) }}</span>
      </div>

      <div class="header-right">
        <!-- Mode toggle -->
        <div class="mode-toggle" role="tablist">
          <button
            class="mode-pill"
            role="tab"
            :aria-selected="mode === 'video'"
            :class="{ active: mode === 'video' }"
            @click="setMode('video')"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><polygon points="23 7 16 12 23 17 23 7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><rect x="1" y="5" width="15" height="14" rx="2" stroke="currentColor" stroke-width="2"/></svg>
            <span>{{ t('mode.video') }}</span>
            <span v-if="mode !== 'video' && videoBadge > 0" class="mode-badge">{{ videoBadge }}</span>
          </button>
          <button
            class="mode-pill"
            role="tab"
            :aria-selected="mode === 'image'"
            :class="{ active: mode === 'image' }"
            @click="setMode('image')"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="9" r="2" stroke="currentColor" stroke-width="2"/><path d="M21 15l-5-5-10 10" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
            <span>{{ t('mode.image') }}</span>
            <span v-if="mode !== 'image' && imageBadge > 0" class="mode-badge">{{ imageBadge }}</span>
          </button>
        </div>

        <div class="hdr-divider"></div>

        <button v-if="showLoggerEnabled" class="hdr-icon-btn" :class="{ active: showLogger }" @click="openDiagnosticLogs" :title="t('nav.diagnostic')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 17l6-6-6-6m8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="hdr-icon-btn" @click="openSettings" :title="t('nav.settings')" :class="{ active: showSettings }">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.8"/></svg>
        </button>

        <div class="hdr-divider"></div>

        <button class="theme-switch" @click="toggleTheme" :title="isDark ? t('nav.toggleLight') : t('nav.toggleDark')">
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

    <!-- ═══ BODY — 两个 compressor 始终挂载，仅用 v-show 切换 ═════ -->
    <VideoCompressor
      ref="videoRef"
      v-show="mode === 'video'"
      :show-settings="mode === 'video' && showSettings"
      @update:show-settings="showSettings = $event"
    />
    <ImageCompressor
      ref="imageRef"
      v-show="mode === 'image'"
      :show-settings="mode === 'image' && showSettings"
      @update:show-settings="showSettings = $event"
    />

    <LoggerConsole :show="showLogger" @close="showLogger = false" />
  </div>
</template>

<style scoped src="./Dashboard.css"></style>
