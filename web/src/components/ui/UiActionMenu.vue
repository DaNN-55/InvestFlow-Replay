<script setup>
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  useId,
  useTemplateRef,
} from "vue";

const props = defineProps({
  label: { type: String, required: true },
  disabled: { type: Boolean, default: false },
  minWidth: { type: Number, default: 112 },
  triggerSize: { type: Number, default: 28 },
});

const open = shallowRef(false);
const positioned = shallowRef(false);
const placement = shallowRef("bottom");
const popoverStyle = shallowRef({});
const trigger = useTemplateRef("trigger");
const popover = useTemplateRef("popover");
const menuId = `ui-action-menu-${useId()}`;

function close({ restoreFocus = false } = {}) {
  open.value = false;
  positioned.value = false;
  if (restoreFocus) {
    trigger.value?.focus();
  }
}

function updatePosition() {
  if (!open.value || !trigger.value || !popover.value) return;

  const viewportMargin = 8;
  const triggerGap = 6;
  const triggerRect = trigger.value.getBoundingClientRect();
  const popoverRect = popover.value.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const availableAbove = triggerRect.top - triggerGap - viewportMargin;
  const availableBelow = viewportHeight - triggerRect.bottom - triggerGap - viewportMargin;
  const openAbove =
    availableBelow < popoverRect.height && availableAbove > availableBelow;
  const availableHeight = openAbove ? availableAbove : availableBelow;
  const desiredTop = openAbove
    ? triggerRect.top - triggerGap - popoverRect.height
    : triggerRect.bottom + triggerGap;
  const top = Math.min(
    Math.max(viewportMargin, desiredTop),
    Math.max(viewportMargin, viewportHeight - popoverRect.height - viewportMargin),
  );
  const desiredLeft = triggerRect.right - popoverRect.width;
  const left = Math.min(
    Math.max(viewportMargin, desiredLeft),
    Math.max(viewportMargin, viewportWidth - popoverRect.width - viewportMargin),
  );

  placement.value = openAbove ? "top" : "bottom";
  popoverStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    maxHeight: `${Math.max(48, Math.floor(availableHeight))}px`,
    minWidth: `${props.minWidth}px`,
  };
  positioned.value = true;
}

async function toggle() {
  if (props.disabled) return;
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  positioned.value = false;
  await nextTick();
  updatePosition();
}

function handleDocumentPointerDown(event) {
  if (
    !open.value ||
    trigger.value?.contains(event.target) ||
    popover.value?.contains(event.target)
  ) {
    return;
  }
  close();
}

function handleKeydown(event) {
  if (open.value && event.key === "Escape") {
    close({ restoreFocus: true });
  }
}

function handlePopoverClick(event) {
  const button = event.target.closest("button");
  if (button && !button.disabled) {
    close();
  }
}

onMounted(() => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("scroll", updatePosition, true);
  window.addEventListener("resize", updatePosition);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  document.removeEventListener("keydown", handleKeydown);
  document.removeEventListener("scroll", updatePosition, true);
  window.removeEventListener("resize", updatePosition);
});
</script>

<template>
  <span
    class="ui-action-menu"
    :style="{ '--ui-action-menu-trigger-size': `${triggerSize}px` }"
  >
    <button
      ref="trigger"
      class="ui-action-menu__trigger"
      type="button"
      :aria-label="label"
      :aria-controls="menuId"
      :aria-expanded="open"
      aria-haspopup="menu"
      :disabled="disabled"
      @click="toggle"
    >
      <slot name="trigger" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="menuId"
        ref="popover"
        class="ui-action-menu__popover"
        :class="{ 'ui-action-menu__popover--positioned': positioned }"
        :data-placement="placement"
        :style="popoverStyle"
        role="menu"
        @click="handlePopoverClick"
      >
        <slot />
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.ui-action-menu {
  display: inline-flex;
  flex: 0 0 auto;
}

.ui-action-menu__trigger {
  display: grid;
  width: var(--ui-action-menu-trigger-size);
  height: var(--ui-action-menu-trigger-size);
  min-width: var(--ui-action-menu-trigger-size);
  min-height: var(--ui-action-menu-trigger-size);
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 7px;
  color: var(--ql-color-text-muted);
  background: transparent;
  cursor: pointer;
}

.ui-action-menu__trigger:hover:not(:disabled),
.ui-action-menu__trigger[aria-expanded="true"] {
  color: var(--ql-color-text-strong);
  background: var(--ql-color-bg-muted);
}

.ui-action-menu__trigger:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ui-action-menu__popover {
  position: fixed;
  z-index: 150;
  display: grid;
  max-width: calc(100vw - 16px);
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--ql-color-border-soft);
  border-radius: 8px;
  background: var(--ql-color-bg-surface-strong);
  box-shadow: var(--ql-shadow-popover);
  opacity: 0;
  visibility: hidden;
}

.ui-action-menu__popover--positioned {
  opacity: 1;
  visibility: visible;
}

:slotted(.ui-action-menu__item) {
  display: flex;
  width: 100%;
  min-height: 32px;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border: 0;
  border-radius: 6px;
  color: var(--ql-color-text-body);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1.25;
  text-align: left;
  white-space: nowrap;
}

:slotted(.ui-action-menu__item:hover:not(:disabled)) {
  color: var(--ql-color-text-strong);
  background: var(--ql-color-bg-muted);
}

:slotted(.ui-action-menu__item:disabled) {
  cursor: not-allowed;
  opacity: 0.45;
}

:slotted(.ui-action-menu__item--danger) {
  color: var(--ql-color-danger);
}

:slotted(.ui-action-menu__hint) {
  padding: 5px 9px;
  color: var(--ql-color-text-muted);
  font-size: 11px;
  line-height: 1.4;
  white-space: normal;
}
</style>
