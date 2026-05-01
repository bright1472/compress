<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';

const props = defineProps<{
  storageKey: string;
  message: string;
  enabled?: boolean;
}>();

const visible = ref(false);

const checkAndShow = () => {
  if (!props.enabled) return;
  if (localStorage.getItem(props.storageKey) === 'dismissed') return;
  if (!visible.value) {
    visible.value = true;
  }
};

watch(() => props.enabled, (newVal) => {
  if (newVal) {
    setTimeout(checkAndShow, 2000);
  }
}, { immediate: true });

onMounted(() => {
  if (props.enabled) {
    setTimeout(checkAndShow, 2000);
  }
});

const dismiss = () => {
  visible.value = false;
  localStorage.setItem(props.storageKey, 'dismissed');
};
</script>

<template>
  <div v-if="visible" class="guide-bubble-wrap" @click="dismiss">
    <div class="guide-bubble">
      <span>{{ message }}</span>
      <button class="guide-bubble-close" @click.stop="dismiss">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Ensure the wrap is positioned correctly relative to the toggle button */
.guide-bubble-wrap { 
  position: absolute; 
  top: calc(100% + 8px); 
  right: -6px; 
  z-index: 100; 
  pointer-events: auto; 
  animation: bubble-in 0.4s cubic-bezier(0.2, 0.8, 0.2, 1.15) forwards, bubble-float 2.5s infinite ease-in-out 0.4s; 
}

.guide-bubble { 
  position: relative; 
  background: var(--c-accent); 
  color: white; 
  padding: 10px 14px; 
  border-radius: 12px; 
  font-size: 0.72rem; 
  font-weight: 700; 
  white-space: nowrap; 
  box-shadow: 0 12px 30px rgba(249,115,22,0.4), 0 0 0 1px rgba(255,255,255,0.1); 
  display: flex; 
  align-items: center; 
  gap: 8px; 
  cursor: pointer; 
}

/* Re-fixed arrow pointing up to the button */
.guide-bubble::after { 
  content: ''; 
  position: absolute; 
  bottom: 100%; 
  right: 14px; 
  border: 6px solid transparent; 
  border-bottom-color: var(--c-accent); 
}

.guide-bubble-close { 
  background: none; 
  border: none; 
  color: white; 
  padding: 0; 
  cursor: pointer; 
  opacity: 0.7; 
  transition: opacity 0.2s; 
  display: flex; 
  align-items: center; 
  justify-content: center; 
  margin-left: 4px; 
}
.guide-bubble-close:hover { opacity: 1; }

@keyframes bubble-in { from { opacity: 0; transform: translateY(10px) scale(0.9); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes bubble-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
</style>
