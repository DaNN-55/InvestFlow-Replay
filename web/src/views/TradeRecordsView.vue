<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Plus, RefreshCw, Save, Settings2, Trash2 } from "lucide-vue-next";

import ReplayHistoryPanel from "../components/replay-history/ReplayHistoryPanel.vue";
import TradeExecutionEventsPanel from "../components/TradeExecutionEventsPanel.vue";
import TradeExecutionSettingsDrawer from "../components/TradeExecutionSettingsDrawer.vue";
import TradeRecordCreateDrawer from "../components/TradeRecordCreateDrawer.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiCard from "../components/ui/UiCard.vue";
import UiDataTable from "../components/ui/UiDataTable.vue";
import UiInput from "../components/ui/UiInput.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import UiTextarea from "../components/ui/UiTextarea.vue";
import { api } from "../services/api";
import {
  buildDiagnosisSnapshotSections,
  buildTradeReviewOverview,
} from "../utils/tradeRecordPresentation.js";
import { buildTradeRecordAnalytics } from "../utils/tradeRecordAnalytics.js";
import {
  buildTradeRecordDraftSavePayload,
  calculateTradeLicense,
  resolveLegacyTradeRecordPlan,
} from "../utils/tradeLicense.js";

const route = useRoute();
const router = useRouter();
const primaryTab = ref("records");

const editableFields = [
  "accountType",
  "tradeType",
  "status",
  "manualMaxAccountRiskPct",
  "manualMaxPositionPct",
  "validForTradeDate",
  "plannedEntryLow",
  "plannedEntryHigh",
  "triggerPrice",
  "noChasePrice",
  "failurePrice",
  "targetPrice",
  "stopLossPrice",
  "takeProfitPrice",
  "plannedAmount",
  "plannedQuantity",
  "estimatedMaxLossAmount",
  "actualEntryDate",
  "actualEntryPrice",
  "actualEntryQuantity",
  "actualExitDate",
  "actualExitPrice",
  "actualExitQuantity",
  "exitSignalType",
  "exitSignalDate",
  "exitSignalPrice",
  "t1Review",
  "t3Review",
  "t5Review",
  "finalReview",
  "entryNotes",
  "exitReason",
  "violationReason",
];

const accountTypeOptions = [
  { value: "simulated", label: "模拟" },
  { value: "live", label: "实盘" },
];
const tradeTypeOptions = [
  { value: "system", label: "系统交易" },
  { value: "subjective", label: "主观交易" },
  { value: "violation", label: "违规交易" },
];
const statusOptions = [
  { value: "draft", label: "草稿" },
  { value: "planned", label: "买入许可证" },
  { value: "entered", label: "已买入" },
  { value: "holding", label: "持仓复盘" },
  { value: "exited", label: "已卖出" },
  { value: "reviewed", label: "最终复盘" },
  { value: "cancelled", label: "已取消" },
  { value: "expired", label: "已失效" },
];

const records = ref([]);
const selectedId = ref("");
const selectedRecord = ref(null);
const strategyProfile = reactive(createEmptyStrategyProfile());
const executionEvents = ref([]);
const reviewPanelTab = ref("review");
const reviewExpanded = ref(true);
const snapshotExpanded = ref(false);
const form = ref(createEmptyForm());
const loading = ref(false);
const detailLoading = ref(false);
const saving = ref(false);
const deleting = ref(false);
const statusText = ref("");
const errorText = ref("");
const executionSettingsOpen = ref(false);
const createDrawerOpen = ref(false);
const creating = ref(false);
const createErrorText = ref("");
const executionSettings = ref(null);

const tableColumns = [
  {
    key: "stock",
    header: "股票",
    cell: (row) => formatStock(row),
    sortable: true,
    class: "trade-record-table__stock",
    headerClass: "trade-record-table__stock",
  },
  {
    key: "tradeType",
    header: "类型",
    cell: (row) => tradeTypeLabel(row?.tradeType),
    sortable: true,
    class: "trade-record-table__type",
    headerClass: "trade-record-table__type",
  },
  {
    key: "strategy",
    header: "战法",
    cell: (row) => row?.strategyProfile?.name || "未指定",
    sortable: true,
    class: "trade-record-table__strategy",
    headerClass: "trade-record-table__strategy",
  },
  {
    key: "status",
    header: "阶段",
    cell: (row) => statusLabel(row?.status),
    sortable: true,
    class: "trade-record-table__status",
    headerClass: "trade-record-table__status",
  },
  {
    key: "profitPct",
    header: "盈亏比例",
    cell: (row) => formatRecordProfitPct(row),
    class: "trade-record-table__profit",
    headerClass: "trade-record-table__profit",
  },
  { key: "updatedAt", header: "更新", cell: (row) => formatDate(row?.updatedAt || row?.createdAt), sortable: true },
];

const selectedRowKeys = computed(() => (selectedId.value ? [selectedId.value] : []));
const selectedViolations = computed(() => normalizeViolations(selectedRecord.value));
const selectedSnapshot = computed(() =>
  selectedRecord.value?.frozenSnapshot
    ?? selectedRecord.value?.evaluationSnapshot
    ?? selectedRecord.value?.diagnosisSnapshot
    ?? selectedRecord.value?.snapshot
    ?? {},
);
const selectedStage = computed(() => String(form.value.status || selectedRecord.value?.status || ""));
const isLegacyLicense = computed(() => selectedStage.value === "planned" && !selectedRecord.value?.licenseSnapshot);
const isLegacyPositionCap = computed(() =>
  selectedRecord.value != null && !Object.hasOwn(selectedRecord.value, "manualMaxPositionPct"),
);
const legacyTradePlan = computed(() => resolveLegacyTradeRecordPlan(selectedRecord.value));
const selectedMaxPositionPct = computed(() => {
  if (!isLegacyPositionCap.value) {
    const parsed = Number(form.value.manualMaxPositionPct);
    return form.value.manualMaxPositionPct !== "" && Number.isFinite(parsed) ? parsed : null;
  }
  return Number(legacyTradePlan.value.maxPositionPct ?? 0);
});
const selectedMaxAccountRiskPct = computed(() => {
  if (form.value.manualMaxAccountRiskPct === "" || form.value.manualMaxAccountRiskPct == null) {
    return executionSettings.value?.defaultMaxAccountRiskPct ?? null;
  }
  const parsed = Number(form.value.manualMaxAccountRiskPct);
  return Number.isFinite(parsed) ? parsed : null;
});
const selectedAccountRiskSource = computed(() =>
  form.value.manualMaxAccountRiskPct === "" || form.value.manualMaxAccountRiskPct == null
    ? "执行参数默认"
    : "本单手工设置",
);
const diagnosisAllowsLicense = computed(() => !isLegacyPositionCap.value || ![
  "avoid_chasing",
  "reduce_or_exit",
  "insufficient_data",
  "insufficient_evidence",
].includes(String(
  legacyTradePlan.value.action ?? "",
)));
const selectedAccountEquity = computed(() => {
  if (form.value.accountType === "simulated") {
    return executionSettings.value?.simulatedAccountEquity ?? null;
  }
  if (form.value.accountType === "live") {
    return executionSettings.value?.liveAccountEquity ?? null;
  }
  return null;
});
const licensePreview = computed(() => calculateTradeLicense({
  triggerPrice: form.value.triggerPrice,
  failurePrice: form.value.failurePrice,
  targetPrice: form.value.targetPrice,
  accountEquity: selectedAccountEquity.value,
  minRewardRiskRatio: executionSettings.value?.defaultMinRewardRiskRatio,
  maxAccountRiskPct: selectedMaxAccountRiskPct.value,
  maxPositionPct: selectedMaxPositionPct.value,
  lotSize: executionSettings.value?.lotSize ?? 100,
}));
const selectedTradeFlags = computed(() => {
  const flags = [];
  const type = String(form.value.tradeType || selectedRecord.value?.tradeType || "").toLowerCase();
  if (type.includes("subjective") || type.includes("主观") || selectedRecord.value?.isSubjective) {
    flags.push("主观单");
  }
  if (type.includes("violation") || type.includes("违规") || selectedRecord.value?.isViolation || selectedViolations.value.length) {
    flags.push("违规单");
  }
  return flags;
});
const diagnosisSnapshotSections = computed(() =>
  buildDiagnosisSnapshotSections(selectedSnapshot.value, selectedRecord.value),
);
const tradeReviewOverview = computed(() =>
  buildTradeReviewOverview({
    stage: selectedStage.value,
    form: form.value,
    record: selectedRecord.value,
    snapshot: selectedSnapshot.value,
    violations: selectedViolations.value,
  }),
);
const tradeAnalytics = computed(() => buildTradeRecordAnalytics(records.value));
const activeReviewPanelExpanded = computed(() =>
  reviewPanelTab.value === "review" ? reviewExpanded.value : snapshotExpanded.value,
);

