import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { createDatabase } from "./db.js";
import { createEngineClient, EngineClientError } from "./engine-client.js";
import { createReplayLifecycleStore } from "./replay-lifecycle-store.js";
import { createReplayInteraction } from "./replay-interaction.js";

export function publicErrorCode(error) {
  return [
    "INVALID_REQUEST",
    "NOT_FOUND",
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_INVALID_RESPONSE",
    "MARKET_CACHE_INSUFFICIENT",
    "RUNTIME_SYNC_FAILED",
    "CONFIG_PERSIST_FAILED",
    "INTERNAL_ERROR",
  ].includes(error?.code)
    ? error.code
    : error?.status === 400
      ? "INVALID_REQUEST"
      : error?.status === 404
        ? "NOT_FOUND"
        : error?.status === 502
          ? "UPSTREAM_UNAVAILABLE"
          : "INTERNAL_ERROR";
}
import { calculateTradeLicense, resolveTradeRecordLifecycle } from "./trade-license.js";
import { calculateTradeLedger } from "./trade-ledger.js";








const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORAGE_ROOT = resolve(MODULE_DIR, "..", "..", "storage");
const DEFAULT_TRADE_RECORDS_ROOT = resolve(DEFAULT_STORAGE_ROOT, "trade-records");
function isoNow() {
  return new Date().toISOString();
}

function assertCondition(condition, message, status = 400) {
  if (!condition) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }
}



function normalizeBody(body) {
  return body && typeof body === "object" ? body : {};
}

function normalizeReplayPlaybookCreate(body) {
  const allowedFields = new Set(["name", "content", "changeSummary"]);
  assertCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "战法包含不支持的字段",
  );
  const name = String(body.name ?? "").trim();
  const content = String(body.content ?? "");
  const changeSummary = String(body.changeSummary ?? "").trim();
  assertCondition(
    name.length >= 1 && name.length <= 120,
    "name 必须是 1 至 120 个字符",
  );
  assertCondition(content.length <= 12000, "content 最多 12000 个字符");
  assertCondition(
    changeSummary.length >= 1 && changeSummary.length <= 500,
    "changeSummary 必须是 1 至 500 个字符",
  );
  return { name, content, changeSummary };
}

function normalizeReplayPlaybookRename(body) {
  const allowedFields = new Set(["name"]);
  assertCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "战法修改包含不支持的字段",
  );
  const name = String(body.name ?? "").trim();
  assertCondition(
    name.length >= 1 && name.length <= 120,
    "name 必须是 1 至 120 个字符",
  );
  return { name };
}

function normalizeReplayPlaybookVersion(body) {
  const allowedFields = new Set([
    "expectedVersionNumber",
    "content",
    "changeSummary",
  ]);
  assertCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "战法版本包含不支持的字段",
  );
  const expectedVersionNumber = body.expectedVersionNumber;
  const content = String(body.content ?? "");
  const changeSummary = String(body.changeSummary ?? "").trim();
  assertCondition(
    Number.isSafeInteger(expectedVersionNumber) && expectedVersionNumber >= 1,
    "expectedVersionNumber 必须是大于等于 1 的安全整数",
  );
  assertCondition(content.length <= 12000, "content 最多 12000 个字符");
  assertCondition(
    changeSummary.length >= 1 && changeSummary.length <= 500,
    "changeSummary 必须是 1 至 500 个字符",
  );
  return { expectedVersionNumber, content, changeSummary };
}

function normalizeReplayPlaybookCandidateCreate(body) {
  const allowedFields = new Set(["sessionId"]);
  assertCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "候选请求包含不支持的字段",
  );
  const sessionId = String(body.sessionId ?? "").trim();
  assertCondition(
    sessionId.length >= 1 && sessionId.length <= 120,
    "sessionId 必须是 1 至 120 个字符",
  );
  return { sessionId };
}

function normalizeReplayPlaybookCandidateReject(body) {
  const allowedFields = new Set(["reason"]);
  assertCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "拒绝候选包含不支持的字段",
  );
  const reason = String(body.reason ?? "").trim();
  assertCondition(reason.length <= 500, "reason 最多 500 个字符");
  return { reason };
}

function beijingToday(value = new Date()) {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}





















































































function sanitizeFileNamePart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_");
}

function sanitizeRecordId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeRecordTimestamp(value, fallback = isoNow()) {
  const text = String(value ?? "").trim();
  return Number.isNaN(Date.parse(text)) ? fallback : text;
}

const AUTO_TRADE_RECORD_VIOLATIONS = new Set([
  "EXCEEDED_NO_CHASE_PRICE",
  "MISSING_STOP_LOSS",
  "OUTSIDE_ENTRY_RANGE",
]);

const TRADE_EXECUTION_EVENT_ACTIONS = new Set([
  "buy",
  "add",
  "reduce",
  "sell",
  "hold",
  "note",
]);

function listTradeRecordFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name);
}

function parseTradeRecordJson(fileName, content, today = beijingToday()) {
  const payload = JSON.parse(String(content ?? "{}"));
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const fallbackId = fileName.replace(/\.json$/iu, "");
  const normalized = resolveTradeRecordLifecycle({
    ...record,
    id: sanitizeRecordId(record.id || fallbackId) || fallbackId,
    fileName,
    createdAt: normalizeRecordTimestamp(record.createdAt),
    updatedAt: normalizeRecordTimestamp(record.updatedAt),
    status: String(record.status ?? ""),
    accountType: String(record.accountType ?? ""),
    tradeType: String(record.tradeType ?? ""),
    violations: normalizeTradeRecordViolations(record.violations),
    strategyProfile: Object.hasOwn(record, "strategyProfile")
      ? normalizeTradeStrategyProfile(record.strategyProfile)
      : null,
    executionEvents: Object.hasOwn(record, "executionEvents")
      ? normalizeTradeExecutionEvents(record.executionEvents)
      : [],
    stockCode: String(record.stockCode ?? ""),
    stockName: String(record.stockName ?? ""),
  }, today);
  return {
    ...normalized,
    ledger: calculateTradeLedger(normalized.executionEvents),
  };
}

