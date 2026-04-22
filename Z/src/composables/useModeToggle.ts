import { ref, watch } from 'vue';

export type CompressMode = 'video' | 'image';

const MODE_KEY = 'titan-mode';
const saved = localStorage.getItem(MODE_KEY);
const initial: CompressMode = saved === 'image' ? 'image' : 'video';

export const mode = ref<CompressMode>(initial);

watch(mode, (v) => { localStorage.setItem(MODE_KEY, v); });

export const setMode = (m: CompressMode) => { mode.value = m; };
