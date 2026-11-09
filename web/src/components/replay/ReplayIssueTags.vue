<script setup>
import UiTooltip from "../ui/UiTooltip.vue";
import { REPLAY_ISSUE_TAGS } from "../../utils/replayTrainingAnalytics.js";
const props = defineProps({ modelValue: { type: Array, default: () => [] }, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);
function toggle(tag, checked) {
  emit("update:modelValue", checked ? [...new Set([...props.modelValue, tag])] : props.modelValue.filter(item => item !== tag));
}
</script>
<template>
  <fieldset class="replay-issue-tags" :disabled="disabled">
    <legend>本次问题（可选）<UiTooltip clickable label="问题标签说明" content="用于跨会话查看重复问题；不根据盈亏自动选择。没有这些问题可不选。" /></legend>
    <div><label v-for="tag in REPLAY_ISSUE_TAGS" :key="tag" :class="{ 'replay-issue-tags__selected': modelValue.includes(tag) }"><input type="checkbox" :checked="modelValue.includes(tag)" @change="toggle(tag, $event.target.checked)"><span>{{ tag }}</span></label></div>
  </fieldset>
</template>
<style scoped>
.replay-issue-tags { padding: 0; margin: 0; border: 0; min-width: 0; }
.replay-issue-tags legend { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 0; color: var(--ql-ink); font-size: 13px; font-weight: 600; }
.replay-issue-tags > div { display: flex; flex-wrap: wrap; gap: 8px; }
.replay-issue-tags label { display: flex; align-items: center; gap: 7px; min-height: 36px; padding: 6px 10px; border: 1px solid var(--ql-line-strong); border-radius: 8px; color: var(--ql-color-text-body); background: var(--ql-panel); font-size: 12px; cursor: pointer; }
.replay-issue-tags input { accent-color: var(--ql-color-primary); }
.replay-issue-tags label:focus-within { outline: 2px solid var(--ql-color-primary); outline-offset: 2px; }
.replay-issue-tags label.replay-issue-tags__selected { border-color: var(--ql-color-primary); color: var(--ql-color-primary); }
</style>