function normalizeTradeRecordViolations(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function parseOptionalNumber(value) {
  const text = typeof value === "string" ? value.trim() : value;
  if (text == null || text === "") {
    return null;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizePositiveOptionalNumber(value, fieldLabel) {
  const parsed = parseOptionalNumber(value);
  if (parsed == null) {
    return null;
  }
  assertCondition(parsed > 0, `${fieldLabel}必须大于 0`);
  return parsed;
}

function normalizeManualMaxPositionPct(value) {
  const parsed = parseOptionalNumber(value);
  if (parsed == null) {
    return null;
  }
  assertCondition(parsed > 0 && parsed <= 100, "单票最大仓位必须大于 0 且不超过 100%");
  return parsed;
}

function normalizeMaxAccountRiskPct(value) {
  const parsed = parseOptionalNumber(value);
  if (parsed == null) {
    return null;
  }
  assertCondition(parsed > 0 && parsed <= 100, "单笔风险预算必须大于 0 且不超过 100%");
  return parsed;
}

function normalizeTradeStrategyProfile(value) {
  if (value == null || value === "") {
    return null;
  }
  assertCondition(
    value && typeof value === "object" && !Array.isArray(value),
    "strategyProfile 必须是对象或 null",
  );
  const allowedFields = new Set([
    "key",
    "name",
    "version",
    "summary",
    "entryRules",
    "exitRules",
    "riskRules",
  ]);
  assertCondition(
    Object.keys(value).every((key) => allowedFields.has(key)),
    "strategyProfile 包含不支持的字段",
  );
  const profile = {};
  for (const field of ["key", "name", "version", "summary", "entryRules", "exitRules", "riskRules"]) {
    if (!Object.hasOwn(value, field)) {
      continue;
    }
    const text = String(value[field] ?? "").trim();
    assertCondition(text.length <= (field === "key" ? 80 : field === "version" ? 40 : 3000), `${field} 超出长度限制`);
    profile[field] = text;
  }
  assertCondition(Boolean(profile.name), "strategyProfile.name 不能为空");
  return profile;
}

function normalizeTradeExecutionEvent(value) {
  assertCondition(
    value && typeof value === "object" && !Array.isArray(value),
    "execution event 必须是对象",
  );
  const allowedFields = new Set([
    "id",
    "eventAt",
    "action",
    "price",
    "quantity",
    "fee",
    "planStatus",
    "note",
    "source",
  ]);
  assertCondition(
    Object.keys(value).every((key) => allowedFields.has(key)),
    "execution event 包含不支持的字段",
  );
  const action = String(value.action ?? "").trim().toLowerCase();
  assertCondition(TRADE_EXECUTION_EVENT_ACTIONS.has(action), "execution event.action 不受支持");
  const eventAt = String(value.eventAt ?? "").trim();
  assertCondition(eventAt.length >= 1 && eventAt.length <= 40, "execution event.eventAt 必须填写且不超过 40 个字符");
  const price = normalizePositiveOptionalNumber(value.price, "成交价格");
  const quantity = normalizePositiveOptionalNumber(value.quantity, "成交数量");
  const fee = parseOptionalNumber(value.fee) ?? 0;
  assertCondition(fee >= 0, "交易费用必须大于等于 0");
  const planStatus = String(value.planStatus ?? "unknown").trim().toLowerCase();
  assertCondition(
    ["planned", "unplanned", "unknown"].includes(planStatus),
    "execution event.planStatus 不受支持",
  );
  if (["buy", "add", "reduce", "sell"].includes(action)) {
    assertCondition(price != null, "买卖动作必须填写成交价格");
    assertCondition(quantity != null, "买卖动作必须填写成交数量");
  }
  const note = String(value.note ?? "").trim();
  const source = String(value.source ?? "").trim();
  assertCondition(note.length <= 1000, "execution event.note 最多 1000 个字符");
  assertCondition(source.length <= 60, "execution event.source 最多 60 个字符");
  return {
    id: sanitizeRecordId(value.id) || randomUUID(),
    eventAt,
    action,
    price,
    quantity,
    fee,
    planStatus,
    note,
    source,
  };
}

function normalizeTradeExecutionEvents(value) {
  if (value == null) {
    return [];
  }
  assertCondition(Array.isArray(value), "executionEvents 必须是数组");
  assertCondition(value.length <= 200, "executionEvents 最多 200 条");
  return value.map(normalizeTradeExecutionEvent);
}

function normalizeDecisionExecutionSettings(body, current) {
  const payload = normalizeBody(body);
  const next = {
    simulatedAccountEquity: Object.hasOwn(payload, "simulatedAccountEquity")
      ? normalizePositiveOptionalNumber(payload.simulatedAccountEquity, "模拟账户本金")
      : current.simulatedAccountEquity,
    liveAccountEquity: Object.hasOwn(payload, "liveAccountEquity")
      ? normalizePositiveOptionalNumber(payload.liveAccountEquity, "实盘账户本金")
      : current.liveAccountEquity,
    defaultMinRewardRiskRatio: Object.hasOwn(payload, "defaultMinRewardRiskRatio")
      ? normalizePositiveOptionalNumber(payload.defaultMinRewardRiskRatio, "最低盈亏比")
      : current.defaultMinRewardRiskRatio,
    defaultMaxAccountRiskPct: Object.hasOwn(payload, "defaultMaxAccountRiskPct")
      ? normalizeMaxAccountRiskPct(payload.defaultMaxAccountRiskPct)
      : current.defaultMaxAccountRiskPct,
    lotSize: 100,
  };
  assertCondition(next.defaultMinRewardRiskRatio != null, "最低盈亏比不能为空");
  assertCondition(next.defaultMaxAccountRiskPct != null, "单笔最大账户风险不能为空");
  return next;
}

function calculateTradeRecordViolations(record) {
  const violations = [];
  const actualEntryPrice = parseOptionalNumber(record.actualEntryPrice);
  const noChasePrice = parseOptionalNumber(record.noChasePrice);
  const plannedEntryLow = parseOptionalNumber(record.plannedEntryLow);
  const plannedEntryHigh = parseOptionalNumber(record.plannedEntryHigh);

  if (actualEntryPrice != null && noChasePrice != null && actualEntryPrice > noChasePrice) {
    violations.push("EXCEEDED_NO_CHASE_PRICE");
  }
  if (
    String(record.tradeType ?? "").trim() === "system"
    && record.status !== "draft"
    && parseOptionalNumber(record.stopLossPrice) == null
  ) {
    violations.push("MISSING_STOP_LOSS");
  }
  if (actualEntryPrice != null && plannedEntryLow != null && plannedEntryHigh != null) {
    const lower = Math.min(plannedEntryLow, plannedEntryHigh);
    const upper = Math.max(plannedEntryLow, plannedEntryHigh);
    if (actualEntryPrice < lower || actualEntryPrice > upper) {
      violations.push("OUTSIDE_ENTRY_RANGE");
    }
  }

  return violations;
}

const RETIRED_NEW_TRADE_RECORD_ROOT_KEYS = new Set([
  "action",
  "actionLabel",
  "boardTape",
  "boardTapeInput",
  "confidence",
  "diagnosisAction",
  "finalScore",
  "final_score",
  "fitLevel",
  "fitScore",
  "initialPositionPct",
  "leaderScore",
  "limitUpBoard",
  "limit_up_board",
  "mainlineScore",
  "manualTape",
  "maxPositionPct",
  "persistenceScore",
  "plannedPositionPct",
  "position",
  "positionPct",
  "position_pct",
  "rating",
  "ratingCode",
  "ratingReason",
  "rating_code",
  "rating_reason",
  "scanScore",
  "score",
  "scoreBreakdown",
  "score_breakdown",
  "scores",
  "strategy",
  "strategySignals",
  "strategySummary",
  "strategy_signals",
  "strategy_summary",
  "technicalScore",
  "technical_score",
  "tradingPlanSummary",
]);

const RETIRED_NEW_TRADE_RECORD_TECHNICAL_KEYS = new Set([
  "chipDistribution",
  "chip_distribution",
  "finalScore",
  "final_score",
  "macd",
  "rating",
  "ratingCode",
  "ratingReason",
  "rating_code",
  "rating_reason",
  "rsi",
  "scoreBreakdown",
  "score_breakdown",
  "strategySignals",
  "strategySummary",
  "strategy_signals",
  "strategy_summary",
  "technicalScore",
  "technical_score",
]);

function stripObjectFields(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.has(key)),
  );
}

function pickObjectFields(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => keys.has(key)),
  );
}

