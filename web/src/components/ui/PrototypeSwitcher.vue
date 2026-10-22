<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
defineProps({ label: { type: String, default: '' } });
const emit = defineEmits(['cycle']);
const isDev = import.meta.env.DEV;
function key(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,button,[contenteditable="true"],[role="dialog"],[role="slider"]')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); emit('cycle', event.key === 'ArrowLeft' ? -1 : 1); }
}
onMounted(() => window.addEventListener('keydown', key));
onBeforeUnmount(() => window.removeEventListener('keydown', key));
</script>
<template>
  <nav v-if="isDev" class="prototype-switcher" aria-label="原型方案切换">
    <button type="button" aria-label="上一个方案" @click="emit('cycle', -1)"><ChevronLeft :size="18" /></button>
    <div><small>交互原型 · ← → 切换</small><strong>{{ label }}</strong></div>
    <button type="button" aria-label="下一个方案" @click="emit('cycle', 1)"><ChevronRight :size="18" /></button>
  </nav>
</template>
<style scoped>
.prototype-switcher { position: fixed; z-index: 60; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 16px; padding: 7px 10px; border: 1px solid #5c6d89; border-radius: 40px; background: #eaf1ff; color: #13223a; box-shadow: 0 8px 32px #0005; white-space: nowrap; }
.prototype-switcher button { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid #b7c7dd; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; }
.prototype-switcher div { display: grid; text-align: center; gap: 2px; }.prototype-switcher small { font-size: 10px; color: #4c6381; }.prototype-switcher strong { font-size: 12px; }
</style>
