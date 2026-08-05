import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  getReplayAutoplayDelay,
  getReplayAutoplayStopReason,
  REPLAY_AUTOPLAY_SPEEDS,
} from "../../src/utils/replayAutoplay.js";

const composableSource = readFileSync(
  new URL("../../src/composables/useReplayAutoplay.js", import.meta.url),
  "utf8",
);
const tradingPanelSource = readFileSync(
  new URL(
    "../../src/components/replay/ReplayTradingPanel.vue",
    import.meta.url,
  ),
  "utf8",
);
const viewSource = readFileSync(
  new URL("../../src/views/MarketReplayView.vue", import.meta.url),
  "utf8",
);

describe("replay autoplay", () => {
  it("provides distinct slow, normal and fast delays", () => {
    assert.deepEqual(
      REPLAY_AUTOPLAY_SPEEDS.map(({ value, label }) => ({ value, label })),
      [
        { value: "slow", label: "慢速" },
        { value: "normal", label: "正常" },
        { value: "fast", label: "快速" },
      ],
    );
    assert.ok(getReplayAutoplayDelay("slow") > getReplayAutoplayDelay("normal"));
    assert.ok(getReplayAutoplayDelay("normal") > getReplayAutoplayDelay("fast"));
    assert.equal(
      getReplayAutoplayDelay("unsupported"),
      getReplayAutoplayDelay("normal"),
    );
  });

  it("pauses before pending orders, completion and abnormal states", () => {
    const activeSession = {
      id: "session-1",
      status: "active",
      pendingOrders: [],
      executions: [],
    };
    assert.equal(getReplayAutoplayStopReason(activeSession), "");
    assert.match(
      getReplayAutoplayStopReason({
        ...activeSession,
        pendingOrders: [{ orderId: "pending" }],
      }),
      /待处理委托/u,
    );
    assert.match(
      getReplayAutoplayStopReason({ ...activeSession, status: "completed" }),
      /已完成/u,
    );
    assert.match(
      getReplayAutoplayStopReason({ ...activeSession, status: "blocked" }),
      /状态异常/u,
    );
  });

  it("pauses on newly returned rejection or market anomaly executions", () => {
    assert.match(
      getReplayAutoplayStopReason(
        {
          id: "session-1",
          status: "active",
          pendingOrders: [],
          executions: [
            { status: "filled" },
            {
              status: "rejected",
              reasonCode: "one_price_limit_up",
              reasonMessage: "一字上涨，买入委托未成交",
            },
          ],
        },
        { executionStartIndex: 1 },
      ),
      /一字上涨/u,
    );
  });

  it("pauses on every non-normal backend market event", () => {
    const messages = {
      suspended: /停牌/u,
      limit_up: /涨停/u,
      limit_down: /跌停/u,
      invalid_market_data: /行情数据异常/u,
    };
    for (const [status, expected] of Object.entries(messages)) {
      assert.match(
        getReplayAutoplayStopReason({
          id: "session-1",
          status: "active",
          pendingOrders: [],
          executions: [],
          marketEvent: { sequence: 251, status },
        }),
        expected,
      );
    }
    assert.equal(
      getReplayAutoplayStopReason({
        id: "session-1",
        status: "active",
        pendingOrders: [],
        executions: [],
        marketEvent: { sequence: 251, status: "normal" },
      }),
      "",
    );
  });

  it("pauses on blind-draft close risk rules without inventing executions", () => {
    const session = {
      id: "session-1",
      status: "active",
      pendingOrders: [],
      executions: [],
      bars: [{ close: 10.2 }, { close: 9.8 }],
    };
    const stopLossReason = getReplayAutoplayStopReason(session, {
      blindDraft: { stopLossPrice: 10 },
    });
    assert.match(stopLossReason, /最新已揭示日线收盘价 9\.80/u);
    assert.match(stopLossReason, /不会自动平仓/u);
    assert.match(stopLossReason, /不代表盘中成交/u);

    const invalidationReason = getReplayAutoplayStopReason(session, {
      blindDraft: {
        stopLossPrice: null,
        invalidationRule: {
          basis: "close",
          operator: "gte",
          threshold: 9.5,
          note: "上方压力假设失效",
        },
      },
    });
    assert.match(invalidationReason, /收盘价 ≥ 9\.50/u);
    assert.match(invalidationReason, /上方压力假设失效/u);
    assert.equal(
      getReplayAutoplayStopReason(session, {
        blindDraft: {
          stopLossPrice: 9,
          invalidationRule: {
            basis: "close",
            operator: "lte",
            threshold: 9.5,
          },
        },
      }),
      "",
    );
  });

  it("uses one awaited recursive timer and stops on lifecycle boundaries", () => {
    assert.match(composableSource, /let stepInFlight = false/u);
    assert.match(composableSource, /if \(!playing\.value \|\| token !== playbackToken \|\| stepInFlight\)/u);
    assert.match(composableSource, /nextSession = await advanceSession\(\)/u);
    assert.match(composableSource, /scheduleNext\(token\)/u);
    assert.doesNotMatch(composableSource, /setInterval/u);
    assert.match(composableSource, /onDeactivated\(\(\) => pause\(\)\)/u);
    assert.match(composableSource, /onBeforeUnmount\(\(\) => pause\(\)\)/u);
    assert.match(composableSource, /watch\(errorMessage/u);
  });

  it("wires speed, pause and manual actions through the trading panel", () => {
    assert.match(tradingPanelSource, /自动播放速度/u);
    assert.match(tradingPanelSource, /自动播放/u);
    assert.match(tradingPanelSource, /暂停/u);
    assert.match(tradingPanelSource, /REPLAY_AUTOPLAY_SPEEDS/u);
    assert.match(tradingPanelSource, /emit\('changeAutoplaySpeed'/u);
    assert.match(tradingPanelSource, /emit\('toggleAutoplay'\)/u);
    assert.match(viewSource, /useReplayAutoplay/u);
    assert.match(viewSource, /@toggle-autoplay="toggleAutoplay"/u);
    assert.match(viewSource, /@change-autoplay-speed="setAutoplaySpeed"/u);
    assert.match(
      viewSource,
      /function handleManualAdvance\(mode = "minute"\)[\s\S]*?pauseAutoplay\(\);[\s\S]*?advanceSession\(mode\);/u,
    );
    assert.match(
      viewSource,
      /function handleSubmitOrder\(order\)[\s\S]*?pauseAutoplay\(\);[\s\S]*?submitOrder\(order\);/u,
    );
  });
});
