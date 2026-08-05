<script setup>
import { ChartCandlestick, ClipboardList, Moon, Sun } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";

const dark = ref(true);

function applyTheme() {
  document.documentElement.dataset.theme = dark.value ? "dark" : "light";
  localStorage.setItem("investflow-replay-theme", dark.value ? "dark" : "light");
}

function toggleTheme() {
  dark.value = !dark.value;
  applyTheme();
}

onMounted(() => {
  dark.value = localStorage.getItem("investflow-replay-theme") !== "light";
  applyTheme();
});
</script>

<template>
  <div class="standalone-shell">
    <header class="standalone-shell__header">
      <RouterLink class="standalone-shell__brand" to="/decision/market-replay">
        InvestFlow Replay
      </RouterLink>
      <nav aria-label="主导航">
        <RouterLink to="/decision/market-replay" aria-label="行情演练" title="行情演练">
          <ChartCandlestick :size="18" aria-hidden="true" />
        </RouterLink>
        <RouterLink to="/decision/trade-records" aria-label="交易追踪" title="交易追踪">
          <ClipboardList :size="18" aria-hidden="true" />
        </RouterLink>
      </nav>
      <button class="standalone-shell__theme" type="button" aria-label="切换主题" @click="toggleTheme">
        <Sun v-if="dark" :size="18" />
        <Moon v-else :size="18" />
      </button>
    </header>
    <main class="standalone-shell__main">
      <RouterView v-slot="{ Component }">
        <KeepAlive>
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.standalone-shell { min-height: 100vh; background: var(--ql-paper); color: var(--ql-ink); }
.standalone-shell__header { position: sticky; top: 0; z-index: 30; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; height: 44px; padding: 0 20px; border-bottom: 1px solid var(--ql-line-strong); background: var(--ql-panel); }
.standalone-shell__brand { color: inherit; font-size: 16px; font-weight: 700; text-decoration: none; }
nav { display: flex; gap: 6px; }
nav a { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 6px; color: var(--ql-muted); text-decoration: none; }
nav a.router-link-active { background: var(--ql-color-primary-soft); color: var(--ql-color-primary); }
.standalone-shell__theme { justify-self: end; display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--ql-line-strong); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.standalone-shell__main { width: min(100%, 1600px); min-width: 0; margin: 0 auto; padding: 0 clamp(16px, 2.5vw, 40px) 40px; box-sizing: border-box; }
@media (max-width: 720px) { .standalone-shell__header { padding: 0 12px; } .standalone-shell__brand { font-size: 14px; } .standalone-shell__main { padding-right: 12px; padding-left: 12px; } }
</style>