function createEmptyForm() {
  return Object.fromEntries(editableFields.map((field) => [field, ""]));
}

function createEmptyStrategyProfile() {
  return {
    key: "",
    name: "",
    version: "",
    summary: "",
    entryRules: "",
    exitRules: "",
    riskRules: "",
  };
}

function normalizeStrategyProfile(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fields = Object.keys(createEmptyStrategyProfile());
  return Object.fromEntries(fields.map((field) => [field, String(source[field] ?? "")]));
}

function normalizeExecutionEvents(value) {
  return Array.isArray(value)
    ? value.filter((event) => event && typeof event === "object").map((event) => ({ ...event }))
    : [];
}

function buildStrategyProfilePayload() {
  if (!strategyProfile.name.trim()) {
    return null;
  }
  return { ...strategyProfile };
}

function extractItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.items ?? payload?.records ?? [];
}

function extractRecord(payload) {
  return payload?.item ?? payload?.record ?? payload ?? null;
}

function hasRecordContent(record) {
  return record && Object.keys(record).length > 0;
}

function recordId(record) {
  return record?.id ?? record?.recordId ?? "";
}

function applyRecordToForm(record) {
  form.value = Object.fromEntries(
    editableFields.map((field) => [field, record?.[field] ?? ""]),
  );
  Object.assign(strategyProfile, normalizeStrategyProfile(record?.strategyProfile));
  executionEvents.value = normalizeExecutionEvents(record?.executionEvents);
}

function buildSavePayload() {
  if (stageIs("draft")) {
    return {
      ...buildTradeRecordDraftSavePayload(form.value, {
        legacyPositionCap: isLegacyPositionCap.value,
      }),
      strategyProfile: buildStrategyProfilePayload(),
      executionEvents: executionEvents.value,
    };
  }
  const fields = ["t1Review", "t3Review", "t5Review", "finalReview", "entryNotes", "exitReason"];
  return Object.fromEntries(
    [
      ...fields.map((field) => {
        const value = form.value[field];
        if (value === "") {
          return [field, null];
        }
        return [field, String(value)];
      }),
      ["executionEvents", executionEvents.value],
    ],
  );
}

function applyUpdatedRecord(record) {
  selectedRecord.value = record;
  applyRecordToForm(record);
  records.value = records.value.map((item) =>
    recordId(item) === recordId(record) ? { ...item, ...record } : item,
  );
}

async function loadExecutionSettings() {
  executionSettings.value = await api.getDecisionExecutionSettings();
}

function formatStock(record) {
  const snapshot = record?.frozenSnapshot ?? record?.evaluationSnapshot ?? record?.snapshot ?? {};
  const code = record?.stockCode ?? snapshot?.stockCode ?? snapshot?.stock?.code ?? "";
  const name = record?.stockName ?? snapshot?.stockName ?? snapshot?.stock?.name ?? "";
  return `${name || "--"} ${code || ""}`.trim();
}

function formatDate(value) {
  if (!value) {
    return "--";
  }
  return String(value).replace("T", " ").slice(0, 16);
}

function formatRange(low, high) {
  if (low == null && high == null) {
    return "--";
  }
  if (low != null && high == null) {
    return String(low);
  }
  if (low == null && high != null) {
    return String(high);
  }
  return `${low ?? "--"} - ${high ?? "--"}`;
}

function optionLabel(options, value) {
  return options.find((option) => option.value === value)?.label || value || "--";
}

function tradeTypeLabel(value) {
  return optionLabel(tradeTypeOptions, value);
}

function statusLabel(value) {
  return optionLabel(statusOptions, value);
}

function accountTypeLabel(value) {
  return optionLabel(accountTypeOptions, value);
}

function stageIs(...stages) {
  return stages.includes(selectedStage.value);
}

function parseTradeNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const normalized = String(value).replace(/,/gu, "").trim();
  const matched = normalized.match(/[-+]?\d+(?:\.\d+)?/u);
  if (!matched) {
    return null;
  }
  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTradePercent(value) {
  const parsed = parseTradeNumber(value);
  if (parsed == null) {
    return "--";
  }
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(2)}%`;
}

function toggleActiveReviewPanel() {
  if (reviewPanelTab.value === "review") {
    reviewExpanded.value = !reviewExpanded.value;
    return;
  }
  snapshotExpanded.value = !snapshotExpanded.value;
}

function formatAnalyticsPercent(value, { signed = false } = {}) {
  if (value == null) return "--";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(2).replace(/\.00$/u, "")}%`;
}

function formatRecordProfitPct(record) {
  const ledgerReturnPct = parseTradeNumber(record?.ledger?.returnPct);
  if (ledgerReturnPct != null && ["open", "closed"].includes(record?.ledger?.state)) {
    return formatTradePercent(ledgerReturnPct);
  }
  const entryPrice = parseTradeNumber(record?.actualEntryPrice);
  const exitPrice = parseTradeNumber(record?.actualExitPrice);
  if (entryPrice == null || exitPrice == null || entryPrice === 0) {
    return "--";
  }
  return formatTradePercent(((exitPrice - entryPrice) / entryPrice) * 100);
}

