<script setup>
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
} from "lucide-vue-next";
import { computed } from "vue";

const props = defineProps({
  variant: {
    type: String,
    default: "info",
  },
  title: {
    type: String,
    default: "",
  },
  dismissible: {
    type: Boolean,
    default: false,
  },
  floating: {
    type: Boolean,
    default: false,
  },
});

defineEmits(["dismiss"]);

const icon = computed(() => {
  if (props.variant === "success") {
    return CheckCircle2;
  }
  if (props.variant === "warning") {
    return AlertTriangle;
  }
  if (props.variant === "danger") {
    return AlertCircle;
  }
  return Info;
});
const variantClass = computed(() => ({
  info: 'ql-ui-alert--info',
  success: 'ql-ui-alert--success',
  warning: 'ql-ui-alert--warning',
  danger: 'ql-ui-alert--danger',
})[props.variant] ?? 'ql-ui-alert--info');
</script>

<template>
  <div class="ql-ui-alert" :class="[variantClass, { 'ql-ui-alert--floating': floating }]">
    <component :is="icon" :size="18" class="ql-mt-0.5 ql-shrink-0" />
    <div class="ql-min-w-0 ql-flex-1">
      <div v-if="title" class="ql-text-sm ql-font-semibold">
        {{ title }}
      </div>
      <div class="ql-text-sm ql-leading-6">
        <slot />
      </div>
    </div>
    <button
      v-if="dismissible"
      type="button"
      aria-label="关闭提醒"
      class="ql-ui-button ql-ui-button--ghost ql-ui-button--sm ql-ui-button--icon"
      @click="$emit('dismiss')"
    >
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.ql-ui-alert--floating {
  position: fixed;
  z-index: 80;
  top: 64px;
  right: 16px;
  width: min(440px, calc(100vw - 32px));
  box-sizing: border-box;
  background: var(--ql-panel);
  color: var(--ql-color-text-strong);
  box-shadow: var(--ql-shadow-lg);
  overflow-wrap: anywhere;
}
.ql-ui-alert--floating.ql-ui-alert--warning { border-color: var(--ql-color-warning); }
</style>
