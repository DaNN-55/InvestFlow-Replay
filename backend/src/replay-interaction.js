import { randomUUID } from "node:crypto";

import { createReplayLifecycle } from "./replay-lifecycle.js";

const DEFAULT_REPLAY_COST_CONFIG = Object.freeze({
  commissionRate: 0.0003,
  minCommission: 5,
  stampTaxRate: 0.0005,
  transferFeeRate: 0.00001,
  slippageBps: 5,
});

export class ReplayInteractionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ReplayInteractionError";
    this.code = code;
    this.status = status;
  }
}

function assertInteractionCondition(condition, message, status = 400, code = "INVALID_REPLAY_COMMAND") {
  if (!condition) {
    throw new ReplayInteractionError(code, message, status);
  }
}

function toPublicReplayReviewDraft(draft) {
  if (!draft) return null;
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
    if (!grouped.has(tradeDate)) grouped.set(tradeDate, []);
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

function normalizeReplayCostConfig(value) {
  const input = value == null ? {} : value;
  assertInteractionCondition(
    input && typeof input === "object" && !Array.isArray(input),
    "costConfig 必须是对象",
  );
  const allowedFields = new Set(Object.keys(DEFAULT_REPLAY_COST_CONFIG));
  assertInteractionCondition(
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
    assertInteractionCondition(
      typeof config[field] === "number" &&
        Number.isFinite(config[field]) &&
        config[field] >= 0 &&
        config[field] < 1,
      `${field} 必须是大于等于 0 且小于 1 的数字`,
    );
  }
  assertInteractionCondition(
    typeof config.minCommission === "number" &&
      Number.isFinite(config.minCommission) &&
      config.minCommission >= 0,
    "minCommission 必须是大于等于 0 的数字",
  );
  assertInteractionCondition(
    typeof config.slippageBps === "number" &&
      Number.isFinite(config.slippageBps) &&
      config.slippageBps >= 0 &&
      config.slippageBps < 10000,
    "slippageBps 必须是大于等于 0 且小于 10000 的数字",
  );
  return config;
}

function normalizeReplayAction(body) {
  assertInteractionCondition(typeof body.actionId === "string", "actionId 必须是字符串");
  const actionId = body.actionId.trim();
  assertInteractionCondition(
    actionId.length > 0 && actionId.length <= 128,
    "actionId 必须是 1 至 128 个字符",
  );
  assertInteractionCondition(
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
  assertInteractionCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "委托包含不支持的字段",
  );
  const action = normalizeReplayAction(body);
  const side = String(body.side ?? "")
    .trim()
    .toLowerCase();
  assertInteractionCondition(["buy", "sell"].includes(side), "side 只支持 buy 或 sell");
  const selectors = [
    body.quantity == null ? null : "shares",
    body.cashRatio == null ? null : "cash_ratio",
    body.positionRatio == null ? null : "position_ratio",
  ].filter(Boolean);
  assertInteractionCondition(selectors.length === 1, "委托必须且只能指定一种数量方式");
  const quantityType = selectors[0];
  if (quantityType === "shares") {
    assertInteractionCondition(
      typeof body.quantity === "number" &&
        Number.isSafeInteger(body.quantity) &&
        body.quantity >= 100,
      "quantity 必须是大于等于 100 的安全整数",
    );
  }
  if (quantityType === "cash_ratio") {
    assertInteractionCondition(side === "buy", "cashRatio 仅支持买入委托");
    assertInteractionCondition(
      typeof body.cashRatio === "number" &&
        Number.isFinite(body.cashRatio) &&
        body.cashRatio > 0 &&
        body.cashRatio <= 1,
      "cashRatio 必须大于 0 且不超过 1",
    );
  }
  if (quantityType === "position_ratio") {
    assertInteractionCondition(side === "sell", "positionRatio 仅支持卖出委托");
    assertInteractionCondition(
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
  assertInteractionCondition(
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
  assertInteractionCondition(
    Object.keys(value).every((key) => allowedFields.has(key)),
    "decision 包含不支持的字段",
  );
  const reasonTags = normalizeReplayReasonTags(value.reasonTags, { required: true });
  const confidence = Number(value.confidence);
  assertInteractionCondition(
    Number.isSafeInteger(confidence) && confidence >= 1 && confidence <= 5,
    "decision.confidence 必须是 1 至 5 的整数",
  );
  const thesis = String(value.thesis ?? "").trim();
  const plan = String(value.plan ?? "").trim();
  assertInteractionCondition(thesis.length >= 10 && thesis.length <= 2000, "decision.thesis 必须是 10 至 2000 个字符");
  assertInteractionCondition(plan.length >= 10 && plan.length <= 2000, "decision.plan 必须是 10 至 2000 个字符");

  if (side === "buy") {
    const riskPlan = String(value.riskPlan ?? "").trim();
    assertInteractionCondition(riskPlan.length >= 10 && riskPlan.length <= 1000, "decision.riskPlan 必须是 10 至 1000 个字符");
    const stopLossPrice = normalizeReplayPositivePrice(value.stopLossPrice, "decision.stopLossPrice");
    const invalidationRule = normalizeReplayInvalidationRule(value.invalidationRule, { partial: false });
    assertInteractionCondition(
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
  assertInteractionCondition(
    ["take_profit", "stop_loss", "thesis_invalidated", "reduce_risk", "manual"].includes(exitType),
    "decision.exitType 不受支持",
  );
  const remainingPositionPlan = String(value.remainingPositionPlan ?? "").trim();
  assertInteractionCondition(
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
  assertInteractionCondition(
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
  assertInteractionCondition(strategyName.length <= 120, "strategyName 最多 120 个字符");
  assertInteractionCondition(
    Boolean(playbookId) === Boolean(playbookVersionId),
    "playbookId 和 playbookVersionId 必须同时提供",
  );
  assertInteractionCondition(playbookId.length <= 120, "playbookId 最多 120 个字符");
  assertInteractionCondition(
    playbookVersionId.length <= 120,
    "playbookVersionId 最多 120 个字符",
  );
  assertInteractionCondition(
    thesis.length >= 10 && thesis.length <= 2000,
    "thesis 必须是 10 至 2000 个字符",
  );
  assertInteractionCondition(
    tradePlan.length >= 10 && tradePlan.length <= 2000,
    "tradePlan 必须是 10 至 2000 个字符",
  );
  assertInteractionCondition(
    riskPlan.length >= 10 && riskPlan.length <= 1000,
    "riskPlan 必须是 10 至 1000 个字符",
  );
  assertInteractionCondition(
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
    assertInteractionCondition(allowedViews.includes(value), `${field} 不受支持`);
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
  assertInteractionCondition(
    typeof value === "number" && Number.isFinite(value) && value > 0,
    `${fieldName} 必须是正数或 null`,
  );
  return value;
}

function normalizeReplayReasonTags(value, { required }) {
  if (value == null && !required) {
    return undefined;
  }
  assertInteractionCondition(Array.isArray(value), "reasonTags 必须是数组");
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    assertInteractionCondition(typeof item === "string", "reasonTags 每项必须是字符串");
    const tag = item.trim();
    assertInteractionCondition(
      tag.length >= 1 && tag.length <= 40,
      "reasonTags 每项必须是 1 至 40 个字符",
    );
    if (!seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  assertInteractionCondition(
    normalized.length <= 8,
    "reasonTags 最多 8 项",
  );
  if (required) {
    assertInteractionCondition(normalized.length >= 1, "reasonTags 至少 1 项");
  }
  return normalized;
}

function normalizeReplayInvalidationRule(value, { partial }) {
  if (value == null) {
    return null;
  }
  assertInteractionCondition(
    typeof value === "object" &&
      !Array.isArray(value),
    "invalidationRule 必须是对象或 null",
  );
  const allowedFields = new Set(["basis", "operator", "threshold", "note"]);
  assertInteractionCondition(
    Object.keys(value).every((key) => allowedFields.has(key)),
    "invalidationRule 包含不支持的字段",
  );
  const result = {};
  if (!partial || Object.hasOwn(value, "basis")) {
    const basis = String(value.basis ?? "").trim().toLowerCase();
    assertInteractionCondition(basis === "close", "invalidationRule.basis 只支持 close");
    result.basis = basis;
  }
  if (!partial || Object.hasOwn(value, "operator")) {
    const operator = String(value.operator ?? "").trim().toLowerCase();
    assertInteractionCondition(
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
      assertInteractionCondition(
        result.threshold != null,
        "invalidationRule.threshold 必须是正数",
      );
    }
  }
  if (Object.hasOwn(value, "note")) {
    assertInteractionCondition(
      typeof value.note === "string",
      "invalidationRule.note 必须是字符串",
    );
    const note = value.note.trim();
    assertInteractionCondition(
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
  assertInteractionCondition(mode === "free", "trainingMode 只支持 free");
  const playbookId = String(body.playbookId ?? "").trim();
  const playbookVersionId = String(body.playbookVersionId ?? "").trim();
  assertInteractionCondition(playbookId.length <= 120, "playbookId 最多 120 个字符");
  assertInteractionCondition(
    playbookVersionId.length <= 120,
    "playbookVersionId 最多 120 个字符",
  );
  assertInteractionCondition(
    !playbookId && !playbookVersionId,
    "自由演练不能在开局时指定战法",
  );
  return { mode };
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
  assertInteractionCondition(
    Object.keys(body).every((key) => allowedFields.has(key)),
    "事后复盘包含不支持的字段",
  );
  const action = normalizeReplayAction(body);
  const outcome = String(body.outcome ?? "").trim().toLowerCase();
  const executionReview = String(body.executionReview ?? "").trim();
  const mistakes = String(body.mistakes ?? "").trim();
  const lessons = String(body.lessons ?? "").trim();
  const strategyAdjustment = String(body.strategyAdjustment ?? "").trim();
  assertInteractionCondition(
    ["correct", "partial", "wrong"].includes(outcome),
    "outcome 只支持 correct、partial 或 wrong",
  );
  assertInteractionCondition(
    executionReview.length >= 10 && executionReview.length <= 2000,
    "executionReview 必须是 10 至 2000 个字符",
  );
  assertInteractionCondition(
    mistakes.length >= 1 && mistakes.length <= 2000,
    "mistakes 必须是 1 至 2000 个字符",
  );
  assertInteractionCondition(
    lessons.length >= 10 && lessons.length <= 2000,
    "lessons 必须是 10 至 2000 个字符",
  );
  assertInteractionCondition(
    typeof body.disciplineScore === "number" &&
      Number.isSafeInteger(body.disciplineScore) &&
      body.disciplineScore >= 1 &&
      body.disciplineScore <= 5,
    "disciplineScore 必须是 1 至 5 的整数",
  );
  assertInteractionCondition(
    typeof body.riskControlScore === "number" &&
      Number.isSafeInteger(body.riskControlScore) &&
      body.riskControlScore >= 1 &&
      body.riskControlScore <= 5,
    "riskControlScore 必须是 1 至 5 的整数",
  );
  assertInteractionCondition(
    body.playbookFitScore == null ||
      (typeof body.playbookFitScore === "number" &&
        Number.isSafeInteger(body.playbookFitScore) &&
        body.playbookFitScore >= 1 &&
        body.playbookFitScore <= 5),
    "playbookFitScore 必须是 1 至 5 的整数",
  );
  assertInteractionCondition(
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
  assertInteractionCondition(
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
  assertInteractionCondition(
    Object.keys(body).length === 2 &&
      Object.hasOwn(body, "draft") &&
      Object.hasOwn(body, "expectedRevision"),
    "草稿请求只支持 draft 和 expectedRevision 字段",
  );
  assertInteractionCondition(
    typeof body.expectedRevision === "number" &&
      Number.isSafeInteger(body.expectedRevision) &&
      body.expectedRevision >= 0,
    "expectedRevision 必须是大于等于 0 的安全整数",
  );
  const draft = body.draft;
  assertInteractionCondition(
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
  assertInteractionCondition(
    Object.keys(draft).every((key) => allowedFields.has(key)),
    "draft 包含不支持的字段",
  );
  const normalized = {};
  for (const [field, maximum] of Object.entries(textLimits)) {
    if (!Object.hasOwn(draft, field)) {
      continue;
    }
    assertInteractionCondition(typeof draft[field] === "string", `${field} 必须是字符串`);
    const value = draft[field].trim();
    assertInteractionCondition(value.length <= maximum, `${field} 最多 ${maximum} 个字符`);
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
      assertInteractionCondition(typeof draft[field] === "string", `${field} 必须是字符串`);
      const value = draft[field].trim().toLowerCase();
      assertInteractionCondition(
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
      assertInteractionCondition(typeof draft.outcome === "string", "outcome 必须是字符串");
      const outcome = draft.outcome.trim().toLowerCase();
      assertInteractionCondition(
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
  assertInteractionCondition(
    Object.keys(body).length === 1 &&
      Object.hasOwn(body, "expectedRevision"),
    "删除草稿请求只支持 expectedRevision 字段",
  );
  assertInteractionCondition(
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
  assertInteractionCondition(
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
  assertInteractionCondition(allowedStates.has(state), "state 不受支持");
  const attemptKind = String(query.attemptKind ?? "all")
    .trim()
    .toLowerCase();
  assertInteractionCondition(
    ["all", "first", "retrain"].includes(attemptKind),
    "attemptKind 不受支持",
  );
  const keyword = String(query.keyword ?? "").trim();
  assertInteractionCondition(keyword.length <= 120, "keyword 最多 120 个字符");
  const page = query.page == null || query.page === ""
    ? 1
    : Number(query.page);
  const pageSize = query.pageSize == null || query.pageSize === ""
    ? 20
    : Number(query.pageSize);
  assertInteractionCondition(
    Number.isSafeInteger(page) && page >= 1,
    "page 必须是大于等于 1 的安全整数",
  );
  assertInteractionCondition(
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


export function presentReplaySession(session) {
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
              adjustedAmount: Number(bar.adjustedAmount ?? bar.amount ?? 0),
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


function requireResult(result) {
  assertInteractionCondition(Boolean(result), "找不到行情演练会话", 404, "REPLAY_SESSION_NOT_FOUND");
  return result;
}

export function createReplayInteraction({
  store,
  scenarioSource,
  createId = randomUUID,
  now = () => new Date().toISOString(),
}) {
  const lifecycle = createReplayLifecycle({ store, scenarioSource, createId, now });

  function visible(session) {
    return presentReplaySession(session);
  }

  async function create(rawBody) {
    const body = rawBody && typeof rawBody === "object" ? rawBody : {};
    const interval = ["1m", "hybrid"].includes(body.interval) ? body.interval : "1d";
    const gameLength = body.gameLength == null
      ? interval === "1m" ? 240 : interval === "hybrid" ? 20 : 60
      : Number(body.gameLength);
    const supportedGameLengths = { "1d": [20, 60, 120], "1m": [240, 720, 1200], hybrid: [20, 60, 120] };
    assertInteractionCondition(
      supportedGameLengths[interval].includes(gameLength),
      interval === "1m" ? "分钟演练长度只支持 240、720、1200" : interval === "hybrid" ? "日内模拟长度只支持 20、60、120 个交易日" : "gameLength 只支持 20、60、120",
    );
    const seed = body.seed == null ? null : Number(body.seed);
    assertInteractionCondition(seed == null || Number.isSafeInteger(seed), "seed 必须是安全整数");
    const initialCapital = body.initialCapital == null ? 100000 : body.initialCapital;
    assertInteractionCondition(
      typeof initialCapital === "number" && Number.isFinite(initialCapital) && initialCapital > 0,
      "initialCapital 必须是大于 0 的数字",
    );
    normalizeReplayTrainingSelection(body);
    const session = await lifecycle.createSession({
      gameLength,
      benchmarkCode: body.benchmarkCode,
      seed,
      interval,
      initialCapital,
      costConfig: normalizeReplayCostConfig(body.costConfig),
      trainingConfig: { mode: "free" },
    });
    return { session: visible(session) };
  }

  function get(sessionId) {
    const session = store.getSession(sessionId);
    requireResult(session);
    return { session: visible(session) };
  }

  function list(rawQuery) {
    return store.listSessions(normalizeReplayHistoryQuery(
      rawQuery && typeof rawQuery === "object" ? rawQuery : {},
    ));
  }

  function deleteSession(sessionId) {
    const deleted = lifecycle.deleteSession(sessionId);
    requireResult(deleted);
    return { deleted: true, sessionId };
  }

  function retrain(sessionId, rawBody) {
    const body = rawBody && typeof rawBody === "object" ? rawBody : {};
    assertInteractionCondition(Object.keys(body).length === 0, "复练请求不支持额外字段");
    return { session: visible(requireResult(lifecycle.retrainSession(sessionId))) };
  }

  function submitOrder(sessionId, rawBody) {
    const normalized = normalizeReplayOrder(rawBody && typeof rawBody === "object" ? rawBody : {});
    const result = requireResult(lifecycle.submitOrder({ sessionId, ...normalized }));
    return { created: result.created, idempotent: result.idempotent, session: visible(result.session) };
  }

  function advance(sessionId, rawBody) {
    const body = rawBody && typeof rawBody === "object" ? rawBody : {};
    const action = normalizeReplayAction(body);
    const result = requireResult(lifecycle.advanceSession({
      sessionId, actionId: action.actionId, expectedRevision: action.expectedRevision,
      mode: body.mode === "day" ? "day" : "minute",
    }));
    return { advanced: result.advanced, idempotent: result.idempotent, session: visible(result.session) };
  }

  function finish(sessionId, rawBody) {
    const body = rawBody && typeof rawBody === "object" ? rawBody : {};
    const action = normalizeReplayAction(body);
    const completionReason = body.reason == null ? "early" : String(body.reason).trim().toLowerCase();
    assertInteractionCondition(["early", "no_opportunity"].includes(completionReason), "reason 只支持 early 或 no_opportunity");
    const result = requireResult(lifecycle.finishSession({
      sessionId, actionId: action.actionId, expectedRevision: action.expectedRevision, completionReason,
      requestPayload: { expectedRevision: action.expectedRevision, ...(body.reason == null ? {} : { reason: completionReason }) },
    }));
    return { finished: result.finished, idempotent: result.idempotent, session: visible(result.session) };
  }

  function reveal(sessionId, rawBody) {
    const action = normalizeReplayAction(rawBody && typeof rawBody === "object" ? rawBody : {});
    const result = requireResult(lifecycle.revealSession({ sessionId, ...action }));
    return { revealed: result.revealed, idempotent: result.idempotent, session: visible(result.session) };
  }

  function saveBlindReview(sessionId, rawBody) {
    const result = requireResult(lifecycle.saveBlindReview({
      sessionId,
      normalized: normalizeReplayBlindReview(rawBody && typeof rawBody === "object" ? rawBody : {}),
    }));
    return { saved: result.saved, idempotent: result.idempotent, session: visible(result.session) };
  }

  function saveReviewDraft(sessionId, stage, rawBody) {
    const session = requireResult(lifecycle.saveReviewDraft({
      sessionId,
      stage,
      normalized: normalizeReplayReviewDraftRequest(
        rawBody && typeof rawBody === "object" ? rawBody : {},
        stage,
      ),
    }));
    return {
      saved: true,
      draft: toPublicReplayReviewDraft(session.reviewDrafts[stage]),
    };
  }

  function deleteReviewDraft(sessionId, stage, rawBody) {
    const result = requireResult(lifecycle.deleteReviewDraft({
      sessionId,
      stage,
      ...normalizeReplayReviewDraftDeleteRequest(
        rawBody && typeof rawBody === "object" ? rawBody : {},
      ),
    }));
    return { deleted: result.deleted, revision: result.revision };
  }

  function savePostReview(sessionId, rawBody) {
    const result = requireResult(lifecycle.savePostReview({
      sessionId,
      normalized: normalizeReplayPostReview(rawBody && typeof rawBody === "object" ? rawBody : {}),
    }));
    return { saved: result.saved, idempotent: result.idempotent, session: visible(result.session) };
  }

  function requireCorrectionStage(stage) {
    assertInteractionCondition(["blind", "post"].includes(stage), "修正阶段无效");
  }

  function appendReviewCorrection(sessionId, stage, rawBody) {
    requireCorrectionStage(stage);
    const result = requireResult(lifecycle.appendReviewCorrection({
      sessionId,
      stage,
      normalized: normalizeReplayReviewCorrection(
        rawBody && typeof rawBody === "object" ? rawBody : {},
        stage,
      ),
    }));
    return {
      saved: result.saved,
      idempotent: result.idempotent,
      correction: result.correction,
      session: visible(result.session),
    };
  }

  function updateReviewCorrection(sessionId, stage, correctionId, rawBody) {
    requireCorrectionStage(stage);
    const result = requireResult(lifecycle.updateReviewCorrection({
      sessionId,
      correctionId,
      stage,
      normalized: normalizeReplayReviewCorrection(
        rawBody && typeof rawBody === "object" ? rawBody : {},
        stage,
      ),
    }));
    assertInteractionCondition(Boolean(result.correction), "找不到复盘修正记录", 404, "REPLAY_REVIEW_CORRECTION_NOT_FOUND");
    return { correction: result.correction, session: visible(result.session) };
  }

  function deleteReviewCorrection(sessionId, stage, correctionId, rawBody) {
    requireCorrectionStage(stage);
    const action = normalizeReplayAction(rawBody && typeof rawBody === "object" ? rawBody : {});
    const result = requireResult(lifecycle.deleteReviewCorrection({
      sessionId,
      correctionId,
      stage,
      ...action,
    }));
    assertInteractionCondition(result.deleted, "找不到复盘修正记录", 404, "REPLAY_REVIEW_CORRECTION_NOT_FOUND");
    return { deleted: true, session: visible(result.session) };
  }

  return {
    create,
    list,
    get,
    deleteSession,
    retrain,
    submitOrder,
    advance,
    finish,
    saveBlindReview,
    saveReviewDraft,
    deleteReviewDraft,
    savePostReview,
    appendReviewCorrection,
    updateReviewCorrection,
    deleteReviewCorrection,
    reveal,
  };
}
