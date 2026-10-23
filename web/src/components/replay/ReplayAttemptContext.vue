<script setup>
import { Eye, ShieldCheck, X } from 'lucide-vue-next';
import { computed, shallowRef, watch, onBeforeUnmount, onDeactivated } from 'vue';
import { getReplayAttemptPresentation } from '../../utils/replayHistoryPresentation.js';
const props=defineProps({attemptInfo:{type:Object,default:null},sessionKey:{type:String,default:''}});
const presentation=computed(()=>getReplayAttemptPresentation(props.attemptInfo));
const visible=shallowRef(false);
let timer;
function dismiss(){visible.value=false;clearTimeout(timer);}
watch(()=>`${props.sessionKey}:${presentation.value.kind}:${props.attemptInfo?.attemptNumber ?? 1}`,()=>{
  clearTimeout(timer);visible.value=true;timer=setTimeout(dismiss,6000);
},{immediate:true});
onBeforeUnmount(()=>clearTimeout(timer));
onDeactivated(dismiss);
</script>
<template>
  <section v-if="visible" class="replay-attempt-context" :class="`replay-attempt-context--${presentation.kind}`" role="status" aria-label="演练类型提醒">
    <Eye v-if="presentation.kind==='retrain'" :size="16" /><ShieldCheck v-else :size="16" />
    <span>{{ presentation.kind==='retrain'?'正在复练 · 不计入首次成绩':'首次盲测 · 计入首次成绩' }}</span>
    <button type="button" aria-label="关闭演练提醒" @click="dismiss"><X :size="15" /></button>
  </section>
</template>
<style scoped>
.replay-attempt-context { position:fixed;z-index:60;top:60px;right:20px;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 12px;border:1px solid var(--ql-color-success);border-radius:7px;background:color-mix(in srgb,var(--ql-color-success) 12%,var(--ql-color-bg-surface-strong));color:var(--ql-color-success);box-shadow:var(--ql-shadow-xs);font-size:12px; }
.replay-attempt-context--retrain { border-color:var(--ql-color-warning);background:color-mix(in srgb,var(--ql-color-warning) 12%,var(--ql-color-bg-surface-strong));color:var(--ql-color-warning); }
.replay-attempt-context span { min-width:0;overflow-wrap:anywhere; }.replay-attempt-context>svg { flex-shrink:0; }
.replay-attempt-context button { display:grid;place-items:center;flex-shrink:0;padding:3px;border:0;border-radius:4px;color:inherit;background:transparent;cursor:pointer; }.replay-attempt-context button:focus-visible { outline:2px solid currentColor;outline-offset:2px; }
</style>
