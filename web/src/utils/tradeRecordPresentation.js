export const TRADE_RECORD_ACCOUNT_TYPE_OPTIONS = Object.freeze([
  { value: "simulated", label: "模拟" },
  { value: "live", label: "实盘" },
]);

export const TRADE_RECORD_TRADE_TYPE_OPTIONS = Object.freeze([
  { value: "system", label: "系统交易" },
  { value: "subjective", label: "主观交易" },
  { value: "violation", label: "违规交易" },
]);

export const TRADE_RECORD_STATUS_OPTIONS = Object.freeze([
  { value: "draft", label: "草稿" },
  { value: "planned", label: "买入许可证" },
  { value: "entered", label: "已买入" },
  { value: "holding", label: "持仓复盘" },
  { value: "exited", label: "已卖出" },
  { value: "reviewed", label: "最终复盘" },
  { value: "cancelled", label: "已取消" },
  { value: "expired", label: "已失效" },
]);

function optionLabel(options, value) {
  return options.find((option) => option.value === value)?.label || value || "--";
}

export function formatTradeRecordAccountType(value) {
  return optionLabel(TRADE_RECORD_ACCOUNT_TYPE_OPTIONS, value);
}

export function formatTradeRecordTradeType(value) {
  return optionLabel(TRADE_RECORD_TRADE_TYPE_OPTIONS, value);
}

export function formatTradeRecordStatus(value) {
  return optionLabel(TRADE_RECORD_STATUS_OPTIONS, value);
}

const STRATEGY_PROFILE_FIELDS = [
  "key",
  "name",
  "version",
  "summary",
  "entryRules",
  "exitRules",
  "riskRules",
];

export function buildStandaloneTradeRecordPayload(input = {}) {
  const strategyProfile = Object.fromEntries(
    STRATEGY_PROFILE_FIELDS.map((field) => [field, String(input?.strategyProfile?.[field] ?? "").trim()]),
  );
  return {
    stockCode: String(input.stockCode ?? "").trim(),
    stockName: String(input.stockName ?? "").trim(),
    accountType: String(input.accountType ?? "simulated"),
    tradeType: String(input.tradeType ?? "system"),
    status: "draft",
    strategyProfile: strategyProfile.name ? strategyProfile : null,
  };
}

export function formatTradeRecordStock(record) {
  const snapshot = record?.frozenSnapshot ?? record?.evaluationSnapshot ?? record?.snapshot ?? {};
  const code = record?.stockCode ?? snapshot?.stockCode ?? snapshot?.stock?.code ?? "";
  const name = record?.stockName ?? snapshot?.stockName ?? snapshot?.stock?.name ?? "";
  return `${name || "--"} ${code || ""}`.trim();
}
