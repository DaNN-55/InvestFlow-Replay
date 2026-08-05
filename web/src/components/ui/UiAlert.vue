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
</script>

<template>
  <div class="ql-ui-alert" :class="`ql-ui-alert--${variant}`">
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
      class="ql-ui-button ql-ui-button--ghost ql-ui-button--sm ql-ui-button--icon"
      @click="$emit('dismiss')"
    >
      <X :size="14" />
    </button>
  </div>
</template>
