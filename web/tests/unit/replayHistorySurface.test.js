import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const viewSource = readFileSync(
  new URL("../../src/views/TradeRecordsView.vue", import.meta.url),
  "utf8",
);
const apiSource = readFileSync(
  new URL("../../src/services/api.js", import.meta.url),
  "utf8",
);
const composableUrl = new URL(
  "../../src/composables/useReplayHistory.js",
  import.meta.url,
);
const panelUrl = new URL(
  "../../src/components/replay-history/ReplayHistoryPanel.vue",
  import.meta.url,
);
const recordsUrl = new URL(
  "../../src/components/replay-history/ReplayHistoryRecords.vue",
  import.meta.url,
);
const filtersUrl = new URL(
  "../../src/components/replay-history/ReplayHistoryFilters.vue",
  import.meta.url,
);
const listUrl = new URL(
  "../../src/components/replay-history/ReplayHistoryList.vue",
  import.meta.url,
);
const detailUrl = new URL(
  "../../src/components/replay-history/ReplayHistoryDetail.vue",
  import.meta.url,
);
const scorePresentationUrl = new URL(
  "../../src/utils/replayScorePresentation.js",
  import.meta.url,
);

function sourceIfPresent(url) {
  return existsSync(url) ? readFileSync(url, "utf8") : "";
}

