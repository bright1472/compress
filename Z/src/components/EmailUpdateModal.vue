<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { api } from '../services/api';
import { authUser, updateUser } from '../composables/useAuth';
import { useI18n } from '../locales/i18n';

const { t } = useI18n();
const props = defineProps<{
  show: boolean;
}>();

const emit = defineEmits(['close', 'success']);

const email = ref(authUser.value?.email || '');
const loading = ref(false);
const error = ref('');

// 监听弹窗显示状态，每次打开时同步最新数据
watch(() => props.show, (isShown) => {
  if (isShown) {
    email.value = authUser.value?.email || '';
    error.value = '';
  }
});

const handleUpdate = async () => {
  if (!email.value.trim() || !email.value.includes('@')) {
    error.value = t('auth.emailRequired');
    return;
  }

  loading.value = true;
  error.value = '';
  try {
    const res = await api.post<{ ok: boolean; email: string }>('/compress/update-email', { 
      email: email.value.trim() 
    });
    if (res.ok) {
      updateUser({ email: res.email });
      emit('success', res.email);
      emit('close');
    }
  } catch (e: any) {
    error.value = e.message || t('common.updateFailed');
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  email.value = authUser.value?.email || '';
});
</script>

<template>
  <Transition name="am-fade">
    <div v-if="show" class="am-overlay" @click.self="emit('close')">
      <div class="am-modal am-email-modal">
        <button class="am-close" @click="emit('close')">&times;</button>
        
        <div class="am-header">
          <div class="am-icon-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/>
            </svg>
          </div>
          <h3>{{ t('auth.emailSettings') }}</h3>
          <p>{{ t('auth.emailHint') }}</p>
        </div>

        <div class="am-body">
          <div class="am-field">
            <input
              v-model="email"
              class="am-input"
              type="email"
              :placeholder="t('auth.emailPlaceholder')"
              @keydown.enter="handleUpdate"
              autoFocus
            />
          </div>
          <p v-if="error" class="am-error">{{ error }}</p>
        </div>

        <div class="am-footer">
          <button class="am-btn am-btn-primary am-btn-full" :disabled="loading" @click="handleUpdate">
            <span v-if="loading" class="am-spinner"></span>
            <span>{{ t('common.confirm') }}</span>
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* ── Overlay & Animation ────────────────────────────────────────── */
.am-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(8px); padding: 20px; }
.am-fade-enter-active, .am-fade-leave-active { transition: opacity 0.2s ease; }
.am-fade-enter-from, .am-fade-leave-to { opacity: 0; }

/* ── Modal Box ─────────────────────────────────────────────────── */
.am-modal { position: relative; width: 100%; max-width: 360px; background: var(--c-bg-elevated); border: 1px solid var(--c-border-strong); border-radius: 20px; padding: 32px 24px; box-shadow: 0 32px 64px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05); animation: am-slide-up 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes am-slide-up { from { opacity: 0; transform: translateY(20px) scale(0.96); } to { opacity: 1; transform: none; } }

/* ── Close Button ───────────────────────────────────────────────── */
.am-close { position: absolute; top: 16px; right: 16px; width: 30px; height: 30px; border-radius: 50%; border: none; background: var(--c-bg-hover); color: var(--c-text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: all 0.15s; }
.am-close:hover { background: rgba(239, 68, 68, 0.1); color: #ef4444; }

/* ── Header ─────────────────────────────────────────────────────── */
.am-icon-circle { width: 56px; height: 56px; background: var(--c-accent-subtle); border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: var(--c-accent); box-shadow: 0 8px 16px rgba(249, 115, 22, 0.2); }
.am-header h3 { margin: 0 0 8px; font-size: 1.25rem; font-weight: 700; color: var(--c-text-primary); text-align: center; }
.am-header p { margin: 0 0 28px; font-size: 0.88rem; color: var(--c-text-muted); text-align: center; line-height: 1.6; }

/* ── Form ────────────────────────────────────────────────────────── */
.am-body { margin-bottom: 24px; }
.am-field { background: var(--c-bg-surface); border: 1.5px solid var(--c-border); border-radius: 12px; transition: all 0.2s; }
.am-field:focus-within { border-color: var(--c-accent); box-shadow: 0 0 0 4px var(--c-accent-subtle); }
.am-input { width: 100%; height: 46px; padding: 0 16px; background: transparent; border: none; outline: none; color: var(--c-text-primary); font-size: 0.95rem; text-align: center; font-family: inherit; }
.am-error { font-size: 0.75rem; color: #ef4444; margin: 8px 0 0; text-align: center; font-weight: 500; }

/* ── Buttons ─────────────────────────────────────────────────────── */
.am-btn { height: 46px; border-radius: 12px; border: none; font-size: 0.95rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; transition: all 0.2s; }
.am-btn-primary { background: var(--c-accent); color: #fff; box-shadow: 0 4px 12px rgba(249, 115, 22, 0.3); }
.am-btn-primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(249, 115, 22, 0.4); }
.am-btn-primary:not(:disabled):active { transform: translateY(0); }
.am-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.am-btn-full { width: 100%; }

/* ── Spinner ─────────────────────────────────────────────────────── */
.am-spinner { width: 16px; height: 16px; border: 2.5px solid rgba(255, 255, 255, 0.3); border-top-color: #fff; border-radius: 50%; animation: am-spin 0.8s linear infinite; }
@keyframes am-spin { to { transform: rotate(360deg); } }
</style>
