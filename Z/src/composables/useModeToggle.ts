import { ref, watch } from 'vue';

export type CompressMode = 'video' | 'image';

const MODE_STORAGE_KEY = 'titan-mode';

const getInitialMode = (): CompressMode => {
  const saved = localStorage.getItem(MODE_STORAGE_KEY);
  return saved === 'image' ? 'image' : 'video';
};

export const mode = ref<CompressMode>(getInitialMode());

// 使用 watch 确保任何对 mode 的修改都能持久化
watch(mode, (newMode) => {
  localStorage.setItem(MODE_STORAGE_KEY, newMode);
}, { immediate: true });

export const setMode = (m: CompressMode) => {
  mode.value = m;
};