async function createStandaloneTradeRecord(payload) {
  creating.value = true;
  createErrorText.value = "";
  statusText.value = "";
  errorText.value = "";
  try {
    const record = extractRecord(await api.saveTradeRecord(payload));
    const id = recordId(record);
    createDrawerOpen.value = false;
    updateRouteSelection(id);
    await loadRecords(id);
    statusText.value = "独立交易追踪单已创建";
  } catch (error) {
    createErrorText.value = error?.message ?? "交易追踪单创建失败";
  } finally {
    creating.value = false;
  }
}

function normalizeViolations(record) {
  const raw = record?.violations ?? record?.violationTags ?? record?.riskViolations ?? [];
  if (!Array.isArray(raw)) {
    return raw ? [String(raw)] : [];
  }
  return raw
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      return item?.label ?? item?.name ?? item?.message ?? "";
    })
    .filter(Boolean);
}

function updateRouteSelection(id) {
  const nextQuery = { ...route.query };
  if (id) {
    nextQuery.id = id;
  } else {
    delete nextQuery.id;
  }
  router.replace({
    path: "/decision/trade-records",
    query: nextQuery,
  });
}

async function loadRecords(preferredId = "") {
  loading.value = true;
  errorText.value = "";
  statusText.value = "";
  try {
    const payload = await api.listTradeRecords();
    records.value = extractItems(payload);
    const nextId = preferredId || String(route.query.id || "") || recordId(records.value[0]);
    if (nextId) {
      await selectRecordById(nextId, false);
    } else {
      selectedId.value = "";
      selectedRecord.value = null;
      form.value = createEmptyForm();
      Object.assign(strategyProfile, createEmptyStrategyProfile());
      executionEvents.value = [];
    }
    statusText.value = "交易追踪列表已刷新";
  } catch (error) {
    records.value = [];
    selectedRecord.value = null;
    form.value = createEmptyForm();
    Object.assign(strategyProfile, createEmptyStrategyProfile());
    executionEvents.value = [];
    errorText.value = error?.message ?? "交易追踪列表加载失败";
  } finally {
    loading.value = false;
  }
}

async function selectRecord(row) {
  const id = recordId(row);
  if (!id) {
    return;
  }
  updateRouteSelection(id);
  await selectRecordById(id, true);
}

async function selectRecordById(id, useListFallback = true) {
  selectedId.value = id;
  reviewPanelTab.value = "review";
  reviewExpanded.value = true;
  snapshotExpanded.value = false;
  const fallback = records.value.find((record) => recordId(record) === id) ?? null;
  if (useListFallback && fallback) {
    selectedRecord.value = fallback;
    applyRecordToForm(fallback);
  }
  detailLoading.value = true;
  errorText.value = "";
  try {
    const payload = await api.getTradeRecord(id);
    const record = extractRecord(payload);
    selectedRecord.value = record;
    applyRecordToForm(record);
  } catch (error) {
    if (fallback) {
      selectedRecord.value = fallback;
      applyRecordToForm(fallback);
    } else {
      selectedRecord.value = null;
      form.value = createEmptyForm();
      Object.assign(strategyProfile, createEmptyStrategyProfile());
      executionEvents.value = [];
    }
    errorText.value = error?.message ?? "交易追踪详情加载失败";
  } finally {
    detailLoading.value = false;
  }
}

async function saveSelectedRecord() {
  if (!selectedId.value) {
    errorText.value = "请先选择一条交易追踪单";
    return;
  }
  saving.value = true;
  statusText.value = "";
  errorText.value = "";
  try {
    const savePayload = buildSavePayload();
    const payload = await api.updateTradeRecord(selectedId.value, savePayload);
    const returnedRecord = extractRecord(payload);
    const record = hasRecordContent(returnedRecord) ? {
      ...(selectedRecord.value ?? {}),
      ...returnedRecord,
    } : {
      ...(selectedRecord.value ?? {}),
      ...savePayload,
    };
    applyUpdatedRecord(record);
    statusText.value = "交易追踪单已保存";
  } catch (error) {
    errorText.value = error?.message ?? "交易追踪单保存失败";
  } finally {
    saving.value = false;
  }
}

async function addExecutionEvent(event) {
  if (!selectedId.value) {
    return;
  }
  saving.value = true;
  statusText.value = "";
  errorText.value = "";
  try {
    const record = extractRecord(await api.recordTradeExecutionEvent(selectedId.value, event));
    applyUpdatedRecord(record);
    statusText.value = "动作记录已添加";
  } catch (error) {
    errorText.value = error?.message ?? "动作记录添加失败";
  } finally {
    saving.value = false;
  }
}

async function issueSelectedLicense() {
  if (!selectedId.value || !licensePreview.value.valid || !diagnosisAllowsLicense.value) {
    errorText.value = !diagnosisAllowsLicense.value
      ? "当前诊断结论不允许开仓"
      : licensePreview.value.errors?.[0]?.message ?? "当前计划不能生成许可证";
    return;
  }
  saving.value = true;
  statusText.value = "";
  errorText.value = "";
  try {
    await api.updateTradeRecord(selectedId.value, buildSavePayload());
    const record = extractRecord(await api.issueTradeLicense(selectedId.value));
    applyUpdatedRecord(record);
    statusText.value = "买入许可证已生成";
  } catch (error) {
    errorText.value = error?.message ?? "买入许可证生成失败";
  } finally {
    saving.value = false;
  }
}

async function recordSelectedEntry() {
  saving.value = true;
  statusText.value = "";
  errorText.value = "";
  try {
    const record = extractRecord(await api.recordTradeEntry(selectedId.value, {
      actualEntryDate: form.value.actualEntryDate,
      actualEntryPrice: form.value.actualEntryPrice,
      actualEntryQuantity: form.value.actualEntryQuantity,
    }));
    applyUpdatedRecord(record);
    statusText.value = "合规买入已记录";
  } catch (error) {
    errorText.value = error?.message ?? "买入记录失败";
  } finally {
    saving.value = false;
  }
}

async function recordSelectedViolationEntry() {
  saving.value = true;
  statusText.value = "";
  errorText.value = "";
  try {
    const record = extractRecord(await api.recordViolationEntry(selectedId.value, {
      actualEntryDate: form.value.actualEntryDate,
      actualEntryPrice: form.value.actualEntryPrice,
      actualEntryQuantity: form.value.actualEntryQuantity,
      violationReason: form.value.violationReason,
    }));
    applyUpdatedRecord(record);
    statusText.value = "违规买入已单独记录";
  } catch (error) {
    errorText.value = error?.message ?? "违规买入记录失败";
  } finally {
    saving.value = false;
  }
}

async function cancelSelectedPlan() {
  saving.value = true;
  statusText.value = "";
  errorText.value = "";
  try {
    const record = extractRecord(await api.cancelTradeRecord(selectedId.value));
    applyUpdatedRecord(record);
    statusText.value = "交易计划已取消";
  } catch (error) {
    errorText.value = error?.message ?? "取消计划失败";
  } finally {
    saving.value = false;
  }
}

