import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import {
  buildNoTradeHint,
  buildRunDetailItems,
  buildTradePairs,
  createRunAnalysis,
  formatOrderBookId,
  resolveBenchmarkLabel,
} from "../../web/src/utils/runAnalysis.js";
import {
  buildMetricSnapshot,
  buildRollingRanges,
  buildSampleRanges,
  createIntegrityReport,
  enumerateParameterCombos,
  enumerateRandomParameterCombos,
} from "./analysis.js";
import { DEFAULT_APP_CONFIG } from "./config-defaults.js";
import { createDatabase } from "./db.js";
import { createMainlineRankingStore } from "./mainline-ranking-store.js";
import { createEngineClient, EngineClientError } from "./engine-client.js";
import { createReplayLifecycle } from "./replay-lifecycle.js";
import { createReplayLifecycleStore } from "./replay-lifecycle-store.js";
import {
  applyRuntimeEnvironmentUpdates,
  buildRuntimeEnvironmentUpdates,
  mergeNetworkConfigPayload,
  mergeNetworkConfigUpdatePayload,
  normalizeNetworkConfigPayload,
  persistEnvironmentUpdates,
  readNetworkConfigSnapshot,
  toPublicNetworkConfig,
} from "./network-config.js";
import {
  assertSafeUpstreamResult,
  createUpstreamServiceError,
  normalizeUpstreamTestRequest,
  upstreamTestForbiddenSecrets,
} from "./upstream-test.js";
import { formatBeijingDateTime, formatBeijingFileStamp } from "./time.js";
import { calculateTradeLicense, resolveTradeRecordLifecycle } from "./trade-license.js";
import { calculateTradeLedger } from "./trade-ledger.js";
import { createWorkspaceService } from "./workspace.js";

const DEFAULT_PORT = Number(process.env.PORT ?? 3100);
const ADJUST_OPTIONS = new Set(["qfq", "hfq", "none"]);
const INTERVAL_OPTIONS = new Set(["1d"]);
const REQUEST_DATA_PROVIDERS = new Set(["akshare"]);
const DECISION_ANALYSIS_TYPES = new Set([
  "mainline_scan",
  "market_scan",
  "stock_diagnosis",
]);
const DATA_PROVIDER_DISPLAY_NAMES = {
  akshare: "AkShare / Eastmoney",
};
const ANALYSIS_METRIC_OPTIONS = new Set([
  "totalReturn",
  "annualReturn",
  "maxDrawdown",
  "sharpeRatio",
  "winRate",
]);
const WORKSPACE_ONLY_BACKTEST_MESSAGE =
  "内置模板回测已下线，请使用 strategies 目录中的代码策略。";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORAGE_ROOT = resolve(MODULE_DIR, "..", "..", "storage");
const DEFAULT_TRADE_RECORDS_ROOT = resolve(MODULE_DIR, "..", "..", "..", "trade-records");
const DEFAULT_STOCK_DECISION_SERVICE_URL =
  process.env.QUANT_WORKBENCH_STOCK_DECISION_SERVICE_URL ??
  `http://127.0.0.1:${process.env.QUANT_WORKBENCH_STOCK_DECISION_PORT ?? 8020}`;
const DEFAULT_CAPITAL_FLOW_URL =
  process.env.QUANT_WORKBENCH_CAPITAL_FLOW_URL ??
  `http://127.0.0.1:${process.env.QUANT_WORKBENCH_CAPITAL_FLOW_PORT ?? 4187}`;
const UPSTREAM_TEST_TIMEOUT_MS = 75_000;
const DEFAULT_REPLAY_COST_CONFIG = Object.freeze({
  commissionRate: 0.0003,
  minCommission: 5,
  stampTaxRate: 0.0005,
  transferFeeRate: 0.00001,
  slippageBps: 0,
});

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

function createForwardError(error, message) {
  const wrapped = new Error(message);
  wrapped.status = error?.status ?? 500;
  if (error?.details !== undefined) {
    wrapped.details = error.details;
  }
  return wrapped;
}

function normalizeBody(body) {
  return body && typeof body === "object" ? body : {};
}

function normalizeReplayCostConfig(value) {
  const input = value == null ? {} : value;
  assertCondition(
    input && typeof input === "object" && !Array.isArray(input),
    "costConfig 必须是对象",
  );
  const allowedFields = new Set(Object.keys(DEFAULT_REPLAY_COST_CONFIG));
  assertCondition(
    Object.keys(input).every((key) => allowedFields.has(key)),
    "costConfig 包含不支持的字段",
  );
  const config = {
    ...DEFAULT_REPLAY_COST_CONFIG,
    ...input,
  };
  for (const field of [
    "commissionRate",
    "stampTaxRate",
    "transferFeeRate",
  ]) {
    assertCondition(
      typeof config[field] === "number" &&
        Number.isFinite(config[field]) &&
        config[field] >= 0 &&
        config[field] < 1,
      `${field} 必须是大于等于 0 且小于 1 的数字`,
    );
  }
  assertCondition(
    typeof config.minCommission === "number" &&
      Number.isFinite(config.minCommission) &&
      config.minCommission >= 0,
    "minCommission 必须是大于等于 0 的数字",
  );
  assertCondition(
    typeof config.slippageBps === "number" &&
      Number.isFinite(config.slippageBps) &&
      config.slippageBps >= 0 &&
      config.slippageBps < 10000,
    "slippageBps 必须是大于等于 0 且小于 10000 的数字",
  );
  return config;
}

function normalizeReplayAction(body) {
  assertCondition(typeof body.actionId === "string", "actionId 必须是字符串");
  const actionId = body.actionId.trim();
  assertCondition(
    actionId.length > 0 && actionId.length <= 128,
    "actionId 必须是 1 至 128 个字符",
  );
  assertCondition(
    typeof body.expectedRevision === "number" &&
      Number.isSafeInteger(body.expectedRevision) &&
      body.expectedRevision >= 0,
    "expectedRevision 必须是大于等于 0 的安全整数",
  );
  return {
    actionId,
    expectedRevision: body.expectedRevision,
  };
}

function normalizeReplayOrder(body) {
  const allowedFields = new Set([
    "actionId",
    "expectedRevision",
    "side",
    "quantity",
    "cashRatio",
    "positionRatio",
    "decision",
  ]);
  assertCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "委托包含不支持的字段",
  );
  const action = normalizeReplayAction(body);
  const side = String(body.side ?? "")
    .trim()
    .toLowerCase();
  assertCondition(["buy", "sell"].includes(side), "side 只支持 buy 或 sell");
  const selectors = [
    body.quantity == null ? null : "shares",
    body.cashRatio == null ? null : "cash_ratio",
    body.positionRatio == null ? null : "position_ratio",
  ].filter(Boolean);
  assertCondition(selectors.length === 1, "委托必须且只能指定一种数量方式");
  const quantityType = selectors[0];
  if (quantityType === "shares") {
    assertCondition(
      typeof body.quantity === "number" &&
        Number.isSafeInteger(body.quantity) &&
        body.quantity >= 100,
      "quantity 必须是大于等于 100 的安全整数",
    );
  }
  if (quantityType === "cash_ratio") {
    assertCondition(side === "buy", "cashRatio 仅支持买入委托");
    assertCondition(
      typeof body.cashRatio === "number" &&
        Number.isFinite(body.cashRatio) &&
        body.cashRatio > 0 &&
        body.cashRatio <= 1,
      "cashRatio 必须大于 0 且不超过 1",
    );
  }
  if (quantityType === "position_ratio") {
    assertCondition(side === "sell", "positionRatio 仅支持卖出委托");
    assertCondition(
      typeof body.positionRatio === "number" &&
        Number.isFinite(body.positionRatio) &&
        body.positionRatio > 0 &&
        body.positionRatio <= 1,
      "positionRatio 必须大于 0 且不超过 1",
    );
  }
  const order = {
    side,
    quantityType,
    requestedQuantity:
      quantityType === "shares" ? body.quantity : null,
    ratio:
      quantityType === "cash_ratio"
        ? body.cashRatio
        : quantityType === "position_ratio"
          ? body.positionRatio
          : null,
    decision: normalizeReplayOrderDecision(body.decision, side),
  };
  return {
    ...action,
    order,
    requestPayload: {
      expectedRevision: action.expectedRevision,
      ...order,
    },
  };
}

function normalizeReplayOrderDecision(value, side) {
  if (value == null) {
    return null;
  }
  assertCondition(
    value && typeof value === "object" && !Array.isArray(value),
    "decision 必须是对象或 null",
  );
  const allowedFields = new Set([
    "reasonTags",
    "confidence",
    "thesis",
    "plan",
    "riskPlan",
    "stopLossPrice",
    "invalidationRule",
    "exitType",
    "remainingPositionPlan",
  ]);
  assertCondition(
    Object.keys(value).every((key) => allowedFields.has(key)),
    "decision 包含不支持的字段",
  );
  const reasonTags = normalizeReplayReasonTags(value.reasonTags, { required: true });
  const confidence = Number(value.confidence);
  assertCondition(
    Number.isSafeInteger(confidence) && confidence >= 1 && confidence <= 5,
    "decision.confidence 必须是 1 至 5 的整数",
  );
  const thesis = String(value.thesis ?? "").trim();
  const plan = String(value.plan ?? "").trim();
  assertCondition(thesis.length >= 10 && thesis.length <= 2000, "decision.thesis 必须是 10 至 2000 个字符");
  assertCondition(plan.length >= 10 && plan.length <= 2000, "decision.plan 必须是 10 至 2000 个字符");

  if (side === "buy") {
    const riskPlan = String(value.riskPlan ?? "").trim();
    assertCondition(riskPlan.length >= 10 && riskPlan.length <= 1000, "decision.riskPlan 必须是 10 至 1000 个字符");
    const stopLossPrice = normalizeReplayPositivePrice(value.stopLossPrice, "decision.stopLossPrice");
    const invalidationRule = normalizeReplayInvalidationRule(value.invalidationRule, { partial: false });
    assertCondition(
      stopLossPrice != null || invalidationRule != null,
      "买入决策必须填写止损价或失效条件",
    );
    return {
      reasonTags,
      confidence,
      thesis,
      plan,
      riskPlan,
      stopLossPrice,
      invalidationRule,
    };
  }

  const exitType = String(value.exitType ?? "").trim().toLowerCase();
  assertCondition(
    ["take_profit", "stop_loss", "thesis_invalidated", "reduce_risk", "manual"].includes(exitType),
    "decision.exitType 不受支持",
  );
  const remainingPositionPlan = String(value.remainingPositionPlan ?? "").trim();
  assertCondition(
    remainingPositionPlan.length >= 2 && remainingPositionPlan.length <= 1000,
    "decision.remainingPositionPlan 必须是 2 至 1000 个字符",
  );
  return {
    reasonTags,
    confidence,
    thesis,
    plan,
    exitType,
    remainingPositionPlan,
  };
}

function normalizeReplayBlindReview(body) {
  const allowedFields = new Set([
    "actionId",
    "expectedRevision",
    "strategyName",
    "playbookId",
    "playbookVersionId",
    "thesis",
    "tradePlan",
    "riskPlan",
    "confidence",
    "trendView",
    "outlook",
    "reasonTags",
    "stopLossPrice",
    "invalidationRule",
  ]);
  assertCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "盲评包含不支持的字段",
  );
  const action = normalizeReplayAction(body);
  const strategyName = String(body.strategyName ?? "").trim();
  const playbookId = String(body.playbookId ?? "").trim();
  const playbookVersionId = String(body.playbookVersionId ?? "").trim();
  const thesis = String(body.thesis ?? "").trim();
  const tradePlan = String(body.tradePlan ?? "").trim();
  const riskPlan = String(body.riskPlan ?? "").trim();
  assertCondition(strategyName.length <= 120, "strategyName 最多 120 个字符");
  assertCondition(
    Boolean(playbookId) === Boolean(playbookVersionId),
    "playbookId 和 playbookVersionId 必须同时提供",
  );
  assertCondition(playbookId.length <= 120, "playbookId 最多 120 个字符");
  assertCondition(
    playbookVersionId.length <= 120,
    "playbookVersionId 最多 120 个字符",
  );
  assertCondition(
    thesis.length >= 10 && thesis.length <= 2000,
    "thesis 必须是 10 至 2000 个字符",
  );
  assertCondition(
    tradePlan.length >= 10 && tradePlan.length <= 2000,
    "tradePlan 必须是 10 至 2000 个字符",
  );
  assertCondition(
    riskPlan.length >= 10 && riskPlan.length <= 1000,
    "riskPlan 必须是 10 至 1000 个字符",
  );
  assertCondition(
    typeof body.confidence === "number" &&
      Number.isSafeInteger(body.confidence) &&
      body.confidence >= 1 &&
      body.confidence <= 5,
    "confidence 必须是 1 至 5 的整数",
  );
  const allowedViews = ["bullish", "bearish", "range", "uncertain"];
  const normalizeOptionalMarketView = (field) => {
    if (!Object.hasOwn(body, field)) {
      return null;
    }
    const value = String(body[field] ?? "").trim().toLowerCase();
    assertCondition(allowedViews.includes(value), `${field} 不受支持`);
    return value;
  };
  const trendView = normalizeOptionalMarketView("trendView");
  const outlook = normalizeOptionalMarketView("outlook");
  const reasonTags = normalizeReplayReasonTags(body.reasonTags, {
    required: true,
  });
  const stopLossPrice = normalizeReplayPositivePrice(
    body.stopLossPrice,
    "stopLossPrice",
  );
  const invalidationRule = normalizeReplayInvalidationRule(
    body.invalidationRule,
    { partial: false },
  );
  const review = {
    strategyName,
    ...(playbookId ? { playbookId, playbookVersionId } : {}),
    thesis,
    tradePlan,
    riskPlan,
    confidence: body.confidence,
    ...(trendView ? { trendView } : {}),
    ...(outlook ? { outlook } : {}),
    reasonTags,
    stopLossPrice,
    invalidationRule,
  };
  return {
    ...action,
    review,
    requestPayload: {
      expectedRevision: action.expectedRevision,
      review,
    },
  };
}

function normalizeReplayPositivePrice(value, fieldName) {
  if (value == null) {
    return null;
  }
  assertCondition(
    typeof value === "number" && Number.isFinite(value) && value > 0,
    `${fieldName} 必须是正数或 null`,
  );
  return value;
}

function normalizeReplayReasonTags(value, { required }) {
  if (value == null && !required) {
    return undefined;
  }
  assertCondition(Array.isArray(value), "reasonTags 必须是数组");
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    assertCondition(typeof item === "string", "reasonTags 每项必须是字符串");
    const tag = item.trim();
    assertCondition(
      tag.length >= 1 && tag.length <= 40,
      "reasonTags 每项必须是 1 至 40 个字符",
    );
    if (!seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  assertCondition(
    normalized.length <= 8,
    "reasonTags 最多 8 项",
  );
  if (required) {
    assertCondition(normalized.length >= 1, "reasonTags 至少 1 项");
  }
  return normalized;
}

function normalizeReplayInvalidationRule(value, { partial }) {
  if (value == null) {
    return null;
  }
  assertCondition(
    typeof value === "object" &&
      !Array.isArray(value),
    "invalidationRule 必须是对象或 null",
  );
  const allowedFields = new Set(["basis", "operator", "threshold", "note"]);
  assertCondition(
    Object.keys(value).every((key) => allowedFields.has(key)),
    "invalidationRule 包含不支持的字段",
  );
  const result = {};
  if (!partial || Object.hasOwn(value, "basis")) {
    const basis = String(value.basis ?? "").trim().toLowerCase();
    assertCondition(basis === "close", "invalidationRule.basis 只支持 close");
    result.basis = basis;
  }
  if (!partial || Object.hasOwn(value, "operator")) {
    const operator = String(value.operator ?? "").trim().toLowerCase();
    assertCondition(
      ["lte", "gte"].includes(operator),
      "invalidationRule.operator 只支持 lte、gte",
    );
    result.operator = operator;
  }
  if (!partial || Object.hasOwn(value, "threshold")) {
    if (partial && value.threshold == null) {
      result.threshold = null;
    } else {
      result.threshold = normalizeReplayPositivePrice(
        value.threshold,
        "invalidationRule.threshold",
      );
      assertCondition(
        result.threshold != null,
        "invalidationRule.threshold 必须是正数",
      );
    }
  }
  if (Object.hasOwn(value, "note")) {
    assertCondition(
      typeof value.note === "string",
      "invalidationRule.note 必须是字符串",
    );
    const note = value.note.trim();
    assertCondition(
      note.length <= 300,
      "invalidationRule.note 最多 300 个字符",
    );
    result.note = note;
  }
  return result;
}

function normalizeReplayTrainingSelection(body) {
  const mode = body.trainingMode == null
    ? "free"
    : String(body.trainingMode).trim();
  assertCondition(mode === "free", "trainingMode 只支持 free");
  const playbookId = String(body.playbookId ?? "").trim();
  const playbookVersionId = String(body.playbookVersionId ?? "").trim();
  assertCondition(playbookId.length <= 120, "playbookId 最多 120 个字符");
  assertCondition(
    playbookVersionId.length <= 120,
    "playbookVersionId 最多 120 个字符",
  );
  assertCondition(
    !playbookId && !playbookVersionId,
    "自由演练不能在开局时指定战法",
  );
  return { mode };
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

function normalizeReplayPostReview(body) {
  const allowedFields = new Set([
    "actionId",
    "expectedRevision",
    "outcome",
    "executionReview",
    "mistakes",
    "lessons",
    "disciplineScore",
    "riskControlScore",
    "playbookFitScore",
    "strategyAdjustment",
  ]);
  assertCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "事后复盘包含不支持的字段",
  );
  const action = normalizeReplayAction(body);
  const outcome = String(body.outcome ?? "").trim().toLowerCase();
  const executionReview = String(body.executionReview ?? "").trim();
  const mistakes = String(body.mistakes ?? "").trim();
  const lessons = String(body.lessons ?? "").trim();
  const strategyAdjustment = String(body.strategyAdjustment ?? "").trim();
  assertCondition(
    ["correct", "partial", "wrong"].includes(outcome),
    "outcome 只支持 correct、partial 或 wrong",
  );
  assertCondition(
    executionReview.length >= 10 && executionReview.length <= 2000,
    "executionReview 必须是 10 至 2000 个字符",
  );
  assertCondition(
    mistakes.length >= 1 && mistakes.length <= 2000,
    "mistakes 必须是 1 至 2000 个字符",
  );
  assertCondition(
    lessons.length >= 10 && lessons.length <= 2000,
    "lessons 必须是 10 至 2000 个字符",
  );
  assertCondition(
    typeof body.disciplineScore === "number" &&
      Number.isSafeInteger(body.disciplineScore) &&
      body.disciplineScore >= 1 &&
      body.disciplineScore <= 5,
    "disciplineScore 必须是 1 至 5 的整数",
  );
  assertCondition(
    typeof body.riskControlScore === "number" &&
      Number.isSafeInteger(body.riskControlScore) &&
      body.riskControlScore >= 1 &&
      body.riskControlScore <= 5,
    "riskControlScore 必须是 1 至 5 的整数",
  );
  assertCondition(
    body.playbookFitScore == null ||
      (typeof body.playbookFitScore === "number" &&
        Number.isSafeInteger(body.playbookFitScore) &&
        body.playbookFitScore >= 1 &&
        body.playbookFitScore <= 5),
    "playbookFitScore 必须是 1 至 5 的整数",
  );
  assertCondition(
    strategyAdjustment.length <= 2000,
    "strategyAdjustment 最多 2000 个字符",
  );
  const review = {
    outcome,
    executionReview,
    mistakes,
    lessons,
    disciplineScore: body.disciplineScore,
    riskControlScore: body.riskControlScore,
    ...(body.playbookFitScore == null
      ? {}
      : { playbookFitScore: body.playbookFitScore }),
    strategyAdjustment,
  };
  return {
    ...action,
    review,
    requestPayload: {
      expectedRevision: action.expectedRevision,
      review,
    },
  };
}

function normalizeReplayReviewCorrection(body, stage) {
  const changeNote = String(body.changeNote ?? "").trim();
  assertCondition(
    changeNote.length >= 1 && changeNote.length <= 500,
    "changeNote 必须是 1 至 500 个字符",
  );
  const reviewBody = { ...body };
  delete reviewBody.changeNote;
  const normalized =
    stage === "blind"
      ? normalizeReplayBlindReview(reviewBody)
      : normalizeReplayPostReview(reviewBody);
  return {
    ...normalized,
    changeNote,
    requestPayload: {
      ...normalized.requestPayload,
      changeNote,
    },
  };
}

function normalizeReplayReviewDraftRequest(body, stage) {
  assertCondition(
    Object.keys(body).length === 2 &&
      Object.hasOwn(body, "draft") &&
      Object.hasOwn(body, "expectedRevision"),
    "草稿请求只支持 draft 和 expectedRevision 字段",
  );
  assertCondition(
    typeof body.expectedRevision === "number" &&
      Number.isSafeInteger(body.expectedRevision) &&
      body.expectedRevision >= 0,
    "expectedRevision 必须是大于等于 0 的安全整数",
  );
  const draft = body.draft;
  assertCondition(
    draft &&
      typeof draft === "object" &&
      !Array.isArray(draft),
    "draft 必须是对象",
  );
  const textLimits =
    stage === "blind"
      ? {
          strategyName: 120,
          playbookId: 120,
          playbookVersionId: 120,
          thesis: 2000,
          tradePlan: 2000,
          riskPlan: 1000,
        }
      : {
          executionReview: 2000,
          mistakes: 2000,
          lessons: 2000,
          strategyAdjustment: 2000,
        };
  const structuredFields =
    stage === "blind"
      ? [
          "confidence",
          "trendView",
          "outlook",
          "reasonTags",
          "stopLossPrice",
          "invalidationRule",
        ]
      : [
          "outcome",
          "disciplineScore",
          "riskControlScore",
          "playbookFitScore",
        ];
  const allowedFields = new Set([
    ...Object.keys(textLimits),
    ...structuredFields,
  ]);
  assertCondition(
    Object.keys(draft).every((key) => allowedFields.has(key)),
    "draft 包含不支持的字段",
  );
  const normalized = {};
  for (const [field, maximum] of Object.entries(textLimits)) {
    if (!Object.hasOwn(draft, field)) {
      continue;
    }
    assertCondition(typeof draft[field] === "string", `${field} 必须是字符串`);
    const value = draft[field].trim();
    assertCondition(value.length <= maximum, `${field} 最多 ${maximum} 个字符`);
    normalized[field] = value;
  }
  if (stage === "blind") {
    if (Object.hasOwn(draft, "confidence")) {
      assertReplayDraftScore(draft.confidence, "confidence");
      normalized.confidence = draft.confidence;
    }
    for (const field of ["trendView", "outlook"]) {
      if (!Object.hasOwn(draft, field)) {
        continue;
      }
      assertCondition(typeof draft[field] === "string", `${field} 必须是字符串`);
      const value = draft[field].trim().toLowerCase();
      assertCondition(
        value === "" ||
          ["bullish", "bearish", "range", "uncertain"].includes(value),
        `${field} 不受支持`,
      );
      normalized[field] = value;
    }
    if (Object.hasOwn(draft, "reasonTags")) {
      normalized.reasonTags = normalizeReplayReasonTags(draft.reasonTags, {
        required: false,
      });
    }
    if (Object.hasOwn(draft, "stopLossPrice")) {
      normalized.stopLossPrice = normalizeReplayPositivePrice(
        draft.stopLossPrice,
        "stopLossPrice",
      );
    }
    if (Object.hasOwn(draft, "invalidationRule")) {
      normalized.invalidationRule = normalizeReplayInvalidationRule(
        draft.invalidationRule,
        { partial: true },
      );
    }
  } else {
    if (Object.hasOwn(draft, "outcome")) {
      assertCondition(typeof draft.outcome === "string", "outcome 必须是字符串");
      const outcome = draft.outcome.trim().toLowerCase();
      assertCondition(
        outcome === "" || ["correct", "partial", "wrong"].includes(outcome),
        "outcome 不受支持",
      );
      normalized.outcome = outcome;
    }
    for (const field of [
      "disciplineScore",
      "riskControlScore",
      "playbookFitScore",
    ]) {
      if (!Object.hasOwn(draft, field)) {
        continue;
      }
      assertReplayDraftScore(draft[field], field);
      normalized[field] = draft[field];
    }
  }
  return {
    draft: normalized,
    expectedRevision: body.expectedRevision,
  };
}

function normalizeReplayReviewDraftDeleteRequest(body) {
  assertCondition(
    Object.keys(body).length === 1 &&
      Object.hasOwn(body, "expectedRevision"),
    "删除草稿请求只支持 expectedRevision 字段",
  );
  assertCondition(
    typeof body.expectedRevision === "number" &&
      Number.isSafeInteger(body.expectedRevision) &&
      body.expectedRevision >= 0,
    "expectedRevision 必须是大于等于 0 的安全整数",
  );
  return {
    expectedRevision: body.expectedRevision,
  };
}

function assertReplayDraftScore(value, fieldName) {
  assertCondition(
    value == null ||
      (typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 1 &&
        value <= 5),
    `${fieldName} 必须是 1 至 5 的整数或 null`,
  );
}

function normalizeReplayHistoryQuery(query) {
  const allowedStates = new Set([
    "all",
    "active",
    "awaiting_blind",
    "awaiting_reveal",
    "awaiting_post",
    "reviewed",
    "skipped",
  ]);
  const state = String(query.state ?? "all").trim().toLowerCase();
  assertCondition(allowedStates.has(state), "state 不受支持");
  const attemptKind = String(query.attemptKind ?? "all")
    .trim()
    .toLowerCase();
  assertCondition(
    ["all", "first", "retrain"].includes(attemptKind),
    "attemptKind 不受支持",
  );
  const keyword = String(query.keyword ?? "").trim();
  assertCondition(keyword.length <= 120, "keyword 最多 120 个字符");
  const page = query.page == null || query.page === ""
    ? 1
    : Number(query.page);
  const pageSize = query.pageSize == null || query.pageSize === ""
    ? 20
    : Number(query.pageSize);
  assertCondition(
    Number.isSafeInteger(page) && page >= 1,
    "page 必须是大于等于 1 的安全整数",
  );
  assertCondition(
    Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 100,
    "pageSize 必须是 1 至 100 的安全整数",
  );
  return {
    state,
    attemptKind,
    keyword,
    page,
    pageSize,
  };
}

function roundReplayValue(value) {
  return Number(Number(value).toFixed(10));
}

function classifyReplayMarketStatus(bar) {
  if (!bar) {
    return "invalid_market_data";
  }
  const volume = Number(bar.volume);
  if (!Number.isFinite(volume) || volume <= 0) {
    return "suspended";
  }
  const prices = [bar.open, bar.high, bar.low, bar.close].map(Number);
  if (prices.some((price) => !Number.isFinite(price) || price <= 0)) {
    return "invalid_market_data";
  }
  const limitType =
    typeof bar.limitType === "string" && bar.limitType.trim()
      ? bar.limitType.trim().toUpperCase()
      : null;
  if (limitType === "U") {
    return "limit_up";
  }
  if (limitType === "D") {
    return "limit_down";
  }
  return "normal";
}

function normalizeDecisionAnalysisDate(value) {
  const text = String(value ?? "").trim();
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  return beijingToday();
}

function normalizeDecisionAnalysisSnapshotPayload(body) {
  const payload = normalizeBody(body);
  const analysisType = String(payload.analysisType ?? payload.type ?? "").trim();
  assertCondition(
    DECISION_ANALYSIS_TYPES.has(analysisType),
    "analysisType 只支持 mainline_scan、market_scan、stock_diagnosis",
  );
  const sourceKey = String(payload.sourceKey ?? "").trim();
  assertCondition(sourceKey.length > 0, "缺少 sourceKey");
  assertCondition(
    payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload),
    "payload 必须是对象",
  );
  return {
    analysisType,
    analysisDate: normalizeDecisionAnalysisDate(payload.analysisDate),
    sourceKey,
    stockCode: String(payload.stockCode ?? "").trim() || null,
    stockName: String(payload.stockName ?? "").trim() || null,
    title: String(payload.title ?? "").trim() || "决策台分析",
    summary:
      payload.summary && typeof payload.summary === "object" && !Array.isArray(payload.summary)
        ? payload.summary
        : null,
    payload: payload.payload,
  };
}

