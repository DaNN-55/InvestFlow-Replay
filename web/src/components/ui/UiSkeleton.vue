<script setup>
const props = defineProps({
  class: {
    type: String,
    default: "",
  },
});
</script>

<template>
  <div class="ql-ui-skeleton" :class="props.class" />
</template>