async function deleteSelectedRecord() {
  if (!selectedId.value || !selectedRecord.value) {
    return;
  }
  if (!window.confirm(`删除 ${formatStock(selectedRecord.value)} 的交易追踪单？`)) {
    return;
  }
  deleting.value = true;
  statusText.value = "";
  errorText.value = "";
  try {
    await api.deleteTradeRecord(selectedId.value);
    records.value = records.value.filter((item) => recordId(item) !== selectedId.value);
    const nextId = recordId(records.value[0]);
    updateRouteSelection(nextId);
    if (nextId) {
      await selectRecordById(nextId, true);
    } else {
      selectedId.value = "";
      selectedRecord.value = null;
      form.value = createEmptyForm();
      Object.assign(strategyProfile, createEmptyStrategyProfile());
      executionEvents.value = [];
    }
    statusText.value = "交易追踪单已删除";
  } catch (error) {
    errorText.value = error?.message ?? "交易追踪单删除失败";
  } finally {
    deleting.value = false;
  }
}

watch(
  () => route.query.id,
  (id) => {
    const nextId = String(id || "");
    if (nextId && nextId !== selectedId.value) {
      void selectRecordById(nextId, true);
    }
  },
);

onMounted(() => {
  void loadRecords();
  void loadExecutionSettings().catch((error) => {
    errorText.value = error?.message ?? "执行参数加载失败";
  });
});
</script>

