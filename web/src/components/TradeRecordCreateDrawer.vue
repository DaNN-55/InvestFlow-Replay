<script setup>
import { computed, onBeforeUnmount, reactive, shallowRef, watch } from "vue";

import { api } from "../services/api";
import { buildStandaloneTradeRecordPayload } from "../utils/tradeRecordPresentation.js";
import TradeRecordStrategyPicker from "./TradeRecordStrategyPicker.vue";
import UiButton from "./ui/UiButton.vue";
import UiDrawer from "./ui/UiDrawer.vue";
import UiInput from "./ui/UiInput.vue";
import UiSelect from "./ui/UiSelect.vue";

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  saving: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: "",
  },
  mode: {
    type: String,
    default: "create",
  },
  initialValues: {
    type: Object,
    default: () => ({}),
  },
});

const emit = defineEmits(["close", "create", "update"]);

const form = reactive(createEmptyForm());
const stockQuery = shallowRef("");
const candidates = shallowRef([]);
const candidatesOpen = shallowRef(false);
const lookupLoading = shallowRef(false);
const lookupError = shallowRef("");
const playbooks = shallowRef([]);
const playbooksLoading = shallowRef(false);
const playbooksError = shallowRef("");
const creatingPlaybook = shallowRef(false);
const strategyError = shallowRef("");
const strategyDraft = shallowRef(createEmptyStrategyDraft());
const legacyStrategyAvailable = shallowRef(false);
const isEditMode = computed(() => props.mode === "edit");
const drawerTitle = computed(() => isEditMode.value ? "修改交易追踪" : "新建交易追踪");
const drawerDescription = computed(() => isEditMode.value
  ? "修改当前交易的标的、分类和战法信息。"
  : "不依赖市场扫描或个股诊断，先建一笔交易，再按实际发生逐笔记录。");
let searchTimer = 0;
let searchVersion = 0;
let playbookRequestVersion = 0;
let selectedQuery = "";

function createEmptyForm() {
  return {
    stockCode: "",
    stockName: "",
    accountType: "simulated",
    tradeType: "system",
  };
}

function createEmptyStrategyDraft() {
  return {
    mode: "none",
    playbookId: "",
    name: "",
    version: "",
    content: "",
    changeSummary: "",
  };
}

function resetForm() {
  const initial = props.initialValues ?? {};
  const strategy = isEditMode.value ? initial.strategyProfile ?? {} : {};
  Object.assign(form, createEmptyForm(), isEditMode.value ? {
    stockCode: String(initial.stockCode ?? ""),
    stockName: String(initial.stockName ?? ""),
    accountType: String(initial.accountType ?? "simulated"),
    tradeType: String(initial.tradeType ?? "system"),
  } : {});
  strategyDraft.value = strategy?.name
    ? {
        ...createEmptyStrategyDraft(),
        mode: "legacy",
        name: String(strategy.name ?? ""),
        version: String(strategy.version ?? ""),
      }
    : createEmptyStrategyDraft();
  legacyStrategyAvailable.value = strategyDraft.value.mode === "legacy";
  selectedQuery = form.stockCode
    ? `${form.stockName ? `${form.stockName} ` : ""}${form.stockCode}`
    : "";
  stockQuery.value = selectedQuery;
  candidates.value = [];
  candidatesOpen.value = false;
  lookupError.value = "";
  strategyError.value = "";
}

async function loadPlaybooks() {
  const requestVersion = ++playbookRequestVersion;
  playbooksLoading.value = true;
  playbooksError.value = "";
  try {
    const result = await api.listReplayPlaybooks();
    if (requestVersion !== playbookRequestVersion) return;
    playbooks.value = Array.isArray(result?.items) ? result.items : [];
    const strategy = isEditMode.value ? props.initialValues?.strategyProfile ?? {} : {};
    const matched = playbooks.value.find((item) => item.id === strategy.key);
    if (matched) {
      strategyDraft.value = {
        ...createEmptyStrategyDraft(),
        mode: "library",
        playbookId: matched.id,
      };
    }
  } catch (error) {
    if (requestVersion === playbookRequestVersion) {
      playbooks.value = [];
      playbooksError.value = error?.message ?? "战法库加载失败";
    }
  } finally {
    if (requestVersion === playbookRequestVersion) playbooksLoading.value = false;
  }
}

function selectCandidate(item) {
  const code = String(item?.code ?? "").trim();
  const name = String(item?.name ?? "").trim();
  if (!/^\d{6}$/u.test(code) || !name) return;
  form.stockCode = code;
  form.stockName = name;
  selectedQuery = `${name} ${code}`;
  stockQuery.value = selectedQuery;
  candidates.value = [];
  candidatesOpen.value = false;
  lookupError.value = "";
}

