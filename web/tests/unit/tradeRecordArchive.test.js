import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  reduceTradeRecordArchive,
  useTradeRecordArchive,
} from "../../src/composables/useTradeRecordArchive.js";

function record(index, extra = {}) {
  return {
    id: `record-${index}`,
    stockName: `股票${index}`,
    stockCode: String(600000 + index),
    accountType: "simulated",
    tradeType: "system",
    status: "draft",
    updatedAt: `2026-09-${String(index).padStart(2, "0")}T10:00:00.000Z`,
    ...extra,
  };
}

function replace(records, requestedId = "", pageSize = 10) {
  return reduceTradeRecordArchive(null, {
    type: "replace",
    records,
    requestedId,
  }, pageSize);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asyncArchive({ records, getTradeRecord, listTradeRecords }) {
  const route = {
    name: "quant-trade-records",
    path: "/decision/trade-records",
    query: {},
  };
  const replacements = [];
  const archive = useTradeRecordArchive({
    __test: {
      route,
      router: {
        replace(location) {
          replacements.push(location);
          route.query = { ...location.query };
        },
      },
      api: {
        listTradeRecords: listTradeRecords ?? (async () => ({ items: records })),
        getTradeRecord: getTradeRecord ?? (async (id) =>
          records.find((item) => item.id === id)),
      },
    },
  });
  return { archive, route, replacements };
}

describe("trade record archive", () => {
  it("loads, sorts, projects, paginates, and summarizes saved records", () => {
    const completed = record(1, {
      status: "reviewed",
      ledger: { state: "closed", returnPct: 12.5 },
      strategyProfile: { name: "突破战法" },
    });

    let archive = replace([completed, record(3), record(2)], "", 2);

    assert.deepEqual(archive.records.map((item) => item.id), ["record-3", "record-2", "record-1"]);
    assert.equal(archive.pageCount, 2);
    assert.deepEqual(archive.pagedItems.map((item) => item.id), ["record-3", "record-2"]);
    archive = reduceTradeRecordArchive(archive, { type: "page", page: 2 }, 2);
    assert.equal(archive.pagedItems[0].meta, "模拟 · 系统交易 · 突破战法");
    assert.equal(archive.pagedItems[0].profit, "+12.50%");
    assert.equal(archive.analytics.summary.completedCount, 1);
  });

  it("locates a valid deep link and repairs an invalid selection", () => {
    const records = Array.from({ length: 11 }, (_, index) => record(index + 1));

    const valid = replace(records, "record-1");
    assert.equal(valid.selectedId, "record-1");
    assert.equal(valid.selectedRecord.id, "record-1");
    assert.equal(valid.page, 2);

    const invalid = replace(records, "missing");
    assert.equal(invalid.selectedId, "record-11");
    assert.equal(invalid.selectedRecord.id, "record-11");
    assert.equal(invalid.page, 1);
  });

  it("reorders accepted records and keeps one authoritative selection", () => {
    let archive = replace([record(3), record(2), record(1)], "record-2", 2);

    archive = reduceTradeRecordArchive(archive, {
      type: "accept",
      record: { ...record(1), updatedAt: "2026-09-30T10:00:00.000Z" },
      select: true,
    }, 2);

    assert.deepEqual(archive.records.map((item) => item.id), ["record-1", "record-3", "record-2"]);
    assert.equal(archive.selectedId, "record-1");
    assert.equal(archive.selectedRecord.id, "record-1");
    assert.equal(archive.page, 1);
  });

  it("preserves equal-timestamp order when accepting detail data", () => {
    const records = Array.from({ length: 11 }, (_, index) => record(index + 1, {
      updatedAt: "2026-09-09T10:00:00.000Z",
    }));
    let archive = replace(records, "record-1");

    archive = reduceTradeRecordArchive(archive, {
      type: "accept",
      record: { ...records[0], finalReview: "详情已补全" },
    });

    assert.deepEqual(archive.records.map((item) => item.id), records.map((item) => item.id));
    assert.equal(archive.page, 1);
    assert.equal(archive.selectedRecord.finalReview, "详情已补全");
  });

  it("selects the next record, then the previous page, as records are removed", () => {
    let archive = replace([record(4), record(3), record(2), record(1)], "record-3", 2);

    archive = reduceTradeRecordArchive(archive, { type: "remove", id: "record-3" }, 2);
    assert.equal(archive.selectedId, "record-2");
    assert.equal(archive.selectedRecord.id, "record-2");
    assert.equal(archive.page, 1);

    archive = reduceTradeRecordArchive(archive, { type: "select", id: "record-1" }, 2);
    archive = reduceTradeRecordArchive(archive, { type: "remove", id: "record-1" }, 2);
    assert.equal(archive.selectedId, "record-2");
    assert.equal(archive.selectedRecord.id, "record-2");
    assert.equal(archive.page, 1);
  });

  it("clears selection and clamps the page when the archive becomes empty", () => {
    let archive = replace([record(1)], "record-1");

    archive = reduceTradeRecordArchive(archive, { type: "page", page: 99 });
    assert.equal(archive.page, 1);

    archive = reduceTradeRecordArchive(archive, { type: "remove", id: "record-1" });
    assert.equal(archive.selectedId, "");
    assert.equal(archive.selectedRecord, null);
    assert.equal(archive.page, 1);
    assert.deepEqual(archive.pagedItems, []);
  });

  it("updates A without reclaiming selection after the user selects B", async () => {
    const records = [record(2), record(1)];
    const { archive } = asyncArchive({ records });
    await archive.load({ preferredId: "record-1" });
    const write = deferred();
    const response = write.promise.then((saved) => archive.acceptSavedRecord(saved));

    await archive.select("record-2");
    write.resolve({ ...record(1), finalReview: "A 已保存" });
    await response;

    assert.equal(archive.selectedId.value, "record-2");
    assert.equal(archive.selectedRecord.value.id, "record-2");
    assert.equal(
      archive.records.value.find((item) => item.id === "record-1").finalReview,
      "A 已保存",
    );
  });

  it("keeps loading B detail when the background save for A returns", async () => {
    const records = [record(2), record(1)];
    const bDetail = deferred();
    const { archive } = asyncArchive({
      records,
      getTradeRecord: async (id) => id === "record-2"
        ? bDetail.promise
        : records.find((item) => item.id === id),
    });
    await archive.load({ preferredId: "record-1" });

    const selectingB = archive.select("record-2");
    archive.acceptSavedRecord({
      ...record(1),
      finalReview: "A 已保存",
    });
    bDetail.resolve({ ...record(2), finalReview: "B 详情已加载" });
    await selectingB;

    assert.equal(archive.selectedId.value, "record-2");
    assert.equal(archive.selectedRecord.value.finalReview, "B 详情已加载");
    assert.equal(
      archive.records.value.find((item) => item.id === "record-1").finalReview,
      "A 已保存",
    );
  });

  it("keeps B selected when detail requests for A and B resolve out of order", async () => {
    const records = [record(2), record(1)];
    const details = {
      "record-1": deferred(),
      "record-2": deferred(),
    };
    const started = [];
    const { archive } = asyncArchive({
      records,
      getTradeRecord(id) {
        started.push(id);
        return details[id].promise;
      },
    });

    const loadingA = archive.load({ preferredId: "record-1" });
    while (!started.includes("record-1")) await Promise.resolve();
    const loadingB = archive.select("record-2");
    while (!started.includes("record-2")) await Promise.resolve();
    details["record-2"].resolve({ ...record(2), finalReview: "B 详情" });
    await loadingB;
    details["record-1"].resolve({ ...record(1), finalReview: "A 详情" });
    const staleA = await loadingA;

    assert.equal(staleA.stale, true);
    assert.equal(archive.selectedId.value, "record-2");
    assert.equal(archive.selectedRecord.value.finalReview, "B 详情");
  });

  it("keeps the list fallback and returns the detail error", async () => {
    const records = [record(1)];
    const { archive } = asyncArchive({
      records,
      getTradeRecord: async () => { throw new Error("详情暂不可用"); },
    });

    const result = await archive.load({ preferredId: "record-1" });

    assert.equal(archive.selectedId.value, "record-1");
    assert.equal(archive.selectedRecord.value.id, "record-1");
    assert.equal(result.record.id, "record-1");
    assert.equal(result.error, "详情暂不可用");
  });

  it("synchronizes the URL after load and select", async () => {
    const records = [record(2), record(1)];
    const { archive, route, replacements } = asyncArchive({ records });

    await archive.load();
    assert.equal(route.query.id, "record-2");
    assert.deepEqual(replacements.at(-1), {
      path: "/decision/trade-records",
      query: { id: "record-2" },
    });

    await archive.select("record-1");
    assert.equal(route.query.id, "record-1");
    assert.deepEqual(replacements.at(-1), {
      path: "/decision/trade-records",
      query: { id: "record-1" },
    });
  });

  it("does not restore the trade-record route after navigation away", async () => {
    const records = [record(1)];
    const list = deferred();
    const { archive, route, replacements } = asyncArchive({
      records,
      listTradeRecords: () => list.promise,
    });
    const loading = archive.load({ preferredId: "record-1" });

    route.name = "quant-market-replay";
    route.path = "/decision/market-replay";
    list.resolve({ items: records });
    await loading;

    assert.deepEqual(replacements, []);
  });
});
