import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REPLAY_INDICATOR_LIMIT_MESSAGE,
  REPLAY_INDICATORS_STORAGE_KEY,
  useReplayIndicators,
} from "../../src/composables/useReplayIndicators.js";

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) {
    values.set(REPLAY_INDICATORS_STORAGE_KEY, initialValue);
  }
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("replay indicator local state", () => {
  it("starts with both default indicators visible and persists toggles", () => {
    const storage = createStorage();
    const state = useReplayIndicators({ storage });

    assert.deepEqual(state.defaultVisibility.value, {
      ma: true,
      boll: false,
      macd: true,
      rsi: true,
      kdj: false,
    });

    state.toggleDefaultIndicator("macd");

    assert.equal(state.defaultVisibility.value.macd, false);
    assert.equal(
      JSON.parse(storage.getItem(REPLAY_INDICATORS_STORAGE_KEY))
        .visiblePanelIds.includes("macd"),
      false,
    );
  });

  it("limits visible subcharts to three without changing stored selection", () => {
    const storage = createStorage();
    const state = useReplayIndicators({ storage });
    assert.equal(state.toggleDefaultIndicator("kdj").changed, true);
    assert.deepEqual(state.visiblePanelIds.value, ["macd", "rsi", "kdj"]);

    const custom = state.saveCustomIndicator({
      name: "量能变化",
      expression: "volume - REF(volume, 1)",
      color: "#10b981",
    });
    assert.equal(state.visiblePanelIds.value.includes(custom.id), false);
    const beforeBlockedToggle = storage.getItem(
      REPLAY_INDICATORS_STORAGE_KEY,
    );
    const blocked = state.toggleCustomIndicator(custom.id);
    assert.deepEqual(blocked, {
      changed: false,
      message: REPLAY_INDICATOR_LIMIT_MESSAGE,
    });
    assert.equal(
      storage.getItem(REPLAY_INDICATORS_STORAGE_KEY),
      beforeBlockedToggle,
    );

    state.toggleDefaultIndicator("rsi");
    assert.equal(state.toggleCustomIndicator(custom.id).changed, true);
    assert.deepEqual(state.visiblePanelIds.value, [
      "macd",
      "kdj",
      custom.id,
    ]);

    state.toggleDefaultIndicator("boll");
    assert.equal(state.defaultVisibility.value.boll, true);
    assert.equal(state.visiblePanelIds.value.length, 3);
  });

  it("creates, edits and removes a custom indicator without changing its id", () => {
    const storage = createStorage();
    const state = useReplayIndicators({ storage });

    const created = state.saveCustomIndicator({
      name: "均线差",
      expression: "MA(close, 5) - MA(close, 20)",
      color: "#ef4444",
    });

    assert.ok(created.id);
    assert.equal(state.customIndicators.value.length, 1);

    const edited = state.saveCustomIndicator({
      ...created,
      name: "均线强弱",
      expression: "MA(close, 5) / MA(close, 20)",
    });

    assert.equal(edited.id, created.id);
    assert.equal(state.customIndicators.value[0].name, "均线强弱");

    state.removeCustomIndicator(created.id);

    assert.deepEqual(state.customIndicators.value, []);
    assert.deepEqual(
      JSON.parse(storage.getItem(REPLAY_INDICATORS_STORAGE_KEY))
        .customIndicators,
      [],
    );
  });

  it("saves and restores an advanced subchart indicator", () => {
    const storage = createStorage();
    const state = useReplayIndicators({ storage });
    const advanced = {
      definitions: "change = close - REF(close, 1)",
      plot: {
        type: "rangeBar",
        label: "砖型图",
        fromExpression: "REF(change, 1)",
        toExpression: "change",
        risingColor: "#ef4444",
        fallingColor: "#10b981",
      },
    };

    const saved = state.saveCustomIndicator({
      name: "砖型图",
      mode: "advanced",
      placement: "main",
      advanced,
    });

    assert.ok(saved.id);
    assert.equal(saved.mode, "advanced");
    assert.equal(saved.placement, "sub");
    assert.deepEqual(saved.advanced, advanced);
    assert.equal(saved.expression, undefined);

    const restored = useReplayIndicators({ storage });
    assert.deepEqual(restored.customIndicators.value, [saved]);
    assert.equal(restored.visiblePanelIds.value.includes(saved.id), true);
  });

  it("rejects malformed advanced indicators without changing stored state", () => {
    const storage = createStorage();
    const state = useReplayIndicators({ storage });

    assert.equal(state.saveCustomIndicator({
      name: "错误指标",
      mode: "advanced",
      advanced: {
        definitions: "future = missing + 1",
        plot: { type: "line", expression: "future" },
      },
    }), null);
    assert.deepEqual(state.customIndicators.value, []);
    assert.equal(storage.getItem(REPLAY_INDICATORS_STORAGE_KEY), null);
  });

  it("saves main-chart indicators separately from limited subcharts", () => {
    const storage = createStorage();
    const state = useReplayIndicators({ storage });

    state.toggleDefaultIndicator("kdj");
    const created = state.saveCustomIndicator({
      name: "白线",
      expression: "MA(close, 20)",
      color: "#2563eb",
      placement: "main",
    });

    assert.equal(created.placement, "main");
    assert.deepEqual(state.visiblePanelIds.value, ["macd", "rsi", "kdj"]);
    assert.deepEqual(state.visibleMainIndicatorIds.value, [created.id]);

    const hidden = state.toggleCustomIndicator(created.id);
    assert.deepEqual(hidden, { changed: true, message: "" });
    assert.deepEqual(state.visibleMainIndicatorIds.value, []);
    assert.deepEqual(
      JSON.parse(storage.getItem(REPLAY_INDICATORS_STORAGE_KEY))
        .visibleMainIndicatorIds,
      [],
    );
  });

  it("moves a visible custom indicator between main chart and subchart", () => {
    const state = useReplayIndicators({ storage: createStorage() });
    const created = state.saveCustomIndicator({
      name: "大哥黄",
      expression: "EMA(close, 55)",
      color: "#facc15",
      placement: "sub",
    });

    assert.equal(state.visiblePanelIds.value.includes(created.id), true);

    const moved = state.saveCustomIndicator({
      ...created,
      placement: "main",
    });

    assert.equal(moved.id, created.id);
    assert.equal(state.visiblePanelIds.value.includes(created.id), false);
    assert.equal(state.visibleMainIndicatorIds.value.includes(created.id), true);
  });

  it("restores valid preferences and ignores malformed saved content", () => {
    const savedState = JSON.stringify({
      defaultVisibility: { macd: false, rsi: true },
      customIndicators: [
        {
          id: "saved-indicator",
          name: "收盘动量",
          expression: "close - REF(close, 1)",
          color: "#10b981",
        },
        {
          id: "invalid-indicator",
          name: "",
          expression: "",
        },
      ],
    });

    const restored = useReplayIndicators({ storage: createStorage(savedState) });
    assert.equal(restored.defaultVisibility.value.macd, false);
    assert.equal(restored.customIndicators.value.length, 1);
    assert.equal(restored.customIndicators.value[0].id, "saved-indicator");
    assert.equal(restored.customIndicators.value[0].placement, "sub");
    assert.deepEqual(restored.visibleMainIndicatorIds.value, []);
    assert.deepEqual(restored.visiblePanelIds.value, [
      "rsi",
      "saved-indicator",
    ]);

    const malformed = useReplayIndicators({
      storage: createStorage("{not-json"),
    });
    assert.equal(malformed.defaultVisibility.value.macd, true);
    assert.deepEqual(malformed.customIndicators.value, []);
  });

  it("keeps in-memory actions usable when browser storage rejects writes", () => {
    const storage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("quota exceeded");
      },
    };
    const state = useReplayIndicators({ storage });

    assert.doesNotThrow(() => state.toggleDefaultIndicator("rsi"));
    assert.equal(state.defaultVisibility.value.rsi, false);

    assert.doesNotThrow(() =>
      state.saveCustomIndicator({
        name: "收盘线",
        expression: "close",
        color: "#2563eb",
      }),
    );
    assert.equal(state.customIndicators.value.length, 1);
  });
});
