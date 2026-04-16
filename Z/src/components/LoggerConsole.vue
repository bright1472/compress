<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { logger } from '../engine/logger';
import { t } from '../locales/i18n';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const logs = ref<any[]>([]);
const terminalRef = ref<HTMLElement | null>(null);
const showErrorsOnly = ref(false);

const filteredLogs = computed(() => {
  if (!showErrorsOnly.value) return logs.value;
  return logs.value.filter(l => l.level === 'error');
});

const updateLogs = () => {
  logs.value = logger.getLogs();
  nextTick(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
    }
  });
};

watch(() => props.show, (isOpen) => {
  if (isOpen) {
    updateLogs();
  }
});

onMounted(() => {
  if (props.show) updateLogs();
});

const copyLog = (log: any) => {
  const time = new Date(log.timestamp).toISOString().split('T')[1].replace('Z', '');
  const text = `[${time}] [${log.level.toUpperCase()}] [${log.category}] ${log.message}`;
  navigator.clipboard.writeText(text);
};

</script>

<template>
  <div v-if="show" class="logger-overlay" @click.self="emit('close')">
    <div class="logger-modal">
      <div class="logger-header">
        <div class="logger-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 17l6-6-6-6m8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Diagnostic Console <span class="paused-badge">(Paused)</span>
        </div>
        <div class="logger-actions">
          <label class="error-filter">
            <input type="checkbox" v-model="showErrorsOnly">
            <span class="filter-label">Errors Only</span>
          </label>
          <button class="logger-btn refresh-btn" @click="updateLogs" title="Fetch latest logs">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="logger-btn logger-close" @click="emit('close')">✕</button>
        </div>
      </div>
      <div class="logger-body" ref="terminalRef">
        <div v-if="filteredLogs.length === 0" class="log-empty">No logs yet...</div>
        <div v-for="(log, idx) in filteredLogs" :key="idx" class="log-row" :class="log.level" @click="copyLog(log)" title="Click to copy">
          <span class="log-time">{{ new Date(log.timestamp).toISOString().split('T')[1].slice(0,-1) }}</span>
          <span class="log-cat">[{{ log.category }}]</span>
          <span class="log-msg">{{ log.message }}</span>
          <span class="log-copy-hint">Copy</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.logger-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 20px; }
.logger-modal { width: 100%; max-width: 800px; height: 60vh; max-height: 600px; display: flex; flex-direction: column; background: #1e1e1e; border: 1px solid #333; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); overflow: hidden; font-family: 'JetBrains Mono', monospace; }
.logger-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; background: #252526; border-bottom: 1px solid #333; }
.logger-title { display: flex; align-items: center; gap: 8px; color: #ccc; font-size: 0.8rem; font-weight: 600; }
.paused-badge { font-size: 0.6rem; background: #884400; color: #ffcc00; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
.logger-actions { display: flex; align-items: center; gap: 8px; }
.logger-btn { background: none; border: none; color: #888; cursor: pointer; padding: 4px; border-radius: 4px; display: flex; align-items: center; justify-content: center; }
.logger-btn:hover { background: #333; color: #fff; }

.error-filter { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 4px 8px; border-radius: 4px; border: 1px solid #333; background: #1e1e1e; transition: all 0.2s; }
.error-filter:hover { background: #333; }
.error-filter input { width: 12px; height: 12px; accent-color: #f48771; cursor: pointer; }
.filter-label { font-size: 0.65rem; color: #aaa; font-weight: 500; user-select: none; }

.logger-body { flex: 1; overflow-y: auto; padding: 10px; background: #1e1e1e; font-size: 0.75rem; color: #ccc; scrollbar-width: thin; scrollbar-color: #444 transparent; }
.log-row { display: flex; align-items: flex-start; gap: 8px; padding: 4px 6px; border-radius: 4px; cursor: pointer; transition: background 0.1s; position: relative; }
.log-row:hover { background: rgba(255,255,255,0.05); }
.log-row:hover .log-copy-hint { opacity: 1; }
.log-time { color: #666; flex-shrink: 0; }
.log-cat { color: #569cd6; flex-shrink: 0; width: 85px; }
.log-msg { flex: 1; word-break: break-all; }
.log-copy-hint { position: absolute; right: 10px; top: 4px; font-size: 0.65rem; color: #fff; background: #007acc; padding: 2px 6px; border-radius: 4px; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
.log-row.error .log-msg { color: #f48771; }
.log-row.warn .log-msg { color: #cca700; }
</style>
