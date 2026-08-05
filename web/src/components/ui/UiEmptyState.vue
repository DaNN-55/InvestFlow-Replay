<template>
  <div class="ql-ui-empty">
    <div v-if="$slots.icon" class="ql-ui-empty__icon">
      <slot name="icon" />
    </div>
    <div class="ql-space-y-2">
      <div v-if="$slots.title" class="ql-ui-empty__title">
        <slot name="title" />
      </div>
      <div v-if="$slots.description" class="ql-ui-empty__description">
        <slot name="description" />
      </div>
    </div>
    <div
      v-if="$slots.actions"
      class="ql-flex ql-flex-wrap ql-justify-center ql-gap-3"
    >
      <slot name="actions" />
    </div>
  </div>
</template>
