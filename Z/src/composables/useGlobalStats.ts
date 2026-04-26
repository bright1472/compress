import { ref } from 'vue';
import { api } from '../services/api';

export const globalSavedBytes = ref(0);
export const globalTotalFiles = ref(0);

let fetched = false;

export async function fetchGlobalStats() {
  if (fetched) return;
  fetched = true;
  try {
    const res = await api.get<Record<string, number>>('/stats/compress');
    globalSavedBytes.value = res.savedBytes ?? 0;
    globalTotalFiles.value = res.files ?? 0;
  } catch {
    // 网络失败时静默，不影响主功能
  }
}

export async function reportStats(savedBytes: number, fileType: 'image' | 'video') {
  const bytes = Math.max(0, savedBytes);
  if (bytes === 0) return;
  // 乐观更新本地显示
  globalSavedBytes.value += bytes;
  globalTotalFiles.value += 1;
  try {
    await Promise.all([
      api.post('/stats/add', { namespace: 'compress', key: 'savedBytes', delta: bytes }),
      api.post('/stats/add', { namespace: 'compress', key: 'files', delta: 1 }),
      api.post('/stats/add', { namespace: 'compress', key: `${fileType}Files`, delta: 1 }),
    ]);
  } catch {
    // 上报失败不影响体验，本地已更新
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(2) + ' TB';
  if (bytes >= 1073741824)    return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576)       return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024)          return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}
