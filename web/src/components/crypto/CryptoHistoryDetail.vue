<script setup>
import { shallowRef, onMounted } from 'vue';
import { api } from '../../services/api.js';
import { createCryptoReplayController } from '../../utils/cryptoReplayController.js';
import UiButton from '../ui/UiButton.vue';
import CryptoReviewPanel from './CryptoReviewPanel.vue';
const props = defineProps({ item: { type: Object, required: true } });
const emit = defineEmits(['open']);
const state = shallowRef({});
// History is read-only: never overwrite the active practice pointer or pending action.
const controller = createCryptoReplayController({ api, storage: { getItem:()=>null, setItem:()=>{} }, changed: value => { state.value=value; } });
onMounted(()=>controller.sync(props.item.id));
</script>
<template>
  <section class="crypto-history-detail">
    <header><div><span>加密合约 · {{ item.attemptInfo.kind === 'first' ? '首次盲测' : '复练' }}</span><h2>{{ item.instrumentId }}</h2></div><UiButton variant="secondary" @click="emit('open',item)">{{ item.status === 'active' || item.status === 'end-blocked' ? '继续练习' : '打开练习与复盘' }}</UiButton></header>
    <p v-if="state.busy" role="status">正在读取资金、事件和复盘…</p>
    <p v-else-if="state.error" role="alert">{{ state.error }} <UiButton variant="secondary" @click="controller.sync(item.id)">重试</UiButton></p>
    <CryptoReviewPanel v-else-if="state.session" :session="state.session" :traces="state.traces" :ledger="state.ledger" :analysis="state.analysis" :analysis-error="state.analysisError" readonly />
  </section>
</template>
<style scoped>
.crypto-history-detail { min-width:0; }header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px; border:1px solid var(--ql-line-strong); border-radius:8px; margin-bottom:12px; background:var(--ql-panel); }header span,p { font-size:12px; color:var(--ql-color-text-muted); }h2 { margin:4px 0; font-size:17px; }@media(max-width:600px) { header { align-items:flex-start; flex-direction:column; } }
</style>
