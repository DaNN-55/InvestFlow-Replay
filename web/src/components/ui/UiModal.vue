<script setup>
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { X } from "lucide-vue-next";

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: "" },
  description: { type: String, default: "" },
  busy: { type: Boolean, default: false },
  panelClass: { type: String, default: "" },
  variant: { type: String, default: "dialog" },
});

const emit = defineEmits(["close"]);

function handleOpenUpdate(open) {
  if (!open) emit("close");
}

</script>

<template>
  <DialogRoot :open="open" @update:open="handleOpenUpdate">
    <DialogPortal>
      <DialogOverlay
        class="ui-modal__overlay"
        :class="{ 'ui-modal__overlay--drawer': props.variant === 'drawer' }"
      >
        <DialogContent
          as-child
          @escape-key-down="busy ? $event.preventDefault() : undefined"
          @interact-outside="busy ? $event.preventDefault() : undefined"
          @pointer-down-outside="busy ? $event.preventDefault() : undefined"
        >
          <section
            class="ui-modal__panel"
            :class="[panelClass, { 'ui-modal__panel--drawer': props.variant === 'drawer' }]"
            :data-busy="String(busy)"
          >
            <header class="ui-modal__header">
              <div>
                <DialogTitle as-child><h2>{{ title }}</h2></DialogTitle>
                <DialogDescription v-if="description" as-child><p>{{ description }}</p></DialogDescription>
              </div>
              <button type="button" aria-label="关闭弹窗" :disabled="busy" @click="emit('close')">
                <X :size="18" />
              </button>
            </header>
            <div class="ui-modal__body"><slot /></div>
          </section>
        </DialogContent>
      </DialogOverlay>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.ui-modal__overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.52);
  backdrop-filter: blur(8px);
}

.ui-modal__panel {
  display: flex;
  width: min(820px, calc(100vw - 32px));
  max-height: min(880px, calc(100vh - 32px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ql-line-strong);
  border-radius: 14px;
  background: var(--ql-panel);
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.24);
}

.ui-modal__overlay--drawer {
  place-items: stretch end;
  padding: 0;
  background: transparent;
  backdrop-filter: none;
}

.ui-modal__panel--drawer {
  width: min(560px, 100vw);
  max-height: 100vh;
  min-height: 100vh;
  border-block: 0;
  border-right: 0;
  border-radius: 14px 0 0 14px;
  box-shadow: -18px 0 54px rgba(15, 23, 42, 0.18);
}

.ui-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--ql-line);
}

.ui-modal__header h2,
.ui-modal__header p {
  margin: 0;
}

.ui-modal__header h2 {
  color: var(--ql-ink);
  font-size: 18px;
}

.ui-modal__header p {
  margin-top: 5px;
  color: var(--ql-color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.ui-modal__header button {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--ql-line-strong);
  border-radius: 8px;
  color: var(--ql-color-text-muted);
  background: var(--ql-panel);
  cursor: pointer;
}

.ui-modal__header button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ui-modal__body {
  min-height: 0;
  overflow: auto;
  padding: 20px;
}

@media (max-width: 640px) {
  .ui-modal__overlay { padding: 0; }
  .ui-modal__panel {
    width: 100vw;
    max-height: 100vh;
    min-height: 100vh;
    border-radius: 0;
  }
}
</style>