<template>
  <section class="ql-page trade-records-page">
    <header class="ql-page-header trade-records-page__header">
      <div class="ql-page-heading ql-min-w-0">
        <p class="ql-page-eyebrow">Decision</p>
        <h1 class="ql-page-title">交易追踪</h1>
        <p class="ql-page-description">
          从买入许可证到最终复盘，记录模拟/实盘、系统/主观/违规交易的执行过程。
        </p>
      </div>
      <div v-if="primaryTab === 'records'" class="ql-page-actions">
        <UiButton type="button" size="sm" @click="createErrorText = ''; createDrawerOpen = true">
          <template #prefix><Plus :size="16" /></template>
          新建交易
        </UiButton>
        <UiButton type="button" variant="secondary" size="sm" @click="executionSettingsOpen = true">
          <template #prefix><Settings2 :size="16" /></template>
          执行参数
        </UiButton>
        <UiButton
          type="button"
          variant="secondary"
          size="sm"
          :loading="loading"
          @click="loadRecords(selectedId)"
        >
          <template #prefix><RefreshCw v-if="!loading" :size="16" /></template>
          刷新
        </UiButton>
      </div>
    </header>

    <nav class="trade-records-primary-tabs" aria-label="交易追踪分类">
      <button
        type="button"
        :class="{ 'trade-records-primary-tabs__button--active': primaryTab === 'records' }"
        @click="primaryTab = 'records'"
      >
        实盘与模拟
      </button>
      <button
        type="button"
        :class="{ 'trade-records-primary-tabs__button--active': primaryTab === 'replay' }"
        @click="primaryTab = 'replay'"
      >
        历史演练
      </button>
    </nav>

    <template v-if="primaryTab === 'records'">
      <UiCard class="trade-record-analytics">
      <template #header>
        <div>
          <h2 class="ql-text-base ql-font-semibold ql-text-slate-900">纪律统计</h2>
          <p class="ql-mt-1 ql-text-xs ql-text-slate-500">按逐笔成交账本统计已完成交易；旧记录继续兼容原有买卖价格。</p>
        </div>
      </template>
      <div class="trade-record-analytics__metrics">
        <div><span>已完成</span><strong>{{ tradeAnalytics.summary.completedCount }} 笔</strong></div>
        <div><span>胜率</span><strong>{{ formatAnalyticsPercent(tradeAnalytics.summary.winRatePct) }}</strong></div>
        <div><span>平均盈亏</span><strong>{{ formatAnalyticsPercent(tradeAnalytics.summary.averageProfitPct, { signed: true }) }}</strong></div>
        <div><span>纪律偏差率</span><strong>{{ formatAnalyticsPercent(tradeAnalytics.summary.deviationRatePct) }}</strong></div>
      </div>
      </UiCard>

      <div class="trade-records-layout">
      <UiCard>
        <template #header>
          <div class="ql-flex ql-w-full ql-items-center ql-justify-between ql-gap-3">
            <div>
              <h2 class="ql-text-base ql-font-semibold ql-text-slate-900">追踪列表</h2>
              <p class="ql-mt-1 ql-text-xs ql-text-slate-500">共 {{ records.length }} 条，点击行查看详情。</p>
            </div>
          </div>
        </template>

        <UiDataTable
          class="trade-record-table"
          :rows="records"
          :columns="tableColumns"
          :loading="loading"
          :selected-keys="selectedRowKeys"
          :row-key="recordId"
          min-width="620px"
          empty-text="暂无交易追踪单"
          @row-click="selectRecord"
        />
      </UiCard>

      <UiCard class="trade-record-detail">
        <template #header>
          <div class="ql-flex ql-w-full ql-flex-col ql-gap-3 lg:ql-flex-row lg:ql-items-start lg:ql-justify-between">
            <div class="ql-min-w-0">
              <h2 class="ql-text-base ql-font-semibold ql-text-slate-900">
                {{ selectedRecord ? formatStock(selectedRecord) : "详情表单" }}
              </h2>
              <p class="ql-mt-1 ql-text-xs ql-text-slate-500">
                {{ selectedRecord ? `账户：${accountTypeLabel(form.accountType)} · 阶段：${statusLabel(form.status)}` : "请选择一条交易追踪单" }}
              </p>
            </div>
            <div class="ql-flex ql-flex-wrap ql-gap-2">
              <UiButton
                type="button"
                size="sm"
                :loading="saving"
                :disabled="!selectedRecord || detailLoading"
                @click="saveSelectedRecord"
              >
                <template #prefix><Save v-if="!saving" :size="16" /></template>
                保存
              </UiButton>
              <UiButton
                type="button"
                variant="danger"
                size="sm"
                :loading="deleting"
                :disabled="!selectedRecord || detailLoading"
                @click="deleteSelectedRecord"
              >
                <template #prefix><Trash2 v-if="!deleting" :size="16" /></template>
                删除
              </UiButton>
            </div>
          </div>
        </template>

        <div v-if="detailLoading" class="trade-record-state">正在读取详情...</div>
        <div v-else-if="!selectedRecord" class="trade-record-state">暂无选中的交易追踪单。</div>
        <template v-else>
          <div class="trade-record-tags">
            <span class="trade-record-tag trade-record-tag--neutral">{{ tradeTypeLabel(form.tradeType) }}</span>
            <span
              v-for="flag in selectedTradeFlags"
              :key="flag"
              class="trade-record-tag"
              :class="flag === '违规单' ? 'trade-record-tag--danger' : 'trade-record-tag--warning'"
            >
              {{ flag }}
            </span>
            <span
              v-for="violation in selectedViolations"
              :key="violation"
              class="trade-record-tag trade-record-tag--danger"
            >
              {{ violation }}
            </span>
            <span v-if="!selectedViolations.length" class="trade-record-tag trade-record-tag--muted">无违规标签</span>
          </div>

          <section class="trade-review-panel">
            <div class="trade-review-panel__toolbar">
              <div class="trade-review-panel__tabs" role="tablist" aria-label="交易追踪内容">
                <button
                  type="button"
                  role="tab"
                  :aria-selected="reviewPanelTab === 'review'"
                  :class="{ 'trade-review-panel__tab--active': reviewPanelTab === 'review' }"
                  @click="reviewPanelTab = 'review'"
                >
                  交易复盘
                </button>
                <button
                  type="button"
                  role="tab"
                  :aria-selected="reviewPanelTab === 'snapshot'"
                  :class="{ 'trade-review-panel__tab--active': reviewPanelTab === 'snapshot' }"
                  @click="reviewPanelTab = 'snapshot'"
                >
                  当日诊断快照
                </button>
              </div>
              <button
                type="button"
                class="trade-review-panel__toggle"
                :aria-expanded="activeReviewPanelExpanded"
                @click="toggleActiveReviewPanel"
              >
                {{ activeReviewPanelExpanded ? '收起' : '展开' }}
              </button>
            </div>

            <div v-if="reviewPanelTab === 'review' && reviewExpanded" class="trade-review-overview">
              <header class="trade-review-overview__header">
              <div>
                <h3>{{ tradeReviewOverview.title }}</h3>
                <p>{{ tradeReviewOverview.description }}</p>
              </div>
              </header>

            <div class="trade-review-overview__metrics">
              <div
                v-for="metric in tradeReviewOverview.metrics"
                :key="metric.label"
                class="trade-review-overview__metric"
                :class="`trade-review-overview__metric--${metric.tone}`"
              >
                <span>{{ metric.label }}</span>
                <strong>{{ metric.value }}</strong>
              </div>
            </div>

            <div class="trade-review-overview__grid">
              <section
                v-for="section in tradeReviewOverview.sections"
                :key="section.key"
                class="trade-review-overview__section"
              >
                <h4>{{ section.title }}</h4>
                <dl>
                  <div v-for="row in section.rows" :key="`${section.key}-${row.label}`">
                    <dt>{{ row.label }}</dt>
                    <dd :class="row.tone ? `trade-review-overview__value--${row.tone}` : ''">{{ row.value }}</dd>
                  </div>
                </dl>
              </section>
            </div>

            <section class="trade-review-overview__section trade-review-overview__section--wide">
              <h4>过程复盘</h4>
              <div v-if="tradeReviewOverview.processNotes.length" class="trade-review-overview__notes">
                <article v-for="note in tradeReviewOverview.processNotes" :key="note.label">
                  <span>{{ note.label }}</span>
                  <p>{{ note.value }}</p>
                </article>
              </div>
              <p v-else class="trade-review-overview__empty">暂无过程复盘内容。</p>
            </section>

            <section v-if="tradeReviewOverview.violations.length" class="trade-review-overview__section trade-review-overview__section--wide">
              <h4>纪律偏差</h4>
              <div class="trade-review-overview__tags">
                <span v-for="violation in tradeReviewOverview.violations" :key="violation">
                  {{ violation }}
                </span>
              </div>
            </section>
            </div>

            <div v-else-if="reviewPanelTab === 'snapshot' && snapshotExpanded" class="trade-record-diagnosis">
              <p class="trade-record-diagnosis__summary">候选来源、模式判断、个股证据与诊断结论</p>
              <div class="trade-record-diagnosis__grid">
                <section
                  v-for="section in diagnosisSnapshotSections"
                  :key="section.key"
                  class="trade-record-diagnosis__section"
                  :class="`trade-record-diagnosis__section--${section.key}`"
                >
                  <h3>{{ section.title }}</h3>
                  <dl v-if="section.items.length">
                    <div v-for="item in section.items" :key="item.label">
                      <dt>{{ item.label }}</dt>
                      <dd>{{ item.value }}</dd>
                    </div>
                  </dl>
                  <ul v-if="section.notes.length">
                    <li v-for="note in section.notes" :key="note">{{ note }}</li>
                  </ul>
                  <p v-if="!section.items.length && !section.notes.length" class="trade-record-diagnosis__empty">--</p>
                </section>
              </div>
            </div>
          </section>

          <form class="trade-record-form" @submit.prevent="saveSelectedRecord">
            <section class="trade-record-form__section">
              <h3>基本信息</h3>
              <div class="trade-record-form__grid trade-record-form__grid--three">
                <label>
                  <span>账户类型</span>
                  <UiSelect v-model="form.accountType" size="sm" :disabled="!stageIs('draft')">
                    <option value="">未设置</option>
                    <option v-for="option in accountTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </UiSelect>
                </label>
                <label>
                  <span>交易类型</span>
                  <UiSelect v-model="form.tradeType" size="sm" :disabled="!stageIs('draft')">
                    <option value="">未设置</option>
                    <option v-for="option in tradeTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </UiSelect>
                </label>
                <label>
                  <span>当前阶段</span>
                  <div class="trade-record-readonly">{{ statusLabel(form.status) }}</div>
                </label>
              </div>
            </section>

            <TradeExecutionEventsPanel
              :events="executionEvents"
              :ledger="selectedRecord?.ledger"
              :saving="saving"
              :disabled="!selectedId"
              @add="addExecutionEvent"
            />

            <section v-if="stageIs('draft')" class="trade-record-form__section">
              <h3>决策草稿</h3>
              <div class="trade-record-form__grid trade-record-form__grid--four">
                <label>
                  <span>单笔风险预算（%）</span>
                  <UiInput v-model="form.manualMaxAccountRiskPct" size="sm" type="text" inputmode="decimal" placeholder="留空使用执行参数" />
                  <small class="trade-record-form__hint">
                    {{ selectedAccountRiskSource }}：{{ selectedMaxAccountRiskPct ?? '--' }}%
                  </small>
                </label>
                <label>
                  <span>单票最大仓位（%）</span>
                  <UiInput v-model="form.manualMaxPositionPct" size="sm" type="text" inputmode="decimal" placeholder="必填，0-100" />
                </label>
                <label>
                  <span>计划交易日</span>
                  <UiInput v-model="form.validForTradeDate" size="sm" type="date" />
                </label>
                <label>
                  <span>触发价 T</span>
                  <UiInput v-model="form.triggerPrice" size="sm" type="text" inputmode="decimal" />
                </label>
                <label>
                  <span>失败价 S</span>
                  <UiInput v-model="form.failurePrice" size="sm" type="text" inputmode="decimal" />
                </label>
                <label>
                  <span>目标价 G</span>
                  <UiInput v-model="form.targetPrice" size="sm" type="text" inputmode="decimal" />
                </label>
              </div>
              <dl v-if="licensePreview.valid" class="trade-license-metrics">
                <div><dt>单笔风险预算</dt><dd>{{ selectedMaxAccountRiskPct }}% / {{ licensePreview.riskBudgetAmount }}</dd></div>
                <div><dt>允许买入区间</dt><dd>{{ formatRange(licensePreview.plannedEntryLow, licensePreview.plannedEntryHigh) }}</dd></div>
                <div><dt>不追价</dt><dd>{{ licensePreview.noChasePrice }}</dd></div>
                <div><dt>止损 / 止盈</dt><dd>{{ licensePreview.stopLossPrice }} / {{ licensePreview.takeProfitPrice }}</dd></div>
                <div><dt>建议股数</dt><dd>{{ licensePreview.plannedQuantity }} 股</dd></div>
                <div><dt>计划金额</dt><dd>{{ licensePreview.plannedAmount }}</dd></div>
                <div><dt>预计最大亏损</dt><dd>{{ licensePreview.estimatedMaxLossAmount }}</dd></div>
              </dl>
              <ul v-else class="trade-license-checks">
                <li v-for="item in licensePreview.errors" :key="item.code">{{ item.message }}</li>
              </ul>
              <ul v-if="!diagnosisAllowsLicense" class="trade-license-checks">
                <li>当前诊断结论不允许开仓，不能生成买入许可证。</li>
              </ul>
              <div class="trade-record-form__grid trade-record-form__grid--one trade-record-form__grid--spaced">
                <label>
                  <span>结构判断备注</span>
                  <UiTextarea v-model="form.entryNotes" />
                </label>
              </div>
              <div class="trade-license-actions">
                <UiButton type="button" variant="secondary" :loading="saving" @click="saveSelectedRecord">保存草稿</UiButton>
                <UiButton type="button" :loading="saving" :disabled="!licensePreview.valid || !diagnosisAllowsLicense" @click="issueSelectedLicense">生成买入许可证</UiButton>
                <UiButton type="button" variant="danger" :disabled="saving" @click="cancelSelectedPlan">取消计划</UiButton>
              </div>
            </section>

            <section v-else-if="stageIs('planned')" class="trade-record-form__section">
              <h3>买入许可证</h3>
              <div v-if="isLegacyLicense" class="trade-license-legacy">
                这是旧版计划，缺少许可证快照，不能直接记录为系统买入。请复制诊断信息创建新草稿。
              </div>
              <dl class="trade-license-metrics">
                <div><dt>允许买入区间</dt><dd>{{ formatRange(form.plannedEntryLow, form.plannedEntryHigh) }}</dd></div>
                <div><dt>超过即不追</dt><dd>{{ form.noChasePrice || '--' }}</dd></div>
                <div><dt>失败全仓止损</dt><dd>{{ form.stopLossPrice || '--' }}</dd></div>
                <div><dt>目标全仓止盈</dt><dd>{{ form.takeProfitPrice || '--' }}</dd></div>
                <div><dt>建议股数</dt><dd>{{ form.plannedQuantity || '--' }} 股</dd></div>
                <div><dt>计划金额</dt><dd>{{ form.plannedAmount || '--' }}</dd></div>
              </dl>
              <div class="trade-record-form__grid trade-record-form__grid--three">
                <label>
                  <span>买入日期</span>
                  <UiInput v-model="form.actualEntryDate" size="sm" type="date" />
                </label>
                <label>
                  <span>买入价格</span>
                  <UiInput v-model="form.actualEntryPrice" size="sm" type="text" />
                </label>
                <label>
                  <span>买入数量</span>
                  <UiInput v-model="form.actualEntryQuantity" size="sm" type="text" />
                </label>
              </div>
              <div class="trade-license-actions">
                <UiButton type="button" :loading="saving" :disabled="isLegacyLicense" @click="recordSelectedEntry">记录合规买入</UiButton>
                <UiButton type="button" variant="danger" :disabled="saving" @click="cancelSelectedPlan">取消计划</UiButton>
              </div>
            </section>

            <template v-else-if="stageIs('entered', 'holding')"></template>

            <section v-else-if="stageIs('exited')" class="trade-record-form__section">
              <h3>已卖出</h3>
              <div class="trade-record-form__grid trade-record-form__grid--three">
                <label>
                  <span>卖出日期</span>
                  <UiInput v-model="form.actualExitDate" size="sm" type="date" />
                </label>
                <label>
                  <span>卖出价格</span>
                  <UiInput v-model="form.actualExitPrice" size="sm" type="text" />
                </label>
                <label>
                  <span>卖出数量</span>
                  <UiInput v-model="form.actualExitQuantity" size="sm" type="text" />
                </label>
              </div>
              <div class="trade-record-form__grid trade-record-form__grid--one trade-record-form__grid--spaced">
                <label>
                  <span>卖出原因</span>
                  <UiTextarea v-model="form.exitReason" />
                </label>
              </div>
            </section>

            <section v-else-if="stageIs('reviewed')" class="trade-record-form__section">
              <h3>最终复盘</h3>
              <dl class="trade-record-final-summary">
                <div>
                  <dt>买入</dt>
                  <dd>{{ formatDate(form.actualEntryDate) }} · {{ form.actualEntryPrice || "--" }} · {{ form.actualEntryQuantity || "--" }} 股</dd>
                </div>
                <div>
                  <dt>卖出</dt>
                  <dd>{{ formatDate(form.actualExitDate) }} · {{ form.actualExitPrice || "--" }} · {{ form.actualExitQuantity || "--" }} 股</dd>
                </div>
                <div>
                  <dt>卖出原因</dt>
                  <dd>{{ form.exitReason || "--" }}</dd>
                </div>
              </dl>
              <div class="trade-record-form__grid trade-record-form__grid--one trade-record-form__grid--spaced">
                <label>
                  <span>最终复盘</span>
                  <UiTextarea v-model="form.finalReview" />
                </label>
              </div>
            </section>

            <section v-else-if="stageIs('cancelled')" class="trade-record-form__section">
              <h3>已取消</h3>
              <div class="trade-record-form__grid trade-record-form__grid--one">
                <label>
                  <span>取消 / 买入备注</span>
                  <UiTextarea v-model="form.entryNotes" />
                </label>
              </div>
            </section>

            <section v-else class="trade-record-form__section">
              <h3>阶段表单</h3>
              <div class="trade-record-stage-hint">
                请先设置当前阶段，再填写对应阶段的交易信息。
              </div>
            </section>

            <details v-if="stageIs('draft', 'planned', 'expired')" class="trade-record-form__section trade-violation-entry">
              <summary>记录系统外违规买入</summary>
              <p>此入口不会补发许可证，记录会永久标记为违规交易。</p>
              <div class="trade-record-form__grid trade-record-form__grid--three">
                <label><span>实际买入日期</span><UiInput v-model="form.actualEntryDate" size="sm" type="date" /></label>
                <label><span>实际买入价格</span><UiInput v-model="form.actualEntryPrice" size="sm" type="number" min="0" step="0.01" /></label>
                <label><span>实际买入数量</span><UiInput v-model="form.actualEntryQuantity" size="sm" type="number" min="0" step="100" /></label>
              </div>
              <label class="trade-violation-entry__reason">
                <span>违规原因</span>
                <UiTextarea v-model="form.violationReason" />
              </label>
              <UiButton type="button" variant="danger" :loading="saving" @click="recordSelectedViolationEntry">确认记录违规买入</UiButton>
            </details>
          </form>
        </template>

        <div v-if="statusText" class="trade-record-message trade-record-message--success">{{ statusText }}</div>
        <div v-if="errorText" class="trade-record-message trade-record-message--error">{{ errorText }}</div>
      </UiCard>
      </div>
      <TradeExecutionSettingsDrawer
        :open="executionSettingsOpen"
        @close="executionSettingsOpen = false"
        @saved="(settings) => { executionSettings = settings; executionSettingsOpen = false; }"
      />
      <TradeRecordCreateDrawer
        :open="createDrawerOpen"
        :saving="creating"
        :error="createErrorText"
        @close="createDrawerOpen = false"
        @create="createStandaloneTradeRecord"
      />
    </template>
    <ReplayHistoryPanel v-else />
  </section>
