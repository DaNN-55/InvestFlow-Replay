<script setup>
import { AlertTriangle, Database, LoaderCircle, RefreshCw } from "lucide-vue-next";
import { computed, shallowRef } from "vue";

import { useReplayCacheStatus } from "../composables/useReplayCacheStatus.js";
import {
  formatCacheBytes,
  formatCacheCount,
  formatCacheTime,
} from "../utils/replayCacheStatus.js";

const open = shallowRef(false);
const { status, error, loading, progress, refresh } = useReplayCacheStatus();

const isCachedFallback = computed(() => {
  const message = `${status.value?.activeTask?.message ?? ""} ${status.value?.initialization?.message ?? ""}`;
  return /本地缓存|连接失败|离线/u.test(message);
});
const tone = computed(() => {
  if (error.value || status.value?.state === "failed") return "failed";
  if (status.value?.state === "running") return "running";
  if (isCachedFallback.value) return "cached";
  return "ready";
});
const headline = computed(() => {
  if (error.value) return error.value;
  if (loading.value) return "正在读取行情缓存";
  return status.value?.activeTask?.message || "行情缓存可用";
});
const market = computed(() => status.value?.market ?? {});
const minute = computed(() => status.value?.minute ?? {});
const storage = computed(() => status.value?.storage ?? {});

function close() {
  open.value = false;
}
</script>

<template>
  <div
    class="replay-cache-status"
    :class="[`replay-cache-status--${tone}`, { 'replay-cache-status--open': open }]"
    @keydown.esc="close"
  >
    <button
      class="replay-cache-status__trigger"
      type="button"
      aria-label="行情缓存状态"
      :aria-expanded="open"
      aria-controls="replay-cache-status-panel"
      @click="open = !open"
    >
      <LoaderCircle v-if="tone === 'running'" class="replay-cache-status__spin" :size="17" />
      <AlertTriangle v-else-if="tone === 'failed'" :size="17" />
      <Database v-else :size="17" />
      <span v-if="progress" class="replay-cache-status__badge">{{ progress.percent }}%</span>
    </button>

    <section
      id="replay-cache-status-panel"
      class="replay-cache-status__panel"
      role="status"
      aria-live="polite"
    >
      <header class="replay-cache-status__heading">
        <div>
          <strong>行情数据</strong>
          <p>{{ headline }}</p>
        </div>
        <button type="button" aria-label="刷新缓存状态" title="刷新" @click="refresh">
          <RefreshCw :size="15" :class="{ 'replay-cache-status__spin': loading }" />
        </button>
      </header>

      <div v-if="progress" class="replay-cache-status__progress">
        <div><span>后台拉取</span><b>{{ progress.completed }}/{{ progress.total }}</b></div>
        <div class="replay-cache-status__track"><i :style="{ width: `${progress.percent}%` }" /></div>
      </div>

      <div class="replay-cache-status__group">
        <h3>日线行情</h3>
        <dl>
          <div><dt>证券名单</dt><dd>{{ formatCacheCount(market.instrumentCount) }} 只</dd></div>
          <div><dt>股票日线</dt><dd>{{ formatCacheCount(market.stockCount) }} 只 / {{ formatCacheCount(market.stockDailyBarCount) }} 条</dd></div>
          <div><dt>复权记录</dt><dd>{{ formatCacheCount(market.adjustFactorCount) }} 条</dd></div>
          <div><dt>指数日线</dt><dd>{{ formatCacheCount(market.indexCount) }} 只 / {{ formatCacheCount(market.indexDailyBarCount) }} 条</dd></div>
          <div><dt>交易日</dt><dd>{{ formatCacheCount(market.tradeDateCount) }} 天</dd></div>
        </dl>
      </div>

      <div class="replay-cache-status__group">
        <h3>分钟行情</h3>
        <dl>
          <div><dt>1分钟缓存</dt><dd>{{ formatCacheCount(minute.oneMinuteInstrumentCount) }} 只 / {{ formatCacheCount(minute.oneMinuteBarCount) }} 条</dd></div>
          <div><dt>5分钟缓存</dt><dd>{{ formatCacheCount(minute.fiveMinuteInstrumentCount) }} 只 / {{ formatCacheCount(minute.fiveMinuteBarCount) }} 条</dd></div>
        </dl>
      </div>

      <div class="replay-cache-status__group replay-cache-status__storage">
        <h3>存储占用</h3>
        <dl>
          <div><dt>日线库</dt><dd>{{ formatCacheBytes(storage.marketBytes) }}</dd></div>
          <div><dt>分钟库</dt><dd>{{ formatCacheBytes(storage.minuteBytes) }}</dd></div>
          <div><dt>合计</dt><dd>{{ formatCacheBytes(storage.totalBytes) }}</dd></div>
        </dl>
      </div>

      <footer>最近更新：{{ formatCacheTime(status?.lastSuccessAt) }}</footer>
    </section>
  </div>