function stripRetiredTradeRecordSnapshotFields(value) {
  const snapshot = stripObjectFields(value, RETIRED_NEW_TRADE_RECORD_ROOT_KEYS);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return snapshot;
  }
  if (!snapshot.technical || typeof snapshot.technical !== "object") {
    return snapshot;
  }
  return {
    ...snapshot,
    technical: stripObjectFields(
      snapshot.technical,
      RETIRED_NEW_TRADE_RECORD_TECHNICAL_KEYS,
    ),
  };
}

function stripRetiredNewTradeRecordFields(value) {
  const payload = stripObjectFields(value, RETIRED_NEW_TRADE_RECORD_ROOT_KEYS);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    ...(Object.hasOwn(payload, "frozenSnapshot")
      ? { frozenSnapshot: stripRetiredTradeRecordSnapshotFields(payload.frozenSnapshot) }
      : {}),
    ...(Object.hasOwn(payload, "evaluationSnapshot")
      ? { evaluationSnapshot: stripRetiredTradeRecordSnapshotFields(payload.evaluationSnapshot) }
      : {}),
  };
}

function preserveLegacyRetiredSnapshotFields(previousSnapshot, nextSnapshot) {
  if (!nextSnapshot || typeof nextSnapshot !== "object" || Array.isArray(nextSnapshot)) {
    return nextSnapshot;
  }
  const legacyRootFields = pickObjectFields(
    previousSnapshot,
    RETIRED_NEW_TRADE_RECORD_ROOT_KEYS,
  );
  const previousTechnical = previousSnapshot?.technical;
  const legacyTechnicalFields = pickObjectFields(
    previousTechnical,
    RETIRED_NEW_TRADE_RECORD_TECHNICAL_KEYS,
  );
  const hasLegacyTechnicalFields = Object.keys(legacyTechnicalFields).length > 0;
  const hasNextTechnical = Object.hasOwn(nextSnapshot, "technical");
  return {
    ...legacyRootFields,
    ...nextSnapshot,
    ...(hasNextTechnical
      ? {
          technical: {
            ...legacyTechnicalFields,
            ...nextSnapshot.technical,
          },
        }
      : hasLegacyTechnicalFields
        ? { technical: legacyTechnicalFields }
        : {}),
  };
}

function preserveLegacyRetiredSnapshotUpdates(previous, payload) {
  return {
    ...payload,
    ...(Object.hasOwn(payload, "frozenSnapshot")
      ? {
          frozenSnapshot: preserveLegacyRetiredSnapshotFields(
            previous?.frozenSnapshot,
            payload.frozenSnapshot,
          ),
        }
      : {}),
    ...(Object.hasOwn(payload, "evaluationSnapshot")
      ? {
          evaluationSnapshot: preserveLegacyRetiredSnapshotFields(
            previous?.evaluationSnapshot,
            payload.evaluationSnapshot,
          ),
        }
      : {}),
  };
}

