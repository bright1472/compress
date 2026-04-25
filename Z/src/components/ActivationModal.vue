<script setup lang="ts">
import { ref } from 'vue';
import { activateLicense } from '../composables/useUsageLimit';
import { t } from '../locales/i18n';

const emit = defineEmits<{ (e: 'close'): void }>();

const key = ref('');
const loading = ref(false);
const error = ref('');
const success = ref(false);

function formatKey(raw: string) {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.match(/.{1,4}/g)?.join('-') ?? cleaned;
}

function onInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  key.value = formatKey(val);
}

async function submit() {
  const trimmed = key.value.trim();
  if (!trimmed) { error.value = t.value('activation.enterKey'); return; }
  loading.value = true;
  error.value = '';
  try {
    await activateLicense(trimmed);
    success.value = true;
    setTimeout(() => emit('close'), 1200);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : t.value('activation.failed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal-box activation-modal">
        <button class="modal-close" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>

        <div class="activation-header">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          <div>
            <p class="activation-title">{{ t('activation.title') }}</p>
            <p class="activation-sub">{{ t('activation.sub') }}</p>
          </div>
        </div>

        <div v-if="success" class="activation-success">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>{{ t('activation.success') }}</span>
        </div>

        <template v-else>
          <input
            class="auth-input activation-key-input"
            type="text"
            :value="key"
            @input="onInput"
            :placeholder="t('activation.placeholder')"
            maxlength="19"
            @keydown.enter="submit"
            autocomplete="off"
            spellcheck="false"
          />
          <p v-if="error" class="auth-error">{{ error }}</p>
          <button class="auth-submit" :disabled="loading" @click="submit">
            <span v-if="loading" class="auth-spinner"></span>
            <span>{{ t('activation.activate') }}</span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>
