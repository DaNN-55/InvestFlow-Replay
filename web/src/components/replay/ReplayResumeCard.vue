<script setup>
import UiButton from '../ui/UiButton.vue';

defineProps({
  sessionId: { type: String, required: true },
  description: { type: String, default: '' },
  busy: Boolean,
});
const emit = defineEmits(['resume']);
</script>

<template>
  <div class="replay-resume">
    <div><strong>有一局练习正在等你</strong><p>{{ description }}</p></div>
    <UiButton variant="secondary" :disabled="busy" @click="emit('resume',sessionId)">继续上次练习</UiButton>
  </div>
</template>

<style scoped>
.replay-resume { display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--ql-line-strong);padding-top:14px;margin-top:14px;font-size:12px; }
.replay-resume>div { min-width:0; }
.replay-resume strong { font-size:12px;font-weight:600; }
.replay-resume p { margin:4px 0 0;color:var(--ql-color-text-muted);font-size:11px;line-height:1.6; }
.replay-resume :deep(.ql-ui-button) { flex-shrink:0;min-height:32px;height:32px;padding:0 10px;border:1px solid var(--ql-line-strong);border-radius:8px;background:var(--ql-panel);color:var(--ql-ink);box-shadow:none;font-size:11px; }
@media(max-width:380px) { .replay-resume { flex-wrap:wrap; } }
</style>
