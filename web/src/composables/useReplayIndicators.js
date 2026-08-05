import { computed, readonly, shallowRef } from "vue";

export const REPLAY_INDICATORS_STORAGE_KEY =
  "investflow.replay.indicator-preferences.v1";
export const MAX_REPLAY_SUBCHARTS = 3;
export const REPLAY_INDICATOR_LIMIT_MESSAGE =
  "最多同时显示 3 个副图，请先关闭一个已显示指标。";

const DEFAULT_MAIN_VISIBILITY = Object.freeze({
  ma: true,
  boll: false,
});
const DEFAULT_VISIBLE_PANEL_IDS = Object.freeze(["macd", "rsi"]);
const BUILTIN_PANEL_IDS = new Set(["macd", "rsi", "kdj"]);

function createIndicatorId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `indicator-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function normalizeCustomIndicator(indicator) {
  const name = String(indicator?.name ?? "").trim();
  const expression = String(indicator?.expression ?? "").trim();
  if (!name || !expression) {
    return null;
  }
  return {
    id: String(indicator?.id ?? createIndicatorId()),
    name,
    expression,
    placement: indicator?.placement === "main" ? "main" : "sub",
    color: /^#[\da-f]{6}$/iu.test(indicator?.color)
      ? indicator.color
      : "#2563eb",
  };
}

function normalizeVisiblePanelIds(ids, customIndicators) {
  const customIds = new Set(
    customIndicators
      .filter((indicator) => indicator.placement === "sub")
      .map((indicator) => indicator.id),
  );
  const seen = new Set();
  return (Array.isArray(ids) ? ids : [])
    .map(String)
    .filter(
      (id) =>
        !seen.has(id) &&
        (BUILTIN_PANEL_IDS.has(id) || customIds.has(id)) &&
        seen.add(id),
    )
    .slice(0, MAX_REPLAY_SUBCHARTS);
}

function normalizeVisibleMainIndicatorIds(ids, customIndicators) {
  const customIds = new Set(
    customIndicators
      .filter((indicator) => indicator.placement === "main")
      .map((indicator) => indicator.id),
  );
  const seen = new Set();
  return (Array.isArray(ids) ? ids : [])
    .map(String)
    .filter((id) => !seen.has(id) && customIds.has(id) && seen.add(id));
}

function readStoredState(storage) {
  if (!storage) {
    return null;
  }
  try {
    const parsed = JSON.parse(storage.getItem(REPLAY_INDICATORS_STORAGE_KEY));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const customIndicators = Array.isArray(parsed.customIndicators)
      ? parsed.customIndicators.map(normalizeCustomIndicator).filter(Boolean)
      : [];
    const legacyVisibleIds = [
      ...(parsed.defaultVisibility?.macd === false ? [] : ["macd"]),
      ...(parsed.defaultVisibility?.rsi === false ? [] : ["rsi"]),
      ...(parsed.defaultVisibility?.kdj === true ? ["kdj"] : []),
      ...customIndicators.map((indicator) => indicator.id),
    ];
    return {
      mainVisibility: {
        ma:
          typeof parsed.mainVisibility?.ma === "boolean"
            ? parsed.mainVisibility.ma
            : typeof parsed.defaultVisibility?.ma === "boolean"
              ? parsed.defaultVisibility.ma
              : DEFAULT_MAIN_VISIBILITY.ma,
        boll:
          typeof parsed.mainVisibility?.boll === "boolean"
            ? parsed.mainVisibility.boll
            : typeof parsed.defaultVisibility?.boll === "boolean"
              ? parsed.defaultVisibility.boll
              : DEFAULT_MAIN_VISIBILITY.boll,
      },
      visiblePanelIds: normalizeVisiblePanelIds(
        parsed.visiblePanelIds ?? legacyVisibleIds,
        customIndicators,
      ),
      visibleMainIndicatorIds: normalizeVisibleMainIndicatorIds(
        parsed.visibleMainIndicatorIds ??
          customIndicators
            .filter((indicator) => indicator.placement === "main")
            .map((indicator) => indicator.id),
        customIndicators,
      ),
      customIndicators,
    };
  } catch {
    return null;
  }
}

export function useReplayIndicators(options = {}) {
  const storage =
    options.storage ??
    (typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage);
  const restored = readStoredState(storage);
  const mainVisibility = shallowRef({
    ...DEFAULT_MAIN_VISIBILITY,
    ...restored?.mainVisibility,
  });
  const visiblePanelIds = shallowRef(
    restored?.visiblePanelIds ?? [...DEFAULT_VISIBLE_PANEL_IDS],
  );
  const visibleMainIndicatorIds = shallowRef(
    restored?.visibleMainIndicatorIds ?? [],
  );
  const customIndicators = shallowRef(restored?.customIndicators ?? []);
  const defaultVisibility = computed(() => ({
    ...mainVisibility.value,
    macd: visiblePanelIds.value.includes("macd"),
    rsi: visiblePanelIds.value.includes("rsi"),
    kdj: visiblePanelIds.value.includes("kdj"),
  }));

  function persist() {
    if (!storage) {
      return;
    }
    try {
      storage.setItem(
        REPLAY_INDICATORS_STORAGE_KEY,
        JSON.stringify({
          mainVisibility: mainVisibility.value,
          visiblePanelIds: visiblePanelIds.value,
          visibleMainIndicatorIds: visibleMainIndicatorIds.value,
          customIndicators: customIndicators.value,
        }),
      );
    } catch {
      // Storage availability must not interrupt indicator editing or replay.
    }
  }

  function togglePanel(id) {
    if (visiblePanelIds.value.includes(id)) {
      visiblePanelIds.value = visiblePanelIds.value.filter(
        (panelId) => panelId !== id,
      );
      persist();
      return { changed: true, message: "" };
    }
    if (visiblePanelIds.value.length >= MAX_REPLAY_SUBCHARTS) {
      return {
        changed: false,
        message: REPLAY_INDICATOR_LIMIT_MESSAGE,
      };
    }
    visiblePanelIds.value = [...visiblePanelIds.value, id];
    persist();
    return { changed: true, message: "" };
  }

  function toggleDefaultIndicator(key) {
    if (key in DEFAULT_MAIN_VISIBILITY) {
      mainVisibility.value = {
        ...mainVisibility.value,
        [key]: !mainVisibility.value[key],
      };
      persist();
      return { changed: true, message: "" };
    }
    if (!BUILTIN_PANEL_IDS.has(key)) {
      return { changed: false, message: "" };
    }
    return togglePanel(key);
  }

  function toggleCustomIndicator(id) {
    const indicator = customIndicators.value.find((item) => item.id === id);
    if (!indicator) {
      return { changed: false, message: "" };
    }
    if (indicator.placement === "main") {
      visibleMainIndicatorIds.value = visibleMainIndicatorIds.value.includes(id)
        ? visibleMainIndicatorIds.value.filter((indicatorId) => indicatorId !== id)
        : [...visibleMainIndicatorIds.value, id];
      persist();
      return { changed: true, message: "" };
    }
    return togglePanel(id);
  }

  function saveCustomIndicator(input) {
    const normalized = normalizeCustomIndicator(input);
    if (!normalized) {
      return null;
    }
    const existingIndex = customIndicators.value.findIndex(
      (item) => item.id === normalized.id,
    );
    if (existingIndex === -1) {
      customIndicators.value = [...customIndicators.value, normalized];
      if (normalized.placement === "main") {
        visibleMainIndicatorIds.value = [
          ...visibleMainIndicatorIds.value,
          normalized.id,
        ];
      } else if (visiblePanelIds.value.length < MAX_REPLAY_SUBCHARTS) {
        visiblePanelIds.value = [...visiblePanelIds.value, normalized.id];
      }
    } else {
      const previous = customIndicators.value[existingIndex];
      const wasVisible =
        previous.placement === "main"
          ? visibleMainIndicatorIds.value.includes(previous.id)
          : visiblePanelIds.value.includes(previous.id);
      customIndicators.value = customIndicators.value.map((item, index) =>
        index === existingIndex ? normalized : item,
      );
      if (previous.placement !== normalized.placement) {
        visibleMainIndicatorIds.value = visibleMainIndicatorIds.value.filter(
          (indicatorId) => indicatorId !== normalized.id,
        );
        visiblePanelIds.value = visiblePanelIds.value.filter(
          (panelId) => panelId !== normalized.id,
        );
        if (wasVisible && normalized.placement === "main") {
          visibleMainIndicatorIds.value = [
            ...visibleMainIndicatorIds.value,
            normalized.id,
          ];
        } else if (
          wasVisible &&
          visiblePanelIds.value.length < MAX_REPLAY_SUBCHARTS
        ) {
          visiblePanelIds.value = [...visiblePanelIds.value, normalized.id];
        }
      }
    }
    persist();
    return normalized;
  }

  function removeCustomIndicator(id) {
    const next = customIndicators.value.filter((item) => item.id !== id);
    if (next.length === customIndicators.value.length) {
      return;
    }
    customIndicators.value = next;
    visiblePanelIds.value = visiblePanelIds.value.filter(
      (panelId) => panelId !== id,
    );
    visibleMainIndicatorIds.value = visibleMainIndicatorIds.value.filter(
      (indicatorId) => indicatorId !== id,
    );
    persist();
  }

  return {
    defaultVisibility,
    mainVisibility: readonly(mainVisibility),
    visiblePanelIds: readonly(visiblePanelIds),
    visibleMainIndicatorIds: readonly(visibleMainIndicatorIds),
    customIndicators: readonly(customIndicators),
    toggleDefaultIndicator,
    toggleCustomIndicator,
    saveCustomIndicator,
    removeCustomIndicator,
  };
}