</template>

<style scoped>
.replay-cache-status { position: relative; color: var(--ql-color-text-muted); }
.replay-cache-status__trigger { position: relative; display: grid; place-items: center; width: 32px; min-height: 32px; height: 32px; padding: 0; border: 1px solid var(--ql-line-strong); border-radius: 6px; background: transparent; color: var(--ql-color-success); cursor: pointer; }
.replay-cache-status--running .replay-cache-status__trigger { color: var(--ql-color-primary); }
.replay-cache-status--cached .replay-cache-status__trigger { color: var(--ql-color-warning); }
.replay-cache-status--failed .replay-cache-status__trigger { color: var(--ql-color-danger); }
.replay-cache-status__trigger:focus-visible { outline: 2px solid var(--ql-color-primary); outline-offset: 2px; }
.replay-cache-status__badge { position: absolute; top: -5px; right: -8px; min-width: 23px; padding: 1px 3px; border-radius: 8px; background: var(--ql-color-primary); color: #fff; font-size: 9px; font-weight: 700; line-height: 13px; }
.replay-cache-status__panel { visibility: hidden; position: absolute; top: calc(100% + 8px); right: 0; z-index: 50; width: min(340px, calc(100vw - 24px)); padding: 14px; border: 1px solid var(--ql-line-strong); border-radius: 10px; background: var(--ql-panel); box-shadow: var(--ql-shadow-lg); opacity: 0; transform: translateY(-4px); transition: opacity 120ms ease, transform 120ms ease, visibility 120ms; pointer-events: none; }
.replay-cache-status:hover .replay-cache-status__panel,
.replay-cache-status:focus-within .replay-cache-status__panel,
.replay-cache-status--open .replay-cache-status__panel { visibility: visible; opacity: 1; transform: translateY(0); pointer-events: auto; }
.replay-cache-status__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 11px; border-bottom: 1px solid var(--ql-line); }
.replay-cache-status__heading strong { color: var(--ql-ink); font-size: 14px; }
.replay-cache-status__heading p { margin: 4px 0 0; color: var(--ql-color-text-muted); font-size: 11px; line-height: 1.45; }
.replay-cache-status__heading button { display: grid; flex: 0 0 auto; place-items: center; width: 28px; min-height: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: var(--ql-paper-soft); color: var(--ql-muted); cursor: pointer; }
.replay-cache-status__progress { padding: 11px 0 2px; font-size: 11px; }
.replay-cache-status__progress > div:first-child { display: flex; justify-content: space-between; color: var(--ql-muted); }
.replay-cache-status__progress b { color: var(--ql-color-primary); }
.replay-cache-status__track { height: 4px; margin-top: 7px; overflow: hidden; border-radius: 4px; background: var(--ql-paper-pressed); }
.replay-cache-status__track i { display: block; height: 100%; border-radius: inherit; background: var(--ql-color-primary); transition: width 180ms ease; }
.replay-cache-status__group { padding-top: 11px; }
.replay-cache-status__group h3 { margin: 0 0 6px; color: var(--ql-muted-soft); font-size: 10px; font-weight: 600; letter-spacing: .08em; }
.replay-cache-status__group dl { display: grid; gap: 5px; margin: 0; }
.replay-cache-status__group dl > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 11px; }
.replay-cache-status__group dt { color: var(--ql-color-text-muted); }
.replay-cache-status__group dd { margin: 0; color: var(--ql-ink); font-variant-numeric: tabular-nums; text-align: right; }
.replay-cache-status__storage dl { grid-template-columns: repeat(3, 1fr); gap: 6px; }
.replay-cache-status__storage dl > div { display: block; padding: 7px; border-radius: 6px; background: var(--ql-paper-soft); }
.replay-cache-status__storage dd { margin-top: 3px; text-align: left; }
.replay-cache-status footer { margin-top: 11px; padding-top: 9px; border-top: 1px solid var(--ql-line); color: var(--ql-muted-soft); font-size: 10px; }
.replay-cache-status__spin { animation: replay-cache-spin 1s linear infinite; }
@keyframes replay-cache-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .replay-cache-status__spin { animation: none; } }
</style>