function closeCandidates() {
  window.setTimeout(() => {
    candidatesOpen.value = false;
  }, 120);
}

function selectedPlaybookProfile() {
  const selected = playbooks.value.find((item) => item.id === strategyDraft.value.playbookId);
  if (!selected) return null;
  const versionNumber = Number(selected.currentVersion?.versionNumber ?? 1);
  const initialStrategy = isEditMode.value ? props.initialValues?.strategyProfile ?? {} : {};
  const version = initialStrategy.key === selected.id && initialStrategy.version
    ? String(initialStrategy.version)
    : `v${versionNumber}`;
  return {
    key: selected.id,
    name: selected.name,
    version,
  };
}

async function strategyProfileForSubmit() {
  const draft = strategyDraft.value;
  if (draft.mode === "none") return null;
  if (draft.mode === "library") return selectedPlaybookProfile();
  if (draft.mode === "legacy") {
    return { key: "custom", name: draft.name, version: draft.version };
  }
  creatingPlaybook.value = true;
  try {
    const result = await api.createReplayPlaybook({
      name: String(draft.name ?? "").trim(),
      content: String(draft.content ?? "").trim(),
      changeSummary: String(draft.changeSummary ?? "").trim(),
    });
    const created = result?.playbook;
    return {
      key: String(created?.id ?? ""),
      name: String(created?.name ?? draft.name).trim(),
      version: `v${Number(created?.currentVersion?.versionNumber ?? 1)}`,
    };
  } finally {
    creatingPlaybook.value = false;
  }
}

const strategySelectionReady = computed(() => {
  const draft = strategyDraft.value;
  if (draft.mode === "none") return true;
  if (draft.mode === "library") return Boolean(selectedPlaybookProfile());
  if (draft.mode === "legacy") return Boolean(String(draft.name ?? "").trim());
  return Boolean(
    String(draft.name ?? "").trim() &&
    String(draft.changeSummary ?? "").trim() &&
    String(draft.content ?? "").length <= 12000,
  );
});

async function submit() {
  if (!form.stockCode.trim()) return;
  strategyError.value = "";
  let strategyProfile;
  try {
    strategyProfile = await strategyProfileForSubmit();
  } catch (error) {
    strategyError.value = error?.message ?? "战法创建失败";
    return;
  }
  const payload = buildStandaloneTradeRecordPayload({
    stockCode: form.stockCode,
    stockName: form.stockName,
    accountType: form.accountType,
    tradeType: form.tradeType,
    strategyProfile,
  });
  if (isEditMode.value) {
    const { status: _status, ...updates } = payload;
    emit("update", {
      ...updates,
      strategyProfile: updates.strategyProfile ? {
        key: updates.strategyProfile.key,
        name: updates.strategyProfile.name,
        version: updates.strategyProfile.version,
      } : null,
    });
    return;
  }
  emit("create", payload);
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      resetForm();
      loadPlaybooks();
    } else {
      playbookRequestVersion += 1;
    }
  },
);

watch(stockQuery, (value) => {
  window.clearTimeout(searchTimer);
  searchVersion += 1;
  const query = String(value ?? "").trim();
  if (query === selectedQuery) return;
  form.stockCode = "";
  form.stockName = "";
  candidates.value = [];
  candidatesOpen.value = false;
  lookupError.value = "";
  if (query.length < 2) return;
  const version = searchVersion;
  searchTimer = window.setTimeout(async () => {
    lookupLoading.value = true;
    try {
      const result = await api.searchDecisionStocks(query);
      if (version !== searchVersion || String(stockQuery.value ?? "").trim() !== query) return;
      candidates.value = Array.isArray(result?.items) ? result.items : [];
      candidatesOpen.value = candidates.value.length > 0;
      lookupError.value = candidates.value.length ? "" : "未找到匹配股票";
    } catch (error) {
      if (version !== searchVersion) return;
      lookupError.value = error?.message ?? "股票查询失败";
    } finally {
      if (version === searchVersion) lookupLoading.value = false;
    }
  }, 260);
});

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer);
});
</script>

