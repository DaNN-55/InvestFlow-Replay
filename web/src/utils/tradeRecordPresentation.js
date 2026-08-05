const SECTOR_TYPE_LABELS = {
  ths_concept: "同花顺概念",
  ths_industry: "同花顺行业",
  industry: "行业",
};

const READINESS_LABELS = {
  confirmed: "已确认",
  waiting: "等待确认",
  waiting_confirmation: "等待确认",
  forming: "形成中",
  invalidated: "已失效",
  insufficient: "证据不足",
};

const MISSING_FIELD_LABELS = {
  tailSessionReturn: "尾盘涨跌",
  marginBalanceChangeRatio: "融资余额变化",
};

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

function firstPresent(...values) {
  return values.find((value) => {
    if (value == null) return false;
    if (typeof value === "string") return value.trim() !== "";
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

function compactText(value, maxLength = 100) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function displayValue(value) {
  if (value == null || value === "") return "--";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "--";
  if (typeof value === "object") {
    return displayValue(firstPresent(value.label, value.name, value.summary, value.message, value.value));
  }
  return compactText(value);
}

function addItem(items, label, value) {
  const formatted = displayValue(value);
  if (formatted !== "--") items.push({ label, value: formatted });
}

function addRow(rows, label, value) {
  rows.push({ label, value: displayValue(value) });
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(digits)).toString();
}

function formatUnit(value, unit, digits = 2) {
  const number = formatNumber(value, digits);
  return number == null ? null : `${number} ${unit}`;
}

function formatPercent(value, { ratio = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const normalized = ratio ? number * 100 : number;
  return `${normalized.toFixed(2)}%`;
}

function resolveMode(snapshot, modeId) {
  const assessments = Array.isArray(snapshot?.modeAssessments) ? snapshot.modeAssessments : [];
  return assessments.find((item) => item?.modeId === modeId) ?? null;
}

function isLegacyMarketPhaseNote(value) {
  return /市场阶段|strong_flat|weak_flat|up_continuation|overheated/u.test(String(value ?? ""));
}

function formatNewsNote(item) {
  if (!item) return "";
  if (typeof item === "string") return compactText(item);
  const title = compactText(item.title ?? item.name ?? item.message ?? "");
  const reason = compactText(item.reason ?? item.summary ?? "");
  const source = compactText(item.source ?? "");
  if (!title) return reason;
  return `${title}${reason ? ` · ${reason}` : ""}${source ? `（${source}）` : ""}`;
}

function resolveSnapshotData(snapshot, record) {
  const evaluation = record?.evaluationSnapshot ?? {};
  return {
    candidate: snapshot?.candidateContext ?? evaluation?.candidateContext ?? {},
    technical: snapshot?.technical ?? evaluation?.technical ?? {},
    capitalFlow: snapshot?.capitalFlow ?? evaluation?.capitalFlow ?? {},
    news: snapshot?.newsSummary ?? snapshot?.news ?? evaluation?.news ?? {},
    plan: snapshot?.tradingPlan ?? record?.tradingPlanSummary ?? record?.tradingPlan ?? {},
  };
}

export function buildDiagnosisSnapshotSections(snapshot = {}, record = {}) {
  const { candidate, technical, capitalFlow, news, plan } = resolveSnapshotData(snapshot, record);
  const selectedMode = resolveMode(snapshot, snapshot?.selectedModeId) ?? plan?.selectedMode ?? null;
  const recommendedMode = resolveMode(snapshot, snapshot?.recommendedModeId);

  const sourceItems = [];
  addItem(sourceItems, "来源", candidate?.source === "market_scan" ? "市场扫描" : "独立诊断");
  addItem(sourceItems, "扫描日期", candidate?.scanTradeDate);
  addItem(sourceItems, "板块类型", SECTOR_TYPE_LABELS[candidate?.sectorType] ?? candidate?.sectorType);
  addItem(sourceItems, "板块", candidate?.sectorName);
  addItem(sourceItems, "候选角色", candidate?.candidateRole ?? candidate?.role);
  const sourceNotes = [
    candidate?.strategy ? `候选路径：${candidate.strategy}` : "",
    candidate?.mainlineScore ? `主线分 ${candidate.mainlineScore}` : "",
    candidate?.leaderScore ? `涨停生态分 ${candidate.leaderScore}` : "",
  ].filter(Boolean);

  const modeItems = [];
  addItem(modeItems, "选择模式", selectedMode?.modeName);
  addItem(modeItems, "当前阶段", selectedMode?.stage);
  addItem(modeItems, "准备度", READINESS_LABELS[selectedMode?.readiness] ?? selectedMode?.readiness);
  addItem(modeItems, "系统首选", recommendedMode?.modeName);
  if (snapshot?.selectionMismatch) addItem(modeItems, "人工调整", "与系统首选不同");
  const modeNotes = [
    ...(selectedMode?.evidence ?? []).filter((item) => !isLegacyMarketPhaseNote(item)).slice(0, 2),
    ...(selectedMode?.counterEvidence ?? []).filter((item) => !isLegacyMarketPhaseNote(item)).slice(0, 2).map((item) => `风险：${item}`),
    ...(selectedMode?.missingData ?? []).slice(0, 2).map((item) => `缺少：${item}`),
  ].map((item) => compactText(item)).filter(Boolean).slice(0, 4);

  const input = capitalFlow?.input ?? {};
  const evidenceItems = [];
  addItem(evidenceItems, "技术结构", technical?.trend?.label ?? technical?.trend?.summary);
  addItem(evidenceItems, "量能状态", technical?.volume?.label ?? technical?.volume?.summary);
  addItem(evidenceItems, "20日均成交", formatUnit(input?.averageAmount20dYi, "亿"));
  addItem(evidenceItems, "成交放大", formatUnit(input?.amountRatio, "倍"));
  addItem(evidenceItems, "换手率", formatPercent(input?.turnoverRate));
  addItem(evidenceItems, "收盘位置", formatPercent(input?.closePositionInRange, { ratio: true }));
  const missingFields = capitalFlow?.meta?.missingFields ?? [];
  const evidenceNotes = missingFields.length
    ? [`数据缺失：${missingFields.map((field) => MISSING_FIELD_LABELS[field] ?? field).join("、")}`]
    : [];

  const conclusionItems = [];
  addItem(conclusionItems, "新闻风险", news?.trendLabel ?? news?.status);
  addItem(conclusionItems, "新闻调整", news?.adjustment != null ? `${news.adjustment} 分` : null);
  addItem(conclusionItems, "负面统计", news?.total != null ? `${news.negative ?? 0}/${news.total} 条` : null);
  const newsNotes = (news?.scoreDetails ?? []).map(formatNewsNote).filter(Boolean).slice(0, 2);
  const invalidationNotes = (selectedMode?.invalidationConditions ?? plan?.exitConditions ?? [])
    .map((item) => `失效：${compactText(item)}`)
    .slice(0, 2);

  return [
    { key: "source", title: "候选来源", items: sourceItems, notes: sourceNotes },
    { key: "mode", title: "模式判断", items: modeItems, notes: modeNotes },
    { key: "evidence", title: "个股证据", items: evidenceItems, notes: evidenceNotes },
    {
      key: "conclusion",
      title: "风险与诊断结论",
      items: conclusionItems,
      notes: [...newsNotes, ...invalidationNotes].slice(0, 4),
    },
  ];
}

function parseNumber(value) {
  if (value == null || value === "") return null;
  const matched = String(value).replace(/,/gu, "").match(/[-+]?\d+(?:\.\d+)?/u);
  if (!matched) return null;
  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSignedMoney(value) {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatDate(value) {
  return value ? String(value).replace("T", " ").slice(0, 16) : "--";
}

function formatRange(low, high) {
  const normalizedLow = low == null || String(low).trim() === "" ? null : low;
  const normalizedHigh = high == null || String(high).trim() === "" ? null : high;
  if (normalizedLow == null && normalizedHigh == null) return "--";
  if (normalizedLow == null) return String(normalizedHigh);
  if (normalizedHigh == null) return String(normalizedLow);
  return `${normalizedLow} - ${normalizedHigh}`;
}

function formatHoldingDays(entryDate, exitDate) {
  if (!entryDate || !exitDate) return "--";
  const entry = new Date(`${String(entryDate).slice(0, 10)}T00:00:00`);
  const exit = new Date(`${String(exitDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(entry.getTime()) || Number.isNaN(exit.getTime())) return "--";
  return `${Math.max(0, Math.round((exit.getTime() - entry.getTime()) / 86400000))} 天`;
}

function assessment(value, tone = "neutral", deviates = false) {
  return { value, tone, deviates };
}

function assessEntry(form) {
  const actual = parseNumber(form?.actualEntryPrice);
  if (actual == null) return assessment("待执行");
  const low = parseNumber(form?.plannedEntryLow);
  const high = parseNumber(form?.plannedEntryHigh);
  const noChase = parseNumber(form?.noChasePrice);
  if (noChase != null && actual > noChase) return assessment("超过不追价", "negative", true);
  if (low != null && actual < low) return assessment("低于许可区间", "negative", true);
  if (high != null && actual > high) return assessment("高于许可区间", "negative", true);
  if (low != null || high != null) return assessment("许可区间内", "positive");
  return assessment("缺少许可基准", "negative", true);
}

function assessQuantity(form) {
  const actual = parseNumber(form?.actualEntryQuantity);
  if (actual == null) return assessment("待执行");
  const planned = parseNumber(form?.plannedQuantity);
  if (planned == null || planned <= 0) return assessment("缺少计划数量", "negative", true);
  if (actual <= planned) return assessment("未超计划", "positive");
  const excess = ((actual - planned) / planned) * 100;
  return assessment(`超计划 ${excess.toFixed(1)}%`, "negative", true);
}

function assessExit(form, requireSignal = true) {
  if (parseNumber(form?.actualExitPrice) == null) return assessment("待执行");
  const labels = {
    target: "按目标信号退出",
    failure: "按失败信号退出",
    manual: "人工退出",
  };
  const value = labels[form?.exitSignalType];
  return value
    ? assessment(value, "positive")
    : assessment("未记录退出信号", requireSignal ? "negative" : "neutral", requireSignal);
}

function stagePresentation(stage) {
  if (stage === "cancelled") {
    return { title: "取消复盘", description: "记录原计划和最终取消原因，不生成空的盈亏指标。" };
  }
  if (["draft", "planned", "expired"].includes(stage)) {
    return { title: "计划核对", description: "核对买入许可证、风险边界和执行准备，不提前展示交易盈亏。" };
  }
  if (["entered", "holding"].includes(stage)) {
    return { title: "持仓复盘", description: "对照买入许可证检查入场、仓位和持仓过程。" };
  }
  return { title: "交易复盘总览", description: "对照许可计划、实际执行和偏差，定位结果来自判断还是执行。" };
}

function hasLicenseBaseline(form, record) {
  return Boolean(record?.licenseSnapshot || [
    form?.plannedEntryLow,
    form?.plannedEntryHigh,
    form?.triggerPrice,
    form?.noChasePrice,
    form?.failurePrice,
    form?.targetPrice,
    form?.plannedQuantity,
  ].some((value) => value != null && String(value).trim() !== ""));
}

function buildLicenseRows(form, hasBaseline = true) {
  if (!hasBaseline) {
    return [
      { label: "许可证状态", value: "无许可记录" },
      { label: "说明", value: "旧版或主观交易未保存买入许可证，不能据此判断执行偏差。" },
    ];
  }
  const rows = [];
  addRow(rows, "允许买入区间", formatRange(form?.plannedEntryLow, form?.plannedEntryHigh));
  addRow(rows, "触发 / 不追", `${displayValue(form?.triggerPrice)} / ${displayValue(form?.noChasePrice)}`);
  addRow(rows, "失败 / 目标", `${displayValue(form?.failurePrice)} / ${displayValue(form?.targetPrice)}`);
  addRow(rows, "计划数量", form?.plannedQuantity ? `${form.plannedQuantity} 股` : null);
  addRow(rows, "最大风险", form?.estimatedMaxLossAmount);
  return rows;
}

function buildProcessNotes(form) {
  return [
    { label: "买入备注", value: form?.entryNotes },
    { label: "T+1 复盘", value: form?.t1Review },
    { label: "T+3 复盘", value: form?.t3Review },
    { label: "T+5 复盘", value: form?.t5Review },
    { label: "最终复盘", value: form?.finalReview },
  ].filter((item) => String(item.value ?? "").trim());
}

export function buildTradeReviewOverview({ stage = "", form = {}, record = {}, violations = [] }) {
  const presentation = stagePresentation(stage);
  const licenseBaselineAvailable = hasLicenseBaseline(form, record);
  const licenseRows = buildLicenseRows(form, licenseBaselineAvailable || ["draft", "planned", "expired", "cancelled"].includes(stage));
  const normalizedViolations = Array.isArray(violations) ? violations : [];

  if (stage === "cancelled") {
    return {
      ...presentation,
      metrics: [
        { label: "记录状态", value: "已取消", tone: "neutral" },
        { label: "入场结果", value: "未入场", tone: "positive" },
        { label: "纪律标签", value: normalizedViolations.length ? `${normalizedViolations.length} 项` : "无违规", tone: normalizedViolations.length ? "negative" : "positive" },
      ],
      sections: [
        { key: "license", title: "原许可计划", rows: licenseRows },
        {
          key: "cancellation",
          title: "取消结果",
          rows: [
            { label: "是否成交", value: "未成交" },
            { label: "取消原因", value: displayValue(form?.entryNotes || form?.exitReason || "未填写取消原因") },
          ],
        },
      ],
      processNotes: buildProcessNotes(form),
      violations: normalizedViolations,
    };
  }

  if (["draft", "planned", "expired"].includes(stage)) {
    const licenseState = stage === "planned" ? "已签发" : stage === "expired" ? "已失效" : "草稿";
    const plannedRange = formatRange(form?.plannedEntryLow, form?.plannedEntryHigh);
    return {
      ...presentation,
      metrics: [
        { label: "许可证状态", value: licenseState, tone: stage === "expired" ? "negative" : "neutral" },
        { label: "允许区间", value: plannedRange === "--" ? "待计算" : plannedRange, tone: "neutral" },
        { label: "计划数量", value: form?.plannedQuantity ? `${form.plannedQuantity} 股` : "待计算", tone: "neutral" },
        { label: "最大风险", value: displayValue(form?.estimatedMaxLossAmount || "待计算"), tone: "neutral" },
      ],
      sections: [
        { key: "license", title: "许可计划", rows: licenseRows },
        {
          key: "readiness",
          title: "执行准备",
          rows: [
            { label: "许可证", value: licenseState },
            { label: "签发时间", value: formatDate(record?.licenseSnapshot?.issuedAt ?? record?.licenseIssuedAt) },
            { label: "有效交易日", value: displayValue(form?.validForTradeDate) },
          ],
        },
      ],
      processNotes: buildProcessNotes(form),
      violations: normalizedViolations,
    };
  }

  const entry = licenseBaselineAvailable ? assessEntry(form) : assessment("无许可基准");
  const quantity = licenseBaselineAvailable ? assessQuantity(form) : assessment("无许可基准");
  const exit = assessExit(form, licenseBaselineAvailable);
  const hasExit = parseNumber(form?.actualExitPrice) != null;
  const deviationCount = normalizedViolations.length
    + Number(entry.deviates)
    + Number(quantity.deviates)
    + Number(hasExit && exit.deviates);
  const entryPrice = parseNumber(form?.actualEntryPrice);
  const exitPrice = parseNumber(form?.actualExitPrice);
  const quantityValue = parseNumber(form?.actualExitQuantity) ?? parseNumber(form?.actualEntryQuantity);
  const profitAmount = entryPrice != null && exitPrice != null && quantityValue != null
    ? (exitPrice - entryPrice) * quantityValue
    : null;
  const profitPct = entryPrice != null && exitPrice != null && entryPrice !== 0
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : null;
  const isCompleted = ["exited", "reviewed"].includes(stage);
  const executionGrade = !licenseBaselineAvailable
    ? (normalizedViolations.length ? `${normalizedViolations.length} 项纪律偏差` : "无法核对")
    : (deviationCount ? `${deviationCount} 项偏差` : "计划内");
  const executionTone = !licenseBaselineAvailable && !normalizedViolations.length
    ? "neutral"
    : deviationCount || normalizedViolations.length
      ? "negative"
      : "positive";
  const metrics = isCompleted
    ? [
      { label: "盈亏金额", value: formatSignedMoney(profitAmount), tone: profitAmount > 0 ? "positive" : profitAmount < 0 ? "negative" : "neutral" },
      { label: "盈亏比例", value: formatSignedPercent(profitPct), tone: profitPct > 0 ? "positive" : profitPct < 0 ? "negative" : "neutral" },
      { label: "持仓周期", value: formatHoldingDays(form?.actualEntryDate, form?.actualExitDate), tone: "neutral" },
      { label: "计划执行度", value: executionGrade, tone: executionTone },
    ]
    : [
      { label: "入场价格", value: entry.value, tone: entry.tone },
      { label: "买入数量", value: quantity.value, tone: quantity.tone },
      { label: "当前阶段", value: "持仓中", tone: "neutral" },
      { label: "计划执行度", value: executionGrade, tone: executionTone },
    ];

  const executionRows = [];
  addRow(executionRows, "买入", `${formatDate(form?.actualEntryDate)} · ${displayValue(form?.actualEntryPrice)} · ${displayValue(form?.actualEntryQuantity)} 股`);
  addRow(executionRows, "卖出", `${formatDate(form?.actualExitDate)} · ${displayValue(form?.actualExitPrice)} · ${displayValue(form?.actualExitQuantity)} 股`);
  addRow(executionRows, "持仓周期", formatHoldingDays(form?.actualEntryDate, form?.actualExitDate));
  addRow(executionRows, "卖出原因", form?.exitReason);

  const deviationRows = [
    { label: "入场价格", value: entry.value, tone: entry.tone },
    { label: "买入数量", value: quantity.value, tone: quantity.tone },
    { label: "退出执行", value: exit.value, tone: exit.tone },
    { label: "纪律偏差", value: normalizedViolations.length ? `${normalizedViolations.length} 项` : "无违规", tone: normalizedViolations.length ? "negative" : "positive" },
  ];

  return {
    ...presentation,
    metrics,
    sections: [
      { key: "license", title: "许可计划", rows: licenseRows },
      { key: "execution", title: "实际执行", rows: executionRows },
      { key: "deviation", title: "执行偏差", rows: deviationRows },
    ],
    processNotes: buildProcessNotes(form),
    violations: normalizedViolations,
  };
}
