import { computed, onMounted, onUnmounted, readonly, shallowRef } from "vue";

import { api } from "../services/api.js";
import { replayCacheProgress } from "../utils/replayCacheStatus.js";

const RUNNING_POLL_INTERVAL = 2000;
const IDLE_POLL_INTERVAL = 10000;

export function useReplayCacheStatus() {
  const status = shallowRef(null);
  const error = shallowRef("");
  const loading = shallowRef(false);
  let timerId = null;
  let stopped = false;

  const progress = computed(() => replayCacheProgress(status.value));

  function clearTimer() {
    if (timerId != null) window.clearTimeout(timerId);
    timerId = null;
  }

  function schedule() {
    clearTimer();
    if (stopped || document.hidden) return;
    const interval = status.value?.state === "running"
      ? RUNNING_POLL_INTERVAL
      : IDLE_POLL_INTERVAL;
    timerId = window.setTimeout(refresh, interval);
  }

  async function refresh() {
    clearTimer();
    loading.value = status.value == null;
    try {
      status.value = await api.getReplayCacheStatus();
      error.value = "";
    } catch (requestError) {
      error.value = requestError instanceof Error ? requestError.message : "缓存状态读取失败";
    } finally {
      loading.value = false;
      schedule();
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) clearTimer();
    else refresh();
  }

  onMounted(() => {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    refresh();
  });

  onUnmounted(() => {
    stopped = true;
    clearTimer();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  });

  return {
    status: readonly(status),
    error: readonly(error),
    loading: readonly(loading),
    progress,
    refresh,
  };
}
