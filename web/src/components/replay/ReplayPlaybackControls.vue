<script setup>
import { Play, Pause } from 'lucide-vue-next';
import UiButton from '../ui/UiButton.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiTooltip from '../ui/UiTooltip.vue';
defineProps({
  label:{type:String,required:true},detail:{type:String,default:''},
  playing:Boolean,playDisabled:Boolean,stepsDisabled:Boolean,speedDisabled:Boolean,
  speed:{type:[String,Number],required:true},speeds:{type:Array,required:true},steps:{type:Array,required:true},
  progress:{type:Number,default:0},message:{type:String,default:''},
  playLabel:{type:String,default:'自动播放'},pauseLabel:{type:String,default:'暂停'},speedLabel:{type:String,default:'自动播放速度'},help:{type:String,default:'空格或 → 推进；播放时发生交易或风险事件会暂停。'},
});
const emit=defineEmits(['toggle','step','speed']);
</script>
<template>
  <section class="replay-playback" aria-label="回放控制">
    <div class="replay-playback__heading">
      <UiButton size="sm" variant="secondary" icon-only :aria-label="playing?pauseLabel:playLabel" :title="playing?pauseLabel:playLabel" :disabled="playDisabled" @click="emit('toggle')"><Pause v-if="playing" :size="15" /><Play v-else :size="15" /></UiButton>
      <div class="replay-playback__context"><strong>{{ label }}</strong><small v-if="detail">{{ detail }}</small></div>
      <UiSelect :model-value="speed" :aria-label="speedLabel" @update:model-value="emit('speed',$event)" :disabled="speedDisabled"><option v-for="option in speeds" :key="option.value" :value="option.value">{{ option.label }}</option></UiSelect>
      <UiTooltip clickable :content="help" label="回放操作说明" />
    </div>
    <div class="replay-playback__progress"><progress :value="progress" max="100" aria-label="练习进度" /><small>{{ Math.round(progress*100)/100 }}%</small></div>
    <div class="replay-playback__steps" :style="{'--step-count':steps.length}"><UiButton v-for="step in steps" :key="step.value" size="sm" variant="secondary" :disabled="stepsDisabled" @click="emit('step',step.value)">{{ step.label }}</UiButton></div>
    <p v-if="message" class="replay-playback__message" role="status">{{ message }}</p>
    <div v-if="$slots.actions" class="replay-playback__actions"><slot name="actions" /></div>
  </section>
</template>
<style scoped>
.replay-playback { display:grid;gap:7px;min-width:0;padding:10px;border:1px solid var(--ql-line-strong);border-radius:7px;background:var(--ql-panel,var(--ql-color-bg-surface-strong));box-sizing:border-box; }
.replay-playback__heading { display:flex;align-items:center;gap:7px;min-width:0; }
.replay-playback__context { flex:1;min-width:0; }.replay-playback strong { display:block;font-size:12px;font-weight:500; }.replay-playback small { display:block;font-size:10px;color:var(--ql-color-text-muted); }.replay-playback__context small { margin-top:2px; }
.replay-playback__heading :deep(.ql-relative) { width:66px;flex-shrink:0; }.replay-playback__heading :deep(select) { height:32px;min-height:32px;font-size:11px;padding-left:7px;border-radius:6px; }
.replay-playback :deep(.ql-ui-button) { min-height:32px;height:32px;padding:0 7px;border-radius:6px;font-size:11px;white-space:normal;line-height:1.2; }.replay-playback__heading :deep(.ql-ui-button--icon) { width:32px;flex-shrink:0; }
.replay-playback__progress { display:flex;align-items:center;gap:8px; }.replay-playback progress { display:block;flex:1;min-width:0;width:100%;height:4px;accent-color:var(--ql-accent); }
.replay-playback__steps { display:grid;grid-template-columns:repeat(var(--step-count),minmax(0,1fr));gap:6px; }.replay-playback__actions { display:flex;gap:6px; }.replay-playback__actions :deep(.ql-ui-button) { flex:1; }
.replay-playback__message { margin:0;font-size:10px;line-height:1.5;color:var(--ql-color-text-muted);overflow-wrap:anywhere; }
</style>
