<script setup>
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { AlertTriangle } from "lucide-vue-next";
import { computed } from "vue";

import UiButton from "./ui/UiButton.vue";

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: "请确认操作",
  },
  message: {
    type: String,
    default: "",
  },
  confirmText: {
    type: String,
    default: "确认",
  },
  cancelText: {
    type: String,
    default: "取消",
  },
  variant: {
    type: String,
    default: "danger",
  },
  busy: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["cancel", "confirm"]);

const iconTone = computed(() =>
  props.variant === "danger"
    ? "ql-bg-[#fff1ef] ql-text-[#b42318]"
    : "ql-bg-[rgba(15,82,186,0.08)] ql-text-[var(--ql-color-primary)]",
);

const confirmTone = computed(() =>
  props.variant === "danger"
    ? "ql-border-[#d92d20] ql-bg-[#d92d20] ql-text-white hover:ql-bg-[#b42318] hover:ql-border-[#b42318]"
    : "ql-border-[var(--ql-color-primary)] ql-bg-[var(--ql-color-primary)] ql-text-white hover:ql-border-[var(--ql-color-primary-strong)] hover:ql-bg-[var(--ql-color-primary-strong)]",
);

function handleOpenUpdate(nextOpen) {
  if (nextOpen || props.busy) {
    return;
  }
  emit("cancel");
}

function handleDismissableEvent(event) {
  if (props.busy) {
    event.preventDefault();
  }
}
</script>

<template>
  <DialogRoot :open="open" @update:open="handleOpenUpdate">
    <DialogPortal>
      <DialogOverlay
        class="ql-fixed ql-inset-0 ql-z-[90] ql-flex ql-items-center ql-justify-center ql-bg-[rgba(0,0,0,0.56)] ql-p-4 ql-backdrop-blur-[20px]"
      >
        <DialogContent
          as-child
          @escape-key-down="handleDismissableEvent"
          @interact-outside="handleDismissableEvent"
          @pointer-down-outside="handleDismissableEvent"
        >
          <div class="ql-shell-card ql-w-full ql-max-w-md ql-p-6">
            <div class="ql-flex ql-items-start ql-gap-4">
              <div
                class="ql-flex ql-h-11 ql-w-11 ql-items-center ql-justify-center ql-rounded-[12px]"
                :class="iconTone"
              >
                <AlertTriangle :size="18" />
              </div>
              <div class="ql-min-w-0 ql-flex-1">
                <DialogTitle as-child>
                  <h3
                    class="ql-font-display ql-text-[21px] ql-font-semibold ql-leading-[1.19] ql-tracking-[0.231px] ql-text-ink"
                  >
                    {{ title }}
                  </h3>
                </DialogTitle>
                <DialogDescription as-child>
                  <p
                    class="ql-mt-2 ql-text-sm ql-leading-6 ql-text-[rgba(0,0,0,0.8)]"
                  >
                    {{ message }}
                  </p>
                </DialogDescription>
              </div>
            </div>

            <div class="ql-mt-6 ql-flex ql-justify-end ql-gap-3">
              <UiButton
                type="button"
                variant="secondary"
                size="md"
                :disabled="busy"
                @click="$emit('cancel')"
              >
                {{ cancelText }}
              </UiButton>
              <UiButton
                type="button"
                :variant="variant === 'danger' ? 'danger' : 'primary'"
                size="md"
                :loading="busy"
                :class="confirmTone"
                @click="$emit('confirm')"
              >
                {{ confirmText }}
              </UiButton>
            </div>
          </div>
        </DialogContent>
      </DialogOverlay>
    </DialogPortal>
  </DialogRoot>
</template>