function normalizeStockQueryRecordPayload(body) {
  const payload = normalizeBody(body);
  const stockCode = String(payload.stockCode ?? payload.code ?? "").trim();
  assertCondition(/^\d{6}$/.test(stockCode), "stockCode 必须是 6 位股票代码");
  const stockName = String(payload.stockName ?? payload.name ?? stockCode).trim() || stockCode;
  const technicalScore = Number(payload.technicalScore);
  const opportunityScore = Number(payload.opportunityScore);
  const summary =
    payload.summary && typeof payload.summary === "object" && !Array.isArray(payload.summary)
      ? payload.summary
      : null;
  return {
    queryDate: normalizeDecisionAnalysisDate(payload.queryDate),
    stockCode,
    stockName,
    inputText: String(payload.inputText ?? "").trim(),
    analysisDate: normalizeDecisionAnalysisDate(payload.analysisDate),
    action: String(payload.action ?? "").trim() || null,
    technicalScore:
      payload.technicalScore == null || payload.technicalScore === ""
        ? null
        : Number.isFinite(technicalScore)
          ? technicalScore
          : null,
    opportunityScore:
      payload.opportunityScore == null || payload.opportunityScore === ""
        ? null
        : Number.isFinite(opportunityScore)
          ? opportunityScore
          : null,
    summary,
  };
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeAdjust(value) {
  const normalized = String(value ?? "qfq")
    .trim()
    .toLowerCase();
  return normalized || "qfq";
}

function normalizeRequestedDataProvider(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "akshare";
  }
  assertCondition(
    REQUEST_DATA_PROVIDERS.has(normalized),
    "dataProvider 当前只支持 akshare（AkShare / Eastmoney）",
  );
  return normalized;
}

function formatDataProviderLabel(provider, fallback = "--") {
  const normalized = String(provider ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return DATA_PROVIDER_DISPLAY_NAMES[normalized] || provider;
}

function beijingToday(value = new Date()) {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseOrderBookId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  const matched = normalized.match(/^(\d{6})\.(XSHG|XSHE|BSE|XBSE)$/);
  if (!matched) {
    return null;
  }
  const exchangeToken = matched[2];
  return {
    orderBookId: normalized,
    symbol: matched[1],
    exchange:
      exchangeToken === "XSHG"
        ? "SSE"
        : exchangeToken === "XSHE"
          ? "SZSE"
          : "BSE",
  };
}

function normalizeBenchmarkValue(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  const benchmarkPattern = /^\d{6}\.(XSHG|XSHE)$/;
  assertCondition(
    !normalized || benchmarkPattern.test(normalized),
    "benchmark 格式必须是 000300.XSHG",
  );
  return normalized;
}

function extractOrderBookIdFromSource(sourceCode) {
  const current = String(sourceCode ?? "");
  const assignmentMatch = current.match(
    /^[ \t]*context\.s1\s*=\s*["'](\d{6}\.(?:XSHG|XSHE))["']/m,
  );
  if (assignmentMatch?.[1]) {
    return parseOrderBookId(assignmentMatch[1]);
  }
  const headerMatch = current.match(
    /^[ \t]*标的[：:]\s*["']?(\d{6}\.(?:XSHG|XSHE))["']?\s*$/m,
  );
  if (headerMatch?.[1]) {
    return parseOrderBookId(headerMatch[1]);
  }
  return null;
}

function validateAdjust(body) {
  const adjust = normalizeAdjust(body.adjust);
  assertCondition(ADJUST_OPTIONS.has(adjust), "复权方式只支持 qfq、hfq、none");
  body.adjust = adjust;
}

function normalizeInterval(value) {
  const interval =
    String(value ?? "1d")
      .trim()
      .toLowerCase() || "1d";
  assertCondition(INTERVAL_OPTIONS.has(interval), "周期当前只支持 1d");
  return interval;
}

function validateMarketRequest(body) {
  assertCondition(/^\d{6}$/.test(body.symbol ?? ""), "标的代码必须是 6 位数字");
  assertCondition(
    ["SSE", "SZSE"].includes(body.exchange),
    "交易所只支持 SSE 或 SZSE",
  );
  body.interval = normalizeInterval(body.interval);
  validateAdjust(body);
  body.dataProvider = normalizeRequestedDataProvider(body.dataProvider);
  assertCondition(isValidDate(body.startDate), "开始日期格式必须是 YYYY-MM-DD");
  assertCondition(isValidDate(body.endDate), "结束日期格式必须是 YYYY-MM-DD");
  assertCondition(body.startDate < body.endDate, "开始日期必须早于结束日期");
}

function validateBacktestRequest(body) {
  validateMarketRequest(body);
  assertCondition(
    typeof body.strategyId === "string" && body.strategyId.length > 0,
    "缺少 strategyId",
  );
  assertCondition(
    typeof body.capital === "number" && body.capital > 0,
    "capital 必须大于 0",
  );
  assertCondition(
    typeof body.slippage === "number" && body.slippage >= 0,
    "slippage 不能小于 0",
  );
  assertCondition(
    typeof body.rate === "number" && body.rate >= 0,
    "rate 不能小于 0",
  );
  body.benchmark = normalizeBenchmarkValue(body.benchmark);
}

function parseSplitRatio(value, fallback = 0.7) {
  const parsed = Number(value ?? fallback);
  assertCondition(Number.isFinite(parsed), "样本内比例必须是数字");
  assertCondition(
    parsed >= 0.1 && parsed <= 0.9,
    "样本内比例必须在 0.1 到 0.9 之间",
  );
  return parsed;
}

function parseRollingDayConfig(value, fallback, fieldName) {
  const parsed = Number(value ?? fallback);
  assertCondition(Number.isFinite(parsed), `${fieldName} 必须是数字`);
  const normalized = Math.floor(parsed);
  assertCondition(normalized >= 5, `${fieldName} 不能小于 5`);
  return normalized;
}

function normalizeOptimizationMethod(value) {
  const method = String(value ?? "grid")
    .trim()
    .toLowerCase();
  assertCondition(
    ["grid", "random"].includes(method),
    "优化方式只支持 grid 或 random",
  );
  return method;
}

function validateWorkspaceRunRequest(body) {
  assertCondition(
    typeof body.path === "string" && body.path.trim().length > 0,
    "缺少策略文件路径",
  );
  assertCondition(body.path.endsWith(".py"), "当前只支持运行 Python 策略文件");
  assertCondition(
    typeof body.sourceCode === "string" && body.sourceCode.trim().length > 0,
    "策略代码不能为空",
  );
  validateAdjust(body);
  body.dataProvider = normalizeRequestedDataProvider(body.dataProvider);
  assertCondition(isValidDate(body.startDate), "开始日期格式必须是 YYYY-MM-DD");
  assertCondition(isValidDate(body.endDate), "结束日期格式必须是 YYYY-MM-DD");
  assertCondition(body.startDate < body.endDate, "开始日期必须早于结束日期");
  assertCondition(
    typeof body.capital === "number" && body.capital > 0,
    "capital 必须大于 0",
  );
  assertCondition(
    typeof body.slippage === "number" && body.slippage >= 0,
    "slippage 不能小于 0",
  );
  assertCondition(
    typeof body.rate === "number" && body.rate >= 0,
    "rate 不能小于 0",
  );
  body.benchmark = normalizeBenchmarkValue(body.benchmark);
}

function normalizeStrategyParameters(value) {
  if (value == null) {
    return {};
  }
  assertCondition(
    value && typeof value === "object" && !Array.isArray(value),
    "strategyParameters 必须是对象",
  );
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, currentValue]) => [String(key ?? "").trim(), currentValue])
      .filter(([key]) => key.length > 0),
  );
}

function normalizeAnalysisMetric(value) {
  const metric = String(value ?? "sharpeRatio").trim() || "sharpeRatio";
  assertCondition(
    ANALYSIS_METRIC_OPTIONS.has(metric),
    "metric 只支持 totalReturn、annualReturn、maxDrawdown、sharpeRatio、winRate",
  );
  return metric;
}

function buildWorkspaceParameterDefinitions(parameterRanges) {
  assertCondition(
    parameterRanges &&
      typeof parameterRanges === "object" &&
      !Array.isArray(parameterRanges),
    "parameterRanges 必须是对象",
  );
  const definitions = Object.entries(parameterRanges)
    .map(([name, range]) => {
      assertCondition(
        range && typeof range === "object" && !Array.isArray(range),
        `参数 ${name} 的范围必须是对象`,
      );
      return {
        name,
        min: Number(range.start ?? 0),
        max: Number(range.end ?? range.start ?? 0),
        step: Number(range.step ?? 1),
      };
    })
    .filter((item) => item.name);
  assertCondition(definitions.length > 0, "至少需要配置一组参数范围", 400);
  return definitions;
}

function resolveWorkspaceOptimizationCombos(requestBody) {
  const method = normalizeOptimizationMethod(requestBody.method);
  const parameterRanges = requestBody.parameterRanges ?? {};
  const parameterDefinitions =
    buildWorkspaceParameterDefinitions(parameterRanges);

  if (method === "random") {
    const randomCount = Math.max(
      1,
      Math.min(80, Math.floor(Number(requestBody.randomCount ?? 20) || 20)),
    );
    const randomSeedInput = requestBody.randomSeed ?? null;
    const randomResolved = enumerateRandomParameterCombos(
      parameterDefinitions,
      parameterRanges,
      {
        count: randomCount,
        seed: randomSeedInput == null ? null : String(randomSeedInput),
      },
    );
    assertCondition(
      randomResolved.combos.length > 0,
      "至少需要配置一组参数范围",
      400,
    );
    return {
      method,
      combos: randomResolved.combos,
      candidateCombos: randomResolved.candidateCombos,
      randomCount,
      randomSeed: randomResolved.seed,
    };
  }

  const estimatedCombos = parameterDefinitions.reduce((product, parameter) => {
    const range = parameterRanges?.[parameter.name];
    const start = Math.floor(Number(range?.start ?? parameter.min ?? 0));
    const end = Math.floor(Number(range?.end ?? parameter.max ?? start));
    const step = Math.max(
      1,
      Math.floor(Number(range?.step ?? parameter.step ?? 1)),
    );
    const count = Math.max(0, Math.floor((end - start) / step) + 1);
    return product * Math.max(count, 1);
  }, 1);

  assertCondition(estimatedCombos <= 80, "单次参数优化最多支持 80 组组合", 400);

  const combos = enumerateParameterCombos(
    parameterDefinitions,
    parameterRanges,
  );
  assertCondition(combos.length > 0, "至少需要配置一组参数范围", 400);
  assertCondition(combos.length <= 80, "单次参数优化最多支持 80 组组合", 400);
  return {
    method,
    combos,
    candidateCombos: combos.length,
    randomCount: null,
    randomSeed: null,
  };
}

function buildRunMetricSummary(run) {
  const snapshot = buildMetricSnapshot(run);
  return {
    totalReturn: snapshot.totalReturn,
    annualReturn: snapshot.annualReturn,
    maxDrawdown: snapshot.maxDrawdown,
    sharpeRatio: snapshot.sharpeRatio,
    winRate: snapshot.winRate,
  };
}

function metricScore(metric, metrics) {
  const raw = Number(metrics?.[metric]);
  if (!Number.isFinite(raw)) {
    return Number.NEGATIVE_INFINITY;
  }
  return metric === "maxDrawdown" ? -raw : raw;
}

function rankAnalysisItems(items, metric) {
  return [...items].sort((left, right) => {
    const scoreDelta =
      metricScore(metric, right.metrics) - metricScore(metric, left.metrics);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return String(left.runId ?? "").localeCompare(
      String(right.runId ?? ""),
      "zh-CN",
    );
  });
}

function parsePagination(query, defaults = {}) {
  const maxPageSize = Number(defaults.maxPageSize ?? 200);
  const defaultPageSize = Number(defaults.pageSize ?? 20);
  const pageRaw = query.page;
  const pageSizeRaw = query.pageSize;
  const hasPageParam = pageRaw != null || pageSizeRaw != null;
  const page = Math.max(1, Number(pageRaw ?? 1) || 1);
  const pageSize = Math.max(
    1,
    Math.min(
      Number(pageSizeRaw ?? defaultPageSize) || defaultPageSize,
      maxPageSize,
    ),
  );
  return {
    hasPageParam,
    page,
    pageSize,
  };
}

function buildPaginationMeta({ page = 1, pageSize = 20, total = 0 }) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Number(pageSize) || 20);
  const safeTotal = Math.max(0, Number(total) || 0);
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  return {
    page: safePage,
    pageSize: safePageSize,
    total: safeTotal,
    totalPages,
  };
}

function coverageCoversRange(coverage, startDate, endDate) {
  if (!coverage?.startDate || !coverage?.endDate) {
    return false;
  }
  return coverage.startDate <= startDate && coverage.endDate >= endDate;
}

function coverageMatchesRequestedProvider(coverage, dataProvider) {
  if (!dataProvider) {
    return true;
  }
  return (
    String(coverage?.provider ?? "")
      .trim()
      .toLowerCase() === dataProvider
  );
}

function normalizeBenchmarkSyncRequest(benchmark, symbol, exchange) {
  const parsed = parseOrderBookId(benchmark);
  if (!parsed) {
    return null;
  }
  if (parsed.symbol === symbol && parsed.exchange === exchange) {
    return null;
  }
  return {
    symbol: parsed.symbol,
    exchange: parsed.exchange,
    adjust: "none",
    orderBookId: parsed.orderBookId,
  };
}

function expandBenchmarkSyncWindow(startDate, endDate) {
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return { startDate, endDate };
  }

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 7);
  end.setUTCDate(end.getUTCDate() + 7);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function normalizeCoverageItem(item) {
  const orderBookId = formatOrderBookId(item.symbol, item.exchange);
  return {
    ...item,
    orderBookId,
  };
}

const INSTRUMENT_DATASET_CONFIG = {
  CS: {
    factorSupported: true,
    financialKeys: ["stock_daily_basic", "stock_fina_indicator"],
    rawKeys: [
      "stock_daily_bars",
      "stock_adj_factors",
      "stock_daily_basic",
      "stock_fina_indicator",
      "stock_instruments",
    ],
  },
  ETF: {
    factorSupported: true,
    financialKeys: [],
    rawKeys: [
      "etf_daily_bars",
      "etf_adj_factors",
      "etf_instruments",
    ],
  },
  INDX: {
    factorSupported: false,
    financialKeys: [],
    rawKeys: ["index_daily_bars", "index_weights"],
  },
  DEFAULT: {
    factorSupported: false,
    financialKeys: [],
    rawKeys: [],
  },
};

const DATASET_FILTER_FIELD_MAP = {
  stock_daily_bars: "ts_code",
  etf_daily_bars: "ts_code",
  index_daily_bars: "ts_code",
  index_weights: "index_code",
  stock_adj_factors: "ts_code",
  etf_adj_factors: "ts_code",
  stock_daily_basic: "ts_code",
  stock_fina_indicator: "ts_code",
  stock_instruments: "ts_code",
  etf_instruments: "ts_code",
};

const COMMON_INDEX_SYMBOLS = new Set([
  "000001",
  "000016",
  "000300",
  "000688",
  "000852",
  "000905",
  "000906",
  "399001",
]);

function datasetDefinitionMap(payload) {
  const datasets = Array.isArray(payload?.datasets) ? payload.datasets : [];
  return new Map(datasets.map((item) => [String(item.key ?? ""), item]));
}

function pickDatasetDefinitions(datasetMap, keys = []) {
  return keys
    .map((key) => datasetMap.get(String(key)))
    .filter(Boolean);
}

function buildInstrumentTypeConfig(type) {
  return (
    INSTRUMENT_DATASET_CONFIG[String(type ?? "").trim().toUpperCase()] ??
    INSTRUMENT_DATASET_CONFIG.DEFAULT
  );
}

function orderBookIdToTsCode(orderBookId) {
  const parsed = parseOrderBookId(orderBookId);
  if (!parsed) {
    return "";
  }
  const suffix =
    parsed.exchange === "SSE"
      ? "SH"
      : parsed.exchange === "SZSE"
        ? "SZ"
        : parsed.exchange === "BSE"
          ? "BJ"
          : parsed.exchange;
  return `${parsed.symbol}.${suffix}`;
}

export function resolveCoverageInstrumentType(item, typeLookup) {
  const tsCode = orderBookIdToTsCode(String(item?.orderBookId ?? ""));
  if (typeLookup?.etfTsCodes?.has(tsCode)) {
    return "ETF";
  }
  if (typeLookup?.stockTsCodes?.has(tsCode)) {
    return "CS";
  }
  const normalized = String(item?.type ?? "").trim().toUpperCase();
  if (normalized) {
    return normalized;
  }
  const parsed = parseOrderBookId(item?.orderBookId);
  if (parsed?.exchange === "BSE") {
    return "CS";
  }
  if (COMMON_INDEX_SYMBOLS.has(String(parsed?.symbol ?? ""))) {
    return "INDX";
  }
  if (String(item?.adjust ?? "").trim().toLowerCase() !== "none") {
    return "CS";
  }
  if (String(parsed?.exchange ?? "").trim().toUpperCase() === "SZSE") {
    return "CS";
  }
  if (String(item?.name ?? "").trim()) {
    return "INDX";
  }
  return "INDX";
}

