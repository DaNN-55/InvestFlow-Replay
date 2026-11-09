<script setup>
import { shallowRef, onMounted } from 'vue';
import { vMotionEnter } from '../../directives/motion.js';
import { Ellipsis, RefreshCw, Trash2 } from 'lucide-vue-next';
import { api } from '../../services/api.js';
import { createCryptoReplayController } from '../../utils/cryptoReplayController.js';
import UiButton from '../ui/UiButton.vue';
import UiActionMenu from '../ui/UiActionMenu.vue';
import CryptoReviewPanel from './CryptoReviewPanel.vue';
const props = defineProps({
  item: { type: Object, required: true },
  retrainState: { type: Object, default: () => ({}) },
  deleteState: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['open', 'retrain', 'delete']);
const state = shallowRef({});
// History is read-only: never overwrite the active practice pointer or pending action.
const controller = createCryptoReplayController({ api, storage: { getItem:()=>null, setItem:()=>{} }, changed: value => { state.value=value; } });
onMounted(()=>controller.sync(props.item.id));
</script>
<template>
  <section v-motion-enter="'detail'" class="crypto-history-detail">
    <header>
      <div><h2>{{ item.instrumentId }}</h2><span>加密合约 · {{ item.attemptInfo.kind === 'first' ? '首次盲测' : '复练' }}</span></div>
      <div class="crypto-history-detail__actions">
        <UiButton variant="secondary" @click="emit('open', item)">打开演练</UiButton>
        <UiActionMenu label="演练记录操作" :min-width="150" :trigger-size="32">
          <template #trigger><Ellipsis :size="17" /></template>
          <button v-if="item.revealed" class="ui-action-menu__item" type="button" :disabled="retrainState.loading" @click="emit('retrain', item)"><RefreshCw :size="14" />复练此行情</button>
          <button class="ui-action-menu__item ui-action-menu__item--danger" type="button" :disabled="deleteState.loading || retrainState.loading" @click="emit('delete', item)"><Trash2 :size="14" />删除记录</button>
        </UiActionMenu>
        <p v-if="retrainState.error || deleteState.error" class="crypto-history-detail__action-error" role="alert">{{ retrainState.error || deleteState.error }}</p>
      </div>
    </header>
    <p v-if="state.busy" role="status">正在读取资金、事件和复盘…</p>
    <p v-else-if="state.error" role="alert">{{ state.error }} <UiButton variant="secondary" @click="controller.sync(item.id)">重试</UiButton></p>
    <CryptoReviewPanel v-else-if="state.session" v-motion-enter="'detail'" :session="state.session" :traces="state.traces" :ledger="state.ledger" :analysis="state.analysis" :analysis-error="state.analysisError" readonly />
  </section>
</template>
<style scoped>
.crypto-history-detail { min-width:0; }header { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:start; gap:12px; padding:16px; border:1px solid var(--ql-line-strong); border-radius:8px; margin-bottom:12px; background:var(--ql-panel); }header span,p { font-size:12px; color:var(--ql-color-text-muted); }h2 { margin:0 0 4px; font-size:17px; overflow-wrap:anywhere; }
.crypto-history-detail__actions { display:flex;align-items:flex-start;justify-content:flex-end;flex-wrap:wrap;gap:8px;min-width:0; }
.crypto-history-detail__action-error { margin:6px 0 0;flex-basis:100%;max-width:220px;color:var(--ql-color-danger);overflow-wrap:anywhere; }
</style>
