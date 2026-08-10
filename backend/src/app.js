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
import { createReplayLifecycle } from "./replay-lifecycle.js";
import { createReplayLifecycleStore } from "./replay-lifecycle-store.js";
import { calculateTradeLicense, resolveTradeRecordLifecycle } from "./trade-license.js";
import { calculateTradeLedger } from "./trade-ledger.js";








const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORAGE_ROOT = resolve(MODULE_DIR, "..", "..", "storage");
const DEFAULT_TRADE_RECORDS_ROOT = resolve(DEFAULT_STORAGE_ROOT, "trade-records");
const DEFAULT_REPLAY_COST_CONFIG = Object.freeze({
  commissionRate: 0.0003,
  minCommission: 5,
  stampTaxRate: 0.0005,
  transferFeeRate: 0.00001,
  slippageBps: 5,
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
  const replayLifecycle = createReplayLifecycle({
    store: createReplayLifecycleStore(database),
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
    database.close();
  };

  return app;
}