function barsNeedRefresh(run) {
  const bars = run?.artifacts?.bars ?? [];
  const trades = run?.artifacts?.trades ?? [];
  const startDate = String(run?.summary?.startDate ?? run?.startDate ?? "");
  const endDate = String(run?.summary?.endDate ?? run?.endDate ?? "");

  if (!bars.length) {
    return true;
  }

  const firstBar = String(bars[0]?.datetime ?? "").slice(0, 10);
  const lastBar = String(bars.at(-1)?.datetime ?? "").slice(0, 10);
  if ((startDate && firstBar > startDate) || (endDate && lastBar < endDate)) {
    return true;
  }

  const firstTrade = String(trades[0]?.datetime ?? "").slice(0, 10);
  if (firstTrade && firstBar && firstTrade < firstBar) {
    return true;
  }

  return false;
}

function sha256(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
}

function resolveBuiltinStrategySource(strategyId, workspaceRoot) {
  const baseDirs = [
    resolve(workspaceRoot, "Quantflow", "engine", "strategies", "builtin"),
    resolve(workspaceRoot, "Quantflow", "engine", "strategies", "custom"),
    resolve(workspaceRoot, "engine", "strategies", "builtin"),
    resolve(workspaceRoot, "engine", "strategies", "custom"),
  ];

  for (const baseDir of baseDirs) {
    if (!existsSync(baseDir)) {
      continue;
    }
    const strategyDirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(baseDir, entry.name));
    for (const strategyDir of strategyDirs) {
      const metaPath = resolve(strategyDir, "strategy.meta.json");
      const sourcePath = resolve(strategyDir, "strategy.py");
      if (!existsSync(metaPath) || !existsSync(sourcePath)) {
        continue;
      }
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        if (meta?.id === strategyId) {
          const sourceCode = readFileSync(sourcePath, "utf8");
          return { sourcePath, sourceCode, meta };
        }
      } catch (error) {
        console.warn(
          `[strategy-scan] failed to parse strategy metadata ${metaPath}: ${error?.message ?? error}`,
        );
      }
    }
  }

  return null;
}

function resolveAppConfig() {
  return structuredClone(DEFAULT_APP_CONFIG);
}

function addSystemLog(
  database,
  { scope = "system", level = "INFO", title, message, payload = null },
) {
  database.addSystemLog({
    id: randomUUID(),
    scope,
    level,
    title,
    message,
    payload,
    createdAt: isoNow(),
  });
}

function saveWorkspaceStrategyVersion(
  database,
  body,
  strategyId,
  summary = null,
) {
  const sourceCode = String(body.sourceCode ?? "");
  if (!sourceCode.trim()) {
    return null;
  }
  const sourceHash = sha256(sourceCode);
  const existing = database.findStrategyVersion(
    strategyId,
    body.path,
    sourceHash,
  );
  if (existing) {
    return existing;
  }
  return database.saveStrategyVersion({
    id: randomUUID(),
    strategyId,
    sourcePath: body.path,
    sourceHash,
    sourceCode,
    summary,
    createdAt: isoNow(),
  });
}

function buildCostModelFromBody(body, appConfig) {
  const defaults = appConfig.cost_defaults ?? {};
  const normalizedSlippageMode = String(
    body.slippageMode ?? defaults.slippageMode ?? "ratio",
  )
    .trim()
    .toLowerCase();
  return {
    slippageMode: normalizedSlippageMode === "ratio" ? "ratio" : "absolute",
    slippageValue: Number(
      body.slippageValue ??
        body.slippage ??
        defaults.slippageValue ??
        defaults.slippage ??
        0,
    ),
    openCommissionRate: Number(
      body.openCommissionRate ?? defaults.openCommissionRate ?? body.rate ?? 0,
    ),
    closeCommissionRate: Number(
      body.closeCommissionRate ??
        defaults.closeCommissionRate ??
        body.rate ??
        0,
    ),
    minCommission: Number(body.minCommission ?? defaults.minCommission ?? 0),
    stampDutyRate: Number(body.stampDutyRate ?? defaults.stampDutyRate ?? 0),
    impactCostBps: Number(body.impactCostBps ?? defaults.impactCostBps ?? 0),
  };
}

function buildPositionConfig(body, appConfig) {
  const defaults = appConfig.position_defaults ?? {};
  return {
    sizing_mode: String(body.sizingMode ?? defaults.sizingMode ?? "percent"),
    fixed_size: Number(
      body.fixedSize ?? body.fixed_size ?? defaults.fixedSize ?? 100,
    ),
    position_pct: Number(body.positionPct ?? defaults.positionPct ?? 100),
    cash_reserve_pct: Number(
      body.cashReservePct ?? defaults.cashReservePct ?? 0,
    ),
    stop_loss_pct: Number(body.stopLossPct ?? defaults.stopLossPct ?? 0),
    take_profit_pct: Number(body.takeProfitPct ?? defaults.takeProfitPct ?? 0),
    trailing_stop_pct: Number(
      body.trailingStopPct ?? defaults.trailingStopPct ?? 0,
    ),
  };
}

function hydrateParameterDefaults(strategy, body, appConfig) {
  const positionConfig = buildPositionConfig(body, appConfig);
  return {
    ...(strategy.defaults ?? {}),
    ...positionConfig,
  };
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

function normalizeTagList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .slice(0, 20),
    ),
  ];
}

function formatMetricPercent(value) {
  return `${Number(value ?? 0).toFixed(2)}%`;
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createExcelHtmlReport(run, metrics) {
  const summaryRows = [
    [
      "策略",
      run.summary?.strategyName ?? run.summary?.strategyId ?? run.strategyId,
    ],
    [
      "标的",
      `${run.summary?.symbol ?? run.symbol}.${run.summary?.exchange ?? run.exchange}`,
    ],
    [
      "区间",
      `${run.summary?.startDate ?? run.startDate} -> ${run.summary?.endDate ?? run.endDate}`,
    ],
    ["累计收益率", formatMetricPercent(metrics.totalReturn)],
    ["最大回撤", formatMetricPercent(metrics.maxDrawdown)],
    ["夏普比率", Number(metrics.sharpeRatio ?? 0).toFixed(2)],
    ["胜率", formatMetricPercent(metrics.winRate)],
    ["总交易次数", String(metrics.tradeCount ?? 0)],
  ];
  const tradeRows = (run.artifacts?.trades ?? []).map((trade) => [
    String(trade.datetime ?? ""),
    String(trade.direction ?? ""),
    String(trade.offset ?? ""),
    Number(trade.price ?? 0).toFixed(4),
    String(trade.volume ?? ""),
    Number(trade.commission ?? 0).toFixed(4),
    Number(trade.tax ?? trade.stampDuty ?? 0).toFixed(4),
    Number(trade.transactionCost ?? 0).toFixed(4),
  ]);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Arial, sans-serif; padding: 16px; }
    table { border-collapse: collapse; margin-bottom: 24px; width: 100%; }
    th, td { border: 1px solid #d1d5db; padding: 6px 8px; font-size: 12px; }
    th { background: #f8fafc; text-align: left; }
    h1, h2 { margin: 0 0 12px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(run.summary?.strategyName ?? run.summary?.strategyId ?? run.strategyId)}</h1>
  <h2>回测摘要</h2>
  <table>
    <tbody>
      ${summaryRows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}
    </tbody>
  </table>
  <h2>成交明细</h2>
  <table>
    <thead>
      <tr>
        <th>时间</th><th>方向</th><th>开平</th><th>价格</th><th>数量</th><th>佣金</th><th>税费</th><th>总成本</th>
      </tr>
    </thead>
    <tbody>
      ${tradeRows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}
    </tbody>
  </table>
</body>
</html>`;
}

function escapePdfText(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function createSimplePdfBuffer(lines) {
  const lineHeight = 14;
  const startX = 54;
  const startY = 760;
  const bottomMargin = 42;
  const maxChars = 88;
  const preparedLines = lines
    .flatMap((line) => wrapPdfLine(normalizePdfLine(line), maxChars))
    .map((line) => escapePdfText(line));
  const maxLinesPerPage = Math.max(
    1,
    Math.floor((startY - bottomMargin) / lineHeight),
  );
  const pages = [];
  for (let index = 0; index < preparedLines.length; index += maxLinesPerPage) {
    pages.push(preparedLines.slice(index, index + maxLinesPerPage));
  }
  if (!pages.length) {
    pages.push(["InvestFlow Export"]);
  }

  const objects = [];
  const pageObjectIds = [];
  const contentObjectIds = [];
  const fontObjectId = 3;
  let nextObjectId = 4;

  pages.forEach((pageLines) => {
    const pageObjectId = nextObjectId;
    const contentObjectId = nextObjectId + 1;
    pageObjectIds.push(pageObjectId);
    contentObjectIds.push(contentObjectId);
    nextObjectId += 2;

    const commands = [
      "BT",
      "/F1 10 Tf",
      `${lineHeight} TL`,
      `${startX} ${startY} Td`,
    ];
    pageLines.forEach((line, index) => {
      if (index > 0) {
        commands.push("T*");
      }
      if (line) {
        commands.push(`(${line}) Tj`);
      }
    });
    commands.push("ET");
    const stream = commands.join("\n");
    objects.push({
      id: pageObjectId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    });
    objects.push({
      id: contentObjectId,
      body: `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    });
  });

  const pageKids = pageObjectIds.map((id) => `${id} 0 R`).join(" ");
  const orderedObjects = [
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    {
      id: 2,
      body: `<< /Type /Pages /Kids [${pageKids}] /Count ${pageObjectIds.length} >>`,
    },
    {
      id: fontObjectId,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    },
    ...objects.sort((left, right) => left.id - right.id),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  orderedObjects.forEach((object) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${object.id} 0 obj\n${object.body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${orderedObjects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${orderedObjects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function normalizePdfLine(value) {
  return String(value ?? "")
    .replaceAll("→", "->")
    .replaceAll("：", ": ")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replaceAll("，", ", ")
    .replaceAll("。", ".")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replaceAll("’", "'")
    .replaceAll("—", "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ");
}

function wrapPdfLine(line, maxChars) {
  if (!line) {
    return [""];
  }

  const normalized = line.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const wrapped = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    let breakAt = remaining.lastIndexOf(" ", maxChars);
    if (breakAt < Math.floor(maxChars * 0.45)) {
      breakAt = maxChars;
    }
    wrapped.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) {
    wrapped.push(remaining);
  }
  return wrapped;
}

function formatPlainNumber(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "--";
  }
  return parsed.toFixed(digits).replace(/\.?0+$/, "");
}

function formatCurrencyValue(value) {
  return `¥${Number(value ?? 0).toFixed(2)}`;
}

function formatCurrencyAscii(value) {
  return `CNY ${Number(value ?? 0).toFixed(2)}`;
}

function formatPercentValue(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "--";
  }
  return `${parsed.toFixed(digits)}%`;
}

function formatSignedPercentValue(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "--";
  }
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(digits)}%`;
}

function formatDateTimeValue(value) {
  return String(value ?? "")
    .replace("T", " ")
    .slice(0, 16);
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function getStrategyDisplayName(run) {
  return String(
    run?.summary?.strategyName ??
      run?.title ??
      run?.request?.title ??
      run?.summary?.strategyId ??
      run?.strategyId ??
      "未命名策略",
  ).trim();
}

function getOrderBookId(run) {
  return (
    formatOrderBookId(
      run?.summary?.symbol ?? run?.symbol,
      run?.summary?.exchange ?? run?.exchange,
    ) || "--"
  );
}

function getPdfStrategyName(run) {
  const displayName = getStrategyDisplayName(run);
  return /[^\x20-\x7E]/.test(displayName)
    ? String(run?.summary?.strategyId ?? run?.strategyId ?? displayName)
    : displayName;
}

function resolveBenchmarkLabelAscii(value) {
  const labels = {
    "000300.XSHG": "CSI 300",
    "000001.XSHG": "SSE Composite",
    "399001.XSHE": "SZSE Component",
    "399006.XSHE": "ChiNext",
    "000905.XSHG": "CSI 500",
  };
  const code = String(value ?? "").trim();
  return labels[code] ?? (code || "--");
}

function formatBenchmarkDisplay(value) {
  const code = String(value ?? "").trim();
  if (!code) {
    return "无基准";
  }
  return `${resolveBenchmarkLabel(code)} (${code})`;
}

function formatBenchmarkDisplayAscii(value) {
  const code = String(value ?? "").trim();
  if (!code) {
    return "No Benchmark";
  }
  return `${resolveBenchmarkLabelAscii(code)} (${code})`;
}

function resolveAdjustLabelAscii(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "qfq") {
    return "Forward Adjusted";
  }
  if (normalized === "hfq") {
    return "Backward Adjusted";
  }
  if (normalized === "none") {
    return "No Adjust";
  }
  return normalized || "--";
}

function resolveSizingModeAscii(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "fixed") {
    return "Fixed Size";
  }
  if (normalized === "percent") {
    return "Position Percent";
  }
  return normalized || "--";
}

function resolveSlippageModeAscii(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "ratio") {
    return "Ratio";
  }
  if (normalized === "absolute" || normalized === "fixed") {
    return "Absolute Spread";
  }
  return normalized || "--";
}

function buildDetailMap(run) {
  return Object.fromEntries(
    buildRunDetailItems(run).map((item) => [item.label, item]),
  );
}

function buildSectionedDetailItems(run) {
  const order = [
    "实验配置",
    "收益表现",
    "风险指标",
    "交易表现",
    "交易成本",
    "其他",
  ];
  const sectionMap = new Map();

  buildRunDetailItems(run).forEach((item) => {
    const bucket = sectionMap.get(item.section) ?? [];
    bucket.push(item);
    sectionMap.set(item.section, bucket);
  });

  return order
    .map((section) => ({
      title: section,
      items: sectionMap.get(section) ?? [],
    }))
    .filter((section) => section.items.length);
}

function buildRecentTradeRows(run, limit = 12) {
  return (run?.artifacts?.trades ?? []).slice(-limit).map((trade) => ({
    datetime: formatDateTimeValue(trade.datetime),
    direction: `${String(trade.direction ?? "").trim() || "--"} / ${String(trade.offset ?? "").trim() || "--"}`,
    price: formatPlainNumber(trade.price, 4),
    volume: formatPlainNumber(trade.volume, 0),
    turnover: formatCurrencyValue(
      trade.turnover ?? Number(trade.price ?? 0) * Number(trade.volume ?? 0),
    ),
    cost: formatCurrencyValue(trade.transactionCost ?? 0),
  }));
}

function buildMonthlyRows(run, limit = 12) {
  return (run?.artifacts?.monthlyReturns ?? []).slice(-limit).map((row) => ({
    month: String(row.month ?? "--"),
    returnPct: formatSignedPercentValue(Number(row.returnPct ?? 0) * 100),
  }));
}

function buildLogRows(run, limit = 8) {
  return (run?.artifacts?.logs ?? []).slice(-limit).map((row) => ({
    timestamp: formatDateTimeValue(row.timestamp),
    level: String(row.level ?? "INFO").toUpperCase(),
    message: String(row.message ?? "").trim() || "--",
  }));
}

function buildMarkdownReport(run, metrics) {
  const analysis = createRunAnalysis(run);
  const detailSections = buildSectionedDetailItems(run);
  const recentTrades = buildRecentTradeRows(run);
  const monthlyRows = buildMonthlyRows(run);
  const logRows = buildLogRows(run);
  const tradePairs = buildTradePairs(run);
  const noTradeHint = buildNoTradeHint(run);
  const generatedAt = formatBeijingDateTime();
  const lines = [
    `# ${getStrategyDisplayName(run)}`,
    "",
    "## 回测概览",
    "",
    `- 导出时间：${generatedAt}`,
    `- 回测 ID：${run.id}`,
    `- 标的：${getOrderBookId(run)}`,
    `- 回测区间：${run.summary?.startDate ?? run.startDate ?? "--"} -> ${run.summary?.endDate ?? run.endDate ?? "--"}`,
    `- 基准：${formatBenchmarkDisplay(run.summary?.benchmark ?? run.request?.benchmark)}`,
    `- 复权方式：${detailSections.flatMap((section) => section.items).find((item) => item.label === "复权方式")?.value ?? "--"}`,
    `- 累计收益率：${formatSignedPercentValue(metrics.totalReturn)}`,
    `- 年化收益率：${formatSignedPercentValue(metrics.annualReturn)}`,
    `- 最大回撤：${formatPercentValue(metrics.maxDrawdown)}`,
    `- 夏普比率：${formatPlainNumber(metrics.sharpeRatio)}`,
    `- 胜率：${formatPercentValue(metrics.winRate)}`,
    `- 总交易次数：${metrics.tradeCount ?? 0}`,
    `- 交易配对数：${tradePairs.length}`,
  ];

  if (noTradeHint) {
    lines.push("", "## 无成交说明", "", noTradeHint);
  }

  detailSections.forEach((section) => {
    lines.push(
      "",
      `## ${section.title}`,
      "",
      "| 指标 | 数值 | 说明 |",
      "| --- | --- | --- |",
    );
    section.items.forEach((item) => {
      lines.push(
        `| ${escapeMarkdownCell(item.label)} | ${escapeMarkdownCell(item.value)} | ${escapeMarkdownCell(item.description)} |`,
      );
    });
  });

  if (monthlyRows.length) {
    lines.push("", "## 最近月份表现", "", "| 月份 | 收益率 |", "| --- | --- |");
    monthlyRows.forEach((row) => {
      lines.push(
        `| ${escapeMarkdownCell(row.month)} | ${escapeMarkdownCell(row.returnPct)} |`,
      );
    });
  }

  if (recentTrades.length) {
    lines.push(
      "",
      "## 最近成交",
      "",
      "| 时间 | 方向 | 价格 | 数量 | 成交额 | 成本 |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    recentTrades.forEach((row) => {
      lines.push(
        `| ${escapeMarkdownCell(row.datetime)} | ${escapeMarkdownCell(row.direction)} | ${escapeMarkdownCell(row.price)} | ${escapeMarkdownCell(row.volume)} | ${escapeMarkdownCell(row.turnover)} | ${escapeMarkdownCell(row.cost)} |`,
      );
    });
  }

  if (logRows.length) {
    lines.push(
      "",
      "## 最近日志",
      "",
      "| 时间 | 级别 | 内容 |",
      "| --- | --- | --- |",
    );
    logRows.forEach((row) => {
      lines.push(
        `| ${escapeMarkdownCell(row.timestamp)} | ${escapeMarkdownCell(row.level)} | ${escapeMarkdownCell(row.message)} |`,
      );
    });
  }

  lines.push(
    "",
    "## 结论速记",
    "",
    `- 期初资金：${formatCurrencyValue(analysis.initialCapital)}，期末资金：${formatCurrencyValue(analysis.endBalance)}。`,
    `- 累计盈亏：${formatCurrencyValue(analysis.cumulativePnl)}，总成本：${formatCurrencyValue(analysis.totalFee)}。`,
    `- 年化波动率：${formatPercentValue(analysis.volatility)}，索提诺比率：${formatPlainNumber(analysis.sortino)}，卡玛比率：${formatPlainNumber(analysis.calmar)}。`,
    `- 最大回撤时长：${analysis.maxDrawdownDuration} 天，恢复因子：${formatPlainNumber(analysis.recoveryFactor)}。`,
    "",
    "该报告由 InvestFlow 自动生成，可直接用于复盘、归档和分享。",
  );

  return lines.join("\n");
}

function buildPdfReportLines(run, metrics) {
  const analysis = createRunAnalysis(run);
  const details = buildDetailMap(run);
  const recentTrades = buildRecentTradeRows(run, 8);
  const noTradeHint = buildNoTradeHint(run);
  const benchmarkCode = run.summary?.benchmark ?? run.request?.benchmark ?? "";
  const parameterSummary =
    run.summary?.parameters ?? run.request?.parameters ?? {};
  const costModel =
    run.summary?.costModel ??
    parameterSummary.costModel ??
    run.request?.costModel ??
    {};
  const lines = [
    "InvestFlow Backtest Report",
    "",
    `Generated: ${formatBeijingDateTime()} BJT`,
    `Run ID: ${run.id}`,
    `Strategy: ${getPdfStrategyName(run)}`,
    `Symbol: ${getOrderBookId(run)}`,
    `Period: ${run.summary?.startDate ?? run.startDate ?? "--"} -> ${run.summary?.endDate ?? run.endDate ?? "--"}`,
    `Benchmark: ${formatBenchmarkDisplayAscii(benchmarkCode)}`,
    `Adjust: ${resolveAdjustLabelAscii(run.summary?.adjust ?? run.request?.adjust)}`,
    "",
    "Performance",
    `- Total Return: ${formatSignedPercentValue(metrics.totalReturn)}`,
    `- Annual Return: ${formatSignedPercentValue(metrics.annualReturn)}`,
    `- Max Drawdown: ${formatPercentValue(metrics.maxDrawdown)}`,
    `- Sharpe Ratio: ${formatPlainNumber(metrics.sharpeRatio)}`,
    `- Cumulative PnL: ${formatCurrencyAscii(analysis.cumulativePnl)}`,
    `- Start / End Balance: ${formatCurrencyAscii(analysis.initialCapital)} / ${formatCurrencyAscii(analysis.endBalance)}`,
    "",
    "Risk",
    `- Volatility: ${formatPercentValue(analysis.volatility)}`,
    `- Sortino: ${formatPlainNumber(analysis.sortino)}`,
    `- Calmar: ${formatPlainNumber(analysis.calmar)}`,
    `- Recovery Factor: ${formatPlainNumber(analysis.recoveryFactor)}`,
    `- Max Drawdown Duration: ${analysis.maxDrawdownDuration} days`,
    `- Alpha / Beta / Info Ratio: ${analysis.alpha == null ? "--" : formatPercentValue(analysis.alpha)} / ${analysis.beta == null ? "--" : formatPlainNumber(analysis.beta)} / ${analysis.infoRatio == null ? "--" : formatPlainNumber(analysis.infoRatio)}`,
    "",
    "Trading & Costs",
    `- Trade Count: ${metrics.tradeCount ?? 0}`,
    `- Trade Days: ${metrics.tradeDays ?? 0}`,
    `- Win Rate: ${formatPercentValue(metrics.winRate)}`,
    `- Profit Factor: ${formatPlainNumber(metrics.profitFactor)}`,
    `- Avg Profit / Loss: ${formatCurrencyAscii(metrics.avgProfit)} / ${formatCurrencyAscii(metrics.avgLoss)}`,
    `- Expectancy: ${formatCurrencyAscii(metrics.expectancy)}`,
    `- Turnover: ${formatCurrencyAscii(metrics.turnover)}`,
    `- Total Fee: ${formatCurrencyAscii(metrics.totalFee)}`,
    "",
    "Configuration",
    `- Sizing Mode: ${resolveSizingModeAscii(parameterSummary.sizing_mode ?? run.request?.sizingMode)}`,
    `- Fixed Size: ${details["固定股数"]?.value ?? details["固定手数"]?.value ?? "--"}`,
    `- Position % / Cash Reserve %: ${details["资金占比"]?.value ?? "--"} / ${details["现金保留"]?.value ?? "--"}`,
    `- Stop Loss / Take Profit / Trailing Stop: ${details["止损"]?.value ?? "--"} / ${details["止盈"]?.value ?? "--"} / ${details["移动止损"]?.value ?? "--"}`,
    `- Slippage: ${resolveSlippageModeAscii(costModel.slippageMode ?? run.request?.slippageMode)} (${details["滑点值"]?.value ?? "--"})`,
    `- Commission Open / Close: ${details["开仓佣金率"]?.value ?? "--"} / ${details["平仓佣金率"]?.value ?? "--"}`,
    `- Min Commission / Stamp Duty / Impact: ${details["最低佣金"]?.value ?? "--"} / ${details["印花税率"]?.value ?? "--"} / ${details["冲击成本设定"]?.value ?? "--"}`,
  ];

  if (noTradeHint) {
    lines.push("", `No-trade note: ${noTradeHint}`);
  }

  if (recentTrades.length) {
    lines.push("", "Recent Trades");
    recentTrades.forEach((row) => {
      lines.push(
        `- ${row.datetime} | ${row.direction} | Px ${row.price} | Vol ${row.volume} | Turnover ${row.turnover} | Cost ${row.cost}`,
      );
    });
  }

  lines.push(
    "",
    "Tip: the Markdown report contains the full Chinese detail version.",
  );
  return lines;
}