</template>

<style scoped>
.trade-records-page {
  width: 100%;
}

.trade-records-page__header {
  align-items: flex-start;
}

.trade-records-primary-tabs {
  border-bottom: 1px solid rgba(15, 23, 42, 0.1);
  display: flex;
  gap: 0.25rem;
}

.trade-records-primary-tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--ql-color-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 800;
  margin-bottom: -1px;
  padding: 0.75rem 1rem;
}

.trade-records-primary-tabs button:hover {
  color: var(--ql-color-text-body);
}

.trade-records-primary-tabs .trade-records-primary-tabs__button--active {
  border-bottom-color: #2563eb;
  color: #1d4ed8;
}

.trade-records-layout {
  display: grid;
  grid-template-columns: minmax(240px, 0.58fr) minmax(620px, 1.42fr);
  gap: 1rem;
}

.trade-record-detail {
  min-width: 0;
}

.trade-record-readonly {
  align-items: center;
  background: var(--ql-color-bg-muted);
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  color: var(--ql-color-text-body);
  display: flex;
  min-height: 2rem;
  padding: 0 0.625rem;
}

.trade-license-metrics {
  display: grid;
  gap: 0.625rem;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 1rem;
}

.trade-license-metrics div {
  background: var(--ql-color-bg-muted);
  border: 1px solid #e2e8f0;
  border-radius: 0.625rem;
  padding: 0.75rem;
}

