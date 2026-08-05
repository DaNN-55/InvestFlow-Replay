<script setup>
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
  "ql-ui-control",
  props.size !== "lg" ? `ql-ui-control--${props.size}` : "",
  props.invalid ? "ql-ui-control--invalid" : "",
]);
</script>

<template>
  <input
    v-bind="attrs"
    :value="modelValue"
    :class="classes"
    @input="emit('update:modelValue', $event.target.value)"
  />
</template>
