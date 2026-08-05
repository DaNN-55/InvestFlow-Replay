<script setup>
import { ChevronDown } from "lucide-vue-next";
import { computed, useAttrs } from "vue";

defineOptions({
  inheritAttrs: false,
});

const props = defineProps({
  modelValue: {
    type: [String, Number],
    default: "",
  },
  size: {
    type: String,
    default: "lg",
  },
  invalid: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["update:modelValue"]);
const attrs = useAttrs();

const classes = computed(() => [
  "ql-ui-control ql-ui-select ql-pr-10",
  props.size !== "lg" ? `ql-ui-control--${props.size}` : "",
  props.invalid ? "ql-ui-control--invalid" : "",
]);
</script>

<template>
  <div class="ql-relative">
    <select
      v-bind="attrs"
      :value="modelValue"
      :class="classes"
      @change="emit('update:modelValue', $event.target.value)"
    >
      <slot />
    </select>
    <ChevronDown
      :size="16"
      class="ql-pointer-events-none ql-absolute ql-right-3 ql-top-1/2 ql--translate-y-1/2 ql-text-slate-400"
    />
  </div>
</template>
