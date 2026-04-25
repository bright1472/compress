import { ref } from 'vue';
import { api } from '../services/api';

export const globalSavedBytes = ref(0);
export const globalTotalFiles = ref(0);

let fetched = false;

export async function fetchGlobalStats() {
  if (fetched) return;
  fetched = true;
  try {
    const res = await api.get<{ totalSavedBytes: number; totalFiles: number }>('/compress/stats');
    globalSavedBytes.value = res.totalSavedBytes;
    globalTotalFiles.value = res.totalFiles;
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
    await api.post('/compress/stats/add', { savedBytes: bytes, fileType });
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
