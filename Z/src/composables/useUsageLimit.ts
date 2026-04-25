import { ref, computed } from 'vue';
import { api } from '../services/api';
import { isLoggedIn } from './useAuth';

const USAGE_KEY = 'titan-usage';

const _saved = (() => { try { return JSON.parse(localStorage.getItem(USAGE_KEY) ?? 'null'); } catch { return null; } })();

export const usageCount = ref<number>(_saved?.usageCount ?? 0);
export const isSubscribed = ref<boolean>(_saved?.isSubscribed ?? false);
export const usageLimit = 5;

export const canCompress = computed(() => isSubscribed.value || usageCount.value < usageLimit);

function saveLocal() {
  localStorage.setItem(USAGE_KEY, JSON.stringify({ usageCount: usageCount.value, isSubscribed: isSubscribed.value }));
}

export async function syncUsage() {
  if (!isLoggedIn.value) return;
  try {
    const res = await api.get<{ usageCount: number; isSubscribed: boolean }>('/compress/usage');
    usageCount.value = res.usageCount;
    isSubscribed.value = res.isSubscribed;
    saveLocal();
  } catch {
    // keep local cache
  }
}

export async function afterCompress() {
  if (isSubscribed.value) return;

  if (!isLoggedIn.value) {
    // 未登录：本地计数
    usageCount.value = Math.min(usageCount.value + 1, usageLimit);
    saveLocal();
    return;
  }

  try {
    const res = await api.post<{ ok: boolean; usageCount: number }>('/compress/usage/increment');
    if (res.ok) {
      usageCount.value = res.usageCount;
      saveLocal();
    }
  } catch {
    usageCount.value = Math.min(usageCount.value + 1, usageLimit);
    saveLocal();
  }
}

export async function activateLicense(licenseKey: string) {
  await api.post('/compress/activate', { license_key: licenseKey });
  isSubscribed.value = true;
  saveLocal();
}
