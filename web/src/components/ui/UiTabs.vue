<script setup>
import { TabsList, TabsRoot, TabsTrigger } from "reka-ui";

defineProps({
  modelValue: {
    type: String,
    default: "",
  },
  items: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <TabsRoot
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <TabsList class="ql-ui-tabs">
      <TabsTrigger
        v-for="item in items"
        :key="item.value"
        :value="item.value"
        class="ql-ui-tab"
        :class="modelValue === item.value ? 'ql-ui-tab--active' : ''"
      >
        <component :is="item.icon" v-if="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </TabsTrigger>
    </TabsList>
  </TabsRoot>
</template>
