<script setup>
import { computed, defineAsyncComponent } from 'vue';
import { useRoute } from 'vue-router';
const route = useRoute();
const LiveView = defineAsyncComponent(() => import('./CryptoReplayView.vue'));
const PrototypeView = import.meta.env.DEV ? defineAsyncComponent(() => import('./crypto-prototype/CryptoReplayPrototype.vue')) : null;
const prototyping = computed(() => import.meta.env.DEV && route.query.prototype === 'ui');
</script>
<template>
  <component :is="prototyping ? PrototypeView : LiveView" />
</template>
