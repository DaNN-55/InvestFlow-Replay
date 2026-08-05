<script setup>
import { LoaderCircle } from "lucide-vue-next";
import { computed, useAttrs } from "vue";

defineOptions({
  inheritAttrs: false,
});

const props = defineProps({
  variant: {
    type: String,
    default: "primary",
  },
  size: {
    type: String,
    default: "lg",
  },
  loading: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  block: {
    type: Boolean,
    default: false,
  },
  iconOnly: {
    type: Boolean,
    default: false,
  },
  type: {
    type: String,
    default: "button",
  },
});

const attrs = useAttrs();

const classes = computed(() => [
  "ql-ui-button",
  `ql-ui-button--${props.variant}`,
  props.size !== "lg" ? `ql-ui-button--${props.size}` : "",
  props.block ? "ql-ui-button--block" : "",
  props.iconOnly ? "ql-ui-button--icon" : "",
]);
const loadingIconSize = computed(() => (props.size === "sm" ? 14 : 16));
</script>

<template>
  <button
    v-bind="attrs"
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
  >
    <LoaderCircle
      v-if="loading"
      class="ql-animate-spin"
      :size="loadingIconSize"
      aria-hidden="true"
    />
    <slot name="prefix" />
    <slot />
    <slot name="suffix" />
  </button>
</template>
