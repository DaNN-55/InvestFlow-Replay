<script setup>
import { computed, useAttrs } from "vue";

defineOptions({
  inheritAttrs: false,
});

const props = defineProps({
  muted: {
    type: Boolean,
    default: false,
  },
  overflowVisible: {
    type: Boolean,
    default: false,
  },
  bodyClass: {
    type: String,
    default: "",
  },
});

const attrs = useAttrs();

const classes = computed(() => [
  "ql-ui-card",
  props.overflowVisible ? "ql-overflow-visible" : "ql-overflow-hidden",
  props.muted ? "ql-ui-card--muted" : "",
]);
</script>

<template>
  <section v-bind="attrs" :class="classes">
    <header v-if="$slots.header" class="ql-ui-card__header">
      <slot name="header" />
    </header>
    <div class="ql-ui-card__body" :class="bodyClass">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="ql-ui-card__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>
