<script setup>
import { CircleHelp } from "lucide-vue-next";
import {
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "reka-ui";

defineProps({
  content: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    default: "查看说明",
  },
});
</script>

<template>
  <TooltipProvider :delay-duration="250">
    <TooltipRoot>
      <TooltipTrigger
        type="button"
        class="ui-tooltip__trigger"
        :aria-label="label"
      >
        <CircleHelp :size="13" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          class="ui-tooltip__content"
          side="top"
          :side-offset="7"
          :collision-padding="10"
        >
          {{ content }}
          <TooltipArrow class="ui-tooltip__arrow" :width="10" :height="5" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<style>
.ui-tooltip__trigger {
  display: inline-grid;
  width: 18px;
  height: 18px;
  min-height: 18px;
  flex: 0 0 auto;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 999px;
  color: var(--ql-color-text-subtle);
  background: transparent;
  cursor: help;
}

.ui-tooltip__trigger:hover,
.ui-tooltip__trigger:focus-visible {
  color: var(--ql-accent);
  background: var(--ql-color-primary-soft);
  outline: none;
}

.ui-tooltip__trigger:focus-visible {
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}

.ui-tooltip__content {
  z-index: 100;
  box-sizing: border-box;
  max-width: min(280px, calc(100vw - 20px));
  padding: 8px 10px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 7px;
  color: var(--ql-color-text-body);
  background: var(--ql-color-bg-surface-strong);
  box-shadow: var(--ql-shadow-md);
  font-size: 11px;
  font-weight: 550;
  line-height: 1.5;
}

.ui-tooltip__arrow {
  fill: var(--ql-color-bg-surface-strong);
}
</style>
