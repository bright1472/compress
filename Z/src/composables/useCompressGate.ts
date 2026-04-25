import { ref } from 'vue';
import { isLoggedIn } from './useAuth';
import { canCompress, usageCount, usageLimit } from './useUsageLimit';

export const limitToastMsg = ref('');
export const limitToastVisible = ref(false);

let _timer: ReturnType<typeof setTimeout> | null = null;

export function checkAndGate(openAuth: () => void, openActivation: () => void): boolean {
  if (canCompress.value) return true;

  limitToastMsg.value = isLoggedIn.value
    ? `免费次数已用完（${usageCount.value}/${usageLimit}），激活订阅解锁无限压缩`
    : `您已使用 ${usageCount.value}/${usageLimit} 次免费压缩，登录后继续使用`;

  limitToastVisible.value = true;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    limitToastVisible.value = false;
    isLoggedIn.value ? openActivation() : openAuth();
  }, 1800);

  return false;
}