.trade-license-metrics dt {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
}

.trade-license-metrics dd {
  color: var(--ql-color-text-strong);
  font-size: 0.875rem;
  font-weight: 700;
  margin-top: 0.25rem;
}

.trade-license-checks {
  color: #b91c1c;
  display: grid;
  font-size: 0.75rem;
  gap: 0.35rem;
  margin: 1rem 0 0;
  padding-left: 1.25rem;
}

.trade-license-legacy {
  background: var(--ql-color-warning-soft);
  border: 1px solid #fde68a;
  border-radius: 0.5rem;
  color: #92400e;
  font-size: 0.75rem;
  line-height: 1.6;
  margin-top: 0.75rem;
  padding: 0.75rem;
}

.trade-license-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1rem;
}

.trade-record-analytics__metrics {
  display: grid;
  gap: 0.75rem;
}

.trade-record-analytics__metrics {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.trade-record-analytics__metrics > div {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 0.5rem;
}

.trade-record-analytics__metrics > div {
  background: var(--ql-color-bg-muted);
  padding: 0.75rem;
}

.trade-record-analytics__metrics span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
}

.trade-record-analytics__metrics strong {
  color: var(--ql-color-text-strong);
  display: block;
  font-size: 1.125rem;
  margin-top: 0.25rem;
}

.trade-violation-entry {
  margin-top: 1rem;
}

.trade-violation-entry summary {
  color: #b91c1c;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 700;
}

.trade-violation-entry p {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  margin: 0.75rem 0;
}

.trade-violation-entry__reason {
  display: grid;
  gap: 0.375rem;
  margin: 0.75rem 0;
}

.trade-record-table :deep(.trade-record-table__stock) {
  max-width: 110px;
  min-width: 110px;
  width: 110px;
}

.trade-record-table :deep(.trade-record-table__profit) {
  max-width: 85px;
  min-width: 85px;
  width: 85px;
}

.trade-record-table :deep(.trade-record-table__type) {
  min-width: 6.25rem;
}

.trade-record-table :deep(.trade-record-table__status) {
  min-width: 6.75rem;
}

.trade-record-table :deep(.ql-ui-data-table__header-cell) {
  padding-bottom: 0.625rem;
  padding-top: 0.625rem;
  vertical-align: middle;
}

.trade-record-table :deep(.ql-ui-data-table__sort-button) {
  min-height: 0;
}

.trade-record-table :deep(.ql-ui-data-table__cell) {
  vertical-align: middle;
}

.trade-record-state {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: var(--ql-color-bg-muted);
  color: var(--ql-color-text-muted);
  font-size: 0.875rem;
  padding: 1rem;
}

.trade-record-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-bottom: 0.75rem;
}

.trade-record-tag {
  border: 1px solid transparent;
  display: inline-flex;
  align-items: center;
  border-radius: 0.5rem;
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 800;
}

.trade-record-tag--neutral {
  background: var(--ql-color-primary-soft);
  border-color: #bfdbfe;
  color: #1e3a8a;
}

.trade-record-tag--warning {
  background: var(--ql-color-warning-soft);
  border-color: #fdba74;
  color: #92400e;
}

.trade-record-tag--danger {
  background: var(--ql-color-danger-soft);
  border-color: #fda4af;
  color: #9f1239;
}

.trade-record-tag--muted {
  background: var(--ql-color-bg-muted-strong);
  border-color: #cbd5e1;
  color: var(--ql-color-text-muted);
}

.trade-review-panel {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: var(--ql-color-bg-surface-strong);
  margin-bottom: 0.75rem;
  overflow: hidden;
}

.trade-review-panel__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  background: var(--ql-color-bg-muted);
  padding: 0.375rem 0.5rem;
}

.trade-review-panel__tabs {
  display: flex;
  gap: 0.25rem;
}

.trade-review-panel__tabs button {
  border: 1px solid transparent;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--ql-color-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 800;
  padding: 0.45rem 0.75rem;
}

.trade-review-panel__tabs button:hover {
  background: #eef2f7;
  color: var(--ql-color-text-body);
}

.trade-review-panel__tabs .trade-review-panel__tab--active {
  border-color: #bfdbfe;
  background: var(--ql-color-primary-soft);
  color: #1d4ed8;
}