<template>
  <UiDrawer
    :open="open"
    :title="drawerTitle"
    :description="drawerDescription"
    panel-class="trade-record-create-drawer"
    @close="emit('close')"
  >
    <form class="trade-record-create" @submit.prevent="submit">
      <section>
        <h3>标的</h3>
        <div class="trade-record-create__stock-lookup">
          <label>
            <span>股票代码或名称</span>
            <UiInput
              v-model="stockQuery"
              type="text"
              placeholder="例如：600519 或 贵州茅台"
              :disabled="saving"
              autocomplete="off"
              autofocus
              @focus="candidatesOpen = candidates.length > 0"
              @blur="closeCandidates"
              @keydown.esc="candidatesOpen = false"
            />
          </label>
          <div v-if="candidatesOpen" class="trade-record-create__candidates">
            <button
              v-for="item in candidates"
              :key="item.code"
              type="button"
              @mousedown.prevent="selectCandidate(item)"
            >
              <strong>{{ item.name }}</strong>
              <span>{{ item.code }}</span>
            </button>
          </div>
        </div>
        <div v-if="form.stockCode" class="trade-record-create__stock-identity">
          <span>{{ form.stockName }}</span>
          <strong>{{ form.stockCode }}</strong>
        </div>
        <p v-else-if="lookupLoading" class="trade-record-create__lookup-state">正在查询...</p>
        <p v-else-if="lookupError" class="trade-record-create__lookup-state trade-record-create__lookup-state--error">{{ lookupError }}</p>
      </section>

      <section>
        <h3>分类</h3>
        <label>
          <span>账户类型</span>
          <UiSelect v-model="form.accountType" :disabled="saving">
            <option value="simulated">模拟</option>
            <option value="live">实盘</option>
          </UiSelect>
        </label>
        <label>
          <span>交易类型</span>
          <UiSelect v-model="form.tradeType" :disabled="saving">
            <option value="system">系统交易</option>
            <option value="subjective">主观交易</option>
            <option value="violation">违规交易</option>
          </UiSelect>
        </label>
      </section>

      <TradeRecordStrategyPicker
        v-model="strategyDraft"
        :playbooks="playbooks"
        :loading="playbooksLoading"
        :error="playbooksError"
        :disabled="saving || creatingPlaybook"
        :allow-legacy="isEditMode && legacyStrategyAvailable"
      />

      <p v-if="error" class="trade-record-create__error">{{ error }}</p>
      <p v-if="strategyError" class="trade-record-create__error">{{ strategyError }}</p>
      <div class="trade-record-create__actions">
        <UiButton type="button" variant="secondary" :disabled="saving" @click="emit('close')">取消</UiButton>
        <UiButton
          type="submit"
          :loading="saving || creatingPlaybook"
          :disabled="saving || creatingPlaybook || !strategySelectionReady || !/^\d{6}$/u.test(form.stockCode)"
        >
          {{ isEditMode ? "保存修改" : "创建追踪单" }}
        </UiButton>
      </div>
    </form>
  </UiDrawer>
</template>

<style scoped>
:global(.trade-record-create-drawer) {
  width: min(440px, 100vw);
}

.trade-record-create {
  display: grid;
  gap: 18px;
}

.trade-record-create section {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.trade-record-create h3 {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--ql-color-text-strong);
  font-size: 13px;
}

.trade-record-create label {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.trade-record-create label > span {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.trade-record-create__stock-lookup {
  grid-column: 1 / -1;
  position: relative;
}

.trade-record-create__stock-lookup label {
  display: grid;
  gap: 6px;
}

.trade-record-create__candidates {
  border: 1px solid #e2e8f0;
  border-radius: 0.625rem;
  background: var(--ql-color-bg-surface-strong);
  box-shadow: 0 12px 24px rgba(15, 23, 42, 0.12);
  left: 0;
  margin-top: 0.25rem;
  overflow: hidden;
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 10;
}

.trade-record-create__candidates button {
  align-items: center;
  border: 0;
  background: transparent;
  color: var(--ql-color-text-body);
  cursor: pointer;
  display: flex;
  font: inherit;
  justify-content: space-between;
  padding: 0.625rem 0.75rem;
  text-align: left;
  width: 100%;
}

.trade-record-create__candidates button:hover {
  background: var(--ql-color-bg-muted);
}

.trade-record-create__candidates strong {
  font-size: 0.8125rem;
}

.trade-record-create__candidates span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
}

.trade-record-create__stock-identity {
  align-items: center;
  border: 1px solid #bfdbfe;
  border-radius: 0.625rem;
  background: var(--ql-color-primary-soft);
  display: flex;
  grid-column: 1 / -1;
  justify-content: space-between;
  padding: 0.625rem 0.75rem;
}

.trade-record-create__stock-identity span,
.trade-record-create__stock-identity strong {
  color: var(--ql-color-text-strong);
  font-size: 0.8125rem;
}

.trade-record-create__lookup-state {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  grid-column: 1 / -1;
  margin: 0;
}

.trade-record-create__lookup-state--error {
  color: var(--ql-color-danger, #b91c1c);
}

.trade-record-create__error {
  margin: 0;
  color: var(--ql-color-danger, #b91c1c);
  font-size: 12px;
}

.trade-record-create__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 6px;
}

@media (max-width: 560px) {
  .trade-record-create section {
    grid-template-columns: 1fr;
  }
}
</style>
