<script setup lang="ts">
import { ref } from 'vue';
import { login, register, authUser, updateUser } from '../composables/useAuth';
import { syncUsage } from '../composables/useUsageLimit';
import { t } from '../locales/i18n';
import { api } from '../services/api';

const props = defineProps<{ limitReached?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const tab = ref<'login' | 'register'>('login');
const account = ref('');
const password = ref('');
const showPwd = ref(false);
const loading = ref(false);
const error = ref('');
const oneClickLoading = ref(false);
const generatedCreds = ref<{ account: string; password: string } | null>(null);
const email = ref('');
const emailStep = ref(false);

function randStr(chars: string, len: number) {
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function genAccount() {
  const adj = ['fast', 'cool', 'ace', 'top', 'pro', 'neo', 'max', 'fox'];
  const a = adj[Math.floor(Math.random() * adj.length)];
  return `${a}_` + randStr('abcdefghijklmnopqrstuvwxyz0123456789', 6);
}

function genPassword() {
  return randStr('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 12);
}

async function oneClickRegister() {
  oneClickLoading.value = true;
  error.value = '';
  generatedCreds.value = null;
  let attempts = 0;
  while (attempts < 5) {
    const acc = genAccount();
    const pwd = genPassword();
    try {
      await register(acc, pwd);
      await syncUsage();
      generatedCreds.value = { account: acc, password: pwd };
      emailStep.value = true;
      oneClickLoading.value = false;
      return;
    } catch (e: any) {
      const msg = e.message || '';
      if (msg.includes('已存在') || msg.includes('exists')) {
        attempts++;
        continue;
      }
      error.value = msg || t.value('auth.failed');
      oneClickLoading.value = false;
      return;
    }
  }
  error.value = t.value('auth.registerRetry');
  oneClickLoading.value = false;
}

async function sendAndEnter() {
  if (!email.value.trim() || !email.value.includes('@')) {
    error.value = t.value('auth.emailRequired');
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    await api.post('/compress/send-credentials', {
      email: email.value.trim(),
      account: generatedCreds.value?.account,
      pass: generatedCreds.value?.password
    });
    
    // 同步更新本地 authUser 状态，以便后续回填
    updateUser({ email: email.value.trim() });
    
    emit('close');
  } catch (e: any) {
    error.value = e.message || 'Failed to send email';
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!account.value.trim() || !password.value.trim()) {
    error.value = t.value('auth.fillAll');
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    if (tab.value === 'login') {
      await login(account.value.trim(), password.value.trim());
    } else {
      await register(account.value.trim(), password.value.trim());
      generatedCreds.value = { account: account.value.trim(), password: password.value.trim() };
      await syncUsage();
      return; // 注册成功后停留在邮箱绑定界面，不直接 emit('close')
    }
    await syncUsage();
    emit('close');
  } catch (e: any) {
    error.value = e.message || t.value('auth.failed');
  } finally {
    loading.value = false;
  }
}

function switchTab(v: 'login' | 'register') {
  tab.value = v;
  error.value = '';
  generatedCreds.value = null;
}

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function closeAfterCreds() {
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div class="am-overlay">
      <div class="am-box">
        <!-- Header -->
        <div class="am-header">
          <div class="am-header-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/>
            </svg>
          </div>
          <div class="am-header-text">
            <span class="am-title">{{ t('app.title') }}</span>
            <span class="am-subtitle">{{ t('auth.modalSubtitle') }}</span>
          </div>
          <button class="am-close" @click="emit('close')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <!-- Limit reached banner -->
        <div v-if="props.limitReached" class="am-limit-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/>
          </svg>
          <span>{{ t('auth.limitBanner') }}</span>
        </div>

        <!-- Tabs -->
        <div v-if="!emailStep" class="am-tabs">
          <button :class="['am-tab', { active: tab === 'login' }]" @click="switchTab('login')">{{ t('auth.login') }}</button>
          <button :class="['am-tab', { active: tab === 'register' }]" @click="switchTab('register')">{{ t('auth.register') }}</button>
        </div>

        <!-- Content Area -->
        <div class="am-content">
          <!-- REGISTER / EMAIL FLOW -->
          <div v-if="tab === 'register' || emailStep">
            <!-- Email binding step -->
            <div v-if="emailStep && generatedCreds" class="am-creds-card am-email-card">
              <div class="am-creds-check">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span>{{ t('auth.registerSuccess') }}</span>
              </div>
              <div class="am-cred-row">
                <span class="am-cred-label">{{ t('auth.accountLabel') }}</span>
                <span class="am-cred-val">{{ generatedCreds.account }}</span>
                <button class="am-cred-copy" @click="copyToClipboard(generatedCreds.account)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg></button>
              </div>
              <div class="am-cred-row">
                <span class="am-cred-label">{{ t('auth.passwordLabel') }}</span>
                <span class="am-cred-val am-cred-pwd">{{ generatedCreds.password }}</span>
                <button class="am-cred-copy" @click="copyToClipboard(generatedCreds.password)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg></button>
              </div>
              <div class="am-divider" style="margin: 5px 0 10px;"></div>
              <div class="am-email-section">
                <p class="am-creds-hint" style="text-align: left; margin-bottom: 8px; color: var(--c-accent);"><strong>{{ t('auth.emailLabel') }}</strong>: {{ t('auth.emailHint') }}</p>
                <div class="am-field">
                  <input v-model="email" class="am-input" type="email" :placeholder="t('auth.emailPlaceholder')" @keydown.enter="sendAndEnter" />
                </div>
              </div>
              <p v-if="error" class="am-error">{{ error }}</p>
              <button class="am-btn am-btn-primary am-btn-full" :disabled="loading" @click="sendAndEnter">
                <span v-if="loading" class="am-spinner"></span>
                <span>{{ t('auth.sendAndStart') }}</span>
              </button>
            </div>
            
            <!-- One-click button -->
            <div v-else-if="!generatedCreds" style="padding-top: 10px;">
              <button class="am-oneclick-btn" :disabled="oneClickLoading" @click="oneClickRegister">
                <span v-if="oneClickLoading" class="am-spinner"></span>
                <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/></svg>
                <span>{{ oneClickLoading ? t('auth.registering') : t('auth.oneClick') }}</span>
              </button>
              <div class="am-divider"><span>{{ t('auth.orManual') }}</span></div>
            </div>
          </div>

          <!-- MANUAL FORM -->
          <div v-if="!generatedCreds && !emailStep" class="am-form">
            <div class="am-field">
              <svg class="am-field-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              <input v-model="account" class="am-input" type="text" :placeholder="t('auth.accountPlaceholder')" @keydown.enter="submit" autocomplete="username" />
            </div>
            <div class="am-field">
              <svg class="am-field-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="1.8"/></svg>
              <input v-model="password" class="am-input" :type="showPwd ? 'text' : 'password'" :placeholder="t('auth.passwordPlaceholder')" @keydown.enter="submit" autocomplete="current-password" />
              <button class="am-pwd-toggle" @click="showPwd = !showPwd" tabindex="-1">
                <svg v-if="showPwd" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/></svg>
              </button>
            </div>
            <p v-if="error" class="am-error">{{ error }}</p>
            <button class="am-btn am-btn-primary am-btn-full" :disabled="loading" @click="submit">
              <span v-if="loading" class="am-spinner"></span>
              <span>{{ tab === 'login' ? t('auth.login') : t('auth.register') }}</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  </Teleport>
</template>

<style scoped src="./AuthModal.css"></style>
