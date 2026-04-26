<script setup lang="ts">
import { ref } from 'vue';
import { login, register } from '../composables/useAuth';
import { syncUsage } from '../composables/useUsageLimit';
import { t } from '../locales/i18n';

const emit = defineEmits<{ (e: 'close'): void }>();

const tab = ref<'login' | 'register'>('login');
const account = ref('');
const password = ref('');
const showPwd = ref(false);
const loading = ref(false);
const error = ref('');

// One-click register state
const oneClickLoading = ref(false);
const generatedCreds = ref<{ account: string; password: string } | null>(null);

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
      oneClickLoading.value = false;
      return;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('已存在') || msg.includes('exists')) {
        attempts++;
        continue;
      }
      error.value = msg || t.value('auth.failed');
      oneClickLoading.value = false;
      return;
    }
  }
  error.value = '注册失败，请稍后重试';
  oneClickLoading.value = false;
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
    }
    await syncUsage();
    emit('close');
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : t.value('auth.failed');
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
    <div class="am-overlay" @click.self="emit('close')">
      <div class="am-box">

        <!-- Header -->
        <div class="am-header">
          <div class="am-header-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/>
            </svg>
          </div>
          <div class="am-header-text">
            <span class="am-title">泰坦压缩</span>
            <span class="am-subtitle">本地处理 · 完全隐私</span>
          </div>
          <button class="am-close" @click="emit('close')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <!-- Tabs -->
        <div class="am-tabs">
          <button :class="['am-tab', { active: tab === 'login' }]" @click="switchTab('login')">
            {{ t('auth.login') }}
          </button>
          <button :class="['am-tab', { active: tab === 'register' }]" @click="switchTab('register')">
            {{ t('auth.register') }}
          </button>
        </div>

        <!-- One-click register (register tab only) -->
        <template v-if="tab === 'register'">

          <!-- Generated credentials display -->
          <div v-if="generatedCreds" class="am-creds-card">
            <div class="am-creds-check">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M20 6L9 17l-5-5" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>注册成功！请保存账号信息</span>
            </div>
            <div class="am-cred-row">
              <span class="am-cred-label">账号</span>
              <span class="am-cred-val">{{ generatedCreds.account }}</span>
              <button class="am-cred-copy" @click="copyToClipboard(generatedCreds?.account ?? '')" title="复制">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg>
              </button>
            </div>
            <div class="am-cred-row">
              <span class="am-cred-label">密码</span>
              <span class="am-cred-val am-cred-pwd">{{ generatedCreds.password }}</span>
              <button class="am-cred-copy" @click="copyToClipboard(generatedCreds?.password ?? '')" title="复制">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg>
              </button>
            </div>
            <p class="am-creds-hint">此密码不会再次显示，请复制后妥善保存</p>
            <button class="am-btn am-btn-primary am-btn-full" @click="closeAfterCreds">
              已保存，开始使用
            </button>
          </div>

          <!-- One-click button (before creds shown) -->
          <template v-else>
            <button
              class="am-oneclick-btn"
              :disabled="oneClickLoading"
              @click="oneClickRegister"
            >
              <span v-if="oneClickLoading" class="am-spinner"></span>
              <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor"/>
              </svg>
              <span>{{ oneClickLoading ? '注册中…' : '一键注册（自动生成账号）' }}</span>
            </button>

            <div class="am-divider"><span>或手动填写</span></div>
          </template>
        </template>

        <!-- Form (hidden when creds shown) -->
        <template v-if="!generatedCreds">
          <div class="am-form">
            <div class="am-field">
              <svg class="am-field-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"/>
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
              <input
                v-model="account"
                class="am-input"
                type="text"
                :placeholder="t('auth.accountPlaceholder')"
                @keydown.enter="submit"
                autocomplete="username"
              />
            </div>
            <div class="am-field">
              <svg class="am-field-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="1.8"/>
              </svg>
              <input
                v-model="password"
                class="am-input"
                :type="showPwd ? 'text' : 'password'"
                :placeholder="t('auth.passwordPlaceholder')"
                @keydown.enter="submit"
                autocomplete="current-password"
              />
              <button class="am-pwd-toggle" @click="showPwd = !showPwd" tabindex="-1">
                <svg v-if="showPwd" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                  <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="1.8"/>
                  <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/>
                </svg>
              </button>
            </div>

            <p v-if="error" class="am-error">{{ error }}</p>

            <button class="am-btn am-btn-primary am-btn-full" :disabled="loading" @click="submit">
              <span v-if="loading" class="am-spinner"></span>
              <span>{{ tab === 'login' ? t('auth.login') : t('auth.register') }}</span>
            </button>
          </div>
        </template>

      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay & Box ───────────────────────────────────────────────── */
.am-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(6px); animation: am-fade-in 0.15s ease; }
@keyframes am-fade-in { from { opacity: 0 } to { opacity: 1 } }

.am-box { position: relative; width: min(400px, 94vw); background: var(--c-bg-elevated); border: 1px solid var(--c-border-strong); border-radius: 18px; box-shadow: 0 32px 64px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04); overflow: hidden; animation: am-slide-up 0.2s cubic-bezier(0.34,1.56,0.64,1); }
@keyframes am-slide-up { from { opacity:0; transform: translateY(16px) scale(0.97) } to { opacity:1; transform: none } }

