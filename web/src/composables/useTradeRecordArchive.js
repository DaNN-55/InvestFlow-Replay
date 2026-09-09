import { computed, readonly, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import { api, extractApiRecord } from "../services/api.js";
import { buildTradeRecordAnalytics } from "../utils/tradeRecordAnalytics.js";
import {
  formatTradeRecordAccountType,
  formatTradeRecordStatus,
  formatTradeRecordStock,
  formatTradeRecordTradeType,
} from "../utils/tradeRecordPresentation.js";

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.items ?? payload?.records ?? [];
}

function recordId(record) {
  return String(record?.id ?? record?.recordId ?? "");
}

function sortTimestamp(record) {
  return String(record?.updatedAt ?? record?.createdAt ?? "");
}

function sortRecords(records) {
  return [...records].sort((left, right) =>
    sortTimestamp(right).localeCompare(sortTimestamp(left)),
  );
}

function parseTradeNumber(value) {
  if (value == null || value === "") return null;
  const matched = String(value).replace(/,/gu, "").trim().match(/[-+]?\d+(?:\.\d+)?/u);
  if (!matched) return null;
  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTradePercent(value) {
  const parsed = parseTradeNumber(value);
  if (parsed == null) return "--";
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(2)}%`;
}

function formatRecordProfitPct(record) {
  const ledgerReturnPct = parseTradeNumber(record?.ledger?.returnPct);
  if (ledgerReturnPct != null && ["open", "closed"].includes(record?.ledger?.state)) {
    return formatTradePercent(ledgerReturnPct);
  }
  const entryPrice = parseTradeNumber(record?.actualEntryPrice);
  const exitPrice = parseTradeNumber(record?.actualExitPrice);
  if (entryPrice == null || exitPrice == null || entryPrice === 0) return "--";
  return formatTradePercent(((exitPrice - entryPrice) / entryPrice) * 100);
}

function listItem(record) {
  const profit = formatRecordProfitPct(record);
  const profitNumber = parseTradeNumber(profit);
  return {
    id: recordId(record),
    title: formatTradeRecordStock(record),
    status: formatTradeRecordStatus(record?.status),
    meta: `${formatTradeRecordAccountType(record?.accountType)} · ${formatTradeRecordTradeType(record?.tradeType)} · ${record?.strategyProfile?.name || "未指定"}`,
    profit: profit === "--" ? "" : profit,
    profitTone: profitNumber == null || profitNumber === 0
      ? "neutral"
      : profitNumber > 0 ? "positive" : "negative",
    updatedAt: String(record?.updatedAt ?? record?.createdAt ?? "").slice(5, 10),
  };
}

function completeModel(state, pageSize) {
  const pageCount = Math.max(1, Math.ceil(state.records.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(state.page) || 1));
  const items = state.records.map(listItem);
  const offset = (page - 1) * pageSize;
  return {
    ...state,
    page,
    pageCount,
    pagedItems: items.slice(offset, offset + pageSize),
    analytics: buildTradeRecordAnalytics(state.records),
  };
}

function selectedState(records, requestedId, pageSize) {
  let index = records.findIndex((record) => recordId(record) === String(requestedId ?? ""));
  if (index < 0) index = records.length ? 0 : -1;
  return {
    records,
    page: index >= 0 ? Math.floor(index / pageSize) + 1 : 1,
    selectedId: index >= 0 ? recordId(records[index]) : "",
    selectedRecord: index >= 0 ? records[index] : null,
  };
}

export function reduceTradeRecordArchive(state, action, pageSize = 10) {
  const size = Math.max(1, Number(pageSize) || 10);
  const current = state ?? completeModel({
    records: [],
    page: 1,
    selectedId: "",
    selectedRecord: null,
  }, size);

  if (action?.type === "replace") {
    return completeModel(
      selectedState(sortRecords(action.records ?? []), action.requestedId, size),
      size,
    );
  }

  if (action?.type === "select") {
    return completeModel(
      selectedState(current.records, action.id, size),
      size,
    );
  }

  if (action?.type === "page") {
    return completeModel({ ...current, page: action.page }, size);
  }

  if (action?.type === "accept") {
    const id = recordId(action.record);
    if (!id) return current;
    const existing = current.records.find((record) => recordId(record) === id);
    const accepted = existing ? { ...existing, ...action.record } : action.record;
    const records = sortRecords(existing
      ? current.records.map((record) => recordId(record) === id ? accepted : record)
      : [...current.records, accepted]);
    if (action.select || current.selectedId === id) {
      return completeModel(selectedState(records, id, size), size);
    }
    const selectedRecord = records.find((record) =>
      recordId(record) === current.selectedId
    ) ?? null;
    return completeModel({ ...current, records, selectedRecord }, size);
  }

  if (action?.type === "remove") {
    const removedId = String(action.id ?? "");
    const removedIndex = current.records.findIndex((record) => recordId(record) === removedId);
    if (removedIndex < 0) return current;
    const records = current.records.filter((record) => recordId(record) !== removedId);
    if (current.selectedId !== removedId) {
      return completeModel({ ...current, records }, size);
    }
    const nextIndex = Math.min(removedIndex, records.length - 1);
    const nextId = nextIndex >= 0 ? recordId(records[nextIndex]) : "";
    return completeModel(selectedState(records, nextId, size), size);
  }

  return current;
}

export function useTradeRecordArchive({ pageSize = 10, __test } = {}) {
  const route = __test?.route ?? useRoute();
  const router = __test?.router ?? useRouter();
  const requests = __test?.api ?? api;
  const model = shallowRef(reduceTradeRecordArchive(null, null, pageSize));
  const loading = shallowRef(false);
  const detailLoading = shallowRef(false);
  const errorMessage = shallowRef("");
  let detailRequestSequence = 0;

  function update(action) {
    model.value = reduceTradeRecordArchive(model.value, action, pageSize);
    return model.value;
  }

  function syncRouteSelection(id) {
    if (String(route.query.id ?? "") === id) return;
    const query = { ...route.query };
    if (id) query.id = id;
    else delete query.id;
    void router.replace({ path: "/decision/trade-records", query });
  }

  async function readSelectedDetail() {
    const id = model.value.selectedId;
    if (!id) return { record: null, error: null };
    const sequence = ++detailRequestSequence;
    detailLoading.value = true;
    try {
      const record = extractApiRecord(await requests.getTradeRecord(id));
      if (sequence !== detailRequestSequence || model.value.selectedId !== id) {
        return { record: model.value.selectedRecord, error: null, stale: true };
      }
      update({ type: "accept", record });
      return { record: model.value.selectedRecord, error: null };
    } catch (error) {
      if (sequence !== detailRequestSequence || model.value.selectedId !== id) {
        return { record: model.value.selectedRecord, error: null, stale: true };
      }
      return {
        record: model.value.selectedRecord,
        error: error?.message ?? "交易追踪详情加载失败",
      };
    } finally {
      if (sequence === detailRequestSequence) detailLoading.value = false;
    }
  }

  async function load({ preferredId = "" } = {}) {
    loading.value = true;
    errorMessage.value = "";
    try {
      const payload = await requests.listTradeRecords();
      update({
        type: "replace",
        records: extractItems(payload),
        requestedId: preferredId || String(route.query.id ?? ""),
      });
      syncRouteSelection(model.value.selectedId);
      return await readSelectedDetail();
    } catch (error) {
      detailRequestSequence += 1;
      detailLoading.value = false;
      update({ type: "replace", records: [], requestedId: "" });
      errorMessage.value = error?.message ?? "交易追踪档案库加载失败";
      syncRouteSelection("");
      return { record: null, error: null };
    } finally {
      loading.value = false;
    }
  }

  async function select(id, { syncRoute = true } = {}) {
    update({ type: "select", id });
    if (syncRoute) syncRouteSelection(model.value.selectedId);
    return await readSelectedDetail();
  }

  function setPage(page) {
    update({ type: "page", page });
  }

  function acceptSavedRecord(record, { select = false } = {}) {
    if (select || recordId(record) === model.value.selectedId) {
      detailRequestSequence += 1;
      detailLoading.value = false;
    }
    update({ type: "accept", record, select });
    syncRouteSelection(model.value.selectedId);
    return model.value.selectedRecord;
  }

  async function remove(id) {
    detailRequestSequence += 1;
    detailLoading.value = false;
    update({ type: "remove", id });
    syncRouteSelection(model.value.selectedId);
    return await readSelectedDetail();
  }

  return {
    records: computed(() => model.value.records),
    page: computed(() => model.value.page),
    selectedId: computed(() => model.value.selectedId),
    selectedRecord: computed(() => model.value.selectedRecord),
    loading: readonly(loading),
    detailLoading: readonly(detailLoading),
    errorMessage: readonly(errorMessage),
    pagedItems: computed(() => model.value.pagedItems),
    pageCount: computed(() => model.value.pageCount),
    analytics: computed(() => model.value.analytics),
    load,
    select,
    setPage,
    acceptSavedRecord,
    remove,
  };
}