.trade-review-panel__toggle {
  border: 0;
  background: transparent;
  color: var(--ql-color-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 800;
  padding: 0.45rem 0.625rem;
}

.trade-review-panel__toggle:hover {
  color: #1d4ed8;
}

.trade-record-diagnosis {
  padding: 1rem;
}

.trade-record-diagnosis__summary {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
  margin: 0;
}

.trade-record-diagnosis summary {
  align-items: center;
  color: var(--ql-color-text-strong);
  cursor: pointer;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  list-style: none;
}

.trade-record-diagnosis summary::-webkit-details-marker {
  display: none;
}

.trade-record-diagnosis summary span {
  font-size: 0.875rem;
  font-weight: 800;
}

.trade-record-diagnosis summary small {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
}

.trade-record-diagnosis__grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 0.75rem;
}

.trade-record-diagnosis__section {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: var(--ql-color-bg-surface-strong);
  min-width: 0;
  padding: 0.75rem;
}

.trade-record-diagnosis__section h3 {
  color: var(--ql-color-text-strong);
  font-size: 0.8125rem;
  font-weight: 800;
  margin-bottom: 0.5rem;
}

.trade-record-diagnosis__section dl {
  display: grid;
  gap: 0.375rem;
}

.trade-record-diagnosis__section dl div {
  display: grid;
  gap: 0.25rem;
  grid-template-columns: 4.5rem minmax(0, 1fr);
}

.trade-record-diagnosis__section dt {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.trade-record-diagnosis__section dd,
.trade-record-diagnosis__section li,
.trade-record-diagnosis__empty {
  color: var(--ql-color-text-body);
  font-size: 0.75rem;
  line-height: 1.5;
  min-width: 0;
  overflow-wrap: anywhere;
}

.trade-record-diagnosis__section dd {
  font-weight: 700;
}

.trade-record-diagnosis__section ul {
  display: grid;
  gap: 0.25rem;
  list-style: disc;
  margin-top: 0.5rem;
  padding-left: 1rem;
}

.trade-review-overview {
  display: grid;
  gap: 0.875rem;
  padding: 1rem;
}

.trade-review-overview__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  list-style: none;
}

.trade-review-overview__header h3 {
  color: var(--ql-color-text-strong);
  font-size: 0.9375rem;
  font-weight: 800;
}

.trade-review-overview__header p {
  margin-top: 0.25rem;
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.trade-review-overview__metrics {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 0.375rem;
}

.trade-review-overview__metric {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: var(--ql-color-bg-muted);
  padding: 0.75rem;
}

.trade-review-overview__metric span {
  display: block;
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.trade-review-overview__metric strong {
  display: block;
  margin-top: 0.25rem;
  color: var(--ql-color-text-strong);
  font-size: 1rem;
  font-weight: 800;
  overflow-wrap: anywhere;
}

.trade-review-overview__metric--positive {
  background: var(--ql-color-success-soft);
  border-color: #bbf7d0;
}

.trade-review-overview__metric--positive strong {
  color: #047857;
}

.trade-review-overview__metric--negative {
  background: var(--ql-color-danger-soft);
  border-color: #fecdd3;
}

.trade-review-overview__metric--negative strong {
  color: #be123c;
}

.trade-review-overview__grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 0.125rem;
}

.trade-review-overview__section {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: var(--ql-color-bg-muted);
  padding: 0.75rem;
}

.trade-review-overview__section--wide {
  background: var(--ql-color-bg-surface-strong);
}

.trade-review-overview__section h4 {
  color: var(--ql-color-text-strong);
  font-size: 0.8125rem;
  font-weight: 800;
  margin-bottom: 0.625rem;
}

.trade-review-overview__section dl {
  display: grid;
  gap: 0.5rem;
}

.trade-review-overview__section dl div {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  gap: 0.5rem;
}

.trade-review-overview__section dt,
.trade-review-overview__notes span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.trade-review-overview__section dd,
.trade-review-overview__notes p,
.trade-review-overview__empty {
  color: var(--ql-color-text-body);
  font-size: 0.75rem;
  font-weight: 650;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.trade-review-overview__value--positive {
  color: #047857 !important;
}

.trade-review-overview__value--negative {
  color: #be123c !important;
}

.trade-review-overview__notes {
  display: grid;
  gap: 0.625rem;
}

.trade-review-overview__notes article {
  border-radius: 8px;
  background: var(--ql-color-bg-muted);
  padding: 0.625rem 0.75rem;
}

.trade-review-overview__notes p {
  margin-top: 0.25rem;
  white-space: pre-wrap;
}

.trade-review-overview__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.trade-review-overview__tags span {
  border-radius: 999px;
  background: #ffe4e6;
  color: #be123c;
  font-size: 0.75rem;
  font-weight: 800;
  padding: 0.25rem 0.625rem;
}

.trade-record-form {
  display: grid;
  gap: 0.75rem;
}

.trade-record-form__section {
  border-top: 1px solid rgba(15, 23, 42, 0.08);
  padding-top: 0.75rem;
}

.trade-record-form__section h3 {
  color: var(--ql-color-text-strong);
  font-size: 0.875rem;
  font-weight: 800;
  margin-bottom: 0.5rem;
}

.trade-record-form__grid {
  display: grid;
  gap: 0.5rem;
}

.trade-record-form__grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.trade-record-form__grid--one {
  grid-template-columns: 1fr;
}

.trade-record-form__grid--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.trade-record-form__grid--four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.trade-record-form__grid--spaced {
  margin-top: 0.5rem;
}

.trade-record-form label {
  display: grid;
  gap: 0.25rem;
}

.trade-record-form label > span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.trade-record-form__hint {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
  line-height: 1.4;
}

.trade-record-form :deep(textarea) {
  min-height: 68px;
  font-size: 0.8125rem;
}

.trade-record-final-summary {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.trade-record-final-summary div,
.trade-record-stage-hint {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: var(--ql-color-bg-muted);
  padding: 0.75rem;
}

.trade-record-final-summary dt {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.trade-record-final-summary dd {
  color: var(--ql-color-text-strong);
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1.5;
  margin-top: 0.25rem;
  overflow-wrap: anywhere;
}

.trade-record-stage-hint {
  color: var(--ql-color-text-muted);
  font-size: 0.875rem;
  font-weight: 700;
}

.trade-record-message {
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 700;
  margin-top: 1rem;
  padding: 0.75rem 1rem;
}

.trade-record-message--success {
  background: var(--ql-color-success-soft);
  color: #047857;
}

.trade-record-message--error {
  background: var(--ql-color-danger-soft);
  color: #be123c;
}

@media (max-width: 1180px) {
  .trade-records-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .trade-record-diagnosis__grid,
  .trade-record-analytics__metrics,
  .trade-review-overview__metrics,
  .trade-review-overview__grid,
  .trade-record-final-summary,
  .trade-record-form__grid--two,
  .trade-record-form__grid--three,
  .trade-record-form__grid--four {
    grid-template-columns: 1fr;
  }

  .trade-review-overview__section dl div {
    grid-template-columns: 1fr;
  }

  .trade-record-diagnosis summary {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