/* ── Header ─────────────────────────────────────────────────────── */
.am-header { display: flex; align-items: center; gap: 12px; padding: 20px 20px 16px; border-bottom: 1px solid var(--c-border); }
.am-header-icon { width: 36px; height: 36px; border-radius: 10px; background: var(--c-accent); display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0; box-shadow: 0 0 16px rgba(249,115,22,0.4); }
.am-header-text { flex: 1; min-width: 0; }
.am-title { display: block; font-size: 0.95rem; font-weight: 700; color: var(--c-text-primary); line-height: 1.3; }
.am-subtitle { display: block; font-size: 0.68rem; color: var(--c-text-muted); margin-top: 1px; }
.am-close { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; border: 1px solid var(--c-border); background: transparent; color: var(--c-text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.12s, color 0.12s; }
.am-close:hover { background: var(--c-bg-hover); color: var(--c-text-primary); }

/* ── Tabs ────────────────────────────────────────────────────────── */
.am-tabs { display: flex; padding: 14px 20px 0; gap: 0; border-bottom: 1px solid var(--c-border); }
.am-tab { flex: 1; height: 36px; border: none; background: transparent; cursor: pointer; font-size: 0.8rem; font-weight: 600; color: var(--c-text-muted); border-bottom: 2px solid transparent; transition: color 0.12s, border-color 0.12s; margin-bottom: -1px; }
.am-tab.active { color: var(--c-accent); border-bottom-color: var(--c-accent); }
.am-tab:hover:not(.active) { color: var(--c-text-secondary); }

/* ── One-click button ────────────────────────────────────────────── */
.am-oneclick-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: calc(100% - 40px); margin: 18px 20px 0; height: 44px; border-radius: 10px; border: 1.5px solid var(--c-accent); background: var(--c-accent-subtle); color: var(--c-accent); font-size: 0.84rem; font-weight: 700; cursor: pointer; transition: background 0.15s, border-color 0.15s, opacity 0.15s; }
.am-oneclick-btn:not(:disabled):hover { background: rgba(249,115,22,0.18); }
.am-oneclick-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Divider ─────────────────────────────────────────────────────── */
.am-divider { display: flex; align-items: center; gap: 10px; padding: 14px 20px 0; font-size: 0.68rem; color: var(--c-text-muted); }
.am-divider::before, .am-divider::after { content: ''; flex: 1; height: 1px; background: var(--c-border); }

/* ── Form ────────────────────────────────────────────────────────── */
.am-form { display: flex; flex-direction: column; gap: 10px; padding: 14px 20px 20px; }
.am-field { position: relative; display: flex; align-items: center; background: var(--c-bg-surface); border: 1px solid var(--c-border); border-radius: 10px; transition: border-color 0.15s; }
.am-field:focus-within { border-color: var(--c-accent); }
.am-field-icon { flex-shrink: 0; margin-left: 12px; color: var(--c-text-muted); pointer-events: none; }
.am-input { flex: 1; height: 42px; padding: 0 10px; background: transparent; border: none; outline: none; color: var(--c-text-primary); font-size: 0.84rem; }
.am-input::placeholder { color: var(--c-text-muted); }
.am-pwd-toggle { width: 36px; height: 42px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; cursor: pointer; color: var(--c-text-muted); flex-shrink: 0; transition: color 0.12s; }
.am-pwd-toggle:hover { color: var(--c-text-secondary); }

/* ── Error ────────────────────────────────────────────────────────── */
.am-error { font-size: 0.73rem; color: #ef4444; margin: 0; }

/* ── Buttons ─────────────────────────────────────────────────────── */
.am-btn { height: 42px; border-radius: 10px; border: none; font-size: 0.84rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: opacity 0.15s; }
.am-btn-primary { background: var(--c-accent); color: #fff; }
.am-btn-primary:not(:disabled):hover { opacity: 0.88; }
.am-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
.am-btn-full { width: 100%; }

/* ── Spinner ─────────────────────────────────────────────────────── */
.am-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: am-spin 0.7s linear infinite; }
@keyframes am-spin { to { transform: rotate(360deg) } }

/* ── Generated Credentials Card ──────────────────────────────────── */
.am-creds-card { margin: 16px 20px 20px; background: var(--c-bg-surface); border: 1px solid rgba(34,197,94,0.3); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.am-creds-check { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; font-weight: 600; color: #22c55e; }
.am-cred-row { display: flex; align-items: center; gap: 8px; background: var(--c-bg-elevated); border: 1px solid var(--c-border); border-radius: 8px; padding: 8px 10px; }
.am-cred-label { font-size: 0.65rem; font-weight: 700; color: var(--c-text-muted); text-transform: uppercase; letter-spacing: 0.06em; width: 28px; flex-shrink: 0; }
.am-cred-val { flex: 1; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; color: var(--c-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.am-cred-pwd { letter-spacing: 0.06em; }
.am-cred-copy { width: 24px; height: 24px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--c-border); border-radius: 5px; cursor: pointer; color: var(--c-text-muted); transition: color 0.12s, border-color 0.12s; }
.am-cred-copy:hover { color: var(--c-accent); border-color: var(--c-accent); }
.am-creds-hint { font-size: 0.68rem; color: var(--c-text-muted); text-align: center; }
</style>