describe("replay history tracking surface", () => {
  it("keeps live tracking and replay history in separate primary tabs", () => {
    assert.match(viewSource, /const primaryTab = ref\("records"\)/u);
    assert.match(viewSource, /aria-label="交易追踪分类"/u);
    assert.match(viewSource, /实盘与模拟/u);
    assert.match(viewSource, /历史演练/u);
    assert.match(viewSource, /primaryTab === 'records'/u);
    assert.match(viewSource, /ReplayHistoryPanel/u);
    assert.match(
      viewSource,
      /v-if="primaryTab === 'records'"[\s\S]*?executionSettingsOpen = true/u,
    );
  });

  it("uses a dedicated replay history API and source state", () => {
    assert.match(apiSource, /listReplaySessions\(params = \{\}\)/u);
    assert.match(apiSource, /deleteReplaySession\(sessionId\)/u);
    const composableSource = sourceIfPresent(composableUrl);
    assert.equal(existsSync(composableUrl), true);
    assert.match(composableSource, /api\.listReplaySessions/u);
    assert.match(composableSource, /const items = shallowRef\(\[\]\)/u);
    assert.match(composableSource, /const selectedItem = computed/u);
    assert.match(composableSource, /async function applyFilters/u);
    assert.match(composableSource, /async function goToPage/u);
    assert.match(composableSource, /async function loadSelectedDetail/u);
    assert.match(composableSource, /api\.getReplaySession\(normalizedId\)/u);
    assert.match(composableSource, /detailRequestSequence/u);
    assert.match(
      composableSource,
      /async function refresh\(\)[\s\S]*?loadHistory\(\{ loadDetail: false \}\)[\s\S]*?loadSelectedDetail/u,
    );
    assert.doesNotMatch(
      composableSource,
      /queryTradeRecords|getDecisionTradeRecords|executionSettings/u,
    );
  });

  it("keeps history container, filters, list and detail focused", () => {
    for (const url of [panelUrl, recordsUrl, filtersUrl, listUrl, detailUrl]) {
      assert.equal(existsSync(url), true, url.pathname);
    }
    const recordsSource = sourceIfPresent(recordsUrl);
    const filtersSource = sourceIfPresent(filtersUrl);
    const listSource = sourceIfPresent(listUrl);
    const detailSource = sourceIfPresent(detailUrl);
    const scorePresentationSource = sourceIfPresent(scorePresentationUrl);

    for (const component of [
      "ReplayHistoryFilters",
      "ReplayHistoryList",
      "ReplayHistoryDetail",
    ]) {
      assert.match(recordsSource, new RegExp(component, "u"));
    }
    assert.match(
      recordsSource,
      /investflow\.replay\.active-session-id/u,
    );
    assert.match(recordsSource, /router\.push\("\/decision\/market-replay"\)/u);
    assert.match(filtersSource, /状态筛选/u);
    assert.match(filtersSource, /关键词/u);
    assert.match(listSource, /共 \{\{ total \}\} 局/u);
    assert.match(listSource, /@click="emit\('select'/u);
    assert.match(detailSource, /打开演练/u);
    assert.match(detailSource, /匿名行情/u);
    assert.match(detailSource, /真实标的已揭晓/u);
    assert.match(detailSource, /候选改进，不会直接修改原战法/u);
    assert.match(detailSource, /ReplayReviewTimeline/u);
    assert.match(detailSource, /ReplayOrderDecisionSnapshot/u);
    assert.match(detailSource, /逐笔委托与成交/u);
    assert.match(detailSource, /props\.item\.executions/u);
    assert.match(detailSource, /props\.item\.pendingOrders/u);
    assert.match(detailSource, /待卖出/u);
    assert.match(detailSource, /:show-original="false"/u);
    assert.match(recordsSource, /detailLoading/u);
    assert.match(recordsSource, /detailError/u);
    assert.match(recordsSource, /重试详情/u);
    for (const label of [
      "执行纪律",
      "风险控制",
      "战法符合度",
      "收益表现",
      "复盘质量",
      "总收益率",
      "个股买入持有基准",
      "相对个股超额",
      "最大回撤",
      "指数基准收益率",
      "相对指数超额",
    ]) {
      assert.match(
        `${detailSource}\n${scorePresentationSource}`,
        new RegExp(label, "u"),
      );
    }
    assert.match(detailSource, /算法/u);
    assert.match(detailSource, /权重快照/u);
    assert.match(detailSource, /不适用/u);
    assert.match(detailSource, /<details[\s\S]*?item\.scoreCard[\s\S]*?open/u);
    assert.doesNotMatch(detailSource, /点击折叠/u);
    assert.doesNotMatch(detailSource, /点击展开/u);
    assert.match(detailSource, /ChevronUp/u);
    assert.match(detailSource, /ChevronDown/u);
    assert.match(detailSource, /replay-history-detail__data-card--positive/u);
    assert.match(detailSource, /:title="dimension\.description"/u);
    assert.match(detailSource, /:title="metric\.description"/u);
    assert.match(detailSource, /:title="entry\.description"/u);
    assert.match(
      detailSource,
      /\.replay-history-detail__score-summary \{[\s\S]*?min-height: 80px;[\s\S]*?padding: 0\.5625rem 1rem;/u,
    );
    assert.match(scorePresentationSource, /description:/u);
    assert.ok(
      detailSource.indexOf('v-if="item.scoreCard"') <
        detailSource.indexOf("揭晓前整局确认"),
      "score card should appear before the review sections",
    );
    assert.match(scorePresentationSource, /暂无指数数据/u);
    assert.match(recordsSource, /@media \(max-width: 900px\)/u);
    assert.match(recordsSource, /grid-template-columns: 300px minmax\(0, 1fr\)/u);
    assert.match(recordsSource, /window\.confirm/u);
    assert.match(recordsSource, /api\.deleteReplaySession/u);
    assert.match(recordsSource, /@delete="deleteReplay"/u);
    assert.match(detailSource, /删除记录/u);
    assert.match(detailSource, /replay-history-detail__reviews/u);
    assert.match(detailSource, /replay-history-detail__order-columns/u);
    assert.match(detailSource, /replay-history-detail__order-column--buy/u);
    assert.match(detailSource, /replay-history-detail__order-column--sell/u);
    assert.match(
      detailSource,
      /replay-history-detail__facts[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/u,
    );
    assert.match(detailSource, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
    assert.match(detailSource, /replay-history-detail__review-section/u);
    assert.match(
      detailSource,
      /replay-history-detail__algorithm[\s\S]*?attemptPresentation\.scoreNote/u,
    );
  });
});