export function createApp(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => new Date();
  const database = createDatabase(options.dbPath);
  const engine = createEngineClient(options.engineUrl);
  const replayLifecycle = createReplayLifecycle({
    store: createReplayLifecycleStore(database),
    scenarioSource: engine,
    createId: randomUUID,
    now: isoNow,
  });
  const mainlineRankingStore = createMainlineRankingStore(options.rankingDbPath);
  const workspace = createWorkspaceService(options.workspaceRoot);
  const stockDecisionServiceUrl = String(
    options.stockDecisionServiceUrl ??
      options.etfServiceUrl ??
      DEFAULT_STOCK_DECISION_SERVICE_URL,
  ).replace(/\/+$/, "");
  const capitalFlowUrl = String(
    options.capitalFlowUrl ?? DEFAULT_CAPITAL_FLOW_URL,
  ).replace(/\/+$/, "");
  const workspaceRoot = resolve(
    options.workspaceRoot ?? resolve(MODULE_DIR, "..", ".."),
  );
  const storageRoot = resolve(
    options.storageRoot ??
      (options.dbPath ? dirname(options.dbPath) : DEFAULT_STORAGE_ROOT),
  );
  const tradeRecordsRoot = resolve(options.tradeRecordsRoot ?? DEFAULT_TRADE_RECORDS_ROOT);
  const envFilePath = resolve(workspaceRoot, ".env.local");
  const runsRoot = resolve(storageRoot, "runs");
  const app = express();
  let coverageCache = {
    dataVersion: null,
    pending: null,
    pendingVersion: null,
    value: null,
  };
  let networkConfigMutationQueue = Promise.resolve();

  app.use(express.json({ limit: "2mb" }));

  function runSerializedNetworkConfigMutation(task) {
    const pending = networkConfigMutationQueue.then(task);
    networkConfigMutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

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

  async function forwardStockDecisionRequest(req, res, next, targetPath) {
    try {
      const url = new URL(`${stockDecisionServiceUrl}${targetPath}`);
      for (const [key, value] of Object.entries(req.query ?? {})) {
        if (Array.isArray(value)) {
          value.forEach((item) => url.searchParams.append(key, String(item)));
        } else if (value != null) {
          url.searchParams.set(key, String(value));
        }
      }

      const method = req.method.toUpperCase();
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: method === "GET" || method === "HEAD"
          ? undefined
          : JSON.stringify(normalizeBody(req.body)),
      });
      const raw = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const looksLikeJson =
        contentType.includes("application/json") ||
        raw.trim().startsWith("{") ||
        raw.trim().startsWith("[");
      const payload = raw && looksLikeJson ? JSON.parse(raw) : raw;

      if (!response.ok) {
        const message =
          payload?.detail ??
          payload?.error?.message ??
          `股票决策服务请求失败（${response.status}）`;
        const error = new Error(message);
        error.status = response.status;
        error.details = payload;
        throw error;
      }

      if (response.status === 204) {
        res.status(204).end();
        return;
      }
      if (!raw.trim() || !looksLikeJson) {
        const error = new Error("股票决策服务返回了非 JSON 响应");
        error.status = 502;
        error.code = "UPSTREAM_INVALID_RESPONSE";
        throw error;
      }
      res.status(response.status).json(payload);
    } catch (error) {
      if (error instanceof SyntaxError) {
        const wrapped = new Error("股票决策服务返回了无效 JSON");
        wrapped.status = 502;
        wrapped.code = "UPSTREAM_INVALID_RESPONSE";
        next(wrapped);
        return;
      }
      if (error?.cause?.code === "ECONNREFUSED") {
        const wrapped = new Error("股票决策服务未启动");
        wrapped.status = 502;
        next(wrapped);
        return;
      }
      next(error);
    }
  }

  async function forwardCapitalFlowRequest(req, res, next, targetPath) {
    try {
      const url = new URL(`${capitalFlowUrl}${targetPath}`);
      for (const [key, value] of Object.entries(req.query ?? {})) {
        if (Array.isArray(value)) {
          value.forEach((item) => url.searchParams.append(key, String(item)));
        } else if (value != null) {
          url.searchParams.set(key, String(value));
        }
      }

      const method = req.method.toUpperCase();
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: method === "GET" || method === "HEAD"
          ? undefined
          : JSON.stringify(normalizeBody(req.body)),
      });
      const raw = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const looksLikeJson =
        contentType.includes("application/json") ||
        raw.trim().startsWith("{") ||
        raw.trim().startsWith("[");
      const payload = raw && looksLikeJson ? JSON.parse(raw) : raw;

      if (!response.ok) {
        const message =
          payload?.message ??
          payload?.detail ??
          payload?.error?.message ??
          `资金流模型服务请求失败（${response.status}）`;
        const error = new Error(message);
        error.status = response.status;
        error.details = payload;
        throw error;
      }

      if (response.status === 204) {
        res.status(204).end();
        return;
      }
      if (!raw.trim() || !looksLikeJson) {
        const error = new Error("资金流模型服务返回了非 JSON 响应");
        error.status = 502;
        error.code = "UPSTREAM_INVALID_RESPONSE";
        throw error;
      }
      res.status(response.status).json(payload);
    } catch (error) {
      if (error instanceof SyntaxError) {
        const wrapped = new Error("资金流模型服务返回了无效 JSON");
        wrapped.status = 502;
        wrapped.code = "UPSTREAM_INVALID_RESPONSE";
        next(wrapped);
        return;
      }
      if (error?.cause?.code === "ECONNREFUSED") {
        const wrapped = new Error("资金流模型服务未启动");
        wrapped.status = 502;
        next(wrapped);
        return;
      }
      next(error);
    }
  }

  async function syncStockDecisionRuntimeEnvironment(updates) {
    const response = await fetch(`${stockDecisionServiceUrl}/api/runtime/environment`, {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ updates }),
    });
    if (!response.ok) {
      throw new Error("股票决策服务拒绝了运行时配置");
    }
  }

  async function rollbackNetworkRuntimeEnvironment({
    engineApplied,
    stockDecisionApplied,
    updates,
  }) {
    const rollbackResults = [];
    if (stockDecisionApplied) {
      try {
        await syncStockDecisionRuntimeEnvironment(updates);
        rollbackResults.push(true);
      } catch {
        rollbackResults.push(false);
      }
    }
    if (engineApplied) {
      try {
        await engine.updateRuntimeEnvironment({ updates });
        rollbackResults.push(true);
      } catch {
        rollbackResults.push(false);
      }
    }
    return rollbackResults.every(Boolean);
  }

  function createRuntimeSyncError(failedService, rollbackSucceeded) {
    const error = new Error("运行服务未能应用网络配置，配置未保存");
    error.status = 503;
    error.code = "RUNTIME_SYNC_FAILED";
    error.details = {
      saved: false,
      failedService,
      rollbackSucceeded,
    };
    return error;
  }

  function invalidateCoverageCache() {
    coverageCache = {
      dataVersion: null,
      pending: null,
      pendingVersion: null,
      value: null,
    };
  }

  async function getCachedCoverage() {
    const versionPayload = await engine.getDataVersion();
    const dataVersion = String(versionPayload?.dataVersion ?? "").trim();
    if (coverageCache.value && coverageCache.dataVersion === dataVersion) {
      return coverageCache.value;
    }
    if (
      coverageCache.pending &&
      coverageCache.pendingVersion === dataVersion
    ) {
      return coverageCache.pending;
    }
    const pending = engine.getDataCoverage().then((coverage) => {
      coverageCache = {
        dataVersion:
          String(coverage?.dataVersion ?? "").trim() || dataVersion,
        pending: null,
        pendingVersion: null,
        value: coverage,
      };
      return coverage;
    });
    coverageCache.pending = pending;
    coverageCache.pendingVersion = dataVersion;
    try {
      return await pending;
    } catch (error) {
      if (coverageCache.pending === pending) {
        coverageCache.pending = null;
        coverageCache.pendingVersion = null;
      }
      throw error;
    }
  }

  async function buildInstrumentOverview(orderBookId) {
    const parsed = parseOrderBookId(orderBookId);
    assertCondition(Boolean(parsed), "无效的 orderBookId");

    const [catalogPayload, rawDatasetPayload] = await Promise.all([
      engine.getDataCatalogItem(parsed.orderBookId),
      engine.getRawDatasets().catch((error) => {
        if (error?.status === 409) {
          return {
            sourceMode: "local",
            sourceDbPath: null,
            datasets: [],
          };
        }
        throw error;
      }),
    ]);
    const catalogItem = catalogPayload?.item ?? null;
    assertCondition(Boolean(catalogItem), "当前数据源里找不到该标的覆盖", 404);
    const instrumentType = String(catalogItem.type ?? "").trim().toUpperCase();
    const datasetConfig = buildInstrumentTypeConfig(instrumentType);
    const datasetMap = datasetDefinitionMap(rawDatasetPayload);

    return {
      item: {
        ...catalogItem,
        symbol: String(catalogItem.symbol ?? parsed.symbol).trim(),
        exchange: String(catalogItem.exchange ?? parsed.exchange).trim(),
        orderBookId: parsed.orderBookId,
        name: String(catalogItem.name ?? "").trim(),
        code: String(catalogItem.code ?? parsed.symbol).trim(),
        type: instrumentType,
        boardType: String(catalogItem.boardType ?? "").trim(),
        listedDate: String(catalogItem.listedDate ?? "").trim(),
        startDate: String(catalogItem.startDate ?? "").trim(),
        endDate: String(catalogItem.endDate ?? "").trim(),
        latestSyncAt: String(catalogItem.latestSyncAt ?? "").trim(),
        availableAdjustments: catalogItem.availableAdjustments ?? [],
      },
      financialDatasets: pickDatasetDefinitions(
        datasetMap,
        datasetConfig.financialKeys,
      ),
      rawDatasets: pickDatasetDefinitions(datasetMap, datasetConfig.rawKeys),
      factorSupported:
        datasetConfig.factorSupported &&
        (catalogItem.availableAdjustments ?? []).some(
          (item) => item === "qfq" || item === "hfq",
        ),
    };
  }

  async function executeBuiltinBacktest({
    strategy,
    body,
    parameterSetId = null,
    requestType = "backtest",
    title = "策略回测",
    runPatch = {},
  }) {
    const appConfig = resolveAppConfig();
    const runId = randomUUID();
    const now = isoNow();
    const costModel = buildCostModelFromBody(body, appConfig);
    const baseParameters = hydrateParameterDefaults(strategy, body, appConfig);
    const builtinStrategySource = resolveBuiltinStrategySource(
      body.strategyId,
      workspaceRoot,
    );
    const strategySourcePath = builtinStrategySource?.sourcePath ?? null;
    const strategySourceCode = builtinStrategySource?.sourceCode ?? "";
    const strategySourceHash = strategySourceCode
      ? sha256(strategySourceCode)
      : "";
    let strategyVersion = null;
    if (strategySourceCode && strategySourceHash) {
      strategyVersion =
        database.findStrategyVersion(
          body.strategyId,
          strategySourcePath,
          strategySourceHash,
        ) ??
        database.saveStrategyVersion({
          id: randomUUID(),
          strategyId: body.strategyId,
          sourcePath: strategySourcePath,
          sourceHash: strategySourceHash,
          sourceCode: strategySourceCode,
          summary: {
            trigger: requestType,
            module: builtinStrategySource?.meta?.module ?? null,
          },
          createdAt: now,
        });
    }
    const parameters = {
      ...baseParameters,
      ...(body.parameters ?? {}),
    };
    const requestSnapshot = {
      requestType,
      strategyId: body.strategyId,
      symbol: body.symbol,
      exchange: body.exchange,
      interval: body.interval,
      adjust: body.adjust,
      startDate: body.startDate,
      endDate: body.endDate,
      capital: body.capital,
      slippage: body.slippage,
      rate: body.rate,
      benchmark: body.benchmark,
      dataProvider: body.dataProvider ?? null,
      costModel,
      parameters,
      title,
      strategySourcePath,
      strategySourceHash,
      dataSync: null,
      benchmarkDataSync: null,
    };

    database.createRun({
      id: runId,
      title,
      strategyId: body.strategyId,
      parameterSetId,
      symbol: body.symbol,
      exchange: body.exchange,
      interval: body.interval,
      startDate: body.startDate,
      endDate: body.endDate,
      capital: body.capital,
      slippage: body.slippage,
      rate: body.rate,
      status: "running",
      errorMessage: null,
      summary: null,
      artifacts: null,
      request: requestSnapshot,
      strategyVersionId: strategyVersion?.id ?? null,
      tags: normalizeTagList(runPatch.tags),
      notes: String(runPatch.notes ?? ""),
      starred: Boolean(runPatch.starred),
      createdAt: now,
      updatedAt: now,
    });

    addSystemLog(database, {
      scope: "backtest",
      level: "INFO",
      title,
      message: `${body.strategyId} ${body.symbol}.${body.exchange} ${body.startDate} -> ${body.endDate}`,
      payload: {
        runId,
        ...requestSnapshot,
      },
    });

    try {
      const dataSync = await ensureMarketData({
        symbol: body.symbol,
        exchange: body.exchange,
        interval: body.interval,
        adjust: body.adjust,
        dataProvider: body.dataProvider ?? null,
        startDate: body.startDate,
        endDate: body.endDate,
        trigger: requestType,
        runId,
      });
      requestSnapshot.dataSync = dataSync;
      requestSnapshot.benchmarkDataSync = await ensureBenchmarkData({
        benchmark: body.benchmark,
        symbol: body.symbol,
        exchange: body.exchange,
        interval: body.interval,
        dataProvider: body.dataProvider ?? null,
        startDate: body.startDate,
        endDate: body.endDate,
        trigger: `${requestType}-benchmark`,
        runId,
      });
      database.updateRun(runId, {
        request: requestSnapshot,
        updatedAt: isoNow(),
      });

      const engineResult = await engine.runBacktest({
        runId,
        strategyId: body.strategyId,
        symbol: body.symbol,
        exchange: body.exchange,
        interval: body.interval,
        adjust: body.adjust,
        startDate: body.startDate,
        endDate: body.endDate,
        capital: body.capital,
        slippage: body.slippage,
        rate: body.rate,
        parameters,
        costModel,
      });

      const savedRun = database.updateRun(runId, {
        symbol: engineResult.summary.symbol ?? body.symbol,
        exchange: engineResult.summary.exchange ?? body.exchange,
        interval: engineResult.summary.interval ?? body.interval,
        startDate: engineResult.summary.startDate ?? body.startDate,
        endDate: engineResult.summary.endDate ?? body.endDate,
        capital: engineResult.summary.capital ?? body.capital,
        status: "completed",
        summary: {
          ...engineResult.summary,
          title,
        },
        artifacts: engineResult.artifacts,
        request: requestSnapshot,
        strategyVersionId: strategyVersion?.id ?? null,
        updatedAt: isoNow(),
      });

      addSystemLog(database, {
        scope: "backtest",
        level: "INFO",
        title: `${title}完成`,
        message: `${body.strategyId} 已完成，共 ${savedRun.summary?.totalTradeCount ?? 0} 笔成交`,
        payload: {
          runId,
          strategyId: body.strategyId,
          symbol: body.symbol,
          exchange: body.exchange,
          startDate: body.startDate,
          endDate: body.endDate,
          totalReturn: savedRun.summary?.totalReturn,
        },
      });

      return savedRun;
    } catch (error) {
      database.updateRun(runId, {
        status: "failed",
        errorMessage: error.message,
        request: requestSnapshot,
        updatedAt: isoNow(),
      });
      addSystemLog(database, {
        scope: "backtest",
        level: "ERROR",
        title: `${title}失败`,
        message: error.message,
        payload: {
          runId,
          ...requestSnapshot,
        },
      });
      throw error;
    }
  }

  async function runIntegrityCheck(payload) {
    const selectedAdjust = normalizeAdjust(payload.adjust);
    const compareAllAdjustments = Boolean(payload.compareAllAdjustments);
    const adjustCandidates = compareAllAdjustments
      ? ["qfq", "hfq", "none"]
      : [selectedAdjust];
    const barsPayload = await engine.getBars({
      symbol: payload.symbol,
      exchange: payload.exchange,
      interval: payload.interval,
      startDate: payload.startDate,
      endDate: payload.endDate,
      adjust: selectedAdjust,
    });
    const comparisons = await Promise.all(
      adjustCandidates.map(async (adjust) => {
        try {
          const current = await engine.getBars({
            symbol: payload.symbol,
            exchange: payload.exchange,
            interval: payload.interval,
            startDate: payload.startDate,
            endDate: payload.endDate,
            adjust,
          });
          const list = current.bars ?? [];
          return {
            adjust,
            bars: list.length,
            firstBarDate: list.length
              ? String(list[0].datetime).slice(0, 10)
              : null,
            lastBarDate: list.length
              ? String(list.at(-1).datetime).slice(0, 10)
              : null,
            error: null,
          };
        } catch (error) {
          if (!compareAllAdjustments || adjust === selectedAdjust) {
            addSystemLog(database, {
              scope: "integrity",
              level: "WARN",
              title: "复权口径检查失败",
              message: `${adjust} 数据检查失败：${error.message}`,
              payload: {
                runId: payload.runId ?? null,
                taskId: payload.taskId ?? null,
                relatedRunIds: Array.isArray(payload.relatedRunIds)
                  ? payload.relatedRunIds
                  : [],
                strategyId: payload.strategyId ?? null,
                symbol: payload.symbol,
                exchange: payload.exchange,
                startDate: payload.startDate,
                endDate: payload.endDate,
                adjust,
              },
            });
          }
          return {
            adjust,
            bars: 0,
            firstBarDate: null,
            lastBarDate: null,
            error: error.message,
          };
        }
      }),
    );
    const run = payload.runId ? database.getRun(payload.runId) : null;
    return createIntegrityReport({
      bars: barsPayload.bars ?? [],
      run,
      startDate: payload.startDate,
      endDate: payload.endDate,
      adjustComparisons: comparisons,
    });
  }

  async function createTask(task) {
    return database.createTask({
      id: task.id ?? randomUUID(),
      type: task.type,
      title: task.title,
      status: task.status ?? "running",
      request: task.request ?? {},
      result: task.result ?? null,
      errorMessage: task.errorMessage ?? null,
      relatedRunIds: task.relatedRunIds ?? [],
      tags: normalizeTagList(task.tags),
      notes: String(task.notes ?? ""),
      starred: Boolean(task.starred),
      createdAt: task.createdAt ?? isoNow(),
      updatedAt: task.updatedAt ?? isoNow(),
    });
  }

  function getAnalysisStrategyLabel(path) {
    return basename(String(path ?? "").trim(), ".py") || "workspace_strategy";
  }

  function hydrateWorkspaceAnalysisBody(rawBody) {
    const body = {
      ...rawBody,
      strategyParameters: normalizeStrategyParameters(
        rawBody.strategyParameters,
      ),
    };
    if (
      (!String(body.sourceCode ?? "").trim() ||
        typeof body.sourceCode !== "string") &&
      typeof body.path === "string" &&
      body.path.trim()
    ) {
      const filePayload = workspace.getFile(body.path);
      assertCondition(Boolean(filePayload), "找不到对应策略文件", 404);
      body.sourceCode = filePayload.content ?? "";
    }
    validateWorkspaceRunRequest(body);
    return body;
  }

  async function executeWorkspaceAnalysisRun({
    body,
    strategyParameters = {},
    title,
    requestType,
    tags = [],
    notes = "",
  }) {
    return runWorkspaceBacktestFromBody(
      {
        ...body,
        strategyParameters,
      },
      {
        title,
        requestType,
        tags,
        notes,
      },
    );
  }

  async function executeOptimizationRuns(body, options = {}) {
    const metric = normalizeAnalysisMetric(options.metric ?? body.metric);
    const comboConfig = resolveWorkspaceOptimizationCombos({
      ...body,
      ...options,
    });
    const items = [];
    const relatedRunIds = [];
    const strategyLabel = getAnalysisStrategyLabel(body.path);

    for (const [index, combo] of comboConfig.combos.entries()) {
      const mergedParams = {
        ...body.strategyParameters,
        ...combo,
      };
      const run = await executeWorkspaceAnalysisRun({
        body,
        strategyParameters: mergedParams,
        title: `参数优化 ${strategyLabel} #${index + 1}`,
        requestType: options.requestType ?? "analysis-optimization-run",
        tags: ["optimization", strategyLabel],
      });
      relatedRunIds.push(run.id);
      items.push({
        runId: run.id,
        params: mergedParams,
        metrics: buildRunMetricSummary(run),
      });
    }

    const ranked = rankAnalysisItems(items, metric);
    return {
      metric,
      method: comboConfig.method,
      candidateCombos: comboConfig.candidateCombos,
      randomCount: comboConfig.randomCount,
      randomSeed: comboConfig.randomSeed,
      all: ranked,
      best: ranked[0] ?? null,
      relatedRunIds,
    };
  }

  async function executeOutOfSampleRuns(body, options = {}) {
    const splitRatio = parseSplitRatio(
      options.splitRatio ?? body.splitRatio,
      0.7,
    );
    const taskTag =
      String(options.taskTag ?? "stability").trim() || "stability";
    const strategyParameters = normalizeStrategyParameters(
      options.strategyParameters ?? body.strategyParameters,
    );
    const sampleRanges = buildSampleRanges(
      body.startDate,
      body.endDate,
      splitRatio,
    );
    const strategyLabel = getAnalysisStrategyLabel(body.path);
    const inSampleTitlePrefix =
      String(options.inSampleTitlePrefix ?? "组合验证样本内").trim() ||
      "组合验证样本内";
    const outSampleTitlePrefix =
      String(options.outSampleTitlePrefix ?? "组合验证样本外").trim() ||
      "组合验证样本外";

    const inSampleRun = await executeWorkspaceAnalysisRun({
      body: {
        ...body,
        startDate: sampleRanges.inSample.startDate,
        endDate: sampleRanges.inSample.endDate,
      },
      strategyParameters,
      title: `${inSampleTitlePrefix} ${strategyLabel}`,
      requestType: options.requestType ?? "analysis-stability-run",
      tags: [taskTag, strategyLabel, "in-sample"],
    });

    const outSampleRun = await executeWorkspaceAnalysisRun({
      body: {
        ...body,
        startDate: sampleRanges.outSample.startDate,
        endDate: sampleRanges.outSample.endDate,
      },
      strategyParameters,
      title: `${outSampleTitlePrefix} ${strategyLabel}`,
      requestType: options.requestType ?? "analysis-stability-run",
      tags: [taskTag, strategyLabel, "out-of-sample"],
    });

    return {
      splitRatio,
      strategyParameters,
      inSample: {
        runId: inSampleRun.id,
        range: sampleRanges.inSample,
        metrics: buildRunMetricSummary(inSampleRun),
      },
      outSample: {
        runId: outSampleRun.id,
        range: sampleRanges.outSample,
        metrics: buildRunMetricSummary(outSampleRun),
      },
      relatedRunIds: [inSampleRun.id, outSampleRun.id],
    };
  }

  async function executeRollingRuns(body, options = {}) {
    const rollingWindowDays = parseRollingDayConfig(
      options.rollingWindowDays ?? body.rollingWindowDays,
      120,
      "rollingWindowDays",
    );
    const rollingStepDays = parseRollingDayConfig(
      options.rollingStepDays ?? body.rollingStepDays,
      40,
      "rollingStepDays",
    );
    const strategyParameters = normalizeStrategyParameters(
      options.strategyParameters ?? body.strategyParameters,
    );
    const taskTag =
      String(options.taskTag ?? "stability").trim() || "stability";
    const rollingRanges = buildRollingRanges(
      body.startDate,
      body.endDate,
      rollingWindowDays,
      rollingStepDays,
    );
    const strategyLabel = getAnalysisStrategyLabel(body.path);
    const rolling = [];
    const relatedRunIds = [];

    for (const segment of rollingRanges) {
      const run = await executeWorkspaceAnalysisRun({
        body: {
          ...body,
          startDate: segment.startDate,
          endDate: segment.endDate,
        },
        strategyParameters,
        title: `${segment.label} ${strategyLabel}`,
        requestType: options.requestType ?? "analysis-stability-run",
        tags: [taskTag, strategyLabel, "rolling"],
      });
      relatedRunIds.push(run.id);
      rolling.push({
        label: segment.label,
        runId: run.id,
        range: segment,
        metrics: buildRunMetricSummary(run),
      });
    }

    return {
      rollingWindowDays,
      rollingStepDays,
      strategyParameters,
      rolling,
      relatedRunIds,
    };
  }

  async function executeStabilityRuns(body, options = {}) {
    const strategyParameters = normalizeStrategyParameters(
      options.strategyParameters ?? body.strategyParameters,
    );
    const taskTag =
      String(options.taskTag ?? "stability").trim() || "stability";
    const outOfSample = await executeOutOfSampleRuns(body, {
      ...options,
      taskTag,
      strategyParameters,
    });
    const rolling = await executeRollingRuns(body, {
      ...options,
      taskTag,
      strategyParameters,
    });

    return {
      splitRatio: outOfSample.splitRatio,
      rollingWindowDays: rolling.rollingWindowDays,
      rollingStepDays: rolling.rollingStepDays,
      strategyParameters,
      inSample: outOfSample.inSample,
      outSample: outOfSample.outSample,
      rolling: rolling.rolling,
      relatedRunIds: [...outOfSample.relatedRunIds, ...rolling.relatedRunIds],
    };
  }

  function buildOutOfSampleWarnings(outOfSample) {
    const warnings = [];
    const inSampleReturn = Number(
      outOfSample?.inSample?.metrics?.totalReturn ?? Number.NaN,
    );
    const outSampleReturn = Number(
      outOfSample?.outSample?.metrics?.totalReturn ?? Number.NaN,
    );

    if (Number.isFinite(inSampleReturn) && Number.isFinite(outSampleReturn)) {
      if (outSampleReturn < 0) {
        warnings.push("样本外收益为负，建议先检查参数过拟合或区间选择。");
      } else if (outSampleReturn + 1e-6 < inSampleReturn * 0.5) {
        warnings.push(
          "样本外收益明显低于样本内，建议继续检查滚动表现与参数空间。",
        );
      }
    }

    return warnings;
  }

  function buildRollingWarnings(rollingResult) {
    const warnings = [];
    const count = Array.isArray(rollingResult?.rolling)
      ? rollingResult.rolling.length
      : 0;
    const windowDays = Number(rollingResult?.rollingWindowDays ?? Number.NaN);
    const stepDays = Number(rollingResult?.rollingStepDays ?? Number.NaN);

    if (count > 0 && count < 3) {
      warnings.push("滚动窗口数量偏少，当前滚动结论更适合作为参考而不是定论。");
    }
    if (
      Number.isFinite(stepDays) &&
      Number.isFinite(windowDays) &&
      stepDays >= windowDays
    ) {
      warnings.push(
        "滚动步长不应大于或等于窗口长度，否则连续验证的价值会明显下降。",
      );
    }
    if (Number.isFinite(windowDays) && windowDays < 60) {
      warnings.push(
        "滚动窗口偏短，可能不足以覆盖一轮完整行情。可优先尝试 90 到 180 天。",
      );
    }

    return warnings;
  }

  function buildResearchWarnings(optimization, stability) {
    const warnings = [];
    if (!optimization) {
      warnings.push("未配置参数范围，本次研究直接使用当前策略参数。");
    }
    warnings.push(...buildOutOfSampleWarnings(stability));
    return warnings;
  }

  async function runOptimizationTaskFromBody(rawBody, existingTask = null) {
    const body = hydrateWorkspaceAnalysisBody(rawBody);
    const strategyLabel = getAnalysisStrategyLabel(body.path);
    const now = isoNow();
    const task = existingTask
      ? database.updateTask(existingTask.id, {
          status: "running",
          errorMessage: null,
          request: { ...body },
          result: null,
          relatedRunIds: [],
          updatedAt: now,
        })
      : await createTask({
          type: "optimization",
          title: `参数优化 · ${strategyLabel}`,
          status: "running",
          request: { ...body },
          relatedRunIds: [],
          createdAt: now,
          updatedAt: now,
        });

    try {
      const optimization = await executeOptimizationRuns(body, {
        metric: rawBody.metric,
      });
      const completed = database.updateTask(task.id, {
        status: "completed",
        result: {
          metric: optimization.metric,
          method: optimization.method,
          candidateCombos: optimization.candidateCombos,
          randomCount: optimization.randomCount,
          randomSeed: optimization.randomSeed,
          best: optimization.best,
          all: optimization.all,
        },
        relatedRunIds: optimization.relatedRunIds,
        errorMessage: null,
        updatedAt: isoNow(),
      });
      addSystemLog(database, {
        scope: "research",
        level: "INFO",
        title: "参数优化完成",
        message: `${strategyLabel} 已完成 ${optimization.all.length} 组参数回测`,
        payload: {
          taskId: task.id,
          best: optimization.best,
        },
      });
      return completed;
    } catch (error) {
      database.updateTask(task.id, {
        status: "failed",
        errorMessage: error.message,
        updatedAt: isoNow(),
      });
      throw error;
    }
  }

  async function runStabilityTaskFromBody(rawBody, existingTask = null) {
    const body = hydrateWorkspaceAnalysisBody(rawBody);
    const strategyLabel = getAnalysisStrategyLabel(body.path);
    const now = isoNow();
    const task = existingTask
      ? database.updateTask(existingTask.id, {
          status: "running",
          errorMessage: null,
          request: { ...body },
          result: null,
          relatedRunIds: [],
          updatedAt: now,
        })
      : await createTask({
          type: "stability",
          title: `组合验证 · ${strategyLabel}`,
          status: "running",
          request: { ...body },
          relatedRunIds: [],
          createdAt: now,
          updatedAt: now,
        });

    try {
      const stability = await executeStabilityRuns(body);
      const completed = database.updateTask(task.id, {
        status: "completed",
        result: {
          splitRatio: stability.splitRatio,
          rollingWindowDays: stability.rollingWindowDays,
          rollingStepDays: stability.rollingStepDays,
          strategyParameters: stability.strategyParameters,
          inSample: stability.inSample,
          outSample: stability.outSample,
          rolling: stability.rolling,
        },
        relatedRunIds: stability.relatedRunIds,
        errorMessage: null,
        updatedAt: isoNow(),
      });
      addSystemLog(database, {
        scope: "research",
        level: "INFO",
        title: "组合验证完成",
        message: `${strategyLabel} 已完成样本内/样本外与滚动窗口验证`,
        payload: {
          taskId: task.id,
          splitRatio: stability.splitRatio,
          rollingWindows: stability.rolling.length,
        },
      });
      return completed;
    } catch (error) {
      database.updateTask(task.id, {
        status: "failed",
        errorMessage: error.message,
        updatedAt: isoNow(),
      });
      throw error;
    }
  }

  async function runOutOfSampleTaskFromBody(rawBody, existingTask = null) {
    const body = hydrateWorkspaceAnalysisBody(rawBody);
    const strategyLabel = getAnalysisStrategyLabel(body.path);
    const now = isoNow();
    const task = existingTask
      ? database.updateTask(existingTask.id, {
          status: "running",
          errorMessage: null,
          request: { ...body },
          result: null,
          relatedRunIds: [],
          updatedAt: now,
        })
      : await createTask({
          type: "out_of_sample",
          title: `样本外测试 · ${strategyLabel}`,
          status: "running",
          request: { ...body },
          relatedRunIds: [],
          createdAt: now,
          updatedAt: now,
        });

    try {
      const outOfSample = await executeOutOfSampleRuns(body, {
        requestType: "analysis-out-of-sample-run",
        taskTag: "out-of-sample",
        inSampleTitlePrefix: "样本内测试",
        outSampleTitlePrefix: "样本外测试",
      });
      const warnings = buildOutOfSampleWarnings(outOfSample);
      const completed = database.updateTask(task.id, {
        status: "completed",
        result: {
          splitRatio: outOfSample.splitRatio,
          strategyParameters: outOfSample.strategyParameters,
          inSample: outOfSample.inSample,
          outSample: outOfSample.outSample,
          warnings,
        },
        relatedRunIds: outOfSample.relatedRunIds,
        errorMessage: null,
        updatedAt: isoNow(),
      });
      addSystemLog(database, {
        scope: "research",
        level: warnings.length ? "WARN" : "INFO",
        title: "样本外测试完成",
        message: `${strategyLabel} 已完成样本内外对照验证`,
        payload: {
          taskId: task.id,
          splitRatio: outOfSample.splitRatio,
          warnings,
        },
      });
      return completed;
    } catch (error) {
      database.updateTask(task.id, {
        status: "failed",
        errorMessage: error.message,
        updatedAt: isoNow(),
      });
      throw error;
    }
  }

  async function runRollingTaskFromBody(rawBody, existingTask = null) {
    const body = hydrateWorkspaceAnalysisBody(rawBody);
    const strategyLabel = getAnalysisStrategyLabel(body.path);
    const now = isoNow();
    const task = existingTask
      ? database.updateTask(existingTask.id, {
          status: "running",
          errorMessage: null,
          request: { ...body },
          result: null,
          relatedRunIds: [],
          updatedAt: now,
        })
      : await createTask({
          type: "rolling",
          title: `滚动测试 · ${strategyLabel}`,
          status: "running",
          request: { ...body },
          relatedRunIds: [],
          createdAt: now,
          updatedAt: now,
        });

    try {
      const rolling = await executeRollingRuns(body, {
        requestType: "analysis-rolling-run",
        taskTag: "rolling",
      });
      const warnings = buildRollingWarnings(rolling);
      const completed = database.updateTask(task.id, {
        status: "completed",
        result: {
          rollingWindowDays: rolling.rollingWindowDays,
          rollingStepDays: rolling.rollingStepDays,
          strategyParameters: rolling.strategyParameters,
          rolling: rolling.rolling,
          warnings,
        },
        relatedRunIds: rolling.relatedRunIds,
        errorMessage: null,
        updatedAt: isoNow(),
      });
      addSystemLog(database, {
        scope: "research",
        level: warnings.length ? "WARN" : "INFO",
        title: "滚动测试完成",
        message: `${strategyLabel} 已完成滚动窗口验证`,
        payload: {
          taskId: task.id,
          rollingWindowDays: rolling.rollingWindowDays,
          rollingStepDays: rolling.rollingStepDays,
          rollingWindows: rolling.rolling.length,
          warnings,
        },
      });
      return completed;
    } catch (error) {
      database.updateTask(task.id, {
        status: "failed",
        errorMessage: error.message,
        updatedAt: isoNow(),
      });
      throw error;
    }
  }

  async function runResearchTaskFromBody(rawBody, existingTask = null) {
    const body = hydrateWorkspaceAnalysisBody(rawBody);
    const strategyLabel = getAnalysisStrategyLabel(body.path);
    const now = isoNow();
    const task = existingTask
      ? database.updateTask(existingTask.id, {
          status: "running",
          errorMessage: null,
          request: { ...body },
          result: null,
          relatedRunIds: existingTask.relatedRunIds ?? [],
          updatedAt: now,
        })
      : await createTask({
          type: "research",
          title: `策略研究 · ${strategyLabel}`,
          status: "running",
          request: { ...body },
          relatedRunIds: [],
          createdAt: now,
          updatedAt: now,
        });

    try {
      const hasParameterRanges =
        body.parameterRanges &&
        typeof body.parameterRanges === "object" &&
        !Array.isArray(body.parameterRanges) &&
        Object.keys(body.parameterRanges).length > 0;
      const optimization = hasParameterRanges
        ? await executeOptimizationRuns(body, {
            metric: rawBody.metric,
            requestType: "analysis-research-optimization-run",
          })
        : null;
      const strategyParameters = normalizeStrategyParameters(
        optimization?.best?.params ?? body.strategyParameters,
      );
      const stability = await executeStabilityRuns(body, {
        requestType: "analysis-research-stability-run",
        strategyParameters,
      });
      const warnings = buildResearchWarnings(optimization, stability);
      const recommendedBacktest = {
        path: body.path,
        sourceCode: body.sourceCode,
        startDate: body.startDate,
        endDate: body.endDate,
        adjust: body.adjust,
        capital: body.capital,
        slippage: body.slippage,
        rate: body.rate,
        benchmark: body.benchmark,
        dataProvider: body.dataProvider ?? null,
        strategyParameters,
        sizingMode: body.sizingMode,
        fixedSize: body.fixedSize,
        positionPct: body.positionPct,
        cashReservePct: body.cashReservePct,
        stopLossPct: body.stopLossPct,
        takeProfitPct: body.takeProfitPct,
        trailingStopPct: body.trailingStopPct,
        slippageMode: body.slippageMode,
        slippageValue: body.slippageValue,
        openCommissionRate: body.openCommissionRate,
        closeCommissionRate: body.closeCommissionRate,
        minCommission: body.minCommission,
        stampDutyRate: body.stampDutyRate,
        impactCostBps: body.impactCostBps,
      };
      const inSampleRun = database.getRun(stability.inSample.runId);
      const completed = database.updateTask(task.id, {
        status: "completed",
        result: {
          metric: normalizeAnalysisMetric(rawBody.metric),
          provider: body.dataProvider ?? "auto",
          best: optimization?.best ?? {
            params: strategyParameters,
            metrics: stability.inSample.metrics,
          },
          optimization: optimization
            ? {
                method: optimization.method,
                candidateCombos: optimization.candidateCombos,
                randomCount: optimization.randomCount,
                randomSeed: optimization.randomSeed,
                top: optimization.all.slice(0, 5),
              }
            : null,
          stability: {
            splitRatio: stability.splitRatio,
            rollingWindowDays: stability.rollingWindowDays,
            rollingStepDays: stability.rollingStepDays,
            inSample: stability.inSample,
            outSample: stability.outSample,
            rolling: stability.rolling,
          },
          dataset: {
            bars: Number(inSampleRun?.artifacts?.bars?.length ?? 0),
          },
          warnings,
          recommendedBacktest,
        },
        errorMessage: null,
        updatedAt: isoNow(),
      });
      addSystemLog(database, {
        scope: "research",
        level: warnings.length ? "WARN" : "INFO",
        title: "策略研究完成",
        message: `${strategyLabel} 已形成研究结论，可继续推进正式回测`,
        payload: {
          taskId: task.id,
          best: optimization?.best ?? { params: strategyParameters },
          warnings,
        },
      });
      return completed;
    } catch (error) {
      database.updateTask(task.id, {
        status: "failed",
        errorMessage: error.message,
        updatedAt: isoNow(),
      });
      throw error;
    }
  }

  function findCoverageEntryInPayload(payload, { symbol, exchange, interval, adjust }) {
    const coverage = Array.isArray(payload?.coverage) ? payload.coverage : [];
    return (
      coverage
        .map(normalizeCoverageItem)
        .find(
          (item) =>
            item.symbol === symbol &&
            item.exchange === exchange &&
            item.interval === interval &&
            item.adjust === adjust,
        ) ?? null
    );
  }

  async function findCoverageEntry(target) {
    return findCoverageEntryInPayload(await getCachedCoverage(), target);
  }

  async function ensureMarketData({
    symbol,
    exchange,
    interval,
    adjust,
    dataProvider = null,
    startDate,
    endDate,
    trigger = "backtest",
    runId = null,
    path = "",
  }) {
    const requestedDataProvider = normalizeRequestedDataProvider(dataProvider);
    const coveragePayload = await getCachedCoverage();
    const sourceMode = String(coveragePayload?.sourceMode ?? "").trim();
    const coverageBefore = findCoverageEntryInPayload(coveragePayload, {
      symbol,
      exchange,
      interval,
      adjust,
    });

    const providerSatisfied =
      sourceMode === "tdx-cache"
        ? true
        : coverageMatchesRequestedProvider(
            coverageBefore,
            requestedDataProvider,
          );

    if (coverageCoversRange(coverageBefore, startDate, endDate) && providerSatisfied) {
      return {
        checked: true,
        synced: false,
        taskId: null,
        symbol,
        exchange,
        interval,
        adjust,
        startDate,
        endDate,
        orderBookId: formatOrderBookId(symbol, exchange),
        barsSynced: 0,
        provider: coverageBefore?.provider ?? requestedDataProvider,
        message:
          sourceMode === "tdx-cache"
            ? "tdx cache coverage satisfied"
            : "local coverage satisfied",
        coverageBefore,
        coverageAfter: coverageBefore,
      };
    }

    assertCondition(
      sourceMode !== "tdx-cache",
      "通达信行情缓存未覆盖所选区间，不能通过通用同步接口自动补数",
      409,
    );

    const now = isoNow();
    const orderBookId = formatOrderBookId(symbol, exchange);
    const task = await createTask({
      type: "market_sync",
      title: `行情增补 ${orderBookId}`,
      status: "running",
      request: {
        trigger,
        runId,
        path,
        symbol,
        exchange,
        interval,
        adjust,
        dataProvider: requestedDataProvider,
        startDate,
        endDate,
        orderBookId,
      },
      relatedRunIds: runId ? [runId] : [],
      createdAt: now,
      updatedAt: now,
    });

    try {
      const result = await engine.syncData({
        symbol,
        exchange,
        interval,
        adjust,
        dataProvider: requestedDataProvider,
        startDate,
        endDate,
      });
      const coverageAfter = await findCoverageEntry({
        symbol,
        exchange,
        interval,
        adjust,
      });
      const syncLog = {
        id: randomUUID(),
        symbol,
        exchange,
        interval,
        startDate,
        endDate,
        status: "success",
        provider: result.provider ?? requestedDataProvider ?? "unknown",
        barsSynced: result.barsSynced,
        message: result.message,
        createdAt: isoNow(),
      };
      database.addSyncLog(syncLog);
      database.updateTask(task.id, {
        status: "completed",
        result: {
          synced: true,
          taskId: task.id,
          orderBookId,
          symbol,
          exchange,
          interval,
          adjust,
          startDate,
          endDate,
          barsSynced: result.barsSynced,
          provider: result.provider ?? requestedDataProvider,
          message: result.message,
          coverageBefore,
          coverageAfter,
        },
        updatedAt: isoNow(),
      });
      return {
        checked: true,
        synced: true,
        taskId: task.id,
        orderBookId,
        symbol,
        exchange,
        interval,
        adjust,
        startDate,
        endDate,
        barsSynced: result.barsSynced,
        provider: result.provider,
        message: result.message,
        coverageBefore,
        coverageAfter,
      };
    } catch (error) {
      database.addSyncLog({
        id: randomUUID(),
        symbol,
        exchange,
        interval,
        startDate,
        endDate,
        status: "failed",
        provider: requestedDataProvider ?? "unknown",
        barsSynced: 0,
        message: error.message,
        createdAt: isoNow(),
      });
      database.updateTask(task.id, {
        status: "failed",
        errorMessage: error.message,
        result: {
          synced: false,
          taskId: task.id,
          orderBookId,
          symbol,
          exchange,
          interval,
          adjust,
          startDate,
          endDate,
          provider: requestedDataProvider,
          coverageBefore,
        },
        updatedAt: isoNow(),
      });
      throw error;
    }
  }

  async function ensureBenchmarkData({
    benchmark,
    symbol,
    exchange,
    interval,
    dataProvider = null,
    startDate,
    endDate,
    trigger,
    runId = null,
    path = "",
  }) {
    const target = normalizeBenchmarkSyncRequest(benchmark, symbol, exchange);
    if (!target) {
      return null;
    }
    const window = expandBenchmarkSyncWindow(startDate, endDate);

    try {
      return await ensureMarketData({
        symbol: target.symbol,
        exchange: target.exchange,
        interval,
        adjust: target.adjust,
        dataProvider,
        startDate: window.startDate,
        endDate: window.endDate,
        trigger,
        runId,
        path,
      });
    } catch (error) {
      throw createForwardError(
        error,
        `基准 ${resolveBenchmarkLabel(target.orderBookId)} (${target.orderBookId}) 同步失败：${error.message}`,
      );
    }
  }

  async function runBuiltinBacktestFromBody(body, override = {}) {
    validateBacktestRequest(body);

    const catalog = await engine.getStrategies();
    const strategy = catalog.strategies.find(
      (item) => item.id === body.strategyId,
    );
    assertCondition(Boolean(strategy), "找不到对应的策略模板", 404);

    let parameterSet = null;
    if (body.parameterSetId) {
      parameterSet = database.getParameterSet(body.parameterSetId);
      assertCondition(Boolean(parameterSet), "找不到对应的参数集", 404);
    }

    return executeBuiltinBacktest({
      strategy,
      body: {
        ...body,
        parameters: {
          ...(parameterSet?.params ?? {}),
          ...(body.parameters ?? {}),
        },
      },
      parameterSetId: body.parameterSetId ?? null,
      requestType: override.requestType ?? "backtest",
      title: override.title ?? "策略回测",
      runPatch: {
        tags: override.tags ?? body.tags,
        notes: override.notes ?? body.notes,
        starred: override.starred ?? body.starred,
      },
    });
  }

  async function runWorkspaceBacktestFromBody(body, override = {}) {
    validateWorkspaceRunRequest(body);

    const runId = randomUUID();
    const now = isoNow();
    const strategyId = basename(body.path, ".py");
    const strategyVersion = saveWorkspaceStrategyVersion(
      database,
      body,
      strategyId,
    );
    const strategyParameters = normalizeStrategyParameters(
      body.strategyParameters,
    );
    const parameters = {
      ...strategyParameters,
      sizing_mode: String(body.sizingMode ?? "percent"),
      fixed_size: Number(body.fixedSize ?? 100),
      position_pct: Number(body.positionPct ?? 100),
      cash_reserve_pct: Number(body.cashReservePct ?? 0),
      stop_loss_pct: Number(body.stopLossPct ?? 0),
      take_profit_pct: Number(body.takeProfitPct ?? 0),
      trailing_stop_pct: Number(body.trailingStopPct ?? 0),
    };
    const costModel = buildCostModelFromBody(body, resolveAppConfig());
    const requestSnapshot = {
      requestType: override.requestType ?? "workspace-run",
      path: body.path,
      startDate: body.startDate,
      endDate: body.endDate,
      adjust: body.adjust,
      capital: body.capital,
      slippage: body.slippage,
      rate: body.rate,
      benchmark: body.benchmark,
      dataProvider: body.dataProvider ?? null,
      strategyParameters,
      parameters,
      costModel,
      sourceCode: body.sourceCode,
      title: override.title ?? "代码策略回测",
      dataSync: null,
      benchmarkDataSync: null,
    };

    database.createRun({
      id: runId,
      title: override.title ?? "代码策略回测",
      strategyId,
      parameterSetId: null,
      symbol: "PYTHON",
      exchange: "LOCAL",
      interval: "1d",
      startDate: body.startDate,
      endDate: body.endDate,
      capital: body.capital,
      slippage: body.slippage,
      rate: body.rate,
      status: "queued",
      errorMessage: null,
      summary: null,
      artifacts: null,
      request: requestSnapshot,
      strategyVersionId: strategyVersion?.id ?? null,
      tags: normalizeTagList(override.tags ?? body.tags),
      notes: String(override.notes ?? body.notes ?? ""),
      starred: Boolean(override.starred ?? body.starred),
      createdAt: now,
      updatedAt: now,
    });

    database.updateRun(runId, {
      status: "running",
      updatedAt: isoNow(),
    });

    try {
      const resolvedInstrument =
        /^\d{6}$/.test(String(body.symbol ?? "")) &&
        ["SSE", "SZSE"].includes(String(body.exchange ?? ""))
          ? {
              symbol: String(body.symbol),
              exchange: String(body.exchange),
            }
          : extractOrderBookIdFromSource(body.sourceCode);
      if (resolvedInstrument) {
        const dataSync = await ensureMarketData({
          symbol: resolvedInstrument.symbol,
          exchange: resolvedInstrument.exchange,
          interval: "1d",
          adjust: body.adjust,
          dataProvider: body.dataProvider ?? null,
          startDate: body.startDate,
          endDate: body.endDate,
          trigger: "workspace-run",
          runId,
          path: body.path,
        });
        requestSnapshot.dataSync = dataSync;
        requestSnapshot.symbol = resolvedInstrument.symbol;
        requestSnapshot.exchange = resolvedInstrument.exchange;
        requestSnapshot.benchmarkDataSync = await ensureBenchmarkData({
          benchmark: body.benchmark,
          symbol: resolvedInstrument.symbol,
          exchange: resolvedInstrument.exchange,
          interval: "1d",
          dataProvider: body.dataProvider ?? null,
          startDate: body.startDate,
          endDate: body.endDate,
          trigger: "workspace-run-benchmark",
          runId,
          path: body.path,
        });
        database.updateRun(runId, {
          request: requestSnapshot,
          updatedAt: isoNow(),
        });
      }

      const engineResult = await engine.runWorkspaceStrategy({
        runId,
        strategyId,
        workspacePath: body.path,
        sourceCode: body.sourceCode,
        startDate: body.startDate,
        endDate: body.endDate,
        capital: body.capital,
        benchmark: body.benchmark,
        adjust: body.adjust,
        slippage: body.slippage,
        rate: body.rate,
        parameters,
        costModel,
      });

      const savedRun = database.updateRun(runId, {
        symbol: engineResult.summary.symbol ?? "PYTHON",
        exchange: engineResult.summary.exchange ?? "LOCAL",
        interval: engineResult.summary.interval ?? "1d",
        startDate: engineResult.summary.startDate ?? body.startDate,
        endDate: engineResult.summary.endDate ?? body.endDate,
        capital: engineResult.summary.capital ?? body.capital,
        status: "completed",
        summary: {
          ...engineResult.summary,
          title: override.title ?? "代码策略回测",
        },
        artifacts: engineResult.artifacts,
        request: requestSnapshot,
        strategyVersionId: strategyVersion?.id ?? null,
        updatedAt: isoNow(),
      });

      addSystemLog(database, {
        scope: "workspace",
        level: "INFO",
        title: "代码策略回测完成",
        message: `${body.path} 已完成回测`,
        payload: {
          runId,
          strategyVersionId: strategyVersion?.id ?? null,
        },
      });

      return savedRun;
    } catch (error) {
      const failedRun = database.getRun(runId);
      if (failedRun && failedRun.status === "running") {
        database.updateRun(runId, {
          status: "failed",
          errorMessage: error.message,
          updatedAt: isoNow(),
        });
      }
      addSystemLog(database, {
        scope: "workspace",
        level: "ERROR",
        title: "代码策略回测失败",
        message: error.message,
        payload: {
          path: body.path,
        },
      });
      throw error;
    }
  }

  app.get("/api/quant/health", (_req, res) => {
    res.json({
      ok: true,
      port: options.port ?? DEFAULT_PORT,
      engineUrl:
        options.engineUrl ??
        process.env.QUANT_WORKBENCH_ENGINE_URL ??
        "http://127.0.0.1:8765",
    });
  });

  app.get("/api/quant/workspace/overview", (_req, res) => {
    res.json(workspace.getOverview());
  });

  app.get("/api/quant/workspace/files", (req, res, next) => {
    try {
      const category = String(req.query.category ?? "");
      const rootPath = String(req.query.rootPath ?? "").trim();
      assertCondition(
        category.length > 0 || rootPath.length > 0,
        "缺少 category 或 rootPath",
      );
      const files = workspace.listFiles(rootPath ? { rootPath } : category);
      assertCondition(
        Boolean(files),
        rootPath ? "找不到对应目录" : "不支持的工作区分类",
        404,
      );
      res.json({
        category: rootPath ? "local" : category,
        rootPath: rootPath || undefined,
        files,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/workspace/folder/pick", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      const directRootPath =
        typeof body.rootPath === "string" ? body.rootPath : "";
      const initialPath =
        typeof body.initialPath === "string" ? body.initialPath : "";
      const payload = workspace.pickFolder({
        rootPath: directRootPath,
        initialPath,
      });
      if (!payload) {
        res.json({ cancelled: true });
        return;
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/workspace/file", (req, res, next) => {
    try {
      const path = String(req.query.path ?? "");
      assertCondition(path.length > 0, "缺少 path");
      const payload = workspace.getFile(path);
      assertCondition(Boolean(payload), "找不到对应文件", 404);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/quant/workspace/file", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      assertCondition(
        typeof body.path === "string" && body.path.length > 0,
        "缺少 path",
      );
      assertCondition(typeof body.content === "string", "content 必须是字符串");
      const payload = workspace.saveFile(body.path, body.content);
      assertCondition(Boolean(payload), "找不到对应文件", 404);
      if (body.path.endsWith(".py")) {
        saveWorkspaceStrategyVersion(
          database,
          { path: body.path, sourceCode: body.content },
          basename(body.path, ".py"),
          {
            trigger: "save",
          },
        );
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/workspace/file/rename", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      assertCondition(
        typeof body.path === "string" && body.path.length > 0,
        "缺少 path",
      );
      assertCondition(
        typeof body.newPath === "string" && body.newPath.length > 0,
        "缺少 newPath",
      );
      const payload = workspace.renameFile(body.path, body.newPath);
      assertCondition(Boolean(payload), "找不到对应文件", 404);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/workspace/file/copy", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      assertCondition(
        typeof body.path === "string" && body.path.length > 0,
        "缺少 path",
      );
      assertCondition(
        typeof body.newPath === "string" && body.newPath.length > 0,
        "缺少 newPath",
      );
      const payload = workspace.copyFile(body.path, body.newPath);
      assertCondition(Boolean(payload), "找不到对应文件", 404);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/workspace/folder", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      assertCondition(
        typeof body.path === "string" && body.path.length > 0,
        "缺少 path",
      );
      const payload = workspace.createFolder(body.path);
      assertCondition(Boolean(payload), "创建目录失败", 400);
      res.json({ folder: payload });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/workspace/folder/rename", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      assertCondition(
        typeof body.path === "string" && body.path.length > 0,
        "缺少 path",
      );
      assertCondition(
        typeof body.newPath === "string" && body.newPath.length > 0,
        "缺少 newPath",
      );
      const payload = workspace.renameFolder(body.path, body.newPath);
      assertCondition(Boolean(payload), "找不到对应目录", 404);
      res.json({ folder: payload });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/workspace/file", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      assertCondition(
        typeof body.path === "string" && body.path.length > 0,
        "缺少 path",
      );
      const payload = workspace.deleteFile(body.path);
      assertCondition(Boolean(payload), "找不到对应文件", 404);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/workspace/folder", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      assertCondition(
        typeof body.path === "string" && body.path.length > 0,
        "缺少 path",
      );
      const payload = workspace.deleteFolder(body.path);
      assertCondition(Boolean(payload), "找不到对应目录", 404);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/workspace/folder/open", (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      const category = typeof body.category === "string" ? body.category : "";
      const rootPath = typeof body.rootPath === "string" ? body.rootPath : "";
      assertCondition(
        category.length > 0 || rootPath.length > 0,
        "缺少 category 或 rootPath",
      );
      const payload = workspace.openFolder(rootPath || category);
      assertCondition(Boolean(payload), "找不到对应目录", 404);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/data/overview", async (_req, res, next) => {
    try {
      const overview = await engine.getDataOverview();
      res.json({
        ...overview,
        coverage: [],
        recentSyncs: database.listRecentSyncLogs(12),
        recentRuns: database.listRecentRunSummaries(5),
      });
    } catch (error) {
      next(error);
    }
  });

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

  function toPublicReplayReviewDraft(draft) {
    if (!draft) {
      return null;
    }
    return {
      stage: draft.stage,
      data: draft.data,
      revision: draft.revision,
      updatedAt: draft.updatedAt,
    };
  }

  function aggregateHybridDailyBars(dailyContext, minuteBars) {
    const grouped = new Map();
    for (const bar of minuteBars) {
      const tradeDate = String(bar.tradeDate ?? "");
      if (!grouped.has(tradeDate)) {
        grouped.set(tradeDate, []);
      }
      grouped.get(tradeDate).push(bar);
    }
    const formedDays = [...grouped.values()].map((bars) => ({
      ...bars[0],
      high: Math.max(...bars.map((bar) => Number(bar.high))),
      low: Math.min(...bars.map((bar) => Number(bar.low))),
      close: Number(bars.at(-1)?.close ?? bars[0].close),
      volume: bars.reduce((sum, bar) => sum + Number(bar.volume ?? 0), 0),
      amount: bars.reduce((sum, bar) => sum + Number(bar.amount ?? 0), 0),
      tradeTime: null,
    }));
    return [...dailyContext, ...formedDays];
  }

  function toPublicReplaySession(session) {
    const progressBarCount =
      Number(session.observationBars) + Number(session.revealedFutureBars);
    const privateBars = Array.isArray(session.snapshot?.bars)
      ? session.snapshot.bars
      : [];
    const isRevealed = Boolean(session.revealedAt);
    const replayWindowBarCount =
      Number(session.observationBars) + Number(session.gameLength);
    const publicBarCount = isRevealed
      ? Math.min(privateBars.length, replayWindowBarCount)
      : progressBarCount;
    const markPrice = Number(privateBars[progressBarCount - 1]?.close ?? 0);
    const account = session.account ?? {};
    const positionQuantity = Number(account.positionQuantity ?? 0);
    const averageCost = Number(account.averageCost ?? 0);
    const marketValue = roundReplayValue(markPrice * positionQuantity);
    const unrealizedPnl = roundReplayValue(
      (markPrice - averageCost) * positionQuantity,
    );
    const realizedPnl = roundReplayValue(account.realizedPnl ?? 0);
    const totalEquity = roundReplayValue(
      Number(account.cash ?? 0) + marketValue,
    );
    const initialCapital = Number(account.initialCapital ?? 0);
    const review = session.review ?? {};
    const blindReview = review.blindReview ?? null;
    const postReview = isRevealed ? review.postReview ?? null : null;
    const marketEvent =
      Number(session.revealedFutureBars) > 0
        ? {
            sequence: progressBarCount,
            status: classifyReplayMarketStatus(
              privateBars[progressBarCount - 1],
            ),
          }
        : null;
    const snapshotInterval = String(session.snapshot?.interval ?? "1d");
    const interval = ["1m", "hybrid"].includes(snapshotInterval)
      ? snapshotInterval
      : "1d";
    const stepMinutes = interval === "hybrid"
      ? Number(session.snapshot?.stepMinutes ?? 1)
      : interval === "1m" ? 1 : null;
    const barUnit = interval === "1m" ? "分钟" : "日";
    const hybridFutureBars = interval === "hybrid"
      ? privateBars.slice(
          Number(session.observationBars),
          Number(session.observationBars) +
            (isRevealed ? Number(session.gameLength) : Number(session.revealedFutureBars)),
        )
      : [];
    const hybridNextBar = interval === "hybrid"
      ? privateBars[
          Number(session.observationBars) + Number(session.revealedFutureBars)
        ] ?? null
      : null;
    const hybridLastDate = String(hybridFutureBars.at(-1)?.tradeDate ?? "");
    const hybridCurrentDayComplete = Boolean(hybridLastDate) &&
      (!hybridNextBar || String(hybridNextBar.tradeDate ?? "") !== hybridLastDate);
    const hybridDates = [...new Set(hybridFutureBars.map((bar) => String(bar.tradeDate ?? "")))];
    const hybridCompletedDays = Math.max(
      0,
      hybridDates.length - (hybridCurrentDayComplete ? 0 : 1),
    );
    const hybridMinuteBars = hybridLastDate
      ? hybridFutureBars.filter((bar) => String(bar.tradeDate ?? "") === hybridLastDate)
      : [];
    const displayPrivateBars = interval === "hybrid"
      ? aggregateHybridDailyBars(
          privateBars.slice(0, Number(session.observationBars)),
          hybridFutureBars,
        )
      : privateBars.slice(0, publicBarCount);
    return {
      id: session.id,
      sourceDataVersion: session.sourceDataVersion,
      interval,
      ...(stepMinutes ? { stepMinutes } : {}),
      gameLength:
        interval === "hybrid"
          ? Number(session.snapshot?.trainingDays ?? 0)
          : session.gameLength,
      observationBars: session.observationBars,
      revealedFutureBars:
        interval === "hybrid"
          ? hybridCompletedDays
          : session.revealedFutureBars,
      ...(interval === "hybrid"
        ? { revealedMinuteBars: Number(session.revealedFutureBars) }
        : {}),
      status: session.status,
      completionReason: session.completionReason,
      benchmarkCode: String(session.snapshot?.benchmark?.code ?? ""),
      revealed: isRevealed,
      revision: Number(session.revision ?? 0),
      marketEvent,
      attemptInfo: session.attemptInfo ?? {
        attemptNumber: 1,
        kind: "first",
        countsTowardFirstScore: true,
        sourceSessionId: null,
      },
      trainingConfig: session.trainingConfig ?? { mode: "free" },
      costConfig: {
        commissionRate: Number(session.costConfig?.commissionRate ?? 0),
        minCommission: Number(session.costConfig?.minCommission ?? 0),
        stampTaxRate: Number(session.costConfig?.stampTaxRate ?? 0),
        transferFeeRate: Number(session.costConfig?.transferFeeRate ?? 0),
        slippageBps: Number(session.costConfig?.slippageBps ?? 0),
      },
      account: {
        initialCapital,
        cash: Number(account.cash ?? 0),
        positionQuantity,
        availableQuantity: Number(account.availableQuantity ?? 0),
        lockedQuantity: Number(account.lockedQuantity ?? 0),
        averageCost,
        totalFees: Number(account.totalFees ?? 0),
      },
      pendingOrders: (session.pendingOrders ?? []).map((order) => ({
        orderId: order.orderId,
        side: order.side,
        quantityType: order.quantityType,
        requestedQuantity: order.requestedQuantity,
        ratio: order.ratio,
        decision: order.decision ?? null,
        submittedSequence: order.submittedSequence,
        scheduledSequence: order.scheduledSequence,
      })),
      executions: (session.executions ?? []).map((execution) => {
        if (execution.status === "filled") {
          return {
              orderId: execution.orderId,
              status: "filled",
              side: execution.side,
              decision: execution.decision ?? null,
              sequence: execution.sequence,
              quantity: execution.quantity,
              referencePrice: execution.referencePrice,
              price: execution.price,
              slippageBps: execution.slippageBps,
              notional: execution.notional,
              commission: execution.commission,
              stampTax: execution.stampTax,
              transferFee: execution.transferFee,
              totalFee: execution.totalFee,
          };
        }
        return {
          orderId: execution.orderId,
          status:
            execution.status === "cancelled" ? "cancelled" : "rejected",
          side: execution.side,
          decision: execution.decision ?? null,
          sequence: execution.sequence,
          reasonCode: execution.reasonCode,
          reasonMessage: execution.reasonMessage,
        };
      }),
      valuation: {
        markPrice,
        marketValue,
        totalEquity,
        realizedPnl,
        unrealizedPnl,
        totalPnl: roundReplayValue(totalEquity - initialCapital),
      },
      review: {
        blindSaved: Boolean(blindReview),
        postSaved: Boolean(postReview),
        blindLocked: isRevealed,
        legacyBlindMissing: isRevealed && !blindReview,
        blindReview,
        postReview,
      },
      reviewDrafts: {
        blind: toPublicReplayReviewDraft(session.reviewDrafts?.blind),
        post: isRevealed
          ? toPublicReplayReviewDraft(session.reviewDrafts?.post)
          : null,
      },
      corrections: (session.corrections ?? [])
        .filter(
          (correction) =>
            isRevealed || correction.stage === "blind",
        )
        .map((correction) => ({
          id: correction.id,
          stage: correction.stage,
          revisionNumber: correction.revisionNumber,
          fullReviewSnapshot: correction.fullReviewSnapshot,
          changeNote: correction.changeNote,
          createdAt: correction.createdAt,
        })),
      scoreCard: isRevealed ? review.scoreCard ?? null : null,
      ...(interval === "hybrid"
        ? {
            intraday: {
              completedDays:
                hybridCompletedDays,
              trainingDays: Number(session.snapshot?.trainingDays ?? 0),
              currentMinute: hybridMinuteBars.length,
              currentDayComplete: hybridCurrentDayComplete,
            },
            minuteBars: hybridMinuteBars.map((bar, index) => ({
              sequence: Number(bar.sequence),
              displayLabel: isRevealed
                ? String(bar.tradeTime ?? "")
                : stepMinutes === 1
                  ? `第 ${index + 1} 分钟`
                  : `第 ${index + 1} 个${stepMinutes}分钟`,
              ...(isRevealed
                ? {
                    tradeDate: String(bar.tradeDate ?? ""),
                    tradeTime: String(bar.tradeTime ?? ""),
                  }
                : {}),
              open: Number(bar.open),
              high: Number(bar.high),
              low: Number(bar.low),
              close: Number(bar.close),
              volume: Number(bar.volume ?? 0),
              amount: Number(bar.amount ?? 0),
              weekIndex: Number(bar.weekIndex),
              monthIndex: Number(bar.monthIndex),
            })),
          }
        : {}),
      ...(isRevealed
        ? {
            reveal: {
              tsCode: String(session.snapshot?.tsCode ?? ""),
              symbol: String(session.snapshot?.symbol ?? ""),
              exchange: String(session.snapshot?.exchange ?? ""),
              name: String(session.snapshot?.name ?? ""),
              startDate: String(privateBars[0]?.tradeDate ?? ""),
              endDate: String(
                privateBars[publicBarCount - 1]?.tradeDate ?? "",
              ),
              ...(interval === "1m"
                ? {
                    startTime: String(privateBars[0]?.tradeTime ?? ""),
                    endTime: String(
                      privateBars[publicBarCount - 1]?.tradeTime ?? "",
                    ),
                  }
                : {}),
            },
          }
        : {}),
      bars: displayPrivateBars.map((bar, index) => ({
        sequence: index + 1,
        displayLabel: isRevealed
          ? String(bar.tradeTime ?? bar.tradeDate ?? "")
          : interval === "hybrid" && index >= Number(session.observationBars)
            ? `第 ${index + 1} 日${
                index === displayPrivateBars.length - 1 && !hybridCurrentDayComplete
                  ? "（形成中）"
                  : ""
              }`
            : `第 ${index + 1} ${barUnit}`,
        ...(isRevealed
          ? {
              tradeDate: String(bar.tradeDate ?? ""),
              ...(bar.tradeTime
                ? { tradeTime: String(bar.tradeTime) }
                : {}),
            }
          : {}),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.volume ?? 0),
        amount: Number(bar.amount ?? 0),
        weekIndex: Number(bar.weekIndex),
        monthIndex: Number(bar.monthIndex),
      })),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  app.post("/api/quant/replay/sessions", async (req, res, next) => {
    try {
      const body = normalizeBody(req.body);
      const interval = ["1m", "hybrid"].includes(body.interval)
        ? body.interval
        : "1d";
      const gameLength = body.gameLength == null
        ? interval === "1m" ? 240 : interval === "hybrid" ? 20 : 60
        : Number(body.gameLength);
      const supportedGameLengths = {
        "1d": [20, 60, 120],
        "1m": [240, 720, 1200],
        hybrid: [20, 60, 120],
      };
      assertCondition(
        supportedGameLengths[interval].includes(gameLength),
        interval === "1m"
          ? "分钟演练长度只支持 240、720、1200"
          : interval === "hybrid"
            ? "日内模拟长度只支持 20、60、120 个交易日"
          : "gameLength 只支持 20、60、120",
      );
      const seed = body.seed == null ? null : Number(body.seed);
      assertCondition(
        seed == null || Number.isSafeInteger(seed),
        "seed 必须是安全整数",
      );
      const initialCapital =
        body.initialCapital == null ? 100000 : body.initialCapital;
      assertCondition(
        typeof initialCapital === "number" &&
          Number.isFinite(initialCapital) &&
          initialCapital > 0,
        "initialCapital 必须是大于 0 的数字",
      );
      const costConfig = normalizeReplayCostConfig(body.costConfig);
      normalizeReplayTrainingSelection(body);
      const trainingConfig = { mode: "free" };
      const session = await replayLifecycle.createSession({
        gameLength,
        benchmarkCode: body.benchmarkCode,
        seed,
        interval,
        initialCapital,
        costConfig,
        trainingConfig,
      });
      res.status(201).json({
        session: toPublicReplaySession(session),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/replay/sessions", (req, res, next) => {
    try {
      const query = normalizeReplayHistoryQuery(req.query ?? {});
      res.json(database.listReplaySessions(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/replay/sessions/:sessionId", (req, res, next) => {
    try {
      const session = database.getReplaySession(
        String(req.params.sessionId ?? ""),
      );
      assertCondition(Boolean(session), "找不到行情演练会话", 404);
      res.json({
        session: toPublicReplaySession(session),
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/replay/sessions/:sessionId", (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId ?? "");
      const deleted = replayLifecycle.deleteSession(sessionId);
      assertCondition(deleted, "找不到行情演练会话", 404);
      res.json({ deleted: true, sessionId });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/quant/replay/sessions/:sessionId/retrain",
    (req, res, next) => {
      try {
        const body = normalizeBody(req.body);
        assertCondition(
          Object.keys(body).length === 0,
          "复练请求不支持额外字段",
        );
        const session = replayLifecycle.retrainSession(
          String(req.params.sessionId ?? ""),
        );
        assertCondition(Boolean(session), "找不到行情演练会话", 404);
        res.status(201).json({
          session: toPublicReplaySession(session),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/quant/replay/sessions/:sessionId/orders", (req, res, next) => {
    try {
      const normalized = normalizeReplayOrder(normalizeBody(req.body));
      const result = replayLifecycle.submitOrder({
        sessionId: String(req.params.sessionId ?? ""),
        actionId: normalized.actionId,
        expectedRevision: normalized.expectedRevision,
        order: normalized.order,
        requestPayload: normalized.requestPayload,
      });
      assertCondition(Boolean(result), "找不到行情演练会话", 404);
      res.status(result.created ? 201 : 200).json({
        created: result.created,
        idempotent: result.idempotent,
        session: toPublicReplaySession(result.session),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/quant/replay/sessions/:sessionId/advance",
    (req, res, next) => {
      try {
        const body = normalizeBody(req.body);
        const action = normalizeReplayAction(body);
        const mode = body.mode === "day" ? "day" : "minute";
        const result = replayLifecycle.advanceSession({
          sessionId: String(req.params.sessionId ?? ""),
          actionId: action.actionId,
          expectedRevision: action.expectedRevision,
          mode,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        res.json({
          advanced: result.advanced,
          idempotent: result.idempotent,
          session: toPublicReplaySession(result.session),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/finish",
    (req, res, next) => {
      try {
        const body = normalizeBody(req.body);
        const action = normalizeReplayAction(body);
        const completionReason = body.reason == null
          ? "early"
          : String(body.reason).trim().toLowerCase();
        assertCondition(
          ["early", "no_opportunity"].includes(completionReason),
          "reason 只支持 early 或 no_opportunity",
        );
        const requestPayload = {
          expectedRevision: action.expectedRevision,
          ...(body.reason == null ? {} : { reason: completionReason }),
        };
        const result = replayLifecycle.finishSession({
          sessionId: String(req.params.sessionId ?? ""),
          actionId: action.actionId,
          expectedRevision: action.expectedRevision,
          completionReason,
          requestPayload,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        res.json({
          finished: result.finished,
          idempotent: result.idempotent,
          session: toPublicReplaySession(result.session),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/reviews/blind",
    (req, res, next) => {
      try {
        const normalized = normalizeReplayBlindReview(
          normalizeBody(req.body),
        );
        const result = replayLifecycle.saveBlindReview({
          sessionId: String(req.params.sessionId ?? ""),
          normalized,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        res.json({
          saved: result.saved,
          idempotent: result.idempotent,
          session: toPublicReplaySession(result.session),
        });
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
          const normalized = normalizeReplayReviewDraftRequest(
            normalizeBody(req.body),
            stage,
          );
          const session = replayLifecycle.saveReviewDraft({
            sessionId: String(req.params.sessionId ?? ""),
            stage,
            normalized,
          });
          assertCondition(Boolean(session), "找不到行情演练会话", 404);
          res.json({
            saved: true,
            draft: toPublicReplayReviewDraft(
              session.reviewDrafts[stage],
            ),
          });
        } catch (error) {
          next(error);
        }
      },
    );
    app.delete(
      `/api/quant/replay/sessions/:sessionId/reviews/${stage}/draft`,
      (req, res, next) => {
        try {
          const normalized = normalizeReplayReviewDraftDeleteRequest(
            normalizeBody(req.body),
          );
          const result = replayLifecycle.deleteReviewDraft({
            sessionId: String(req.params.sessionId ?? ""),
            stage,
            expectedRevision: normalized.expectedRevision,
          });
          assertCondition(Boolean(result), "找不到行情演练会话", 404);
          res.json({
            deleted: result.deleted,
            revision: result.revision,
          });
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
        const normalized = normalizeReplayPostReview(
          normalizeBody(req.body),
        );
        const result = replayLifecycle.savePostReview({
          sessionId: String(req.params.sessionId ?? ""),
          normalized,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        res.json({
          saved: result.saved,
          idempotent: result.idempotent,
          session: toPublicReplaySession(result.session),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/reviews/blind/corrections",
    (req, res, next) => {
      try {
        const normalized = normalizeReplayReviewCorrection(
          normalizeBody(req.body),
          "blind",
        );
        const sessionId = String(req.params.sessionId ?? "");
        const result = replayLifecycle.appendReviewCorrection({
          sessionId,
          stage: "blind",
          normalized,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        res.json({
          saved: result.saved,
          idempotent: result.idempotent,
          correction: result.correction,
          session: toPublicReplaySession(result.session),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/reviews/post/corrections",
    (req, res, next) => {
      try {
        const normalized = normalizeReplayReviewCorrection(
          normalizeBody(req.body),
          "post",
        );
        const sessionId = String(req.params.sessionId ?? "");
        const result = replayLifecycle.appendReviewCorrection({
          sessionId,
          stage: "post",
          normalized,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        res.json({
          saved: result.saved,
          idempotent: result.idempotent,
          correction: result.correction,
          session: toPublicReplaySession(result.session),
        });
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
        assertCondition(["blind", "post"].includes(stage), "修正阶段无效");
        const normalized = normalizeReplayReviewCorrection(
          normalizeBody(req.body),
          stage,
        );
        const sessionId = String(req.params.sessionId ?? "");
        const result = replayLifecycle.updateReviewCorrection({
          sessionId,
          correctionId: String(req.params.correctionId ?? ""),
          stage,
          normalized,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        assertCondition(Boolean(result.correction), "找不到复盘修正记录", 404);
        res.json({ correction: result.correction, session: toPublicReplaySession(result.session) });
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
        assertCondition(["blind", "post"].includes(stage), "修正阶段无效");
        const action = normalizeReplayAction(normalizeBody(req.body));
        const result = replayLifecycle.deleteReviewCorrection({
          sessionId: String(req.params.sessionId ?? ""),
          correctionId: String(req.params.correctionId ?? ""),
          stage,
          actionId: action.actionId,
          expectedRevision: action.expectedRevision,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        assertCondition(result.deleted, "找不到复盘修正记录", 404);
        res.json({ deleted: true, session: toPublicReplaySession(result.session) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quant/replay/sessions/:sessionId/reveal",
    (req, res, next) => {
      try {
        const body = normalizeBody(req.body);
        const action = normalizeReplayAction(body);
        const result = replayLifecycle.revealSession({
          sessionId: String(req.params.sessionId ?? ""),
          actionId: action.actionId,
          expectedRevision: action.expectedRevision,
        });
        assertCondition(Boolean(result), "找不到行情演练会话", 404);
        res.json({
          revealed: result.revealed,
          idempotent: result.idempotent,
          session: toPublicReplaySession(result.session),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/quant/network/config", (_req, res, next) => {
    try {
      res.json({
        config: toPublicNetworkConfig(
          readNetworkConfigSnapshot({
            env: process.env,
            envFilePath,
          }),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/network/upstream-test", async (req, res, next) => {
    let normalized;
    try {
      normalized = normalizeUpstreamTestRequest(
        normalizeBody(req.body),
        readNetworkConfigSnapshot({
          env: process.env,
          envFilePath,
        }),
      );
    } catch (error) {
      next(error);
      return;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TEST_TIMEOUT_MS);
    try {
      const serviceUrl = normalized.source === "tushare"
        ? capitalFlowUrl
        : stockDecisionServiceUrl;
      const response = await fetch(`${serviceUrl}/api/upstream-test`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(normalized.payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("probe unavailable");
      const payload = await response.json();
      res.status(200).json(assertSafeUpstreamResult(
        payload,
        normalized.source,
        upstreamTestForbiddenSecrets(normalized.payload),
      ));
    } catch {
      res.status(503).json(createUpstreamServiceError(normalized.source, {
        testedAt: clock().toISOString(),
        elapsedMs: Math.max(0, Date.now() - startedAt),
      }));
    } finally {
      clearTimeout(timeout);
    }
  });

  app.put("/api/quant/network/config", async (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      const result = await runSerializedNetworkConfigMutation(async () => {
        const currentConfig = readNetworkConfigSnapshot({
          env: process.env,
          envFilePath,
        });
        const nextConfig = normalizeNetworkConfigPayload(
          mergeNetworkConfigUpdatePayload(currentConfig, body),
        );
        const previousRuntimeUpdates =
          buildRuntimeEnvironmentUpdates(currentConfig);
        const runtimeUpdates = buildRuntimeEnvironmentUpdates(nextConfig);
        let engineApplied = false;
        let stockDecisionApplied = false;

        try {
          await engine.updateRuntimeEnvironment({ updates: runtimeUpdates });
          engineApplied = true;
        } catch {
          throw createRuntimeSyncError("engine", true);
        }
        try {
          await syncStockDecisionRuntimeEnvironment(runtimeUpdates);
          stockDecisionApplied = true;
        } catch {
          const rollbackSucceeded = await rollbackNetworkRuntimeEnvironment({
            engineApplied,
            stockDecisionApplied,
            updates: previousRuntimeUpdates,
          });
          throw createRuntimeSyncError(
            "stock-decision",
            rollbackSucceeded,
          );
        }
        try {
          persistEnvironmentUpdates(envFilePath, runtimeUpdates);
        } catch {
          const rollbackSucceeded = await rollbackNetworkRuntimeEnvironment({
            engineApplied,
            stockDecisionApplied,
            updates: previousRuntimeUpdates,
          });
          const error = new Error("网络配置无法写入，运行时修改已撤销");
          error.status = 500;
          error.code = "CONFIG_PERSIST_FAILED";
          error.details = {
            saved: false,
            rollbackSucceeded,
          };
          throw error;
        }
        applyRuntimeEnvironmentUpdates(process.env, runtimeUpdates);

        const appliedConfig = readNetworkConfigSnapshot({
          env: process.env,
          envFilePath,
        });

        addSystemLog(database, {
          scope: "system",
          level: "INFO",
          title: "网络配置已更新",
          message: `默认数据源 ${formatDataProviderLabel(appliedConfig.dataProvider, appliedConfig.dataProvider)} · 同步模式 ${appliedConfig.syncMode || "auto"}`,
          payload: {
            dataProvider: appliedConfig.dataProvider,
            syncMode: appliedConfig.syncMode,
            akshareProxyMode: appliedConfig.akshareProxyMode,
            proxyConfigured: appliedConfig.proxyConfigured,
            tushareTokenConfigured: Boolean(appliedConfig.tushareToken),
          },
        });

        return {
          saved: true,
          runtimeApplied: true,
          message: "网络配置已保存并同步到当前运行服务",
          config: toPublicNetworkConfig(appliedConfig),
        };
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/data/catalog", async (req, res, next) => {
    try {
      const keyword = String(req.query.keyword ?? "").trim();
      const instrumentType = String(req.query.type ?? "")
        .trim()
        .toUpperCase();
      const exchange = String(req.query.exchange ?? "")
        .trim()
        .toUpperCase();
      const interval = String(req.query.interval ?? "1d")
        .trim()
        .toLowerCase();
      const adjust = normalizeAdjust(req.query.adjust);
      const pagination = parsePagination(req.query, {
        pageSize: 20,
        maxPageSize: 100,
      });
      res.json(await engine.getDataCatalog({
        keyword,
        type: instrumentType,
        exchange,
        interval,
        adjust,
        page: pagination.page,
        pageSize: pagination.pageSize,
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/quant/data/catalog/:orderBookId/overview",
    async (req, res, next) => {
      try {
        res.json(await buildInstrumentOverview(req.params.orderBookId));
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/quant/data/catalog/:orderBookId/raw-table",
    async (req, res, next) => {
      try {
        const parsed = parseOrderBookId(req.params.orderBookId);
        assertCondition(Boolean(parsed), "无效的 orderBookId");
        const dataset = String(req.query.dataset ?? "").trim();
        assertCondition(dataset.length > 0, "缺少 dataset 参数");
        const catalogPayload = await engine.getDataCatalogItem(parsed.orderBookId);
        const instrumentType = String(catalogPayload?.item?.type ?? "")
          .trim()
          .toUpperCase();
        const rawDatasetKeys = new Set(
          buildInstrumentTypeConfig(instrumentType).rawKeys,
        );
        assertCondition(
          rawDatasetKeys.has(dataset),
          "当前标的不支持该原始表",
          404,
        );
        const startDate = String(req.query.startDate ?? "").trim();
        const endDate = String(req.query.endDate ?? "").trim();
        if (startDate) {
          assertCondition(
            isValidDate(startDate),
            "开始日期格式必须是 YYYY-MM-DD",
          );
        }
        if (endDate) {
          assertCondition(
            isValidDate(endDate),
            "结束日期格式必须是 YYYY-MM-DD",
          );
        }
        if (startDate && endDate) {
          assertCondition(startDate <= endDate, "开始日期不能晚于结束日期");
        }
        const pagination = parsePagination(req.query, {
          pageSize: 50,
          maxPageSize: 200,
        });
        const filterField = DATASET_FILTER_FIELD_MAP[dataset];
        assertCondition(Boolean(filterField), "当前原始表暂不支持按标的过滤", 400);
        const fieldValue = orderBookIdToTsCode(parsed.orderBookId);
        assertCondition(Boolean(fieldValue), "无法解析当前标的对应的 ts_code", 400);

        const result = await engine.getRawTable({
          dataset,
          page: pagination.page,
          pageSize: pagination.pageSize,
          startDate,
          endDate,
          fieldFilters: {
            [filterField]: fieldValue,
          },
        });

        res.json({
          orderBookId: parsed.orderBookId,
          ...result,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/quant/instruments/search", async (req, res, next) => {
    try {
      const q = String(req.query.q ?? "").trim();
      const parsedLimit = Number(req.query.limit ?? 8);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(parsedLimit, 20))
        : 8;
      if (!q) {
        res.json({
          query: "",
          items: [],
        });
        return;
      }
      res.json(await engine.searchInstruments({ q, limit }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/data/bars", async (req, res, next) => {
    try {
      const payload = {
        symbol: String(req.query.symbol ?? ""),
        exchange: String(req.query.exchange ?? ""),
        interval: String(req.query.interval ?? ""),
        adjust: String(req.query.adjust ?? "qfq"),
        startDate: String(req.query.startDate ?? ""),
        endDate: String(req.query.endDate ?? ""),
      };
      validateMarketRequest(payload);
      const result = await engine.getBars(payload);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/data/sync", async (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      const coveragePayload = await getCachedCoverage();
      assertCondition(
        coveragePayload?.sourceMode !== "tdx-cache",
        "通达信行情缓存由专用增量同步维护，不支持通用同步接口",
        409,
      );
      validateMarketRequest(body);
      const result = await engine.syncData(body);
      const now = isoNow();
      const syncLog = {
        id: randomUUID(),
        symbol: body.symbol,
        exchange: body.exchange,
        interval: body.interval,
        startDate: body.startDate,
        endDate: body.endDate,
        status: "success",
        provider: result.provider,
        barsSynced: result.barsSynced,
        message: result.message,
        createdAt: now,
      };
      database.addSyncLog(syncLog);
      invalidateCoverageCache();
      res.status(201).json({
        sync: syncLog,
        coverage: await getCachedCoverage(),
      });
    } catch (error) {
      const now = isoNow();
      if (
        body.symbol &&
        body.exchange &&
        body.interval &&
        body.startDate &&
        body.endDate
      ) {
        database.addSyncLog({
          id: randomUUID(),
          symbol: body.symbol,
          exchange: body.exchange,
          interval: body.interval,
          startDate: body.startDate,
          endDate: body.endDate,
          status: "failed",
          provider: body.dataProvider ?? "unknown",
          barsSynced: 0,
          message: error.message,
          createdAt: now,
        });
      }
      next(error);
    }
  });

  app.get("/api/quant/system/logs", (req, res) => {
    const pagination = parsePagination(req.query, {
      pageSize: Math.max(10, Math.min(Number(req.query.limit ?? 100), 500)),
      maxPageSize: 500,
    });
    const level = String(req.query.level ?? "").trim();
    const scope = String(req.query.scope ?? "").trim();
    const keyword = String(req.query.keyword ?? "").trim();
    const paged = database.querySystemLogs(
      {
        level: level || null,
        scope: scope || null,
        keyword: keyword || null,
      },
      {
        page: pagination.page,
        pageSize: pagination.pageSize,
      },
    );
    res.json({
      logs: paged.items,
      meta: buildPaginationMeta({
        page: paged.page,
        pageSize: paged.pageSize,
        total: paged.total,
      }),
    });
  });

  app.delete("/api/quant/system/logs/:logId", (req, res, next) => {
    try {
      const deleted = database.deleteSystemLog(String(req.params.logId ?? ""));
      assertCondition(Boolean(deleted), "找不到日志记录", 404);
      res.json({
        id: deleted.id,
        deleted: true,
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/system/logs", (_req, res) => {
    const result = database.clearSystemLogs();
    res.json({
      deleted: true,
      deletedCount: result.deletedCount,
    });
  });

  app.post("/api/quant/decision/analysis-snapshots", (req, res, next) => {
    try {
      const snapshot = database.saveDecisionAnalysisSnapshot(normalizeDecisionAnalysisSnapshotPayload(req.body));
      if (snapshot.analysisType === "mainline_scan") {
        mainlineRankingStore.replaceSnapshot({
          sourceKey: snapshot.sourceKey,
          analysisDate: snapshot.analysisDate,
          capturedAt: snapshot.updatedAt ?? snapshot.createdAt,
          results: snapshot.payload?.results,
        });
      }
      res.status(201).json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/decision/mainline-ranking-history", (req, res, next) => {
    try {
      const sourceKey = String(req.query.sourceKey ?? "").trim();
      assertCondition(sourceKey.length > 0, "缺少 sourceKey");
      const sectorCodes = String(req.query.sectorCodes ?? req.query.sectorCode ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 100);
      assertCondition(sectorCodes.length > 0, "缺少 sectorCode");
      const days = Math.max(1, Math.min(10, Math.floor(Number(req.query.days) || 5)));
      const snapshots = database.listDecisionAnalysisSnapshots({
        analysisType: "mainline_scan",
        sourceKey,
        limit: days,
      });
      const itemsBySector = Object.fromEntries(sectorCodes.map((sectorCode) => [sectorCode, []]));
      for (const snapshot of snapshots) {
        mainlineRankingStore.replaceSnapshot({
          sourceKey: snapshot.sourceKey,
          analysisDate: snapshot.analysisDate,
          capturedAt: snapshot.updatedAt ?? snapshot.createdAt,
          results: snapshot.payload?.results,
        });
      }
      Object.assign(itemsBySector, mainlineRankingStore.listHistory({ sourceKey, sectorCodes, days }));
      if (sectorCodes.length === 1 && !req.query.sectorCodes) {
        res.json({ items: itemsBySector[sectorCodes[0]] });
        return;
      }
      res.json({ itemsBySector });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/decision/stock-query-records", (req, res) => {
    const pagination = parsePagination(req.query, {
      pageSize: 50,
      maxPageSize: 300,
    });
    const result = database.queryStockQueryRecords(
      {
        queryDate: String(req.query.date ?? req.query.queryDate ?? "").trim(),
        stockCode: String(req.query.stockCode ?? "").trim(),
        keyword: String(req.query.keyword ?? "").trim(),
      },
      pagination,
    );
    res.json({
      ...result,
      meta: buildPaginationMeta(result),
    });
  });

  app.post("/api/quant/decision/stock-query-records", (req, res, next) => {
    try {
      const record = database.createStockQueryRecord(
        normalizeStockQueryRecordPayload(req.body),
      );
      res.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/decision/stock-query-records/:recordId", (req, res, next) => {
    try {
      const recordId = String(req.params.recordId ?? "").trim();
      assertCondition(recordId.length > 0, "缺少查询记录 id");
      const deleted = database.deleteStockQueryRecord(recordId);
      assertCondition(Boolean(deleted), "找不到查询记录", 404);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

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

  app.get("/api/quant/decision/stocks/search", (req, res, next) => {
    forwardStockDecisionRequest(req, res, next, "/api/stocks/search");
  });

  app.get("/api/quant/decision/stocks/:code/evaluation", (req, res, next) => {
    forwardStockDecisionRequest(req, res, next, `/api/stocks/${encodeURIComponent(req.params.code)}/evaluation`);
  });

  app.get("/api/quant/decision/stocks/:code/supplemental-data", (req, res, next) => {
    forwardStockDecisionRequest(req, res, next, `/api/stocks/${encodeURIComponent(req.params.code)}/supplemental-data`);
  });

  app.post("/api/quant/decision/stocks/:code/decision-records", (req, res, next) => {
    forwardStockDecisionRequest(req, res, next, `/api/stocks/${encodeURIComponent(req.params.code)}/decision-records`);
  });

  app.get("/api/quant/decision/stocks/:code/decision-records", (req, res, next) => {
    forwardStockDecisionRequest(req, res, next, `/api/stocks/${encodeURIComponent(req.params.code)}/decision-records`);
  });

  app.get("/api/quant/decision/data-sources", (req, res, next) => {
    forwardStockDecisionRequest(req, res, next, "/api/data-sources");
  });

  app.patch("/api/quant/decision/data-sources", (req, res, next) => {
    forwardStockDecisionRequest(req, res, next, "/api/data-sources");
  });

  app.get("/api/quant/capital-flow/akshare", (req, res, next) => {
    forwardCapitalFlowRequest(req, res, next, "/api/akshare");
  });

  app.get("/api/quant/capital-flow/scan", (req, res, next) => {
    forwardCapitalFlowRequest(req, res, next, "/api/scan");
  });

  app.get("/api/quant/capital-flow/mainline-scan", (req, res, next) => {
    forwardCapitalFlowRequest(req, res, next, "/api/mainline-scan");
  });

  app.get("/api/quant/tasks", (_req, res) => {
    const status = String(_req.query.status ?? "").trim();
    const type = String(_req.query.type ?? "").trim();
    const keyword = String(_req.query.keyword ?? "").trim();
    const tag = String(_req.query.tag ?? "").trim();
    const starred = String(_req.query.starred ?? "").trim() === "true";
    const hiddenTaskTypes = ["stock_idea_manual", "kelly_position_sizing"];
    const pagination = parsePagination(_req.query, {
      pageSize: 20,
      maxPageSize: 200,
    });
    if (hiddenTaskTypes.includes(type)) {
      res.json({
        tasks: [],
        meta: buildPaginationMeta({
          page: pagination.page,
          pageSize: pagination.pageSize,
          total: 0,
        }),
      });
      return;
    }
    if (!pagination.hasPageParam) {
      const tasks = database.listTasks({
        status: status || null,
        type: type || null,
        excludeTypes: type ? [] : hiddenTaskTypes,
        keyword: keyword || null,
        tag: tag || null,
        starred,
      });
      res.json({
        tasks,
        meta: buildPaginationMeta({
          page: 1,
          pageSize: tasks.length || 1,
          total: tasks.length,
        }),
      });
      return;
    }
    const paged = database.queryTasks(
      {
        status: status || null,
        type: type || null,
        excludeTypes: type ? [] : hiddenTaskTypes,
        keyword: keyword || null,
        tag: tag || null,
        starred,
      },
      {
        page: pagination.page,
        pageSize: pagination.pageSize,
      },
    );
    res.json({
      tasks: paged.items,
      meta: buildPaginationMeta({
        page: paged.page,
        pageSize: paged.pageSize,
        total: paged.total,
      }),
    });
  });

  app.get("/api/quant/tasks/:taskId", (req, res, next) => {
    try {
      const task = database.getTask(String(req.params.taskId ?? ""));
      assertCondition(Boolean(task), "找不到任务记录", 404);
      res.json(task);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/quant/tasks/:taskId", (req, res, next) => {
    const body = normalizeBody(req.body);
    try {
      const patch = { updatedAt: isoNow() };
      if (typeof body.title === "string" && body.title.trim()) {
        patch.title = body.title.trim();
      }
      if (typeof body.notes === "string") {
        patch.notes = body.notes;
      }
      if (body.tags) {
        patch.tags = normalizeTagList(body.tags);
      }
      if (typeof body.starred === "boolean") {
        patch.starred = body.starred;
      }
      const updated = database.updateTask(
        String(req.params.taskId ?? ""),
        patch,
      );
      assertCondition(Boolean(updated), "找不到任务记录", 404);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/tasks/:taskId", (req, res, next) => {
    try {
      const deleted = database.deleteTask(String(req.params.taskId ?? ""));
      assertCondition(Boolean(deleted), "找不到任务记录", 404);
      res.json({
        id: deleted.id,
        deleted: true,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/tasks/:taskId/cancel", (req, res, next) => {
    try {
      const taskId = String(req.params.taskId ?? "");
      const current = database.getTask(taskId);
      assertCondition(Boolean(current), "找不到任务记录", 404);
      assertCondition(
        ["running", "queued"].includes(
          String(current.status ?? "").toLowerCase(),
        ),
        "当前任务不可取消",
        400,
      );
      const cancelled = database.updateTask(taskId, {
        status: "cancelled",
        errorMessage: "任务已取消",
        updatedAt: isoNow(),
      });
      addSystemLog(database, {
        scope: "task",
        level: "INFO",
        title: "任务已取消",
        message: `${current.title} 已被用户取消`,
        payload: {
          taskId: current.id,
          type: current.type,
        },
      });
      res.json(cancelled);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/tasks/:taskId/rerun", async (req, res, next) => {
    try {
      const task = database.getTask(String(req.params.taskId ?? ""));
      assertCondition(Boolean(task), "找不到任务记录", 404);
      const requestBody = {
        ...(task.request ?? {}),
        ...normalizeBody(req.body),
      };

      if (
        task.type === "optimization" ||
        task.type === "out_of_sample" ||
        task.type === "rolling" ||
        task.type === "stability" ||
        task.type === "research"
      ) {
        if (task.type === "optimization") {
          const rerun = await runOptimizationTaskFromBody(requestBody, task);
          res.status(201).json(rerun);
          return;
        }
        if (task.type === "out_of_sample") {
          const rerun = await runOutOfSampleTaskFromBody(requestBody, task);
          res.status(201).json(rerun);
          return;
        }
        if (task.type === "rolling") {
          const rerun = await runRollingTaskFromBody(requestBody, task);
          res.status(201).json(rerun);
          return;
        }
        if (task.type === "stability") {
          const rerun = await runStabilityTaskFromBody(requestBody, task);
          res.status(201).json(rerun);
          return;
        }
        const rerun = await runResearchTaskFromBody(requestBody, task);
        res.status(201).json(rerun);
        return;
      }
      throw new Error("当前任务类型不支持重新运行");
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/quant/tasks/:taskId/promote-backtest",
    async (req, res, next) => {
      const body = normalizeBody(req.body);
      try {
        const task = database.getTask(String(req.params.taskId ?? ""));
        assertCondition(Boolean(task), "找不到任务记录", 404);
        assertCondition(task.type === "research", "当前任务不是研究任务", 400);
        assertCondition(task.status === "completed", "研究任务尚未完成", 400);
        const recommendedBacktest = task.result?.recommendedBacktest;
        assertCondition(
          Boolean(recommendedBacktest),
          "当前研究结果没有可推进的正式回测",
          400,
        );
        const strategyLabel = getAnalysisStrategyLabel(
          recommendedBacktest.path,
        );
        const run = await runWorkspaceBacktestFromBody(
          {
            ...recommendedBacktest,
            ...body,
            strategyParameters: normalizeStrategyParameters(
              body.strategyParameters ?? recommendedBacktest.strategyParameters,
            ),
          },
          {
            title: body.title || `研究推进回测 · ${strategyLabel}`,
            requestType: "analysis-research-promotion",
            tags: ["research-promotion", strategyLabel],
          },
        );
        const updatedTask = database.updateTask(task.id, {
          relatedRunIds: [...new Set([...(task.relatedRunIds ?? []), run.id])],
          result: {
            ...(task.result ?? {}),
            recommendedBacktest: null,
            promotedRunId: run.id,
          },
          updatedAt: isoNow(),
        });
        res.status(201).json({
          task: updatedTask,
          run,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/quant/strategy-versions", (req, res) => {
    const strategyId = String(req.query.strategyId ?? "").trim();
    const pagination = parsePagination(req.query, {
      pageSize: 20,
      maxPageSize: 200,
    });
    const hasPageParam = pagination.hasPageParam;
    if (!hasPageParam) {
      const versions = database.listStrategyVersions(strategyId || null);
      res.json({
        versions,
        meta: buildPaginationMeta({
          page: 1,
          pageSize: versions.length || 1,
          total: versions.length,
        }),
      });
      return;
    }
    const paged = database.queryStrategyVersions(strategyId || null, {
      page: pagination.page,
      pageSize: pagination.pageSize,
    });
    res.json({
      versions: paged.items,
      meta: buildPaginationMeta({
        page: paged.page,
        pageSize: paged.pageSize,
        total: paged.total,
      }),
    });
  });

  app.delete("/api/quant/strategy-versions/:versionId", (req, res, next) => {
    try {
      const deleted = database.deleteStrategyVersion(
        String(req.params.versionId ?? ""),
      );
      assertCondition(Boolean(deleted), "找不到对应版本", 404);
      addSystemLog(database, {
        scope: "version",
        level: "INFO",
        title: "策略版本已删除",
        message: `${deleted.sourcePath} 的历史版本已删除`,
        payload: {
          versionId: deleted.id,
          strategyId: deleted.strategyId,
          sourceHash: deleted.sourceHash,
        },
      });
      res.json({
        id: deleted.id,
        deleted: true,
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/strategy-versions", (req, res) => {
    const strategyId = String(req.query.strategyId ?? "").trim();
    const result = database.clearStrategyVersions(strategyId || null);
    addSystemLog(database, {
      scope: "version",
      level: "INFO",
      title: "策略版本已清空",
      message: strategyId
        ? `策略 ${strategyId} 的历史版本已清空`
        : "全部策略历史版本已清空",
      payload: {
        strategyId: strategyId || null,
        deletedCount: result.deletedCount,
      },
    });
    res.json({
      deleted: true,
      deletedCount: result.deletedCount,
    });
  });

  app.post(
    "/api/quant/strategy-versions/:versionId/restore",
    (req, res, next) => {
      try {
        const version = database.getStrategyVersion(
          String(req.params.versionId ?? ""),
        );
        assertCondition(Boolean(version), "找不到对应版本", 404);
        const restored = workspace.saveFile(
          version.sourcePath,
          version.sourceCode,
        );
        assertCondition(Boolean(restored), "恢复版本失败", 400);
        addSystemLog(database, {
          scope: "version",
          level: "INFO",
          title: "策略版本已恢复",
          message: `${version.sourcePath} 已恢复到历史版本`,
          payload: {
            versionId: version.id,
            sourceHash: version.sourceHash,
          },
        });
        res.json({
          restored,
          version,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/quant/data/integrity", async (req, res, next) => {
    const body = normalizeBody(req.body);
    try {
      const run = body.runId ? database.getRun(String(body.runId)) : null;
      const payload = run
        ? {
            runId: run.id,
            symbol: run.summary?.symbol ?? run.symbol,
            exchange: run.summary?.exchange ?? run.exchange,
            interval: run.summary?.interval ?? run.interval,
            adjust: run.summary?.adjust ?? "qfq",
            startDate: run.summary?.startDate ?? run.startDate,
            endDate: run.summary?.endDate ?? run.endDate,
          }
        : {
            symbol: String(body.symbol ?? ""),
            exchange: String(body.exchange ?? ""),
            interval: String(body.interval ?? "1d"),
            adjust: normalizeAdjust(body.adjust),
            startDate: String(body.startDate ?? ""),
            endDate: String(body.endDate ?? ""),
          };
      validateMarketRequest(payload);
      const report = await runIntegrityCheck({
        ...payload,
        compareAllAdjustments: Boolean(body.compareAllAdjustments),
      });
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/analysis/optimize", async (req, res, next) => {
    try {
      const task = await runOptimizationTaskFromBody(normalizeBody(req.body));
      res.status(201).json(task);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/analysis/stability", async (req, res, next) => {
    try {
      const task = await runStabilityTaskFromBody(normalizeBody(req.body));
      res.status(201).json(task);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/analysis/out-of-sample", async (req, res, next) => {
    try {
      const task = await runOutOfSampleTaskFromBody(normalizeBody(req.body));
      res.status(201).json(task);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/analysis/rolling", async (req, res, next) => {
    try {
      const task = await runRollingTaskFromBody(normalizeBody(req.body));
      res.status(201).json(task);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/analysis/research", async (req, res, next) => {
    try {
      const task = await runResearchTaskFromBody(normalizeBody(req.body));
      res.status(201).json(task);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/workspace/run", async (req, res, next) => {
    const body = normalizeBody(req.body);

    try {
      const savedRun = await runWorkspaceBacktestFromBody(body, {
        title: body.title || "代码策略回测",
      });
      res.status(201).json(savedRun);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/backtests", (_req, res) => {
    const status = String(_req.query.status ?? "").trim();
    const strategyId = String(_req.query.strategyId ?? "").trim();
    const keyword = String(_req.query.keyword ?? "").trim();
    const tag = String(_req.query.tag ?? "").trim();
    const starred = String(_req.query.starred ?? "").trim() === "true";
    const pagination = parsePagination(_req.query, {
      pageSize: 20,
      maxPageSize: 200,
    });
    const hasPageParam = pagination.hasPageParam;
    if (!hasPageParam) {
      const runs = database.listRuns({
        status: status || null,
        strategyId: strategyId || null,
        keyword: keyword || null,
        tag: tag || null,
        starred,
      });
      res.json({
        runs,
        meta: buildPaginationMeta({
          page: 1,
          pageSize: runs.length || 1,
          total: runs.length,
        }),
      });
      return;
    }
    const paged = database.queryRuns(
      {
        status: status || null,
        strategyId: strategyId || null,
        keyword: keyword || null,
        tag: tag || null,
        starred,
      },
      {
        page: pagination.page,
        pageSize: pagination.pageSize,
      },
    );
    res.json({
      runs: paged.items,
      meta: buildPaginationMeta({
        page: paged.page,
        pageSize: paged.pageSize,
        total: paged.total,
      }),
    });
  });

  app.patch("/api/quant/backtests/:runId", (req, res, next) => {
    const body = normalizeBody(req.body);
    try {
      const patch = { updatedAt: isoNow() };
      if (typeof body.title === "string" && body.title.trim()) {
        patch.title = body.title.trim();
      }
      if (typeof body.notes === "string") {
        patch.notes = body.notes;
      }
      if (body.tags) {
        patch.tags = normalizeTagList(body.tags);
      }
      if (typeof body.starred === "boolean") {
        patch.starred = body.starred;
      }
      const updated = database.updateRun(String(req.params.runId ?? ""), patch);
      assertCondition(Boolean(updated), "找不到回测记录", 404);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/backtests/:runId/rerun", async (req, res, next) => {
    try {
      const current = database.getRun(String(req.params.runId ?? ""));
      assertCondition(Boolean(current), "找不到回测记录", 404);
      assertCondition(
        Boolean(current.request),
        "当前回测没有可复用的请求快照",
        400,
      );
      const requestBody = {
        ...current.request,
        ...normalizeBody(req.body),
      };
      delete requestBody.requestType;
      delete requestBody.title;
      delete requestBody.strategySourcePath;
      delete requestBody.strategySourceHash;

      if (current.request?.requestType === "workspace-run") {
        const rerun = await runWorkspaceBacktestFromBody(
          {
            path: requestBody.path,
            sourceCode: requestBody.sourceCode,
            startDate: requestBody.startDate,
            endDate: requestBody.endDate,
            adjust: requestBody.adjust,
            capital: requestBody.capital,
            benchmark: requestBody.benchmark,
            slippage: requestBody.slippage,
            rate: requestBody.rate,
            sizingMode:
              requestBody.parameters?.sizing_mode ?? requestBody.sizingMode,
            fixedSize:
              requestBody.parameters?.fixed_size ?? requestBody.fixedSize,
            positionPct:
              requestBody.parameters?.position_pct ?? requestBody.positionPct,
            cashReservePct:
              requestBody.parameters?.cash_reserve_pct ??
              requestBody.cashReservePct,
            stopLossPct:
              requestBody.parameters?.stop_loss_pct ?? requestBody.stopLossPct,
            takeProfitPct:
              requestBody.parameters?.take_profit_pct ??
              requestBody.takeProfitPct,
            trailingStopPct:
              requestBody.parameters?.trailing_stop_pct ??
              requestBody.trailingStopPct,
            slippageMode:
              requestBody.costModel?.slippageMode ?? requestBody.slippageMode,
            slippageValue:
              requestBody.costModel?.slippageValue ?? requestBody.slippageValue,
            openCommissionRate:
              requestBody.costModel?.openCommissionRate ??
              requestBody.openCommissionRate,
            closeCommissionRate:
              requestBody.costModel?.closeCommissionRate ??
              requestBody.closeCommissionRate,
            minCommission:
              requestBody.costModel?.minCommission ?? requestBody.minCommission,
            stampDutyRate:
              requestBody.costModel?.stampDutyRate ?? requestBody.stampDutyRate,
            impactCostBps:
              requestBody.costModel?.impactCostBps ?? requestBody.impactCostBps,
          },
          {
            title: current.title || "代码策略回测",
            tags: current.tags,
            notes: current.notes,
            starred: current.starred,
          },
        );
        res.status(201).json(rerun);
        return;
      }

      assertCondition(false, WORKSPACE_ONLY_BACKTEST_MESSAGE, 410);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quant/backtests/:runId", async (req, res, next) => {
    try {
      const run = database.getRun(req.params.runId);
      assertCondition(Boolean(run), "找不到回测记录", 404);

      if (
        run.status === "queued" ||
        run.status === "running" ||
        barsNeedRefresh(run)
      ) {
        try {
          const remoteRun = await engine.getRun(run.id);
          database.updateRun(run.id, {
            status: remoteRun.status,
            summary: remoteRun.summary ?? run.summary,
            artifacts: remoteRun.artifacts ?? run.artifacts,
            errorMessage: remoteRun.errorMessage ?? run.errorMessage,
            updatedAt: isoNow(),
          });
        } catch (error) {
          addSystemLog(database, {
            scope: "workspace",
            level: "WARN",
            title: "回测结果刷新失败",
            message: `刷新回测 ${run.id} 远端结果失败，已保留本地状态`,
            payload: {
              runId: run.id,
              error: error?.message ?? String(error),
            },
          });
        }
      }

      res.json(database.getRun(req.params.runId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quant/backtests/:runId/export", (req, res, next) => {
    const body = normalizeBody(req.body);
    try {
      const run = database.getRun(String(req.params.runId ?? ""));
      assertCondition(Boolean(run), "找不到回测记录", 404);
      const format =
        String(body.format ?? "json")
          .trim()
          .toLowerCase() || "json";
      const metrics = buildMetricSnapshot(run);
      const exportsRoot = resolve(workspaceRoot, "exports");
      mkdirSync(exportsRoot, { recursive: true });
      const stamp = formatBeijingFileStamp();
      const baseName = sanitizeFileNamePart(
        `${run.summary?.strategyId ?? run.strategyId}_${run.id}_${stamp}`,
      );
      let fileName = `${baseName}.json`;
      let content = "";
      let binaryContent = null;
      let contentType = "application/json;charset=utf-8";

      if (format === "csv") {
        fileName = `${baseName}_trades.csv`;
        const headers = [
          "datetime",
          "direction",
          "offset",
          "price",
          "volume",
          "commission",
          "stampDuty",
          "impactCost",
          "slippageCost",
          "transactionCost",
        ];
        const rows = (run.artifacts?.trades ?? []).map((trade) =>
          headers.map((key) => escapeCsvCell(trade[key] ?? "")).join(","),
        );
        content = [headers.join(","), ...rows].join("\n");
        contentType = "text/csv;charset=utf-8";
      } else if (format === "xls" || format === "xlsx" || format === "excel") {
        fileName = `${baseName}.xls`;
        content = createExcelHtmlReport(run, metrics);
        contentType = "application/vnd.ms-excel;charset=utf-8";
      } else if (format === "pdf") {
        fileName = `${baseName}.pdf`;
        binaryContent = createSimplePdfBuffer(
          buildPdfReportLines(run, metrics),
        );
        contentType = "application/pdf";
      } else if (format === "md") {
        fileName = `${baseName}.md`;
        content = buildMarkdownReport(run, metrics);
        contentType = "text/markdown;charset=utf-8";
      } else {
        content = JSON.stringify(
          {
            run,
            metrics,
          },
          null,
          2,
        );
        contentType = "application/json;charset=utf-8";
      }

      const absolutePath = resolve(exportsRoot, fileName);
      if (binaryContent) {
        writeFileSync(absolutePath, binaryContent);
      } else {
        writeFileSync(absolutePath, content, "utf8");
      }
      addSystemLog(database, {
        scope: "export",
        level: "INFO",
        title: "回测结果已导出",
        message: fileName,
        payload: {
          runId: run.id,
          format,
        },
      });
      res.json({
        path: `exports/${fileName}`,
        fileName,
        format,
        content: binaryContent ? binaryContent.toString("base64") : content,
        encoding: binaryContent ? "base64" : "utf8",
        contentType,
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quant/backtests/:runId", (req, res, next) => {
    try {
      const runId = String(req.params.runId ?? "");
      assertCondition(runId.length > 0, "缺少 runId");

      const deleted = database.deleteRun(runId);
      assertCondition(Boolean(deleted), "找不到回测记录", 404);

      const runDir = resolve(runsRoot, runId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }

      res.json({
        id: runId,
        deleted: true,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    const status =
      error?.status ??
      (error instanceof EngineClientError ? error.status : 500);
    const errorCode = [
      "INVALID_REQUEST",
      "NOT_FOUND",
      "UPSTREAM_UNAVAILABLE",
      "UPSTREAM_INVALID_RESPONSE",
      "RUNTIME_SYNC_FAILED",
      "CONFIG_PERSIST_FAILED",
      "INTERNAL_ERROR",
    ].includes(error?.code)
      ? error.code
      : status === 400
        ? "INVALID_REQUEST"
        : status === 404
          ? "NOT_FOUND"
          : status === 502
            ? "UPSTREAM_UNAVAILABLE"
            : "INTERNAL_ERROR";

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
    try {
      mainlineRankingStore.close();
    } finally {
      database.close();
    }
  };

  return app;
}

export function startServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const app = createApp({
    ...options,
    port,
  });

  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`quantflow-backend listening on http://127.0.0.1:${port}`);
  });
  server.once("close", () => app.dispose());
  return server;
}
