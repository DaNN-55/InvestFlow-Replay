<script setup>
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { X } from "lucide-vue-next";

defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: "",
  },
  description: {
    type: String,
    default: "",
  },
  overlayTone: {
    type: String,
    default: "dim",
  },
  panelClass: {
    type: String,
    default: "",
  },
  headerClass: {
    type: String,
    default: "",
  },
  bodyClass: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["close"]);

function handleOpenUpdate(nextOpen) {
  if (!nextOpen) {
    emit("close");
  }
}
</script>

<template>
  <DialogRoot :open="open" @update:open="handleOpenUpdate">
    <DialogPortal>
      <DialogOverlay
        class="ql-ui-drawer"
        :class="{
          'ql-ui-drawer--clear': overlayTone === 'clear',
          'ql-ui-drawer--transparent': overlayTone === 'transparent',
        }"
      >
        <DialogContent as-child>
          <aside class="ql-ui-drawer__panel" :class="panelClass">
            <header class="ql-ui-drawer__header" :class="headerClass">
              <div class="ql-ui-drawer__header-main">
                <div class="ql-ui-drawer__header-top">
                  <DialogTitle v-if="title" as-child>
                    <div class="ql-ui-title">{{ title }}</div>
                  </DialogTitle>
                  <DialogClose as-child>
                    <button
                      type="button"
                      class="ql-ui-button ql-ui-button--ghost ql-ui-button--sm ql-ui-button--icon ql-ui-drawer__close"
                    >
                      <X :size="16" />
                    </button>
                  </DialogClose>
                </div>
                <DialogDescription v-if="description" as-child>
                  <div class="ql-ui-description">
                    {{ description }}
                  </div>
                </DialogDescription>
              </div>
            </header>
            <div class="ql-ui-drawer__body" :class="bodyClass">
              <slot />
            </div>
          </aside>
        </DialogContent>
      </DialogOverlay>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.ql-ui-drawer__header-main {
  display: grid;
  gap: 6px;
  width: 100%;
}

.ql-ui-drawer__header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.ql-ui-drawer__close {
  flex-shrink: 0;
}

.ql-ui-drawer--clear {
  background: var(--ql-overlay-clear);
  backdrop-filter: blur(6px);
}

.ql-ui-drawer--transparent {
  background: transparent;
  backdrop-filter: none;
}

.ql-ui-drawer--clear .ql-ui-drawer__panel {
  box-shadow: none;
}
</style>