function normalizeTradeRecordPayload(body, previous = null) {
  const normalizedBody = normalizeBody(body);
  const cleanedPayload = stripRetiredNewTradeRecordFields(normalizedBody);
  delete cleanedPayload.ledger;
  const payload = previous
    ? preserveLegacyRetiredSnapshotUpdates(previous, cleanedPayload)
    : cleanedPayload;
  if (
    previous
    && !Object.hasOwn(previous, "manualMaxPositionPct")
    && Object.hasOwn(payload, "manualMaxPositionPct")
    && (payload.manualMaxPositionPct == null || payload.manualMaxPositionPct === "")
  ) {
    delete payload.manualMaxPositionPct;
  }
  const now = isoNow();
  const id = sanitizeRecordId(payload.id || previous?.id || randomUUID());
  const shouldPreserveUpdatedAt = !previous && payload.updatedAt;
  assertCondition(id.length > 0, "交易追踪单 id 无效");
  const { ledger: _previousLedger, ...base } = previous ? { ...previous } : {};
  const requestedStatus = String(payload.status ?? previous?.status ?? "");
  const normalizedStatus = !previous && requestedStatus === "planned" && !payload.licenseSnapshot
    ? "draft"
    : requestedStatus;
  const record = {
    ...base,
    ...payload,
    id,
    fileName: previous?.fileName || "",
    createdAt: normalizeRecordTimestamp(payload.createdAt ?? previous?.createdAt, now),
    updatedAt: shouldPreserveUpdatedAt
      ? normalizeRecordTimestamp(payload.updatedAt, now)
      : now,
    status: normalizedStatus,
    accountType: String(payload.accountType ?? previous?.accountType ?? ""),
    tradeType: String(payload.tradeType ?? previous?.tradeType ?? ""),
    stockCode: String(payload.stockCode ?? previous?.stockCode ?? ""),
    stockName: String(payload.stockName ?? previous?.stockName ?? ""),
  };
  if (!previous) {
    assertCondition(record.stockCode.trim().length > 0, "股票代码不能为空");
    assertCondition(
      ["simulated", "live"].includes(record.accountType),
      "账户类型只支持模拟或实盘",
    );
    assertCondition(
      ["system", "subjective", "violation"].includes(record.tradeType),
      "交易类型不受支持",
    );
  }
  if (Object.hasOwn(payload, "manualMaxPositionPct")) {
    record.manualMaxPositionPct = normalizeManualMaxPositionPct(payload.manualMaxPositionPct);
  } else if (!previous) {
    record.manualMaxPositionPct = null;
  } else if (Object.hasOwn(previous, "manualMaxPositionPct")) {
    record.manualMaxPositionPct = previous.manualMaxPositionPct;
  }
  if (Object.hasOwn(payload, "manualMaxAccountRiskPct")) {
    record.manualMaxAccountRiskPct = normalizeMaxAccountRiskPct(payload.manualMaxAccountRiskPct);
  } else if (!previous) {
    record.manualMaxAccountRiskPct = null;
  } else if (Object.hasOwn(previous, "manualMaxAccountRiskPct")) {
    record.manualMaxAccountRiskPct = previous.manualMaxAccountRiskPct;
  }
  if (Object.hasOwn(payload, "strategyProfile")) {
    record.strategyProfile = normalizeTradeStrategyProfile(payload.strategyProfile);
  } else if (!previous) {
    record.strategyProfile = null;
  } else if (Object.hasOwn(previous, "strategyProfile")) {
    record.strategyProfile = previous.strategyProfile;
  }
  if (Object.hasOwn(payload, "executionEvents")) {
    record.executionEvents = normalizeTradeExecutionEvents(payload.executionEvents);
  } else if (!previous) {
    record.executionEvents = [];
  } else if (Object.hasOwn(previous, "executionEvents")) {
    record.executionEvents = normalizeTradeExecutionEvents(previous.executionEvents);
  }
  const manualViolations = normalizeTradeRecordViolations(
    payload.violations ?? previous?.violations,
  ).filter((item) => !AUTO_TRADE_RECORD_VIOLATIONS.has(item));
  record.violations = [
    ...new Set([
      ...manualViolations,
      ...calculateTradeRecordViolations(record),
    ]),
  ];
  return record;
}

