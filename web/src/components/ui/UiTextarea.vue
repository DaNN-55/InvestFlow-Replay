<script setup>
import { computed, useAttrs } from "vue";

defineOptions({
  inheritAttrs: false,
});

const props = defineProps({
  modelValue: {
    type: String,
    default: "",
  },
  invalid: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["update:modelValue"]);
const attrs = useAttrs();

const classes = computed(() => [
  "ql-ui-control ql-min-h-[120px] ql-py-3",
  props.invalid ? "ql-ui-control--invalid" : "",
]);
</script>

<template>
  <textarea
    v-bind="attrs"
    :value="modelValue"
    :class="classes"
    @input="emit('update:modelValue', $event.target.value)"
  />
</template>