function serializeTradeRecordJson(record) {
  const { fileName: _fileName, ledger: _ledger, ...payload } = record;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildTradeRecordFileName(record) {
  const datePart = String(record.createdAt ?? "").slice(0, 10).replaceAll("-", "") || "record";
  const stockCodePart = sanitizeFileNamePart(record.stockCode || "stock").slice(0, 24) || "stock";
  const stockNamePart = sanitizeFileNamePart(record.stockName || "trade").slice(0, 48) || "trade";
  return `${datePart}-${stockCodePart}-${stockNamePart}-trade-${record.id}.json`;
}

































































export function createApp(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => new Date();
  const database = createDatabase(options.dbPath);
  const engine = createEngineClient(options.engineUrl);
  const replayStore = createReplayLifecycleStore(database);
  const replayInteraction = createReplayInteraction({
    store: replayStore,
    scenarioSource: engine,
    createId: randomUUID,
    now: isoNow,
  });
  const tradeRecordsRoot = resolve(options.tradeRecordsRoot ?? DEFAULT_TRADE_RECORDS_ROOT);
  const app = express();

  app.use(express.json({ limit: "2mb" }));

  function ensureTradeRecordsRoot() {
    mkdirSync(tradeRecordsRoot, { recursive: true });
  }

  function readTradeRecords() {
    ensureTradeRecordsRoot();
    return listTradeRecordFiles(tradeRecordsRoot)
      .map((fileName) => {
        const absolutePath = resolve(tradeRecordsRoot, fileName);
        return parseTradeRecordJson(
          fileName,
          readFileSync(absolutePath, "utf8"),
          beijingToday(clock()),
        );
      })
      .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
  }

  function findTradeRecordById(id) {
    const normalizedId = sanitizeRecordId(id);
    if (!normalizedId) {
      return null;
    }
    return readTradeRecords().find((record) => record.id === normalizedId) ?? null;
  }

  function saveTradeRecordFile(body, previous = null) {
    ensureTradeRecordsRoot();
    const record = normalizeTradeRecordPayload(body, previous);
    const fileName = previous?.fileName || buildTradeRecordFileName(record);
    const absolutePath = resolve(tradeRecordsRoot, fileName);
    assertCondition(dirname(absolutePath) === tradeRecordsRoot, "交易追踪单路径无效");
    writeFileSync(absolutePath, serializeTradeRecordJson(record), "utf8");
    return parseTradeRecordJson(
      fileName,
      readFileSync(absolutePath, "utf8"),
      beijingToday(clock()),
    );
  }

  function accountEquityForRecord(record, settings) {
    if (record.accountType === "simulated") {
      return settings.simulatedAccountEquity;
    }
    if (record.accountType === "live") {
      return settings.liveAccountEquity;
    }
    return null;
  }

  function maxPositionPctForRecord(record) {
    if (Object.hasOwn(record, "manualMaxPositionPct")) {
      return parseOptionalNumber(record.manualMaxPositionPct);
    }
    return parseOptionalNumber(
      record.tradingPlanSummary?.maxPositionPct
        ?? record.frozenSnapshot?.tradingPlan?.maxPositionPct
        ?? record.evaluationSnapshot?.tradingPlan?.maxPositionPct,
    );
  }

  function maxAccountRiskPctForRecord(record, settings) {
    return parseOptionalNumber(record.manualMaxAccountRiskPct)
      ?? settings.defaultMaxAccountRiskPct;
  }

  function issueTradeLicense(record) {
    assertCondition(record.status === "draft", "只有草稿可以生成买入许可证");
    if (!Object.hasOwn(record, "manualMaxPositionPct")) {
      const diagnosisAction = String(
        record.tradingPlanSummary?.action
          ?? record.frozenSnapshot?.tradingPlan?.action
          ?? "",
      );
      assertCondition(
        !["avoid_chasing", "reduce_or_exit", "insufficient_data", "insufficient_evidence"].includes(diagnosisAction),
        "当前诊断结论不允许开仓",
      );
    }
    const settings = database.getDecisionExecutionSettings();
    const accountEquity = accountEquityForRecord(record, settings);
    const maxAccountRiskPct = maxAccountRiskPctForRecord(record, settings);
    const maxPositionPct = maxPositionPctForRecord(record);
    assertCondition(maxPositionPct != null, "请填写单票最大仓位（%）后再生成买入许可证");
    const calculation = calculateTradeLicense({
      triggerPrice: record.triggerPrice,
      failurePrice: record.failurePrice,
      targetPrice: record.targetPrice,
      accountEquity,
      minRewardRiskRatio: settings.defaultMinRewardRiskRatio,
      maxAccountRiskPct,
      maxPositionPct,
      lotSize: settings.lotSize,
    });
    if (!calculation.valid) {
      const issue = calculation.errors[0];
      const error = new Error(issue?.message || "交易计划未通过许可证校验");
      error.status = 400;
      error.details = { errors: calculation.errors };
      throw error;
    }
    assertCondition(/^\d{4}-\d{2}-\d{2}$/.test(String(record.validForTradeDate ?? "")), "请选择许可证交易日");
    const issuedAt = isoNow();
    return saveTradeRecordFile({
      status: "planned",
      ...calculation,
      licenseSnapshot: {
        accountEquity,
        minRewardRiskRatio: settings.defaultMinRewardRiskRatio,
        maxAccountRiskPct,
        maxPositionPct,
        lotSize: settings.lotSize,
        calculationVersion: 1,
        issuedAt,
      },
      licenseIssuedAt: issuedAt,
      planRevision: Number(record.planRevision ?? 0) + 1,
    }, record);
  }

  function recordTradeEntry(record, body) {
    assertCondition(record.status === "planned" && record.licenseSnapshot, "当前没有有效买入许可证");
    const payload = normalizeBody(body);
    const entryDate = String(payload.actualEntryDate ?? "").trim();
    const entryPrice = parseOptionalNumber(payload.actualEntryPrice);
    const entryQuantity = parseOptionalNumber(payload.actualEntryQuantity);
    assertCondition(entryDate === record.validForTradeDate, "实际买入日期与许可证交易日不一致");
    assertCondition(entryPrice != null && entryPrice >= Number(record.plannedEntryLow), "实际买入价低于触发价");
    assertCondition(entryPrice <= Number(record.noChasePrice), "实际买入价超过不追价");
    assertCondition(entryQuantity != null && entryQuantity > 0, "实际买入数量必须大于 0");
    assertCondition(entryQuantity % Number(record.licenseSnapshot.lotSize ?? 100) === 0, "实际买入数量必须是每手股数的整数倍");
    assertCondition(entryQuantity <= Number(record.plannedQuantity), "实际买入数量超过许可证上限");
    const executionEvents = [
      ...normalizeTradeExecutionEvents(record.executionEvents),
      normalizeTradeExecutionEvent({
        eventAt: entryDate,
        action: "buy",
        price: entryPrice,
        quantity: entryQuantity,
        fee: 0,
        planStatus: "planned",
        source: "买入许可证",
      }),
    ];
    return saveTradeRecordFile({
      status: "entered",
      actualEntryDate: entryDate,
      actualEntryPrice: entryPrice,
      actualEntryQuantity: entryQuantity,
      executionEvents,
    }, record);
  }

  function recordTradePriceObservation(record, body) {
    assertCondition(["entered", "holding"].includes(record.status), "只有已买入或持仓中的记录可以记录观察价");
    const payload = normalizeBody(body);
    const observedAt = String(payload.observedAt ?? "").trim();
    const observedPrice = parseOptionalNumber(payload.observedPrice);
    const entryPrice = parseOptionalNumber(record.actualEntryPrice);
    assertCondition(/^\d{4}-\d{2}-\d{2}$/.test(observedAt), "请填写观察日期");
    assertCondition(observedPrice != null && observedPrice > 0, "观察价必须大于 0");
    assertCondition(entryPrice != null && entryPrice > 0, "缺少实际买入价，无法计算利润回撤保护");
    const previousHigh = parseOptionalNumber(record.profitProtectionHighestPrice) ?? entryPrice;
    const executionEvents = [
      ...normalizeTradeExecutionEvents(record.executionEvents),
      normalizeTradeExecutionEvent({
        eventAt: observedAt,
        action: "hold",
        price: observedPrice,
        quantity: null,
        fee: 0,
        planStatus: "unknown",
        source: "持仓观察",
      }),
    ];
    return saveTradeRecordFile({
      status: "holding",
      profitProtectionLastObservedAt: observedAt,
      profitProtectionCurrentPrice: observedPrice,
      profitProtectionHighestPrice: Math.max(previousHigh, observedPrice),
      executionEvents,
    }, record);
  }

  function recordTradeExecutionEvent(record, body) {
    const event = normalizeTradeExecutionEvent(normalizeBody(body));
    const events = normalizeTradeExecutionEvents(record.executionEvents);
    const nextEvents = [...events, event];
    const hasPriorTrades = calculateTradeLedger(events).tradeEventCount > 0;
    const nextStatus = resolveTradeRecordStatus(nextEvents, hasPriorTrades ? "holding" : "entered");
    return saveTradeRecordFile({
      executionEvents: nextEvents,
      status: nextStatus,
    }, record);
  }

  function resolveTradeRecordStatus(events, firstOpenStatus = "entered") {
    const ledger = calculateTradeLedger(events);
    if (ledger.state === "closed") {
      return "exited";
    }
    if (ledger.state === "open") {
      return ledger.tradeEventCount > 1 ? "holding" : firstOpenStatus;
    }
    return "draft";
  }

  function updateTradeExecutionEvent(record, eventId, body) {
    const events = normalizeTradeExecutionEvents(record.executionEvents);
    const eventIndex = events.findIndex((event) => event.id === eventId);
    assertCondition(eventIndex >= 0, "找不到成交或动作记录", 404);
    const nextEvents = [...events];
    nextEvents[eventIndex] = normalizeTradeExecutionEvent({
      ...events[eventIndex],
      ...normalizeBody(body),
      id: eventId,
    });
    return saveTradeRecordFile({
      executionEvents: nextEvents,
      status: resolveTradeRecordStatus(nextEvents),
    }, record);
  }

  function deleteTradeExecutionEvent(record, eventId) {
    const events = normalizeTradeExecutionEvents(record.executionEvents);
    assertCondition(events.some((event) => event.id === eventId), "找不到成交或动作记录", 404);
    const nextEvents = events.filter((event) => event.id !== eventId);
    return saveTradeRecordFile({
      executionEvents: nextEvents,
      status: resolveTradeRecordStatus(nextEvents),
    }, record);
  }

  function recordTradeExit(record, body) {
    assertCondition(["entered", "holding"].includes(record.status), "只有已买入或持仓中的记录可以卖出");
    const payload = normalizeBody(body);
    const signalType = String(payload.exitSignalType ?? "").trim();
    const signalDate = String(payload.exitSignalDate ?? "").trim();
    const signalPrice = parseOptionalNumber(payload.exitSignalPrice);
    const exitDate = String(payload.actualExitDate ?? "").trim();
    const exitPrice = parseOptionalNumber(payload.actualExitPrice);
    const exitQuantity = parseOptionalNumber(payload.actualExitQuantity);
    assertCondition(["target", "failure", "manual"].includes(signalType), "卖出信号只支持目标止盈、失败止损或手动退出");
    assertCondition(/^\d{4}-\d{2}-\d{2}$/.test(signalDate), "请填写卖出信号日期");
    assertCondition(/^\d{4}-\d{2}-\d{2}$/.test(exitDate), "请填写实际卖出日期");
    assertCondition(exitDate >= signalDate, "实际卖出日期不能早于信号日期");
    assertCondition(signalPrice != null && signalPrice > 0, "请填写卖出信号价格");
    if (signalType === "target") {
      assertCondition(signalPrice >= Number(record.targetPrice), "目标止盈信号价低于计划目标价");
    } else if (signalType === "failure") {
      assertCondition(signalPrice <= Number(record.failurePrice), "失败止损信号价高于计划失败价");
    } else {
      assertCondition(String(payload.exitReason ?? "").trim().length > 0, "手动退出必须填写卖出原因");
    }
    assertCondition(exitPrice != null && exitPrice > 0, "实际卖出价格必须大于 0");
    assertCondition(exitQuantity === Number(record.actualEntryQuantity), "第一版卖出必须一次退出全部计划持仓");
    const executionEvents = [
      ...normalizeTradeExecutionEvents(record.executionEvents),
      normalizeTradeExecutionEvent({
        eventAt: exitDate,
        action: "sell",
        price: exitPrice,
        quantity: exitQuantity,
        fee: 0,
        planStatus: signalType === "manual" ? "unknown" : "planned",
        source: "卖出确认",
        note: String(payload.exitReason ?? record.exitReason ?? "").trim(),
      }),
    ];
    calculateTradeLedger(executionEvents);
    return saveTradeRecordFile({
      status: "exited",
      exitSignalType: signalType,
      exitSignalDate: signalDate,
      exitSignalPrice: signalPrice,
      actualExitDate: exitDate,
      actualExitPrice: exitPrice,
      actualExitQuantity: exitQuantity,
      exitReason: String(payload.exitReason ?? record.exitReason ?? "").trim(),
      executionEvents,
    }, record);
  }

  function recordViolationEntry(record, body) {
    assertCondition(["draft", "planned", "expired"].includes(record.status), "当前阶段不能记录违规买入");
    const payload = normalizeBody(body);
    const entryDate = String(payload.actualEntryDate ?? "").trim();
    const entryPrice = parseOptionalNumber(payload.actualEntryPrice);
    const entryQuantity = parseOptionalNumber(payload.actualEntryQuantity);
    const violationReason = String(payload.violationReason ?? "").trim();
    assertCondition(/^\d{4}-\d{2}-\d{2}$/.test(entryDate), "请填写实际买入日期");
    assertCondition(entryPrice != null && entryPrice > 0, "实际买入价格必须大于 0");
    assertCondition(entryQuantity != null && entryQuantity > 0, "实际买入数量必须大于 0");
    assertCondition(violationReason.length > 0, "记录违规交易必须填写原因");
    const violations = normalizeTradeRecordViolations(record.violations);
    if (!record.licenseSnapshot) {
      violations.push("NO_VALID_LICENSE");
    }
    if (record.validForTradeDate && entryDate !== record.validForTradeDate) {
      violations.push("EXPIRED_LICENSE");
    }
    if (parseOptionalNumber(record.noChasePrice) != null && entryPrice > Number(record.noChasePrice)) {
      violations.push("EXCEEDED_NO_CHASE_PRICE");
    }
    if (parseOptionalNumber(record.plannedQuantity) != null && entryQuantity > Number(record.plannedQuantity)) {
      violations.push("EXCEEDED_PLANNED_QUANTITY");
    }
    const executionEvents = [
      ...normalizeTradeExecutionEvents(record.executionEvents),
      normalizeTradeExecutionEvent({
        eventAt: entryDate,
        action: "buy",
        price: entryPrice,
        quantity: entryQuantity,
        fee: 0,
        planStatus: "unplanned",
        source: "违规买入",
        note: violationReason,
      }),
    ];
    return saveTradeRecordFile({
      status: "entered",
      tradeType: "violation",
      actualEntryDate: entryDate,
      actualEntryPrice: entryPrice,
      actualEntryQuantity: entryQuantity,
      violationReason,
      violations: [...new Set(violations)],
      executionEvents,
    }, record);
  }

  function revokedLicenseFields() {
    return {
      status: "draft",
      licenseSnapshot: null,
      licenseIssuedAt: null,
      plannedEntryLow: null,
      plannedEntryHigh: null,
      noChasePrice: null,
      stopLossPrice: null,
      takeProfitPrice: null,
      plannedQuantity: null,
      plannedAmount: null,
      estimatedMaxLossAmount: null,
      rewardRiskRatioAtTrigger: null,
      rewardRiskRatioAtWorstEntry: null,
      riskBudgetAmount: null,
      positionCapAmount: null,
      plannedPositionPct: null,
    };
  }

  function deleteTradeRecordFile(id) {
    const record = findTradeRecordById(id);
    assertCondition(Boolean(record), "找不到交易追踪单", 404);
    rmSync(resolve(tradeRecordsRoot, record.fileName), { force: true });
    return record;
  }

































































  app.get("/api/quant/replay/benchmarks", async (req, res, next) => {
    try {
      res.json(await engine.getReplayBenchmarks({ retry: req.query.retry === "true" }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/replay/cache/status", async (_req, res, next) => {
    try {
      res.json(await engine.getReplayCacheStatus());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/replay/playbooks", (_req, res, next) => {
    try {
      res.json({
        items: database.listReplayPlaybooks(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/replay/playbooks", (req, res, next) => {
    try {
      const normalized = normalizeReplayPlaybookCreate(
        normalizeBody(req.body),
      );
      const playbook = database.createReplayPlaybook({
        id: randomUUID(),
        versionId: randomUUID(),
        ...normalized,
        now: isoNow(),
      });
      res.status(201).json({ playbook });
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/quant/replay/playbooks/:playbookId",
    (req, res, next) => {
      try {
        const result = database.getReplayPlaybook(
          String(req.params.playbookId ?? ""),
        );
        assertCondition(Boolean(result), "找不到演练战法", 404);
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/api/quant/replay/playbooks/:playbookId",
    (req, res, next) => {
      try {
        const normalized = normalizeReplayPlaybookRename(
          normalizeBody(req.body),
        );
        const playbook = database.renameReplayPlaybook({
          playbookId: String(req.params.playbookId ?? ""),
          ...normalized,
          now: isoNow(),
        });
        assertCondition(Boolean(playbook), "找不到演练战法", 404);
        res.json({ playbook });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/quant/replay/playbooks/:playbookId",
    (req, res, next) => {
      try {
        const deleted = database.deleteReplayPlaybook({
          playbookId: String(req.params.playbookId ?? ""),
          now: isoNow(),
        });
        assertCondition(deleted, "找不到演练战法", 404);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/playbooks/:playbookId/versions",
    (req, res, next) => {
      try {
        const normalized = normalizeReplayPlaybookVersion(
          normalizeBody(req.body),
        );
        const result = database.createReplayPlaybookVersion({
          playbookId: String(req.params.playbookId ?? ""),
          id: randomUUID(),
          ...normalized,
          now: isoNow(),
        });
        assertCondition(Boolean(result), "找不到演练战法", 404);
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/quant/replay/playbooks/:playbookId/versions/:versionId",
    (req, res, next) => {
      try {
        const deleted = database.deleteReplayPlaybookVersion({
          playbookId: String(req.params.playbookId ?? ""),
          versionId: String(req.params.versionId ?? ""),
        });
        assertCondition(Boolean(deleted), "找不到战法版本", 404);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/quant/replay/playbook-candidates", (req, res, next) => {
    try {
      const normalized = normalizeReplayPlaybookCandidateCreate(
        normalizeBody(req.body),
      );
      const candidate = database.createReplayPlaybookCandidate({
        id: randomUUID(),
        sessionId: normalized.sessionId,
        now: isoNow(),
      });
      assertCondition(Boolean(candidate), "找不到行情演练会话", 404);
      res.json({ candidate });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/quant/replay/playbook-candidates/:candidateId/accept",
    (req, res, next) => {
      try {
        const normalized = normalizeReplayPlaybookVersion(
          normalizeBody(req.body),
        );
        const result = database.acceptReplayPlaybookCandidate({
          candidateId: String(req.params.candidateId ?? ""),
          versionId: randomUUID(),
          ...normalized,
          now: isoNow(),
        });
        assertCondition(Boolean(result), "找不到战法改进候选", 404);
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/playbook-candidates/:candidateId/reject",
    (req, res, next) => {
      try {
        const normalized = normalizeReplayPlaybookCandidateReject(
          normalizeBody(req.body),
        );
        const candidate = database.rejectReplayPlaybookCandidate({
          candidateId: String(req.params.candidateId ?? ""),
          reason: normalized.reason,
          now: isoNow(),
        });
        assertCondition(Boolean(candidate), "找不到战法改进候选", 404);
        res.json({ candidate });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/quant/replay/sessions", async (req, res, next) => {
    try {
      res.status(201).json(await replayInteraction.create(normalizeBody(req.body)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/replay/sessions", (req, res, next) => {
    try {
      res.json(replayInteraction.list(req.query ?? {}));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/replay/sessions/:sessionId", (req, res, next) => {
    try {
      res.json(replayInteraction.get(String(req.params.sessionId ?? "")));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/replay/sessions/:sessionId", (req, res, next) => {
    try {
      res.json(replayInteraction.deleteSession(String(req.params.sessionId ?? "")));
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/quant/replay/sessions/:sessionId/retrain",
    (req, res, next) => {
      try {
        res.status(201).json(replayInteraction.retrain(
          String(req.params.sessionId ?? ""),
          normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/quant/replay/sessions/:sessionId/orders", (req, res, next) => {
    try {
      const result = replayInteraction.submitOrder(
        String(req.params.sessionId ?? ""), normalizeBody(req.body),
      );
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/quant/replay/sessions/:sessionId/advance",
    (req, res, next) => {
      try {
        res.json(replayInteraction.advance(
          String(req.params.sessionId ?? ""), normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/finish",
    (req, res, next) => {
      try {
        res.json(replayInteraction.finish(
          String(req.params.sessionId ?? ""), normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/reviews/blind",
    (req, res, next) => {
      try {
        res.json(replayInteraction.saveBlindReview(
          String(req.params.sessionId ?? ""), normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  for (const stage of ["blind", "post"]) {
    app.put(
      `/api/quant/replay/sessions/:sessionId/reviews/${stage}/draft`,
      (req, res, next) => {
        try {
          res.json(replayInteraction.saveReviewDraft(
            String(req.params.sessionId ?? ""), stage, normalizeBody(req.body),
          ));
        } catch (error) {
          next(error);
        }
      },
    );
    app.delete(
      `/api/quant/replay/sessions/:sessionId/reviews/${stage}/draft`,
      (req, res, next) => {
        try {
          res.json(replayInteraction.deleteReviewDraft(
            String(req.params.sessionId ?? ""), stage, normalizeBody(req.body),
          ));
        } catch (error) {
          next(error);
        }
      },
    );
  }

  app.post(
    "/api/quant/replay/sessions/:sessionId/reviews/post",
    (req, res, next) => {
      try {
        res.json(replayInteraction.savePostReview(
          String(req.params.sessionId ?? ""), normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/reviews/blind/corrections",
    (req, res, next) => {
      try {
        res.json(replayInteraction.appendReviewCorrection(
          String(req.params.sessionId ?? ""), "blind", normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/reviews/post/corrections",
    (req, res, next) => {
      try {
        res.json(replayInteraction.appendReviewCorrection(
          String(req.params.sessionId ?? ""), "post", normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/api/quant/replay/sessions/:sessionId/reviews/:stage/corrections/:correctionId",
    (req, res, next) => {
      try {
        const stage = String(req.params.stage ?? "");
        res.json(replayInteraction.updateReviewCorrection(
          String(req.params.sessionId ?? ""),
          stage,
          String(req.params.correctionId ?? ""),
          normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/quant/replay/sessions/:sessionId/reviews/:stage/corrections/:correctionId",
    (req, res, next) => {
      try {
        const stage = String(req.params.stage ?? "");
        res.json(replayInteraction.deleteReviewCorrection(
          String(req.params.sessionId ?? ""),
          stage,
          String(req.params.correctionId ?? ""),
          normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/reveal",
    (req, res, next) => {
      try {
        res.json(replayInteraction.reveal(
          String(req.params.sessionId ?? ""), normalizeBody(req.body),
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/quant/decision/execution-settings", (_req, res, next) => {
    try {
      res.json(database.getDecisionExecutionSettings());
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/quant/decision/execution-settings", (req, res, next) => {
    try {
      const current = database.getDecisionExecutionSettings();
      const settings = normalizeDecisionExecutionSettings(req.body, current);
      res.json(database.saveDecisionExecutionSettings(settings));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/decision/trade-records", (_req, res, next) => {
    try {
      res.json({
        rootPath: tradeRecordsRoot,
        items: readTradeRecords(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/decision/trade-records/:id", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/decision/trade-records", (req, res, next) => {
    try {
      const requestedId = sanitizeRecordId(req.body?.id);
      const previous = requestedId ? findTradeRecordById(requestedId) : null;
      const record = saveTradeRecordFile(req.body, previous);
      res.status(previous ? 200 : 201).json(record);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/decision/trade-records/:id/license", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(issueTradeLicense(record));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/decision/trade-records/:id/entry", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(recordTradeEntry(record, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/decision/trade-records/:id/price-observation", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(recordTradePriceObservation(record, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/decision/trade-records/:id/execution-events", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(recordTradeExecutionEvent(record, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/quant/decision/trade-records/:id/execution-events/:eventId", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(updateTradeExecutionEvent(record, req.params.eventId, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/decision/trade-records/:id/execution-events/:eventId", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(deleteTradeExecutionEvent(record, req.params.eventId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/decision/trade-records/:id/violation-entry", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(recordViolationEntry(record, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/decision/trade-records/:id/exit", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      res.json(recordTradeExit(record, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/decision/trade-records/:id/cancel", (req, res, next) => {
    try {
      const record = findTradeRecordById(req.params.id);
      assertCondition(Boolean(record), "找不到交易追踪单", 404);
      assertCondition(["draft", "planned"].includes(record.status), "当前阶段不能取消计划");
      res.json(saveTradeRecordFile({ status: "cancelled" }, record));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/quant/decision/trade-records/:id", (req, res, next) => {
    try {
      const previous = findTradeRecordById(req.params.id);
      assertCondition(Boolean(previous), "找不到交易追踪单", 404);
      const payload = normalizeBody(req.body);
      if (Object.hasOwn(payload, "status")) {
        assertCondition(String(payload.status) === previous.status, "阶段只能通过专用动作修改");
      }
      const planInputKeys = [
        "accountType",
        "manualMaxAccountRiskPct",
        "manualMaxPositionPct",
        "validForTradeDate",
        "triggerPrice",
        "failurePrice",
        "targetPrice",
        "strategyProfile",
      ];
      const changesPlan = planInputKeys.some((key) => Object.hasOwn(payload, key));
      if (["entered", "holding", "exited", "reviewed"].includes(previous.status)) {
        assertCondition(!changesPlan, "买入后不能修改已冻结的交易计划");
      }
      const updates = previous.status === "planned" && changesPlan
        ? { ...payload, ...revokedLicenseFields() }
        : payload;
      res.json(saveTradeRecordFile(updates, previous));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/decision/trade-records/:id", (req, res, next) => {
    try {
      const deleted = deleteTradeRecordFile(req.params.id);
      res.json({
        id: deleted.id,
        deleted: true,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/decision/stocks/search", async (req, res, next) => {
    try {
      const query = String(req.query.query ?? req.query.q ?? "").trim();
      if (!query) {
        res.json({ query: "", items: [] });
        return;
      }
      const result = await engine.searchInstruments({ q: query, limit: 8 });
      const items = (Array.isArray(result?.items) ? result.items : [])
        .map((item) => ({
          code: String(item?.orderBookId ?? item?.code ?? "").split(".")[0],
          name: String(item?.name ?? "").trim(),
        }))
        .filter((item) => /^\d{6}$/u.test(item.code) && item.name);
      res.json({ query, items });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    const status =
      error?.status ??
      (error instanceof EngineClientError ? error.status : 500);
    const errorCode = publicErrorCode({ ...error, status });

    res.status(status).json({
      error: {
        code: errorCode,
        message: error.message ?? "未知错误",
        details: error.details ?? null,
      },
    });
  });

  let disposed = false;
  app.dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    database.close();
  };

  return app;
}
