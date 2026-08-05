import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = resolve(
  MODULE_DIR,
  "..",
  "..",
  "storage",
  "quantflow-workbench.sqlite",
);

const REPLAY_SCENARIO_FINGERPRINT_VERSION = "replay-scenario-v3";
const REPLAY_SCENARIO_FINGERPRINT_V2 = "replay-scenario-v2";
const LEGACY_REPLAY_SCENARIO_FINGERPRINT_VERSION =
  "legacy-unidentifiable-v1";
const REPLAY_SCORE_V2 = "replay-score-v2";
const CURRENT_REPLAY_SCORING_CONFIG = Object.freeze({
  algorithmVersion: REPLAY_SCORE_V2,
  weights: Object.freeze({
    executionDiscipline: 30,
    riskControl: 25,
    playbookCompliance: 20,
    returnPerformance: 15,
    reviewQuality: 10,
  }),
  parameters: Object.freeze({
    returnPerformance: Object.freeze({
      neutralScore: 7.5,
      pointsPerReturnPct: 0.75,
      minimumScore: 0,
      maximumScore: 15,
    }),
  }),
});

function cloneReplayScoringConfig(config = CURRENT_REPLAY_SCORING_CONFIG) {
  return JSON.parse(JSON.stringify(config));
}

function createJsonParseError(message, extra = {}) {
  const error = new Error(message);
  error.name = "DatabaseJsonParseError";
  Object.assign(error, extra);
  return error;
}

function reportJsonParseError({ fieldName, rowId, rawValue, error }) {
  console.error(
    `[db] failed to parse JSON field ${fieldName} for row ${rowId ?? "<unknown>"}: ${error?.message ?? error}`,
    {
      fieldName,
      rowId: rowId ?? null,
      rawValue:
        typeof rawValue === "string"
          ? rawValue.slice(0, 240)
          : String(rawValue),
    },
  );
}

function parseJson(value, fallback, context = {}) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    reportJsonParseError({
      fieldName: context.fieldName ?? "unknown_json",
      rowId: context.rowId ?? null,
      rawValue: value,
      error,
    });
    if (context.strict) {
      throw createJsonParseError(
        `数据库字段 ${context.fieldName ?? "unknown_json"} 包含无效 JSON`,
        {
          fieldName: context.fieldName ?? "unknown_json",
          rowId: context.rowId ?? null,
          cause: error,
        },
      );
    }
    return fallback;
  }
}

function normalizeTagList(tags) {
  return Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function rowToParameterSet(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    strategyId: row.strategy_id,
    name: row.name,
    params: parseJson(
      row.params_json,
      {},
      {
        fieldName: "parameter_sets.params_json",
        rowId: row.id,
        strict: true,
      },
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    title: row.title ?? "",
    strategyId: row.strategy_id,
    parameterSetId: row.parameter_set_id,
    symbol: row.symbol,
    exchange: row.exchange,
    interval: row.interval,
    startDate: row.start_date,
    endDate: row.end_date,
    capital: row.capital,
    slippage: row.slippage,
    rate: row.rate,
    status: row.status,
    errorMessage: row.error_message,
    summary: parseJson(row.summary_json, null, {
      fieldName: "backtest_runs.summary_json",
      rowId: row.id,
      strict: true,
    }),
    artifacts: parseJson(row.artifacts_json, null, {
      fieldName: "backtest_runs.artifacts_json",
      rowId: row.id,
      strict: true,
    }),
    request: parseJson(row.request_json, null, {
      fieldName: "backtest_runs.request_json",
      rowId: row.id,
      strict: true,
    }),
    strategyVersionId: row.strategy_version_id ?? null,
    tags: normalizeTagList(
      parseJson(row.tags_json, [], {
        fieldName: "backtest_runs.tags_json",
        rowId: row.id,
        strict: true,
      }),
    ),
    notes: row.notes ?? "",
    starred: Boolean(row.starred ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRunSummary(row) {
  const run = rowToRun(row);
  if (!run) {
    return null;
  }
  const { artifacts: _artifacts, request: _request, ...summary } = run;
  return summary;
}

function createReplayScenarioIdentity({
  snapshot,
  observationBars,
  gameLength,
  legacySessionId = "",
}) {
  const tsCode = String(snapshot?.tsCode ?? "").trim();
  const normalizedObservationBars = Number(observationBars);
  const normalizedGameLength = Number(gameLength);
  const replayWindowBarCount =
    normalizedObservationBars + normalizedGameLength;
  const bars = Array.isArray(snapshot?.bars)
    ? snapshot.bars.slice(0, replayWindowBarCount)
    : [];
  const hasStableMarketWindow =
    tsCode &&
    Number.isSafeInteger(normalizedObservationBars) &&
    normalizedObservationBars > 0 &&
    Number.isSafeInteger(normalizedGameLength) &&
    normalizedGameLength > 0 &&
    bars.length === replayWindowBarCount &&
    bars.every(
      (bar) =>
        String(bar?.tradeDate ?? "").trim() &&
        [bar.open, bar.high, bar.low, bar.close].every((value) =>
          Number.isFinite(Number(value)),
        ) &&
        [bar.volume, bar.amount, bar.preClose, bar.adjustFactor].every(
          (value) => value == null || Number.isFinite(Number(value)),
        ),
    );
  if (!hasStableMarketWindow) {
    if (!legacySessionId) {
      throw createReplayStateError(
        "行情演练场景缺少完整标的、日期或 K 线，无法生成稳定场景身份",
        500,
      );
    }
    return {
      fingerprint: `legacy-unidentifiable:${createHash("sha256")
        .update(String(legacySessionId))
        .digest("hex")}`,
      version: LEGACY_REPLAY_SCENARIO_FINGERPRINT_VERSION,
    };
  }
  const benchmarkSupplied =
    snapshot?.benchmark !== undefined && snapshot?.benchmark !== null;
  const benchmarkCode = String(snapshot?.benchmark?.code ?? "")
    .trim()
    .toUpperCase();
  const benchmarkBars = Array.isArray(snapshot?.benchmark?.bars)
    ? snapshot.benchmark.bars
    : [];
  const hasStableBenchmarkWindow =
    benchmarkCode &&
    benchmarkBars.length === normalizedGameLength + 1 &&
    benchmarkBars.every((bar, index) => {
      const expectedSequence = normalizedObservationBars + index;
      const stockBar = bars[expectedSequence - 1];
      return (
        Number(bar?.sequence) === expectedSequence &&
        String(bar?.tradeDate ?? "").trim() ===
          String(stockBar?.tradeDate ?? "").trim() &&
        [bar.open, bar.high, bar.low, bar.close].every((value) =>
          Number.isFinite(Number(value)),
        ) &&
        [bar.volume, bar.amount, bar.preClose].every(
          (value) => value == null || Number.isFinite(Number(value)),
        )
      );
    });
  if (benchmarkSupplied && !hasStableBenchmarkWindow) {
    throw createReplayStateError(
      "行情演练场景的指数基准缺少完整代码、日期或 K 线",
      500,
    );
  }
  const fingerprintVersion = hasStableBenchmarkWindow
    ? REPLAY_SCENARIO_FINGERPRINT_VERSION
    : REPLAY_SCENARIO_FINGERPRINT_V2;
  const identity = JSON.stringify([
    fingerprintVersion,
    tsCode,
    normalizedObservationBars,
    normalizedGameLength,
    bars.map((bar, index) => [
      index + 1,
      String(bar.tradeDate).trim(),
      Number(bar.open),
      Number(bar.high),
      Number(bar.low),
      Number(bar.close),
      bar.volume == null ? null : Number(bar.volume),
      bar.amount == null ? null : Number(bar.amount),
      bar.preClose == null ? null : Number(bar.preClose),
      bar.adjustFactor == null ? null : Number(bar.adjustFactor),
    ]),
    ...(hasStableBenchmarkWindow
      ? [
          benchmarkCode,
          benchmarkBars.map((bar) => [
            Number(bar.sequence),
            String(bar.tradeDate).trim(),
            Number(bar.open),
            Number(bar.high),
            Number(bar.low),
            Number(bar.close),
            bar.volume == null ? null : Number(bar.volume),
            bar.amount == null ? null : Number(bar.amount),
            bar.preClose == null ? null : Number(bar.preClose),
          ]),
        ]
      : []),
  ]);
  return {
    fingerprint: createHash("sha256").update(identity).digest("hex"),
    version: fingerprintVersion,
  };
}

function rowToReplaySession(row) {
  if (!row) {
    return null;
  }
  const scoringConfig = parseJson(row.scoring_config_json, null, {
    fieldName: "replay_sessions.scoring_config_json",
    rowId: row.id,
    strict: true,
  });
  if (!scoringConfig) {
    throw createJsonParseError(
      "行情演练会话缺少创建时冻结的评分配置",
      {
        fieldName: "replay_sessions.scoring_config_json",
        rowId: row.id,
      },
    );
  }
  return {
    id: row.id,
    sourceDataVersion: row.source_data_version,
    gameLength: Number(row.game_length),
    observationBars: Number(row.observation_bars),
    revealedFutureBars: Number(row.revealed_future_bars),
    status: row.status,
    completionReason: row.completion_reason ?? null,
    revealedAt: row.revealed_at ?? null,
    revision: Number(row.revision ?? 0),
    snapshot: parseJson(row.snapshot_json, null, {
      fieldName: "replay_sessions.snapshot_json",
      rowId: row.id,
      strict: true,
    }),
    account: parseJson(row.account_json, {}, {
      fieldName: "replay_sessions.account_json",
      rowId: row.id,
      strict: true,
    }),
    costConfig: parseJson(row.cost_config_json, {}, {
      fieldName: "replay_sessions.cost_config_json",
      rowId: row.id,
      strict: true,
    }),
    trainingConfig: parseJson(
      row.training_config_json,
      { mode: "free" },
      {
        fieldName: "replay_sessions.training_config_json",
        rowId: row.id,
        strict: true,
      },
    ),
    scoringConfig,
    scenarioFingerprint: row.scenario_fingerprint,
    scenarioFingerprintVersion: row.scenario_fingerprint_version,
    attemptInfo: {
      attemptNumber: Number(row.attempt_number ?? 1),
      kind: row.attempt_kind === "retrain" ? "retrain" : "first",
      countsTowardFirstScore: Boolean(
        row.counts_toward_first_score ?? 1,
      ),
      sourceSessionId: row.source_session_id ?? null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReplayReview(row) {
  if (!row) {
    return {
      blindReview: null,
      postReview: null,
      scoreCard: null,
      blindUpdatedAt: null,
      postUpdatedAt: null,
    };
  }
  return {
    blindReview: parseJson(row.blind_json, null, {
      fieldName: "replay_reviews.blind_json",
      rowId: row.session_id,
      strict: true,
    }),
    postReview: parseJson(row.post_json, null, {
      fieldName: "replay_reviews.post_json",
      rowId: row.session_id,
      strict: true,
    }),
    scoreCard: parseJson(row.score_json, null, {
      fieldName: "replay_reviews.score_json",
      rowId: row.session_id,
      strict: true,
    }),
    blindUpdatedAt: row.blind_updated_at ?? null,
    postUpdatedAt: row.post_updated_at ?? null,
  };
}

function rowToReplayReviewCorrection(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    stage: row.stage,
    revisionNumber: Number(row.revision_number),
    fullReviewSnapshot: parseJson(row.full_review_json, null, {
      fieldName: "replay_review_corrections.full_review_json",
      rowId: row.id,
      strict: true,
    }),
    changeNote: row.change_note,
    createdAt: row.created_at,
  };
}

function rowToReplayReviewDraft(row) {
  if (!row) {
    return null;
  }
  return {
    stage: row.stage,
    data: row.deleted_at
      ? null
      : parseJson(row.draft_json, {}, {
          fieldName: "replay_review_drafts.draft_json",
          rowId: `${row.session_id}:${row.stage}`,
          strict: true,
        }),
    revision: Number(row.revision),
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

function rowToReplayHistoryItem(row) {
  const revealed = Boolean(row.revealed_at);
  const snapshot = parseJson(row.snapshot_json, {}, {
    fieldName: "replay_sessions.snapshot_json",
    rowId: row.id,
    strict: false,
  });
  const interval = ["1m", "hybrid"].includes(row.interval)
    ? row.interval
    : "1d";
  const revealedMinuteBars = interval === "hybrid"
    ? (snapshot.bars ?? []).slice(250, 250 + Number(row.revealed_future_bars))
    : [];
  const revealedDates = [...new Set(
    revealedMinuteBars.map((bar) => String(bar.tradeDate ?? "")),
  )];
  const nextHybridBar = interval === "hybrid"
    ? snapshot.bars?.[250 + Number(row.revealed_future_bars)] ?? null
    : null;
  const lastRevealedDate = String(revealedMinuteBars.at(-1)?.tradeDate ?? "");
  const completedHybridDays = revealedDates.length - (
    lastRevealedDate &&
    nextHybridBar &&
    String(nextHybridBar.tradeDate ?? "") === lastRevealedDate
      ? 1
      : 0
  );
  const storedTrainingConfig = parseJson(
    row.training_config_json,
    { mode: "free" },
    {
      fieldName: "replay_sessions.training_config_json",
      rowId: row.id,
      strict: true,
    },
  );
  const trainingConfig = storedTrainingConfig.mode === "playbook"
    ? {
        mode: "playbook",
        playbookId: storedTrainingConfig.playbookId,
        playbookVersionId: storedTrainingConfig.playbookVersionId,
        playbookName: storedTrainingConfig.playbookName,
        playbookVersionNumber: storedTrainingConfig.playbookVersionNumber,
      }
    : { mode: "free" };
  return {
    id: row.id,
    interval,
    ...(interval === "hybrid"
      ? { stepMinutes: Number(snapshot.stepMinutes ?? 1) }
      : interval === "1m" ? { stepMinutes: 1 } : {}),
    gameLength: interval === "hybrid"
      ? Number(snapshot.trainingDays ?? 0)
      : Number(row.game_length),
    progress: {
      current: interval === "hybrid"
        ? completedHybridDays
        : Number(row.revealed_future_bars),
      total: interval === "hybrid"
        ? Number(snapshot.trainingDays ?? 0)
        : Number(row.game_length),
    },
    status: row.status,
    completionReason: row.completion_reason ?? null,
    revealed,
    reviewState: row.review_state,
    blindReview: parseJson(row.blind_json, null, {
      fieldName: "replay_reviews.blind_json",
      rowId: row.id,
      strict: true,
    }),
    postReview: revealed
      ? parseJson(row.post_json, null, {
          fieldName: "replay_reviews.post_json",
          rowId: row.id,
          strict: true,
        })
      : null,
    scoreCard: revealed
      ? parseJson(row.score_json, null, {
          fieldName: "replay_reviews.score_json",
          rowId: row.id,
          strict: true,
        })
      : null,
    trainingConfig,
    attemptInfo: {
      attemptNumber: Number(row.attempt_number ?? 1),
      kind: row.attempt_kind === "retrain" ? "retrain" : "first",
      countsTowardFirstScore: Boolean(
        row.counts_toward_first_score ?? 1,
      ),
      sourceSessionId: row.source_session_id ?? null,
    },
    correctionSummary: {
      blindCount: Number(row.blind_correction_count ?? 0),
      postCount: revealed
        ? Number(row.post_correction_count ?? 0)
        : 0,
    },
    ...(revealed
      ? {
          reveal: {
            tsCode: String(row.ts_code ?? ""),
            symbol: String(row.symbol ?? ""),
            exchange: String(row.exchange ?? ""),
            name: String(row.name ?? ""),
            startDate: String(row.start_date ?? ""),
            endDate: String(row.end_date ?? ""),
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReplayPlaybook(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    currentVersionId: row.current_version_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReplayPlaybookVersion(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    playbookId: row.playbook_id,
    versionNumber: Number(row.version_number),
    content: row.content,
    changeSummary: row.change_summary,
    sourceCandidateId: row.source_candidate_id ?? null,
    createdAt: row.created_at,
  };
}

function rowToReplayPlaybookCandidate(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    playbookId: row.playbook_id,
    sessionId: row.session_id,
    sourceVersionId: row.source_version_id,
    suggestion: row.suggestion,
    state: row.state,
    acceptedVersionId: row.accepted_version_id ?? null,
    reason: row.reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createReplayStateError(message, status = 409) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeExpectedReplayDraftRevision(value) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw createReplayStateError(
      "expectedRevision 必须是大于等于 0 的安全整数",
      400,
    );
  }
  return value;
}

function roundReplayNumber(value) {
  return Number(Number(value).toFixed(10));
}

function roundReplayMetric(value) {
  return Number(Number(value).toFixed(4));
}

function roundReplayScore(value) {
  return Number(Number(value).toFixed(2));
}

function clampReplayScore(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function calculateReplayIndexBenchmark({
  snapshot,
  stockBars,
  observationBars,
  completionSequence,
  totalReturnPct,
}) {
  if (snapshot?.benchmark == null) {
    return {
      returnPct: null,
      excessReturnPct: null,
      status: "unavailable",
    };
  }
  const benchmarkCode = String(snapshot.benchmark.code ?? "")
    .trim()
    .toUpperCase();
  const benchmarkBars = Array.isArray(snapshot.benchmark.bars)
    ? snapshot.benchmark.bars
    : [];
  const benchmarkBySequence = new Map(
    benchmarkBars.map((bar) => [Number(bar?.sequence), bar]),
  );
  const startBar = benchmarkBySequence.get(observationBars);
  const endBar = benchmarkBySequence.get(completionSequence);
  const stockStartBar = stockBars[observationBars - 1];
  const stockEndBar = stockBars[completionSequence - 1];
  const startClose = Number(startBar?.close);
  const endClose = Number(endBar?.close);
  const hasValidWindow =
    benchmarkCode &&
    benchmarkBySequence.size === benchmarkBars.length &&
    startBar &&
    endBar &&
    String(startBar.tradeDate ?? "").trim() ===
      String(stockStartBar?.tradeDate ?? "").trim() &&
    String(endBar.tradeDate ?? "").trim() ===
      String(stockEndBar?.tradeDate ?? "").trim() &&
    Number.isFinite(startClose) &&
    startClose > 0 &&
    Number.isFinite(endClose) &&
    endClose > 0;
  if (!hasValidWindow) {
    throw createReplayStateError(
      "行情演练会话的指数基准无法与结算区间完整对齐",
      500,
    );
  }
  const returnPct = ((endClose / startClose) - 1) * 100;
  return {
    returnPct,
    excessReturnPct: totalReturnPct - returnPct,
    status: "available",
  };
}

function normalizeReplayScoringConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw createReplayStateError(
      "行情演练会话缺少创建时冻结的评分配置",
      500,
    );
  }
  const algorithmVersion = String(config.algorithmVersion ?? "").trim();
  if (algorithmVersion !== REPLAY_SCORE_V2) {
    throw createReplayStateError(
      `不支持会话冻结的评分算法版本：${algorithmVersion || "<empty>"}`,
      500,
    );
  }
  const dimensionNames = [
    "executionDiscipline",
    "riskControl",
    "playbookCompliance",
    "returnPerformance",
    "reviewQuality",
  ];
  const weights = Object.fromEntries(
    dimensionNames.map((name) => {
      const value = Number(config.weights?.[name]);
      if (!Number.isFinite(value) || value < 0) {
        throw createReplayStateError(
          `会话冻结的评分权重 ${name} 无效`,
          500,
        );
      }
      return [name, value];
    }),
  );
  const returnPerformance = {
    neutralScore: Number(
      config.parameters?.returnPerformance?.neutralScore,
    ),
    pointsPerReturnPct: Number(
      config.parameters?.returnPerformance?.pointsPerReturnPct,
    ),
    minimumScore: Number(
      config.parameters?.returnPerformance?.minimumScore,
    ),
    maximumScore: Number(
      config.parameters?.returnPerformance?.maximumScore,
    ),
  };
  if (
    !Object.values(returnPerformance).every(Number.isFinite) ||
    returnPerformance.minimumScore < 0 ||
    returnPerformance.maximumScore < returnPerformance.minimumScore ||
    returnPerformance.neutralScore < returnPerformance.minimumScore ||
    returnPerformance.neutralScore > returnPerformance.maximumScore
  ) {
    throw createReplayStateError(
      "会话冻结的收益评分参数无效",
      500,
    );
  }
  return {
    algorithmVersion,
    weights,
    parameters: { returnPerformance },
  };
}

function calculateReplayScoreCard(session) {
  const scoringConfig = normalizeReplayScoringConfig(
    session.scoringConfig,
  );
  const { algorithmVersion, weights } = scoringConfig;
  const returnPerformanceParameters =
    scoringConfig.parameters.returnPerformance;
  const initialCapital = Number(session.account?.initialCapital ?? 0);
  const observationBars = Number(session.observationBars ?? 0);
  const revealedFutureBars = Number(session.revealedFutureBars ?? 0);
  const completionSequence = observationBars + revealedFutureBars;
  const bars = Array.isArray(session.snapshot?.bars)
    ? session.snapshot.bars
    : [];
  const filledExecutions = (session.executions ?? []).filter(
    (execution) => execution.status === "filled",
  );
  const fillsBySequence = new Map();
  for (const fill of filledExecutions) {
    const sequence = Number(fill.sequence);
    const values = fillsBySequence.get(sequence) ?? [];
    values.push(fill);
    fillsBySequence.set(sequence, values);
  }

  let cash = initialCapital;
  let positionQuantity = 0;
  const equityCurve = [initialCapital];
  const capitalUtilizationCurve = [];
  for (
    let sequence = observationBars + 1;
    sequence <= completionSequence;
    sequence += 1
  ) {
    for (const fill of fillsBySequence.get(sequence) ?? []) {
      const quantity = Number(fill.quantity ?? 0);
      const notional = Number(fill.notional ?? 0);
      const totalFee = Number(fill.totalFee ?? 0);
      if (fill.side === "buy") {
        cash -= notional + totalFee;
        positionQuantity += quantity;
      } else {
        cash += notional - totalFee;
        positionQuantity -= quantity;
      }
    }
    const close = Number(bars[sequence - 1]?.close ?? 0);
    const marketValue = positionQuantity * close;
    const equity = cash + marketValue;
    equityCurve.push(equity);
    capitalUtilizationCurve.push(
      equity > 0 ? (marketValue / equity) * 100 : 0,
    );
  }

  const finalEquity = equityCurve.at(-1) ?? initialCapital;
  const totalReturnPct =
    initialCapital > 0 ? ((finalEquity / initialCapital) - 1) * 100 : 0;
  const benchmarkStart = Number(bars[observationBars - 1]?.close ?? 0);
  const benchmarkEnd = Number(bars[completionSequence - 1]?.close ?? 0);
  const stockBuyAndHoldReturnPct =
    benchmarkStart > 0 && Number.isFinite(benchmarkEnd)
      ? ((benchmarkEnd / benchmarkStart) - 1) * 100
      : null;
  const strategyVsStockBuyAndHoldPct =
    stockBuyAndHoldReturnPct == null
      ? null
      : totalReturnPct - stockBuyAndHoldReturnPct;
  const indexBenchmark = calculateReplayIndexBenchmark({
    snapshot: session.snapshot,
    stockBars: bars,
    observationBars,
    completionSequence,
    totalReturnPct,
  });
  let runningPeak = equityCurve[0] ?? initialCapital;
  let maxDrawdownPct = 0;
  for (const equity of equityCurve) {
    runningPeak = Math.max(runningPeak, equity);
    if (runningPeak > 0) {
      maxDrawdownPct = Math.max(
        maxDrawdownPct,
        ((runningPeak - equity) / runningPeak) * 100,
      );
    }
  }

  const blind = session.review?.blindReview;
  const post = session.review?.postReview;
  const playbookConfigured =
    session.trainingConfig?.mode === "playbook" &&
    String(
      session.trainingConfig?.playbookVersionId ?? "",
    ).trim().length > 0;
  const playbookHasContent =
    String(session.trainingConfig?.playbookContent ?? "").trim().length > 0;
  const playbookApplicable = playbookConfigured && playbookHasContent;
  const hasScore = (value) =>
    Number.isSafeInteger(value) && value >= 1 && value <= 5;
  const requiredFields = [
    typeof blind?.thesis === "string" && blind.thesis.length >= 10,
    typeof blind?.tradePlan === "string" && blind.tradePlan.length >= 10,
    typeof blind?.riskPlan === "string" && blind.riskPlan.length >= 10,
    Number.isSafeInteger(blind?.confidence) &&
      blind.confidence >= 1 &&
      blind.confidence <= 5,
    ["correct", "partial", "wrong"].includes(post?.outcome),
    typeof post?.executionReview === "string" &&
      post.executionReview.length >= 10,
    typeof post?.mistakes === "string" && post.mistakes.length >= 1,
    typeof post?.lessons === "string" && post.lessons.length >= 10,
    hasScore(post?.disciplineScore),
    hasScore(post?.riskControlScore),
    ...(playbookApplicable ? [hasScore(post?.playbookFitScore)] : []),
  ];
  const completedRequiredFields = requiredFields.filter(Boolean).length;
  const totalRequiredFields = requiredFields.length;
  const executionDisciplineApplicable = hasScore(post?.disciplineScore);
  const riskControlApplicable = hasScore(post?.riskControlScore);
  const playbookComplianceApplicable =
    playbookApplicable && hasScore(post?.playbookFitScore);
  const breakdown = {
    executionDiscipline: executionDisciplineApplicable
      ? roundReplayScore(
          (Number(post.disciplineScore) / 5) *
            weights.executionDiscipline,
        )
      : null,
    riskControl: riskControlApplicable
      ? roundReplayScore(
          (Number(post.riskControlScore) / 5) * weights.riskControl,
        )
      : null,
    playbookCompliance: playbookComplianceApplicable
      ? roundReplayScore(
          (Number(post.playbookFitScore) / 5) *
            weights.playbookCompliance,
        )
      : null,
    returnPerformance: roundReplayScore(
      clampReplayScore(
        returnPerformanceParameters.neutralScore +
          totalReturnPct *
            returnPerformanceParameters.pointsPerReturnPct,
        returnPerformanceParameters.minimumScore,
        returnPerformanceParameters.maximumScore,
      ),
    ),
    reviewQuality: roundReplayScore(
      (completedRequiredFields / totalRequiredFields) *
        weights.reviewQuality,
    ),
  };
  const applicability = {
    executionDiscipline: {
      applicable: executionDisciplineApplicable,
      reason: executionDisciplineApplicable
        ? null
        : "legacy_missing_input",
    },
    riskControl: {
      applicable: riskControlApplicable,
      reason: riskControlApplicable ? null : "legacy_missing_input",
    },
    playbookCompliance: {
      applicable: playbookComplianceApplicable,
      reason: playbookComplianceApplicable
        ? null
        : !playbookConfigured
          ? "free_training"
          : !playbookHasContent
            ? "blank_playbook"
            : "legacy_missing_input",
    },
    returnPerformance: { applicable: true, reason: null },
    reviewQuality: { applicable: true, reason: null },
  };
  const appliedDimensionNames = Object.keys(weights).filter(
    (name) => applicability[name].applicable,
  );
  const appliedWeightTotal = appliedDimensionNames.reduce(
    (sum, name) => sum + weights[name],
    0,
  );
  const rawTotal = appliedDimensionNames.reduce(
    (sum, name) => sum + Number(breakdown[name] ?? 0),
    0,
  );
  const total =
    appliedWeightTotal > 0
      ? roundReplayScore((rawTotal / appliedWeightTotal) * 100)
      : 0;
  const endingMarkPrice = Number(
    bars[Math.max(0, completionSequence - 1)]?.close ?? 0,
  );
  const endingPositionQuantity = Number(
    session.account?.positionQuantity ?? positionQuantity,
  );
  const endingMarketValue = endingPositionQuantity * endingMarkPrice;
  const averageCost = Number(session.account?.averageCost ?? 0);
  const totalFees = filledExecutions.reduce(
    (sum, execution) => sum + Number(execution.totalFee ?? 0),
    0,
  );
  const averageCapitalUtilizationPct =
    capitalUtilizationCurve.length > 0
      ? capitalUtilizationCurve.reduce((sum, value) => sum + value, 0) /
        capitalUtilizationCurve.length
      : 0;
  return {
    algorithmVersion,
    weights,
    appliedWeightTotal,
    rawTotal: roundReplayScore(rawTotal),
    total,
    breakdown,
    applicability,
    metrics: {
      totalReturnPct: roundReplayMetric(totalReturnPct),
      maxDrawdownPct: roundReplayMetric(maxDrawdownPct),
      totalTradingCosts: roundReplayMetric(totalFees),
      realizedPnl: roundReplayMetric(
        Number(session.account?.realizedPnl ?? 0),
      ),
      unrealizedPnl: roundReplayMetric(
        (endingMarkPrice - averageCost) * endingPositionQuantity,
      ),
      endingCapitalUtilizationPct: roundReplayMetric(
        finalEquity > 0 ? (endingMarketValue / finalEquity) * 100 : 0,
      ),
      averageCapitalUtilizationPct: roundReplayMetric(
        averageCapitalUtilizationPct,
      ),
      maxCapitalUtilizationPct: roundReplayMetric(
        capitalUtilizationCurve.length > 0
          ? Math.max(...capitalUtilizationCurve)
          : 0,
      ),
      stockBuyAndHoldReturnPct:
        stockBuyAndHoldReturnPct == null
          ? null
          : roundReplayMetric(stockBuyAndHoldReturnPct),
      strategyVsStockBuyAndHoldPct:
        strategyVsStockBuyAndHoldPct == null
          ? null
          : roundReplayMetric(strategyVsStockBuyAndHoldPct),
      indexBenchmarkReturnPct:
        indexBenchmark.returnPct == null
          ? null
          : roundReplayMetric(indexBenchmark.returnPct),
      indexExcessReturnPct:
        indexBenchmark.excessReturnPct == null
          ? null
          : roundReplayMetric(indexBenchmark.excessReturnPct),
      indexBenchmarkStatus: indexBenchmark.status,
    },
    completeness: {
      completedRequiredFields,
      totalRequiredFields,
      legacyBlindMissing: Boolean(session.revealedAt && !blind),
    },
  };
}

function calculateReplayFees(notional, side, costConfig) {
  const commission = Math.max(
    Number(costConfig.minCommission),
    notional * Number(costConfig.commissionRate),
  );
  const stampTax =
    side === "sell" ? notional * Number(costConfig.stampTaxRate) : 0;
  const transferFee = notional * Number(costConfig.transferFeeRate);
  return {
    commission: roundReplayNumber(commission),
    stampTax: roundReplayNumber(stampTax),
    transferFee: roundReplayNumber(transferFee),
    totalFee: roundReplayNumber(commission + stampTax + transferFee),
  };
}

function replayOrderQuantity(order, account, price, costConfig) {
  if (order.quantityType === "shares") {
    return Math.floor(Number(order.requestedQuantity) / 100) * 100;
  }
  if (order.quantityType === "cash_ratio") {
    const budget = Number(account.cash) * Number(order.ratio);
    let quantity = Math.floor(budget / price / 100) * 100;
    while (quantity > 0) {
      const notional = price * quantity;
      const fees = calculateReplayFees(notional, "buy", costConfig);
      if (notional + fees.totalFee <= budget && notional + fees.totalFee <= account.cash) {
        return quantity;
      }
      quantity -= 100;
    }
    return 0;
  }
  if (order.quantityType === "position_ratio") {
    return (
      Math.floor(
        (Number(account.availableQuantity) * Number(order.ratio)) / 100,
      ) * 100
    );
  }
  return 0;
}

function rowToSyncLog(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    symbol: row.symbol,
    exchange: row.exchange,
    interval: row.interval,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    provider: row.provider,
    barsSynced: row.bars_synced,
    message: row.message,
    createdAt: row.created_at,
  };
}

function rowToTask(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    request: parseJson(
      row.request_json,
      {},
      {
        fieldName: "analysis_tasks.request_json",
        rowId: row.id,
        strict: true,
      },
    ),
    result: parseJson(row.result_json, null, {
      fieldName: "analysis_tasks.result_json",
      rowId: row.id,
      strict: true,
    }),
    errorMessage: row.error_message,
    relatedRunIds: parseJson(row.related_run_ids_json, [], {
      fieldName: "analysis_tasks.related_run_ids_json",
      rowId: row.id,
      strict: true,
    }),
    tags: normalizeTagList(
      parseJson(row.tags_json, [], {
        fieldName: "analysis_tasks.tags_json",
        rowId: row.id,
        strict: true,
      }),
    ),
    notes: row.notes ?? "",
    starred: Boolean(row.starred ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSystemLog(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    scope: row.scope,
    level: row.level,
    title: row.title,
    message: row.message,
    payload: parseJson(row.payload_json, null, {
      fieldName: "system_logs.payload_json",
      rowId: row.id,
      strict: false,
    }),
    createdAt: row.created_at,
  };
}

function rowToStrategyVersion(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    strategyId: row.strategy_id,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    sourceCode: row.source_code,
    summary: parseJson(row.summary_json, null, {
      fieldName: "strategy_versions.summary_json",
      rowId: row.id,
      strict: true,
    }),
    createdAt: row.created_at,
  };
}

function rowToDecisionAnalysisSnapshot(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    analysisType: row.analysis_type,
    analysisDate: row.analysis_date,
    sourceKey: row.source_key,
    stockCode: row.stock_code ?? "",
    stockName: row.stock_name ?? "",
    title: row.title ?? "",
    summary: parseJson(row.summary_json, null, {
      fieldName: "decision_analysis_snapshots.summary_json",
      rowId: row.id,
      strict: true,
    }),
    payload: parseJson(row.payload_json, null, {
      fieldName: "decision_analysis_snapshots.payload_json",
      rowId: row.id,
      strict: true,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToStockQueryRecord(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    queryDate: row.query_date,
    stockCode: row.stock_code,
    stockName: row.stock_name,
    inputText: row.input_text ?? "",
    analysisDate: row.analysis_date ?? "",
    action: row.action ?? "",
    technicalScore: row.technical_score,
    opportunityScore: row.opportunity_score,
    summary: parseJson(row.summary_json, null, {
      fieldName: "stock_query_records.summary_json",
      rowId: row.id,
      strict: true,
    }),
    createdAt: row.created_at,
  };
}

function ensureColumn(db, tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
    );
  }
}

function normalizePaginationOptions(options = {}, defaults = {}) {
  const defaultPage = Number(defaults.page ?? 1);
  const defaultPageSize = Number(defaults.pageSize ?? 20);
  const maxPageSize = Number(defaults.maxPageSize ?? 500);
  const page = Math.max(1, Number(options.page ?? defaultPage) || defaultPage);
  const pageSize = Math.max(
    1,
    Math.min(
      Number(options.pageSize ?? defaultPageSize) || defaultPageSize,
      maxPageSize,
    ),
  );
  const offset = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    offset,
  };
}

function buildTagFilterSql({ filterTag, tableAlias, tagTableName, idColumn }) {
  const values = [];
  if (!filterTag) {
    return {
      joinSql: "",
      whereSql: "",
      values,
    };
  }
  values.push(String(filterTag).trim());
  return {
    joinSql: `
      INNER JOIN ${tagTableName} AS ${tagTableName}_filter
        ON ${tagTableName}_filter.${idColumn} = ${tableAlias}.id
    `,
    whereSql: `${tagTableName}_filter.tag = ?`,
    values,
  };
}

export function createDatabase(dbPath = DEFAULT_DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  let closed = false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS parameter_sets (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      name TEXT NOT NULL,
      params_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      title TEXT,
      strategy_id TEXT NOT NULL,
      parameter_set_id TEXT,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      interval TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      capital REAL NOT NULL,
      slippage REAL NOT NULL,
      rate REAL NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      summary_json TEXT,
      artifacts_json TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      starred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS data_sync_logs (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      interval TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      bars_synced INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analysis_tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      related_run_ids_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      starred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_logs (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_versions (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_code TEXT NOT NULL,
      summary_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decision_analysis_snapshots (
      id TEXT PRIMARY KEY,
      analysis_type TEXT NOT NULL,
      analysis_date TEXT NOT NULL,
      source_key TEXT NOT NULL,
      stock_code TEXT,
      stock_name TEXT,
      title TEXT NOT NULL,
      summary_json TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (analysis_type, analysis_date, source_key)
    );

    CREATE TABLE IF NOT EXISTS stock_query_records (
      id TEXT PRIMARY KEY,
      query_date TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      input_text TEXT NOT NULL DEFAULT '',
      analysis_date TEXT,
      action TEXT,
      technical_score REAL,
      opportunity_score REAL,
      summary_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decision_execution_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      simulated_account_equity REAL,
      live_account_equity REAL,
      default_min_reward_risk_ratio REAL NOT NULL,
      default_max_account_risk_pct REAL NOT NULL,
      lot_size INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backtest_run_tags (
      run_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (run_id, tag)
    );

    CREATE TABLE IF NOT EXISTS analysis_task_tags (
      task_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (task_id, tag)
    );

    CREATE TABLE IF NOT EXISTS replay_sessions (
      id TEXT PRIMARY KEY,
      source_data_version TEXT NOT NULL,
      game_length INTEGER NOT NULL,
      observation_bars INTEGER NOT NULL,
      revealed_future_bars INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      completion_reason TEXT,
      revealed_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL,
      account_json TEXT NOT NULL DEFAULT '{}',
      cost_config_json TEXT NOT NULL DEFAULT '{}',
      training_config_json TEXT NOT NULL DEFAULT '{"mode":"free"}',
      scoring_config_json TEXT NOT NULL,
      scenario_fingerprint TEXT,
      scenario_fingerprint_version TEXT,
      attempt_number INTEGER,
      attempt_kind TEXT,
      counts_toward_first_score INTEGER,
      source_session_id TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replay_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, action_id)
    );

    CREATE TABLE IF NOT EXISTS replay_scenario_attempt_counters (
      scenario_fingerprint TEXT PRIMARY KEY,
      last_attempt_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replay_orders (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity_type TEXT NOT NULL,
      requested_quantity INTEGER,
      ratio REAL,
      decision_json TEXT,
      submitted_sequence INTEGER NOT NULL,
      scheduled_sequence INTEGER NOT NULL,
      created_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, action_id)
    );

    CREATE TABLE IF NOT EXISTS replay_fills (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      sequence INTEGER NOT NULL,
      side TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reference_price REAL NOT NULL,
      price REAL NOT NULL,
      slippage_bps REAL NOT NULL,
      notional REAL NOT NULL,
      commission REAL NOT NULL,
      stamp_tax REAL NOT NULL,
      transfer_fee REAL NOT NULL,
      total_fee REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replay_order_rejections (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      sequence INTEGER NOT NULL,
      reason_code TEXT NOT NULL,
      reason_message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replay_reviews (
      session_id TEXT PRIMARY KEY,
      blind_json TEXT,
      post_json TEXT,
      score_json TEXT,
      blind_updated_at TEXT,
      post_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replay_review_corrections (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('blind', 'post')),
      revision_number INTEGER NOT NULL,
      full_review_json TEXT NOT NULL,
      change_note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, action_id),
      UNIQUE (session_id, stage, revision_number)
    );

    CREATE TABLE IF NOT EXISTS replay_review_drafts (
      session_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('blind', 'post')),
      draft_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (session_id, stage)
    );

    CREATE TABLE IF NOT EXISTS replay_playbooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS replay_playbook_versions (
      id TEXT PRIMARY KEY,
      playbook_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      source_candidate_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (playbook_id, version_number)
    );

    CREATE TABLE IF NOT EXISTS replay_playbook_candidates (
      id TEXT PRIMARY KEY,
      playbook_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_version_id TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected')),
      accepted_version_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, playbook_id)
    );

    CREATE INDEX IF NOT EXISTS idx_backtest_run_tags_tag
      ON backtest_run_tags(tag);

    CREATE INDEX IF NOT EXISTS idx_analysis_task_tags_tag
      ON analysis_task_tags(tag);

    CREATE INDEX IF NOT EXISTS idx_decision_analysis_snapshots_date_type
      ON decision_analysis_snapshots(analysis_date DESC, analysis_type);

    CREATE INDEX IF NOT EXISTS idx_decision_analysis_snapshots_stock
      ON decision_analysis_snapshots(stock_code, analysis_date DESC);

    CREATE INDEX IF NOT EXISTS idx_stock_query_records_date
      ON stock_query_records(query_date DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_stock_query_records_stock
      ON stock_query_records(stock_code, query_date DESC);

    CREATE INDEX IF NOT EXISTS idx_replay_sessions_updated
      ON replay_sessions(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_replay_events_session
      ON replay_events(session_id, sequence, created_at);

    CREATE INDEX IF NOT EXISTS idx_replay_review_corrections_session
      ON replay_review_corrections(session_id, created_at, revision_number);

    CREATE INDEX IF NOT EXISTS idx_replay_orders_session
      ON replay_orders(session_id, scheduled_sequence, created_revision);

    CREATE INDEX IF NOT EXISTS idx_replay_playbook_versions_playbook
      ON replay_playbook_versions(playbook_id, version_number DESC);

    CREATE INDEX IF NOT EXISTS idx_replay_playbook_candidates_playbook
      ON replay_playbook_candidates(playbook_id, state, updated_at DESC);
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS replay_reviews_blind_immutable
    BEFORE UPDATE ON replay_reviews
    WHEN OLD.blind_json IS NOT NULL
      AND NEW.blind_json IS NOT OLD.blind_json
    BEGIN
      SELECT RAISE(ABORT, 'initial blind review is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS replay_reviews_post_immutable
    BEFORE UPDATE ON replay_reviews
    WHEN OLD.post_json IS NOT NULL
      AND NEW.post_json IS NOT OLD.post_json
    BEGIN
      SELECT RAISE(ABORT, 'initial post review is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS replay_reviews_score_immutable
    BEFORE UPDATE ON replay_reviews
    WHEN OLD.score_json IS NOT NULL
      AND NEW.score_json IS NOT OLD.score_json
    BEGIN
      SELECT RAISE(ABORT, 'initial score card is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS replay_reviews_no_delete
    BEFORE DELETE ON replay_reviews
    WHEN OLD.blind_json IS NOT NULL
      OR OLD.post_json IS NOT NULL
      OR OLD.score_json IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'initial replay reviews are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS replay_review_corrections_no_update
    BEFORE UPDATE ON replay_review_corrections
    BEGIN
      SELECT RAISE(ABORT, 'replay review corrections are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS replay_review_corrections_no_delete
    BEFORE DELETE ON replay_review_corrections
    BEGIN
      SELECT RAISE(ABORT, 'replay review corrections are append-only');
    END;
  `);

  ensureColumn(db, "backtest_runs", "request_json", "TEXT");
  ensureColumn(db, "backtest_runs", "strategy_version_id", "TEXT");
  ensureColumn(db, "backtest_runs", "title", "TEXT");
  ensureColumn(db, "backtest_runs", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "backtest_runs", "notes", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "backtest_runs", "starred", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "analysis_tasks", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "analysis_tasks", "notes", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "analysis_tasks", "starred", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "replay_sessions", "revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "replay_sessions", "completion_reason", "TEXT");
  ensureColumn(db, "replay_sessions", "revealed_at", "TEXT");
  ensureColumn(db, "replay_sessions", "deleted_at", "TEXT");
  ensureColumn(db, "replay_playbooks", "deleted_at", "TEXT");
  db.prepare(
    `
    UPDATE replay_sessions
    SET completion_reason = 'natural'
    WHERE status = 'completed'
      AND completion_reason IS NULL
    `,
  ).run();
  ensureColumn(db, "replay_sessions", "scenario_fingerprint", "TEXT");
  ensureColumn(
    db,
    "replay_sessions",
    "scenario_fingerprint_version",
    "TEXT",
  );
  ensureColumn(db, "replay_sessions", "attempt_number", "INTEGER");
  ensureColumn(db, "replay_sessions", "attempt_kind", "TEXT");
  ensureColumn(
    db,
    "replay_sessions",
    "counts_toward_first_score",
    "INTEGER",
  );
  ensureColumn(db, "replay_sessions", "source_session_id", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_replay_sessions_scenario_attempt
      ON replay_sessions(scenario_fingerprint, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_replay_sessions_attempt_kind
      ON replay_sessions(attempt_kind, updated_at DESC);
  `);
  const replayAttemptRows = db
    .prepare(
      `
      SELECT
        id,
        source_data_version,
        game_length,
        observation_bars,
        snapshot_json,
        scenario_fingerprint,
        scenario_fingerprint_version,
        attempt_number,
        attempt_kind,
        counts_toward_first_score,
        created_at
      FROM replay_sessions
      ORDER BY created_at ASC, id ASC
      `,
    )
    .all();
  const replayAttemptCounters = new Map(
    db
      .prepare(
        `
        SELECT scenario_fingerprint, last_attempt_number
        FROM replay_scenario_attempt_counters
        `,
      )
      .all()
      .map((row) => [
        row.scenario_fingerprint,
        Number(row.last_attempt_number),
      ]),
  );
  for (const row of replayAttemptRows) {
    const snapshot = parseJson(row.snapshot_json, null, {
      fieldName: "replay_sessions.snapshot_json",
      rowId: row.id,
      strict: true,
    });
    const identity = createReplayScenarioIdentity({
      snapshot,
      observationBars: row.observation_bars,
      gameLength: row.game_length,
      legacySessionId: row.id,
    });
    row.previous_scenario_fingerprint = row.scenario_fingerprint;
    row.identity_changed =
      row.scenario_fingerprint !== identity.fingerprint ||
      row.scenario_fingerprint_version !== identity.version;
    if (row.identity_changed) {
      db.prepare(
        `
        UPDATE replay_sessions
        SET
          scenario_fingerprint = ?,
          scenario_fingerprint_version = ?
        WHERE id = ?
        `,
      ).run(identity.fingerprint, identity.version, row.id);
    }
    row.scenario_fingerprint = identity.fingerprint;
    row.scenario_fingerprint_version = identity.version;
  }
  const attemptGroups = new Map();
  for (const row of replayAttemptRows) {
    const rows = attemptGroups.get(row.scenario_fingerprint) ?? [];
    rows.push(row);
    attemptGroups.set(row.scenario_fingerprint, rows);
  }
  for (const rows of attemptGroups.values()) {
    const requiresAttemptMigration = rows.some(
      (row) =>
        row.identity_changed ||
        row.attempt_number == null ||
        row.attempt_kind == null ||
        row.counts_toward_first_score == null,
    );
    if (!requiresAttemptMigration) {
      continue;
    }
    const previousFingerprintGroups = new Map();
    for (const row of rows) {
      const key =
        row.previous_scenario_fingerprint ||
        `missing:${row.id}`;
      const values = previousFingerprintGroups.get(key) ?? [];
      values.push(row);
      previousFingerprintGroups.set(key, values);
    }
    const historicalAttemptCount = Array.from(
      previousFingerprintGroups.entries(),
    ).reduce(
      (sum, [fingerprint, groupedRows]) =>
        sum +
        Math.max(
          groupedRows.length,
          Number(replayAttemptCounters.get(fingerprint) ?? 0),
        ),
      0,
    );
    const hadAttemptMetadata = rows.some(
      (row) =>
        row.attempt_number != null ||
        row.attempt_kind != null ||
        row.counts_toward_first_score != null,
    );
    const retainsFirstAttempt =
      rows.some((row) => Boolean(row.counts_toward_first_score)) ||
      !hadAttemptMetadata;
    const firstAttemptNumber = retainsFirstAttempt
      ? 1
      : Math.max(1, historicalAttemptCount - rows.length + 1);
    rows.forEach((row, index) => {
      const attemptNumber = firstAttemptNumber + index;
      const isFirst = retainsFirstAttempt && index === 0;
      db.prepare(
        `
        UPDATE replay_sessions
        SET
          attempt_number = ?,
          attempt_kind = ?,
          counts_toward_first_score = ?
        WHERE id = ?
        `,
      ).run(
        attemptNumber,
        isFirst ? "first" : "retrain",
        isFirst ? 1 : 0,
        row.id,
      );
      row.attempt_number = attemptNumber;
      row.attempt_kind = isFirst ? "first" : "retrain";
      row.counts_toward_first_score = isFirst ? 1 : 0;
    });
    const maximumAttemptNumber = Math.max(
      historicalAttemptCount,
      ...rows.map((row) => Number(row.attempt_number)),
    );
    const counterTimestamp =
      rows[rows.length - 1]?.created_at ?? new Date().toISOString();
    db.prepare(
      `
      INSERT INTO replay_scenario_attempt_counters (
        scenario_fingerprint,
        last_attempt_number,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(scenario_fingerprint) DO UPDATE SET
        last_attempt_number = MAX(
          replay_scenario_attempt_counters.last_attempt_number,
          excluded.last_attempt_number
        ),
        updated_at = excluded.updated_at
      `,
    ).run(
      rows[0].scenario_fingerprint,
      maximumAttemptNumber,
      rows[0].created_at ?? counterTimestamp,
      counterTimestamp,
    );
  }
  ensureColumn(
    db,
    "replay_sessions",
    "account_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  ensureColumn(
    db,
    "replay_sessions",
    "cost_config_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  ensureColumn(
    db,
    "replay_sessions",
    "training_config_json",
    `TEXT NOT NULL DEFAULT '{"mode":"free"}'`,
  );
  db.prepare(
    `
    UPDATE replay_sessions
    SET training_config_json = '{"mode":"free"}'
    WHERE training_config_json IS NULL OR training_config_json = ''
    `,
  ).run();
  db.prepare(
    `
    UPDATE replay_sessions
    SET account_json = ?
    WHERE account_json IS NULL OR account_json = '{}'
    `,
  ).run(
    JSON.stringify({
      initialCapital: 100000,
      cash: 100000,
      positionQuantity: 0,
      availableQuantity: 0,
      lockedQuantity: 0,
      averageCost: 0,
      realizedPnl: 0,
      totalFees: 0,
    }),
  );
  db.prepare(
    `
    UPDATE replay_sessions
    SET cost_config_json = ?
    WHERE cost_config_json IS NULL OR cost_config_json = '{}'
    `,
  ).run(
    JSON.stringify({
      commissionRate: 0.0003,
      minCommission: 5,
      stampTaxRate: 0.0005,
      transferFeeRate: 0.00001,
      slippageBps: 0,
    }),
  );
  ensureColumn(db, "replay_sessions", "scoring_config_json", "TEXT");
  const legacyScoringRows = db
    .prepare(
      `
      SELECT
        sessions.id,
        sessions.scoring_config_json,
        reviews.score_json
      FROM replay_sessions AS sessions
      LEFT JOIN replay_reviews AS reviews
        ON reviews.session_id = sessions.id
      WHERE sessions.scoring_config_json IS NULL
        OR sessions.scoring_config_json = ''
      `,
    )
    .all();
  for (const row of legacyScoringRows) {
    const storedScore = parseJson(row.score_json, null, {
      fieldName: "replay_reviews.score_json",
      rowId: row.id,
      strict: true,
    });
    const storedAlgorithmVersion = String(
      storedScore?.algorithmVersion ?? "",
    ).trim();
    const hasStoredWeights =
      storedScore?.weights &&
      typeof storedScore.weights === "object" &&
      !Array.isArray(storedScore.weights);
    let scoringConfig;
    if (!storedScore) {
      scoringConfig = {
        ...normalizeReplayScoringConfig(cloneReplayScoringConfig()),
        migration: {
          source: "legacy_session",
          weightsSource: "replay_score_v2_fixed",
          parametersSource: "replay_score_v2_fixed",
          settlement: "pending",
        },
      };
    } else if (storedAlgorithmVersion === REPLAY_SCORE_V2) {
      const recoveredConfig = normalizeReplayScoringConfig({
        algorithmVersion: REPLAY_SCORE_V2,
        weights: hasStoredWeights
          ? storedScore.weights
          : CURRENT_REPLAY_SCORING_CONFIG.weights,
        parameters: CURRENT_REPLAY_SCORING_CONFIG.parameters,
      });
      scoringConfig = {
        ...recoveredConfig,
        migration: {
          source: "legacy_score_card",
          weightsSource: hasStoredWeights
            ? "score_card"
            : "replay_score_v2_fixed",
          parametersSource: "replay_score_v2_fixed",
          settlement: "existing_replay_score_v2",
        },
      };
    } else {
      scoringConfig = {
        algorithmVersion:
          storedAlgorithmVersion || "legacy-unversioned-score",
        ...(hasStoredWeights
          ? { weights: storedScore.weights }
          : {}),
        migration: {
          source: "legacy_score_card",
          weightsSource: hasStoredWeights
            ? "score_card"
            : "unavailable",
          parametersSource: "unavailable",
          settlement: "historical_score_only",
        },
      };
    }
    db.prepare(
      `
      UPDATE replay_sessions
      SET scoring_config_json = ?
      WHERE id = ?
        AND (
          scoring_config_json IS NULL
          OR scoring_config_json = ''
        )
      `,
    ).run(JSON.stringify(scoringConfig), row.id);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS replay_sessions_scoring_config_immutable
    BEFORE UPDATE OF scoring_config_json ON replay_sessions
    WHEN OLD.scoring_config_json IS NOT NULL
      AND OLD.scoring_config_json != ''
      AND NEW.scoring_config_json IS NOT OLD.scoring_config_json
    BEGIN
      SELECT RAISE(ABORT, 'replay scoring configuration is immutable');
    END;
  `);
  ensureColumn(
    db,
    "replay_review_drafts",
    "revision",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(db, "replay_review_drafts", "deleted_at", "TEXT");
  ensureColumn(db, "replay_orders", "decision_json", "TEXT");
  db.prepare(
    `
    UPDATE replay_review_drafts
    SET revision = 0
    WHERE revision IS NULL
    `,
  ).run();

  const replayPlaybookSeededAt = new Date().toISOString();
  const shaofuPlaybookContent = [
    "定位：本决策台不负责少妇战法选股；信号以通达信中已确认的少妇 / B1 条件为准。本台只用于历史盲测、模拟与实盘记录。",
    "适用前提：只做日线右侧的已确认信号；先排除明显高位出货、左侧抄底和大盘系统性走弱。",
    "入场核对：前期有强势异动；回调靠近你的白线或黄线防守位；量能没有异常放大；当天或次日出现止跌、缩量一致或向上拐头的确认。",
    "执行：每笔记录必须写清信号类型、入场理由、防守价、仓位和次日不及预期的处理；白线 / 黄线失守或确认失败时按原计划退出。",
    "边界：指标只负责缩小观察范围，不能代替看图和风险判断；不因历史案例好看而跳过止损与仓位纪律。",
  ].join("\n");
  for (const seed of [
    {
      id: "replay-playbook-longtou",
      versionId: "replay-playbook-longtou-v1",
      name: "龙头战法",
    },
    {
      id: "replay-playbook-shaofu",
      versionId: "replay-playbook-shaofu-v1",
      name: "少妇战法",
      content: shaofuPlaybookContent,
      changeSummary: "首个可执行版本",
    },
  ]) {
    db.prepare(
      `
      INSERT OR IGNORE INTO replay_playbooks (
        id,
        name,
        current_version_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      `,
    ).run(
      seed.id,
      seed.name,
      seed.versionId,
      replayPlaybookSeededAt,
      replayPlaybookSeededAt,
    );
    db.prepare(
      `
      INSERT OR IGNORE INTO replay_playbook_versions (
        id,
        playbook_id,
        version_number,
        content,
        change_summary,
        source_candidate_id,
        created_at
      ) VALUES (?, ?, 1, ?, ?, NULL, ?)
      `,
    ).run(
      seed.versionId,
      seed.id,
      seed.content ?? "",
      seed.changeSummary ?? "默认空白模板",
      replayPlaybookSeededAt,
    );
    db.prepare(
      `
      UPDATE replay_playbooks
      SET current_version_id = ?
      WHERE id = ?
        AND current_version_id IS NULL
      `,
    ).run(seed.versionId, seed.id);
  }
  const currentShaofuVersion = db.prepare(
    `
    SELECT versions.id, versions.version_number, versions.content
    FROM replay_playbooks AS playbooks
    INNER JOIN replay_playbook_versions AS versions
      ON versions.id = playbooks.current_version_id
    WHERE playbooks.id = 'replay-playbook-shaofu'
    `,
  ).get();
  if (currentShaofuVersion && !String(currentShaofuVersion.content ?? "").trim()) {
    const nextVersionNumber = Number(currentShaofuVersion.version_number) + 1;
    const nextVersionId = `replay-playbook-shaofu-v${nextVersionNumber}`;
    db.prepare(
      `
      INSERT INTO replay_playbook_versions (
        id,
        playbook_id,
        version_number,
        content,
        change_summary,
        source_candidate_id,
        created_at
      ) VALUES (?, 'replay-playbook-shaofu', ?, ?, '补齐首个可执行版本，保留旧空白模板', NULL, ?)
      `,
    ).run(nextVersionId, nextVersionNumber, shaofuPlaybookContent, replayPlaybookSeededAt);
    db.prepare(
      `
      UPDATE replay_playbooks
      SET current_version_id = ?, updated_at = ?
      WHERE id = 'replay-playbook-shaofu'
      `,
    ).run(nextVersionId, replayPlaybookSeededAt);
  }

  function replaceRunTags(runId, tags) {
    const normalizedTags = normalizeTagList(tags);
    db.prepare(
      `
      DELETE FROM backtest_run_tags
      WHERE run_id = ?
    `,
    ).run(runId);
    if (!normalizedTags.length) {
      return;
    }
    db.prepare(
      `
      INSERT INTO backtest_run_tags (run_id, tag)
      VALUES (?, ?)
    `,
    ).run(runId, normalizedTags[0]);
    for (const tag of normalizedTags.slice(1)) {
      db.prepare(
        `
        INSERT INTO backtest_run_tags (run_id, tag)
        VALUES (?, ?)
      `,
      ).run(runId, tag);
    }
  }

  function replaceTaskTags(taskId, tags) {
    const normalizedTags = normalizeTagList(tags);
    db.prepare(
      `
      DELETE FROM analysis_task_tags
      WHERE task_id = ?
    `,
    ).run(taskId);
    if (!normalizedTags.length) {
      return;
    }
    db.prepare(
      `
      INSERT INTO analysis_task_tags (task_id, tag)
      VALUES (?, ?)
    `,
    ).run(taskId, normalizedTags[0]);
    for (const tag of normalizedTags.slice(1)) {
      db.prepare(
        `
        INSERT INTO analysis_task_tags (task_id, tag)
        VALUES (?, ?)
      `,
      ).run(taskId, tag);
    }
  }

  function backfillTagTables() {
    const runRows = db
      .prepare(
        `
      SELECT id, tags_json
      FROM backtest_runs
    `,
      )
      .all();
    for (const row of runRows) {
      replaceRunTags(
        row.id,
        parseJson(row.tags_json, [], {
          fieldName: "backtest_runs.tags_json",
          rowId: row.id,
          strict: false,
        }),
      );
    }

    const taskRows = db
      .prepare(
        `
      SELECT id, tags_json
      FROM analysis_tasks
    `,
      )
      .all();
    for (const row of taskRows) {
      replaceTaskTags(
        row.id,
        parseJson(row.tags_json, [], {
          fieldName: "analysis_tasks.tags_json",
          rowId: row.id,
          strict: false,
        }),
      );
    }
  }

  backfillTagTables();

  function readReplayAction(sessionId, actionId) {
    const row = db
      .prepare(
        `
        SELECT *
        FROM replay_events
        WHERE session_id = ? AND action_id = ?
        `,
      )
      .get(sessionId, actionId);
    if (!row) {
      return null;
    }
    return {
      eventType: row.event_type,
      payload: parseJson(row.payload_json, {}, {
        fieldName: "replay_events.payload_json",
        rowId: row.id,
        strict: true,
      }),
    };
  }

  function assertReplayActionMatches(existing, eventType, requestPayload) {
    if (
      existing.eventType !== eventType ||
      JSON.stringify(existing.payload?.request ?? null) !==
        JSON.stringify(requestPayload)
    ) {
      throw createReplayStateError("actionId 已被其他操作使用", 409);
    }
  }

  function insertReplayEvent({
    sessionId,
    actionId,
    eventType,
    sequence,
    payload,
    createdAt,
  }) {
    db.prepare(
      `
      INSERT INTO replay_events (
        id,
        session_id,
        action_id,
        event_type,
        sequence,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      randomUUID(),
      sessionId,
      actionId,
      eventType,
      sequence,
      JSON.stringify(payload),
      createdAt,
    );
  }

  function readReplayOrders(sessionId) {
    const orders = db
      .prepare(
        `
        SELECT *
        FROM replay_orders
        WHERE session_id = ?
        ORDER BY created_revision ASC
        `,
      )
      .all(sessionId);
    const fills = db
      .prepare(
        `
        SELECT *
        FROM replay_fills
        WHERE session_id = ?
        ORDER BY sequence ASC, rowid ASC
        `,
      )
      .all(sessionId);
    const rejections = db
      .prepare(
        `
        SELECT *
        FROM replay_order_rejections
        WHERE session_id = ?
        ORDER BY sequence ASC, rowid ASC
        `,
      )
      .all(sessionId);
    const fillsByOrderId = new Map(fills.map((fill) => [fill.order_id, fill]));
    const rejectionsByOrderId = new Map(
      rejections.map((rejection) => [rejection.order_id, rejection]),
    );
    const pendingOrders = [];
    const executions = [];
    for (const order of orders) {
      const common = {
        orderId: order.id,
        side: order.side,
        quantityType: order.quantity_type,
        requestedQuantity:
          order.requested_quantity == null
            ? null
            : Number(order.requested_quantity),
        ratio: order.ratio == null ? null : Number(order.ratio),
        decision: parseJson(order.decision_json, null, {
          fieldName: "replay_orders.decision_json",
          rowId: order.id,
          strict: true,
        }),
        submittedSequence: Number(order.submitted_sequence),
        scheduledSequence: Number(order.scheduled_sequence),
      };
      const fill = fillsByOrderId.get(order.id);
      if (fill) {
        executions.push({
          ...common,
          status: "filled",
          sequence: Number(fill.sequence),
          quantity: Number(fill.quantity),
          referencePrice: Number(fill.reference_price),
          price: Number(fill.price),
          slippageBps: Number(fill.slippage_bps),
          notional: Number(fill.notional),
          commission: Number(fill.commission),
          stampTax: Number(fill.stamp_tax),
          transferFee: Number(fill.transfer_fee),
          totalFee: Number(fill.total_fee),
        });
        continue;
      }
      const rejection = rejectionsByOrderId.get(order.id);
      if (rejection) {
        executions.push({
          ...common,
          status:
            rejection.reason_code === "session_finished_early"
              ? "cancelled"
              : "rejected",
          sequence: Number(rejection.sequence),
          reasonCode: rejection.reason_code,
          reasonMessage: rejection.reason_message,
        });
        continue;
      }
      pendingOrders.push(common);
    }
    return {
      pendingOrders,
      executions,
    };
  }

  function readReplayReview(sessionId) {
    const row = db
      .prepare("SELECT * FROM replay_reviews WHERE session_id = ?")
      .get(sessionId);
    return rowToReplayReview(row);
  }

  function readReplayReviewCorrections(sessionId) {
    return db
      .prepare(
        `
        SELECT *
        FROM replay_review_corrections
        WHERE session_id = ?
        ORDER BY created_at ASC, stage ASC, revision_number ASC
        `,
      )
      .all(sessionId)
      .map(rowToReplayReviewCorrection);
  }

  function readReplayReviewDrafts(sessionId) {
    const rows = db
      .prepare(
        `
        SELECT *
        FROM replay_review_drafts
        WHERE session_id = ?
        `,
      )
      .all(sessionId);
    const drafts = { blind: null, post: null };
    for (const row of rows) {
      drafts[row.stage] = rowToReplayReviewDraft(row);
    }
    return drafts;
  }

  function readReplaySession(sessionId) {
    const row = db
      .prepare(
        "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
      )
      .get(sessionId);
    const session = rowToReplaySession(row);
    if (!session) {
      return null;
    }
    const hydrated = {
      ...session,
      ...readReplayOrders(sessionId),
      review: readReplayReview(sessionId),
      corrections: readReplayReviewCorrections(sessionId),
      reviewDrafts: readReplayReviewDrafts(sessionId),
    };
    return hydrated;
  }

  function reserveReplayAttempt(scenarioFingerprint, now) {
    return Number(
      db.prepare(
        `
        INSERT INTO replay_scenario_attempt_counters (
          scenario_fingerprint,
          last_attempt_number,
          created_at,
          updated_at
        ) VALUES (?, 1, ?, ?)
        ON CONFLICT(scenario_fingerprint) DO UPDATE SET
          last_attempt_number =
            replay_scenario_attempt_counters.last_attempt_number + 1,
          updated_at = excluded.updated_at
        RETURNING last_attempt_number
        `,
      ).get(scenarioFingerprint, now, now)?.last_attempt_number ?? 1,
    );
  }

  function readReplayPlaybook(playbookId) {
    return rowToReplayPlaybook(
      db
        .prepare(
          "SELECT * FROM replay_playbooks WHERE id = ? AND deleted_at IS NULL",
        )
        .get(playbookId),
    );
  }

  function readReplayPlaybookVersion(versionId) {
    return rowToReplayPlaybookVersion(
      db
        .prepare("SELECT * FROM replay_playbook_versions WHERE id = ?")
        .get(versionId),
    );
  }

  function readReplayPlaybookCandidate(candidateId) {
    return rowToReplayPlaybookCandidate(
      db
        .prepare("SELECT * FROM replay_playbook_candidates WHERE id = ?")
        .get(candidateId),
    );
  }

  function rejectReplayOrder(order, sequence, reasonCode, reasonMessage, now) {
    db.prepare(
      `
      INSERT INTO replay_order_rejections (
        id,
        session_id,
        order_id,
        sequence,
        reason_code,
        reason_message,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      randomUUID(),
      order.session_id,
      order.id,
      sequence,
      reasonCode,
      reasonMessage,
      now,
    );
  }

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    },

    getDecisionExecutionSettings() {
      const row = db
        .prepare("SELECT * FROM decision_execution_settings WHERE id = 1")
        .get();
      return {
        simulatedAccountEquity: row?.simulated_account_equity ?? null,
        liveAccountEquity: row?.live_account_equity ?? null,
        defaultMinRewardRiskRatio: row?.default_min_reward_risk_ratio ?? 2,
        defaultMaxAccountRiskPct: row?.default_max_account_risk_pct ?? 0.5,
        lotSize: row?.lot_size ?? 100,
      };
    },

    saveDecisionExecutionSettings(settings) {
      const updatedAt = new Date().toISOString();
      db.prepare(
        `
        INSERT INTO decision_execution_settings (
          id,
          simulated_account_equity,
          live_account_equity,
          default_min_reward_risk_ratio,
          default_max_account_risk_pct,
          lot_size,
          updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          simulated_account_equity = excluded.simulated_account_equity,
          live_account_equity = excluded.live_account_equity,
          default_min_reward_risk_ratio = excluded.default_min_reward_risk_ratio,
          default_max_account_risk_pct = excluded.default_max_account_risk_pct,
          lot_size = excluded.lot_size,
          updated_at = excluded.updated_at
        `,
      ).run(
        settings.simulatedAccountEquity,
        settings.liveAccountEquity,
        settings.defaultMinRewardRiskRatio,
        settings.defaultMaxAccountRiskPct,
        settings.lotSize,
        updatedAt,
      );
      return this.getDecisionExecutionSettings();
    },

    saveDecisionAnalysisSnapshot(snapshot) {
      const now = snapshot.updatedAt ?? new Date().toISOString();
      const id = snapshot.id ?? randomUUID();
      const createdAt = snapshot.createdAt ?? now;
      db.prepare(
        `
        INSERT INTO decision_analysis_snapshots (
          id,
          analysis_type,
          analysis_date,
          source_key,
          stock_code,
          stock_name,
          title,
          summary_json,
          payload_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(analysis_type, analysis_date, source_key)
        DO UPDATE SET
          stock_code = excluded.stock_code,
          stock_name = excluded.stock_name,
          title = excluded.title,
          summary_json = excluded.summary_json,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        snapshot.analysisType,
        snapshot.analysisDate,
        snapshot.sourceKey,
        snapshot.stockCode ?? null,
        snapshot.stockName ?? null,
        snapshot.title,
        snapshot.summary ? JSON.stringify(snapshot.summary) : null,
        JSON.stringify(snapshot.payload ?? {}),
        createdAt,
        now,
      );
      return this.findDecisionAnalysisSnapshot(
        snapshot.analysisType,
        snapshot.analysisDate,
        snapshot.sourceKey,
      );
    },

    findDecisionAnalysisSnapshot(analysisType, analysisDate, sourceKey) {
      const row = db
        .prepare(
          `
          SELECT *
          FROM decision_analysis_snapshots
          WHERE analysis_type = ?
            AND analysis_date = ?
            AND source_key = ?
        `,
        )
        .get(analysisType, analysisDate, sourceKey);
      return rowToDecisionAnalysisSnapshot(row);
    },

    listDecisionAnalysisSnapshots({ analysisType, sourceKey, limit = 5 }) {
      const normalizedLimit = Math.max(1, Math.min(30, Math.floor(Number(limit) || 5)));
      const rows = db
        .prepare(
          `
          SELECT *
          FROM decision_analysis_snapshots
          WHERE analysis_type = ?
            AND source_key = ?
          ORDER BY analysis_date DESC
          LIMIT ?
        `,
        )
        .all(analysisType, sourceKey, normalizedLimit);
      return rows.map(rowToDecisionAnalysisSnapshot);
    },

    createStockQueryRecord(record) {
      const createdAt = record.createdAt ?? new Date().toISOString();
      const id = record.id ?? randomUUID();
      db.prepare(
        `
        INSERT INTO stock_query_records (
          id,
          query_date,
          stock_code,
          stock_name,
          input_text,
          analysis_date,
          action,
          technical_score,
          opportunity_score,
          summary_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        record.queryDate,
        record.stockCode,
        record.stockName,
        record.inputText ?? "",
        record.analysisDate ?? null,
        record.action ?? null,
        record.technicalScore ?? null,
        record.opportunityScore ?? null,
        record.summary ? JSON.stringify(record.summary) : null,
        createdAt,
      );
      const row = db
        .prepare(
          `
          SELECT *
          FROM stock_query_records
          WHERE id = ?
        `,
        )
        .get(id);
      return rowToStockQueryRecord(row);
    },

    queryStockQueryRecords(filters = {}, options = {}) {
      const clauses = [];
      const values = [];
      if (filters.queryDate) {
        clauses.push("query_date = ?");
        values.push(String(filters.queryDate).trim());
      }
      if (filters.stockCode) {
        clauses.push("stock_code = ?");
        values.push(String(filters.stockCode).trim());
      }
      if (filters.keyword) {
        clauses.push("(stock_code LIKE ? OR stock_name LIKE ? OR input_text LIKE ? OR summary_json LIKE ?)");
        const keyword = `%${String(filters.keyword).trim()}%`;
        values.push(keyword, keyword, keyword, keyword);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const pagination = normalizePaginationOptions(options, {
        page: 1,
        pageSize: 50,
        maxPageSize: 300,
      });
      const totalRow = db
        .prepare(
          `
          SELECT COUNT(*) AS total
          FROM stock_query_records
          ${where}
        `,
        )
        .get(...values);
      const rows = db
        .prepare(
          `
          SELECT *
          FROM stock_query_records
          ${where}
          ORDER BY query_date DESC, created_at DESC
          LIMIT ?
          OFFSET ?
        `,
        )
        .all(...values, pagination.pageSize, pagination.offset);
      return {
        items: rows.map(rowToStockQueryRecord),
        total: Number(totalRow?.total ?? 0),
        page: pagination.page,
        pageSize: pagination.pageSize,
      };
    },

    deleteStockQueryRecord(recordId) {
      const result = db
        .prepare("DELETE FROM stock_query_records WHERE id = ?")
        .run(String(recordId ?? "").trim());
      return result.changes > 0;
    },

    saveParameterSet(parameterSet) {
      const statement = db.prepare(`
        INSERT INTO parameter_sets (
          id,
          strategy_id,
          name,
          params_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      statement.run(
        parameterSet.id,
        parameterSet.strategyId,
        parameterSet.name,
        JSON.stringify(parameterSet.params),
        parameterSet.createdAt,
        parameterSet.updatedAt,
      );
      return this.getParameterSet(parameterSet.id);
    },

    listParameterSets() {
      const rows = db
        .prepare(
          `
          SELECT *
          FROM parameter_sets
          ORDER BY updated_at DESC
        `,
        )
        .all();
      return rows.map(rowToParameterSet);
    },

    getParameterSet(id) {
      const row = db
        .prepare(
          `
          SELECT *
          FROM parameter_sets
          WHERE id = ?
        `,
        )
        .get(id);
      return rowToParameterSet(row);
    },

    createRun(run) {
      const normalizedTags = normalizeTagList(run.tags);
      db.prepare(
        `
        INSERT INTO backtest_runs (
          id,
          title,
          strategy_id,
          parameter_set_id,
          symbol,
          exchange,
          interval,
          start_date,
          end_date,
          capital,
          slippage,
          rate,
          status,
          error_message,
          summary_json,
          artifacts_json,
          request_json,
          strategy_version_id,
          tags_json,
          notes,
          starred,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        run.id,
        run.title ?? "",
        run.strategyId,
        run.parameterSetId,
        run.symbol,
        run.exchange,
        run.interval,
        run.startDate,
        run.endDate,
        run.capital,
        run.slippage,
        run.rate,
        run.status,
        run.errorMessage ?? null,
        run.summary ? JSON.stringify(run.summary) : null,
        run.artifacts ? JSON.stringify(run.artifacts) : null,
        run.request ? JSON.stringify(run.request) : null,
        run.strategyVersionId ?? null,
        JSON.stringify(normalizedTags),
        run.notes ?? "",
        run.starred ? 1 : 0,
        run.createdAt,
        run.updatedAt,
      );
      replaceRunTags(run.id, normalizedTags);
      return this.getRun(run.id);
    },

    updateRun(runId, patch) {
      const current = this.getRun(runId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        ...patch,
      };
      const normalizedTags = normalizeTagList(next.tags);
      db.prepare(
        `
        UPDATE backtest_runs
        SET
          title = ?,
          symbol = ?,
          exchange = ?,
          interval = ?,
          start_date = ?,
          end_date = ?,
          capital = ?,
          slippage = ?,
          rate = ?,
          status = ?,
          error_message = ?,
          summary_json = ?,
          artifacts_json = ?,
          request_json = ?,
          strategy_version_id = ?,
          tags_json = ?,
          notes = ?,
          starred = ?,
          updated_at = ?
        WHERE id = ?
      `,
      ).run(
        next.title ?? "",
        next.symbol,
        next.exchange,
        next.interval,
        next.startDate,
        next.endDate,
        next.capital,
        next.slippage,
        next.rate,
        next.status,
        next.errorMessage ?? null,
        next.summary ? JSON.stringify(next.summary) : null,
        next.artifacts ? JSON.stringify(next.artifacts) : null,
        next.request ? JSON.stringify(next.request) : null,
        next.strategyVersionId ?? null,
        JSON.stringify(normalizedTags),
        next.notes ?? "",
        next.starred ? 1 : 0,
        next.updatedAt,
        runId,
      );
      replaceRunTags(runId, normalizedTags);
      return this.getRun(runId);
    },

    queryRuns(filters = {}, options = {}) {
      const clauses = [];
      const values = [];
      const tagFilter = buildTagFilterSql({
        filterTag: filters.tag,
        tableAlias: "backtest_runs",
        tagTableName: "backtest_run_tags",
        idColumn: "run_id",
      });

      if (filters.status) {
        clauses.push("status = ?");
        values.push(filters.status);
      }
      if (filters.strategyId) {
        clauses.push("strategy_id = ?");
        values.push(filters.strategyId);
      }
      if (filters.starred === true) {
        clauses.push("starred = 1");
      }
      if (filters.keyword) {
        clauses.push(`(
          title LIKE ?
          OR strategy_id LIKE ?
          OR symbol LIKE ?
          OR notes LIKE ?
          OR EXISTS (
            SELECT 1
            FROM backtest_run_tags AS backtest_run_tags_keyword
            WHERE backtest_run_tags_keyword.run_id = backtest_runs.id
              AND backtest_run_tags_keyword.tag LIKE ?
          )
        )`);
        const keyword = `%${String(filters.keyword).trim()}%`;
        values.push(keyword, keyword, keyword, keyword, keyword);
      }
      if (tagFilter.whereSql) {
        clauses.push(tagFilter.whereSql);
        values.push(...tagFilter.values);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const pagination = normalizePaginationOptions(options, {
        page: 1,
        pageSize: 20,
        maxPageSize: 200,
      });
      const totalRow = db
        .prepare(
          `
          SELECT COUNT(*) AS total
          FROM backtest_runs
          ${tagFilter.joinSql}
          ${where}
        `,
        )
        .get(...values);
      const rows = db
        .prepare(
          `
          SELECT *
          FROM backtest_runs
          ${tagFilter.joinSql}
          ${where}
          ORDER BY created_at DESC
          LIMIT ?
          OFFSET ?
        `,
        )
        .all(...values, pagination.pageSize, pagination.offset);
      return {
        items: rows.map(rowToRun),
        total: Number(totalRow?.total ?? 0),
        page: pagination.page,
        pageSize: pagination.pageSize,
      };
    },

    listRuns(filters = {}) {
      const clauses = [];
      const values = [];
      const tagFilter = buildTagFilterSql({
        filterTag: filters.tag,
        tableAlias: "backtest_runs",
        tagTableName: "backtest_run_tags",
        idColumn: "run_id",
      });

      if (filters.status) {
        clauses.push("status = ?");
        values.push(filters.status);
      }
      if (filters.strategyId) {
        clauses.push("strategy_id = ?");
        values.push(filters.strategyId);
      }
      if (filters.starred === true) {
        clauses.push("starred = 1");
      }
      if (filters.keyword) {
        clauses.push(`(
          title LIKE ?
          OR strategy_id LIKE ?
          OR symbol LIKE ?
          OR notes LIKE ?
          OR EXISTS (
            SELECT 1
            FROM backtest_run_tags AS backtest_run_tags_keyword
            WHERE backtest_run_tags_keyword.run_id = backtest_runs.id
              AND backtest_run_tags_keyword.tag LIKE ?
          )
        )`);
        const keyword = `%${String(filters.keyword).trim()}%`;
        values.push(keyword, keyword, keyword, keyword, keyword);
      }
      if (tagFilter.whereSql) {
        clauses.push(tagFilter.whereSql);
        values.push(...tagFilter.values);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `
          SELECT *
          FROM backtest_runs
          ${tagFilter.joinSql}
          ${where}
          ORDER BY created_at DESC
        `,
        )
        .all(...values);
      return rows.map(rowToRun);
    },

    listRecentRunSummaries(limit = 5) {
      const normalizedLimit = Math.max(
        1,
        Math.min(Number.parseInt(limit, 10) || 5, 20),
      );
      const rows = db
        .prepare(
          `
          SELECT
            id,
            title,
            strategy_id,
            parameter_set_id,
            symbol,
            exchange,
            interval,
            start_date,
            end_date,
            capital,
            slippage,
            rate,
            status,
            error_message,
            summary_json,
            strategy_version_id,
            tags_json,
            notes,
            starred,
            created_at,
            updated_at
          FROM backtest_runs
          ORDER BY created_at DESC
          LIMIT ?
        `,
        )
        .all(normalizedLimit);
      return rows.map(rowToRunSummary);
    },

    getReplayScenarioUsage() {
      const rows = db.prepare(
        `
        SELECT snapshot_json
        FROM replay_sessions
        ORDER BY created_at DESC
        `,
      ).all();
      const usedTsCodes = new Set();
      const recentWindowEndDates = [];
      for (const row of rows) {
        try {
          const snapshot = JSON.parse(row.snapshot_json || "{}");
          const tsCode = String(snapshot.tsCode || "").trim().toUpperCase();
          if (tsCode) usedTsCodes.add(tsCode);
          const bars = Array.isArray(snapshot.bars) ? snapshot.bars : [];
          const endDate = String(bars.at(-1)?.tradeDate || "").slice(0, 10);
          if (endDate && recentWindowEndDates.length < 12) {
            recentWindowEndDates.push(endDate);
          }
        } catch {
          // Legacy or damaged snapshots cannot participate in novelty scheduling.
        }
      }
      return {
        usedTsCodes: [...usedTsCodes],
        recentWindowEndDates,
      };
    },

    createReplaySession(session) {
      const scenarioIdentity = createReplayScenarioIdentity({
        snapshot: session.snapshot,
        observationBars: session.observationBars,
        gameLength: session.gameLength,
      });
      const scoringConfig = normalizeReplayScoringConfig(
        session.scoringConfig ?? cloneReplayScoringConfig(),
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        const attemptNumber = reserveReplayAttempt(
          scenarioIdentity.fingerprint,
          session.createdAt,
        );
        const isFirst = attemptNumber === 1;
        db.prepare(
        `
        INSERT INTO replay_sessions (
          id,
          source_data_version,
          game_length,
        observation_bars,
        revealed_future_bars,
        status,
        revision,
        snapshot_json,
          account_json,
          cost_config_json,
          training_config_json,
          scoring_config_json,
          scenario_fingerprint,
          scenario_fingerprint_version,
          attempt_number,
        attempt_kind,
        counts_toward_first_score,
        source_session_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
        session.id,
        session.sourceDataVersion,
        session.gameLength,
        session.observationBars,
        session.revealedFutureBars,
        session.status,
        session.revision,
        JSON.stringify(session.snapshot),
        JSON.stringify(session.account),
        JSON.stringify(session.costConfig),
        JSON.stringify(session.trainingConfig ?? { mode: "free" }),
        JSON.stringify(scoringConfig),
        scenarioIdentity.fingerprint,
        scenarioIdentity.version,
        attemptNumber,
        isFirst ? "first" : "retrain",
        isFirst ? 1 : 0,
        null,
        session.createdAt,
        session.updatedAt,
        );
        const created = readReplaySession(session.id);
        db.exec("COMMIT");
        return created;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    retrainReplaySession({ sourceSessionId, id, createdAt }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const sourceRow = db
          .prepare(
            "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
          )
          .get(sourceSessionId);
        if (!sourceRow) {
          db.exec("COMMIT");
          return null;
        }
        const source = rowToReplaySession(sourceRow);
        if (!source.revealedAt) {
          throw createReplayStateError(
            "原演练尚未揭晓，不能使用该场景复练",
            409,
          );
        }
        const attemptNumber = reserveReplayAttempt(
          source.scenarioFingerprint,
          createdAt,
        );
        const initialCapital = Number(source.account?.initialCapital ?? 100000);
        const scoringConfig = normalizeReplayScoringConfig(
          source.scoringConfig,
        );
        const account = {
          initialCapital,
          cash: initialCapital,
          positionQuantity: 0,
          availableQuantity: 0,
          lockedQuantity: 0,
          averageCost: 0,
          realizedPnl: 0,
          totalFees: 0,
        };
        db.prepare(
          `
          INSERT INTO replay_sessions (
            id,
            source_data_version,
            game_length,
            observation_bars,
            revealed_future_bars,
            status,
            revision,
            snapshot_json,
            account_json,
            cost_config_json,
            training_config_json,
            scoring_config_json,
            scenario_fingerprint,
            scenario_fingerprint_version,
            attempt_number,
            attempt_kind,
            counts_toward_first_score,
            source_session_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, 0, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, 'retrain', 0, ?, ?, ?)
          `,
        ).run(
          id,
          source.sourceDataVersion,
          source.gameLength,
          source.observationBars,
          JSON.stringify(source.snapshot),
          JSON.stringify(account),
          JSON.stringify(source.costConfig),
          JSON.stringify(source.trainingConfig),
          JSON.stringify(scoringConfig),
          source.scenarioFingerprint,
          source.scenarioFingerprintVersion,
          attemptNumber,
          sourceSessionId,
          createdAt,
          createdAt,
        );
        const created = readReplaySession(id);
        db.exec("COMMIT");
        return created;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    getReplaySession(sessionId) {
      return readReplaySession(sessionId);
    },

    deleteReplaySession(sessionId, deletedAt) {
      const result = db
        .prepare(
          `
          UPDATE replay_sessions
          SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
          `,
        )
        .run(deletedAt, deletedAt, sessionId);
      return Number(result.changes ?? 0) === 1;
    },

    saveReplayReviewDraft({
      sessionId,
      stage,
      draft,
      expectedRevision,
      updatedAt,
    }) {
      const normalizedExpectedRevision =
        normalizeExpectedReplayDraftRevision(expectedRevision);
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = readReplaySession(sessionId);
        if (!current) {
          db.exec("COMMIT");
          return null;
        }
        if (stage === "blind") {
          if (current.revealedAt) {
            throw createReplayStateError(
              "答案已揭晓，不能保存盲评草稿",
              409,
            );
          }
          if (current.review.blindReview) {
            throw createReplayStateError(
              "首次盲评已经保存，不能再保存草稿",
              409,
            );
          }
        } else {
          if (!current.revealedAt) {
            throw createReplayStateError(
              "请先揭晓答案再保存事后复盘草稿",
              409,
            );
          }
          if (current.review.postReview) {
            throw createReplayStateError(
              "首次事后复盘已经保存，不能再保存草稿",
              409,
            );
          }
        }
        const currentDraftRow = db
          .prepare(
            `
            SELECT revision
            FROM replay_review_drafts
            WHERE session_id = ? AND stage = ?
            `,
          )
          .get(sessionId, stage);
        const currentDraftRevision = Number(
          currentDraftRow?.revision ?? 0,
        );
        if (currentDraftRevision !== normalizedExpectedRevision) {
          throw createReplayStateError(
            `草稿版本冲突，当前 revision 为 ${currentDraftRevision}`,
            409,
          );
        }
        const nextDraftRevision = currentDraftRevision + 1;
        const result = db.prepare(
          `
          INSERT INTO replay_review_drafts (
            session_id,
            stage,
            draft_json,
            revision,
            updated_at,
            deleted_at
          ) VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT(session_id, stage) DO UPDATE SET
            draft_json = excluded.draft_json,
            revision = excluded.revision,
            updated_at = excluded.updated_at,
            deleted_at = NULL
          WHERE replay_review_drafts.revision = ?
          `,
        ).run(
          sessionId,
          stage,
          JSON.stringify(draft),
          nextDraftRevision,
          updatedAt,
          normalizedExpectedRevision,
        );
        if (Number(result.changes ?? 0) !== 1) {
          throw createReplayStateError(
            "草稿版本冲突，请刷新后继续编辑",
            409,
          );
        }
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return session;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    deleteReplayReviewDraft({
      sessionId,
      stage,
      expectedRevision,
      updatedAt,
    }) {
      const normalizedExpectedRevision =
        normalizeExpectedReplayDraftRevision(expectedRevision);
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = readReplaySession(sessionId);
        if (!current) {
          db.exec("COMMIT");
          return null;
        }
        if (stage === "blind") {
          if (current.revealedAt) {
            throw createReplayStateError(
              "答案已揭晓，不能删除盲评草稿",
              409,
            );
          }
          if (current.review.blindReview) {
            throw createReplayStateError(
              "首次盲评已经保存，草稿已结束",
              409,
            );
          }
        } else {
          if (!current.revealedAt) {
            throw createReplayStateError(
              "请先揭晓答案再删除事后复盘草稿",
              409,
            );
          }
          if (current.review.postReview) {
            throw createReplayStateError(
              "首次事后复盘已经保存，草稿已结束",
              409,
            );
          }
        }
        const currentDraftRow = db
          .prepare(
            `
            SELECT revision, deleted_at
            FROM replay_review_drafts
            WHERE session_id = ? AND stage = ?
            `,
          )
          .get(sessionId, stage);
        const currentDraftRevision = Number(
          currentDraftRow?.revision ?? 0,
        );
        if (currentDraftRevision !== normalizedExpectedRevision) {
          throw createReplayStateError(
            `草稿版本冲突，当前 revision 为 ${currentDraftRevision}`,
            409,
          );
        }
        if (!currentDraftRow) {
          const tombstoneRevision = 1;
          db.prepare(
            `
            INSERT INTO replay_review_drafts (
              session_id,
              stage,
              draft_json,
              revision,
              updated_at,
              deleted_at
            ) VALUES (?, ?, '{}', ?, ?, ?)
            `,
          ).run(
            sessionId,
            stage,
            tombstoneRevision,
            updatedAt,
            updatedAt,
          );
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            deleted: false,
            revision: tombstoneRevision,
            session,
          };
        }
        if (currentDraftRow.deleted_at) {
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            deleted: false,
            revision: currentDraftRevision,
            session,
          };
        }
        const nextDraftRevision = currentDraftRevision + 1;
        const result = db
          .prepare(
            `
            UPDATE replay_review_drafts
            SET
              draft_json = '{}',
              revision = ?,
              updated_at = ?,
              deleted_at = ?
            WHERE session_id = ?
              AND stage = ?
              AND revision = ?
              AND deleted_at IS NULL
            `,
          )
          .run(
            nextDraftRevision,
            updatedAt,
            updatedAt,
            sessionId,
            stage,
            normalizedExpectedRevision,
          );
        if (Number(result.changes ?? 0) !== 1) {
          throw createReplayStateError(
            "草稿版本冲突，请刷新后继续编辑",
            409,
          );
        }
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return {
          deleted: true,
          revision: nextDraftRevision,
          session,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listReplaySessions({ state, attemptKind, keyword, page, pageSize }) {
      const reviewStateSql = `
        CASE
          WHEN sessions.status = 'active' THEN 'active'
          WHEN sessions.completion_reason = 'no_opportunity' THEN 'skipped'
          WHEN sessions.revealed_at IS NULL
            AND reviews.blind_json IS NULL THEN 'awaiting_blind'
          WHEN sessions.revealed_at IS NULL THEN 'awaiting_reveal'
          WHEN reviews.post_json IS NULL THEN 'awaiting_post'
          ELSE 'reviewed'
        END
      `;
      const conditions = ["sessions.deleted_at IS NULL"];
      const parameters = [];
      const stateConditions = {
        active: "sessions.status = 'active'",
        skipped: "sessions.completion_reason = 'no_opportunity'",
        awaiting_blind: `
          sessions.status = 'completed'
          AND COALESCE(sessions.completion_reason, '') != 'no_opportunity'
          AND sessions.revealed_at IS NULL
          AND reviews.blind_json IS NULL
        `,
        awaiting_reveal: `
          sessions.status = 'completed'
          AND COALESCE(sessions.completion_reason, '') != 'no_opportunity'
          AND sessions.revealed_at IS NULL
          AND reviews.blind_json IS NOT NULL
        `,
        awaiting_post: `
          sessions.revealed_at IS NOT NULL
          AND reviews.post_json IS NULL
        `,
        reviewed: `
          sessions.revealed_at IS NOT NULL
          AND reviews.post_json IS NOT NULL
        `,
      };
      if (state !== "all") {
        conditions.push(stateConditions[state]);
      }
      if (attemptKind !== "all") {
        conditions.push("sessions.attempt_kind = ?");
        parameters.push(attemptKind);
      }
      if (keyword) {
        const pattern = `%${keyword}%`;
        conditions.push(
          `
          (
            sessions.id LIKE ?
            OR COALESCE(reviews.blind_json, '') LIKE ?
            OR (
              sessions.revealed_at IS NOT NULL
              AND COALESCE(reviews.post_json, '') LIKE ?
            )
            OR (
              sessions.revealed_at IS NOT NULL
              AND (
                COALESCE(json_extract(sessions.snapshot_json, '$.name'), '') LIKE ?
                OR COALESCE(json_extract(sessions.snapshot_json, '$.tsCode'), '') LIKE ?
                OR COALESCE(json_extract(sessions.snapshot_json, '$.symbol'), '') LIKE ?
              )
            )
          )
          `,
        );
        parameters.push(
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
        );
      }
      const whereSql = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";
      const total = Number(
        db.prepare(
          `
          SELECT COUNT(*) AS count
          FROM replay_sessions AS sessions
          LEFT JOIN replay_reviews AS reviews
            ON reviews.session_id = sessions.id
          ${whereSql}
          `,
        ).get(...parameters)?.count ?? 0,
      );
      const offset = (page - 1) * pageSize;
      const rows = db.prepare(
        `
        SELECT
          sessions.id,
          sessions.snapshot_json,
          sessions.game_length,
          COALESCE(json_extract(sessions.snapshot_json, '$.interval'), '1d') AS interval,
          sessions.revealed_future_bars,
          sessions.status,
          sessions.completion_reason,
          sessions.revealed_at,
          sessions.created_at,
          sessions.updated_at,
          sessions.training_config_json,
          sessions.attempt_number,
          sessions.attempt_kind,
          sessions.counts_toward_first_score,
          sessions.source_session_id,
          (
            SELECT COUNT(*)
            FROM replay_review_corrections AS corrections
            WHERE corrections.session_id = sessions.id
              AND corrections.stage = 'blind'
          ) AS blind_correction_count,
          (
            SELECT COUNT(*)
            FROM replay_review_corrections AS corrections
            WHERE corrections.session_id = sessions.id
              AND corrections.stage = 'post'
          ) AS post_correction_count,
          reviews.blind_json,
          reviews.post_json,
          reviews.score_json,
          ${reviewStateSql} AS review_state,
          CASE WHEN sessions.revealed_at IS NOT NULL
            THEN json_extract(sessions.snapshot_json, '$.tsCode')
          END AS ts_code,
          CASE WHEN sessions.revealed_at IS NOT NULL
            THEN json_extract(sessions.snapshot_json, '$.symbol')
          END AS symbol,
          CASE WHEN sessions.revealed_at IS NOT NULL
            THEN json_extract(sessions.snapshot_json, '$.exchange')
          END AS exchange,
          CASE WHEN sessions.revealed_at IS NOT NULL
            THEN json_extract(sessions.snapshot_json, '$.name')
          END AS name,
          CASE WHEN sessions.revealed_at IS NOT NULL
            THEN json_extract(sessions.snapshot_json, '$.bars[0].tradeDate')
          END AS start_date,
          CASE WHEN sessions.revealed_at IS NOT NULL
            THEN json_extract(
              sessions.snapshot_json,
              '$.bars['
                || (sessions.observation_bars + sessions.game_length - 1)
                || '].tradeDate'
            )
          END AS end_date
        FROM replay_sessions AS sessions
        LEFT JOIN replay_reviews AS reviews
          ON reviews.session_id = sessions.id
        ${whereSql}
        ORDER BY sessions.updated_at DESC, sessions.id DESC
        LIMIT ? OFFSET ?
        `,
      ).all(...parameters, pageSize, offset);
      return {
        items: rows.map(rowToReplayHistoryItem),
        total,
        page,
        pageSize,
      };
    },

    listReplayPlaybooks() {
      const rows = db
        .prepare(
          `
          SELECT
            playbooks.*,
            versions.id AS version_id,
            versions.playbook_id AS version_playbook_id,
            versions.version_number,
            versions.content,
            versions.change_summary,
            versions.source_candidate_id,
            versions.created_at AS version_created_at,
            COUNT(
              CASE WHEN candidates.state = 'pending' THEN 1 END
            ) AS pending_candidate_count
          FROM replay_playbooks AS playbooks
          LEFT JOIN replay_playbook_versions AS versions
            ON versions.id = playbooks.current_version_id
          LEFT JOIN replay_playbook_candidates AS candidates
            ON candidates.playbook_id = playbooks.id
          WHERE playbooks.deleted_at IS NULL
          GROUP BY playbooks.id
          ORDER BY playbooks.created_at ASC, playbooks.id ASC
          `,
        )
        .all();
      return rows.map((row) => ({
        ...rowToReplayPlaybook(row),
        currentVersion: row.version_id
          ? rowToReplayPlaybookVersion({
              id: row.version_id,
              playbook_id: row.version_playbook_id,
              version_number: row.version_number,
              content: row.content,
              change_summary: row.change_summary,
              source_candidate_id: row.source_candidate_id,
              created_at: row.version_created_at,
            })
          : null,
        pendingCandidateCount: Number(row.pending_candidate_count ?? 0),
      }));
    },

    getReplayPlaybook(playbookId) {
      const playbook = readReplayPlaybook(playbookId);
      if (!playbook) {
        return null;
      }
      const versions = db
        .prepare(
          `
          SELECT *
          FROM replay_playbook_versions
          WHERE playbook_id = ?
          ORDER BY version_number DESC
          `,
        )
        .all(playbookId)
        .map(rowToReplayPlaybookVersion);
      const candidates = db
        .prepare(
          `
          SELECT *
          FROM replay_playbook_candidates
          WHERE playbook_id = ?
          ORDER BY updated_at DESC, id DESC
          `,
        )
        .all(playbookId)
        .map(rowToReplayPlaybookCandidate);
      return {
        playbook: {
          ...playbook,
          currentVersion:
            versions.find(
              (version) => version.id === playbook.currentVersionId,
            ) ?? null,
        },
        versions,
        candidates,
      };
    },

    createReplayPlaybook({ id, versionId, name, content, changeSummary, now }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare("SELECT id FROM replay_playbooks WHERE name = ?")
          .get(name);
        if (existing) {
          throw createReplayStateError("战法名称已存在", 409);
        }
        db.prepare(
          `
          INSERT INTO replay_playbooks (
            id,
            name,
            current_version_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?)
          `,
        ).run(id, name, versionId, now, now);
        db.prepare(
          `
          INSERT INTO replay_playbook_versions (
            id,
            playbook_id,
            version_number,
            content,
            change_summary,
            source_candidate_id,
            created_at
          ) VALUES (?, ?, 1, ?, ?, NULL, ?)
          `,
        ).run(versionId, id, content, changeSummary, now);
        const playbook = readReplayPlaybook(id);
        const version = readReplayPlaybookVersion(versionId);
        db.exec("COMMIT");
        return {
          ...playbook,
          currentVersion: version,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    renameReplayPlaybook({ playbookId, name, now }) {
      const duplicate = db
        .prepare(
          "SELECT id FROM replay_playbooks WHERE name = ? AND id <> ?",
        )
        .get(name, playbookId);
      if (duplicate) {
        throw createReplayStateError("战法名称已存在", 409);
      }
      const result = db
        .prepare(
          `
          UPDATE replay_playbooks
          SET name = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
          `,
        )
        .run(name, now, playbookId);
      return result.changes ? readReplayPlaybook(playbookId) : null;
    },

    deleteReplayPlaybook({ playbookId, now }) {
      const result = db
        .prepare(
          `
          UPDATE replay_playbooks
          SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
          `,
        )
        .run(now, now, playbookId);
      return result.changes > 0;
    },

    getReplayPlaybookVersionLink(playbookId, versionId) {
      const row = db
        .prepare(
          `
          SELECT
            playbooks.id AS playbook_id,
            playbooks.name AS playbook_name,
            versions.id AS version_id,
            versions.version_number,
            versions.content,
            versions.change_summary
          FROM replay_playbooks AS playbooks
          INNER JOIN replay_playbook_versions AS versions
            ON versions.playbook_id = playbooks.id
          WHERE playbooks.id = ? AND versions.id = ?
          `,
        )
        .get(playbookId, versionId);
      if (!row) {
        return null;
      }
      return {
        playbookId: row.playbook_id,
        playbookName: row.playbook_name,
        versionId: row.version_id,
        versionNumber: Number(row.version_number),
        content: row.content,
        changeSummary: row.change_summary,
      };
    },

    createReplayPlaybookVersion({
      playbookId,
      id,
      expectedVersionNumber,
      content,
      changeSummary,
      now,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `
            SELECT
              playbooks.*,
              versions.version_number AS current_version_number
            FROM replay_playbooks AS playbooks
            LEFT JOIN replay_playbook_versions AS versions
              ON versions.id = playbooks.current_version_id
            WHERE playbooks.id = ?
            `,
          )
          .get(playbookId);
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        const currentVersionNumber = Number(row.current_version_number ?? 0);
        if (currentVersionNumber !== expectedVersionNumber) {
          throw createReplayStateError(
            `战法版本冲突，当前版本为 v${currentVersionNumber}`,
            409,
          );
        }
        const nextVersionNumber = currentVersionNumber + 1;
        db.prepare(
          `
          INSERT INTO replay_playbook_versions (
            id,
            playbook_id,
            version_number,
            content,
            change_summary,
            source_candidate_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?)
          `,
        ).run(
          id,
          playbookId,
          nextVersionNumber,
          content,
          changeSummary,
          now,
        );
        db.prepare(
          `
          UPDATE replay_playbooks
          SET current_version_id = ?, updated_at = ?
          WHERE id = ?
          `,
        ).run(id, now, playbookId);
        const playbook = readReplayPlaybook(playbookId);
        const version = readReplayPlaybookVersion(id);
        db.exec("COMMIT");
        return { playbook, version };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    createReplayPlaybookCandidate({ id, sessionId, now }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `
            SELECT
              sessions.id,
              sessions.revealed_at,
              reviews.blind_json,
              reviews.post_json
            FROM replay_sessions AS sessions
            LEFT JOIN replay_reviews AS reviews
              ON reviews.session_id = sessions.id
            WHERE sessions.id = ?
            `,
          )
          .get(sessionId);
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        if (!row.revealed_at) {
          throw createReplayStateError("未揭晓会话不能生成战法改进候选", 409);
        }
        const blindReview = parseJson(row.blind_json, null, {
          fieldName: "replay_reviews.blind_json",
          rowId: sessionId,
          strict: true,
        });
        const postReview = parseJson(row.post_json, null, {
          fieldName: "replay_reviews.post_json",
          rowId: sessionId,
          strict: true,
        });
        const playbookId = String(blindReview?.playbookId ?? "").trim();
        const sourceVersionId = String(
          blindReview?.playbookVersionId ?? "",
        ).trim();
        const suggestion = String(
          postReview?.strategyAdjustment ?? "",
        ).trim();
        if (!playbookId || !sourceVersionId) {
          throw createReplayStateError(
            "盲评未关联战法版本，不能生成改进候选",
            409,
          );
        }
        if (!suggestion) {
          throw createReplayStateError(
            "事后复盘没有战法改进建议，不能生成候选",
            409,
          );
        }
        const sourceVersion = db
          .prepare(
            `
            SELECT id
            FROM replay_playbook_versions
            WHERE id = ? AND playbook_id = ?
            `,
          )
          .get(sourceVersionId, playbookId);
        if (!sourceVersion) {
          throw createReplayStateError("盲评关联的战法版本不存在", 409);
        }
        const existingRow = db
          .prepare(
            `
            SELECT *
            FROM replay_playbook_candidates
            WHERE session_id = ? AND playbook_id = ?
            `,
          )
          .get(sessionId, playbookId);
        if (existingRow) {
          if (
            existingRow.source_version_id === sourceVersionId &&
            existingRow.suggestion === suggestion
          ) {
            const existing = rowToReplayPlaybookCandidate(existingRow);
            db.exec("COMMIT");
            return existing;
          }
          throw createReplayStateError(
            "该演练已生成候选，复盘建议变化后不能覆盖原候选",
            409,
          );
        }
        db.prepare(
          `
          INSERT INTO replay_playbook_candidates (
            id,
            playbook_id,
            session_id,
            source_version_id,
            suggestion,
            state,
            accepted_version_id,
            reason,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
          `,
        ).run(
          id,
          playbookId,
          sessionId,
          sourceVersionId,
          suggestion,
          now,
          now,
        );
        const candidate = readReplayPlaybookCandidate(id);
        db.exec("COMMIT");
        return candidate;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    acceptReplayPlaybookCandidate({
      candidateId,
      versionId,
      expectedVersionNumber,
      content,
      changeSummary,
      now,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const candidateRow = db
          .prepare(
            `
            SELECT *
            FROM replay_playbook_candidates
            WHERE id = ?
            `,
          )
          .get(candidateId);
        if (!candidateRow) {
          db.exec("COMMIT");
          return null;
        }
        if (candidateRow.state !== "pending") {
          throw createReplayStateError("该候选已处理，不能重复接受", 409);
        }
        const currentRow = db
          .prepare(
            `
            SELECT
              playbooks.current_version_id,
              versions.version_number
            FROM replay_playbooks AS playbooks
            LEFT JOIN replay_playbook_versions AS versions
              ON versions.id = playbooks.current_version_id
            WHERE playbooks.id = ?
            `,
          )
          .get(candidateRow.playbook_id);
        const currentVersionNumber = Number(
          currentRow?.version_number ?? 0,
        );
        if (currentVersionNumber !== expectedVersionNumber) {
          throw createReplayStateError(
            `战法版本冲突，当前版本为 v${currentVersionNumber}`,
            409,
          );
        }
        const nextVersionNumber = currentVersionNumber + 1;
        db.prepare(
          `
          INSERT INTO replay_playbook_versions (
            id,
            playbook_id,
            version_number,
            content,
            change_summary,
            source_candidate_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          versionId,
          candidateRow.playbook_id,
          nextVersionNumber,
          content,
          changeSummary,
          candidateId,
          now,
        );
        db.prepare(
          `
          UPDATE replay_playbooks
          SET current_version_id = ?, updated_at = ?
          WHERE id = ?
          `,
        ).run(versionId, now, candidateRow.playbook_id);
        db.prepare(
          `
          UPDATE replay_playbook_candidates
          SET
            state = 'accepted',
            accepted_version_id = ?,
            reason = NULL,
            updated_at = ?
          WHERE id = ?
          `,
        ).run(versionId, now, candidateId);
        const candidate = readReplayPlaybookCandidate(candidateId);
        const playbook = readReplayPlaybook(candidateRow.playbook_id);
        const version = readReplayPlaybookVersion(versionId);
        db.exec("COMMIT");
        return { candidate, playbook, version };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    rejectReplayPlaybookCandidate({ candidateId, reason, now }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const candidate = readReplayPlaybookCandidate(candidateId);
        if (!candidate) {
          db.exec("COMMIT");
          return null;
        }
        if (candidate.state !== "pending") {
          throw createReplayStateError("该候选已处理，不能重复拒绝", 409);
        }
        db.prepare(
          `
          UPDATE replay_playbook_candidates
          SET state = 'rejected', reason = ?, updated_at = ?
          WHERE id = ?
          `,
        ).run(reason || null, now, candidateId);
        const rejected = readReplayPlaybookCandidate(candidateId);
        db.exec("COMMIT");
        return rejected;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    submitReplayOrder({
      sessionId,
      actionId,
      expectedRevision,
      order,
      requestPayload,
      updatedAt,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentRow = db
          .prepare(
            "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
          )
          .get(sessionId);
        if (!currentRow) {
          db.exec("COMMIT");
          return null;
        }
        const current = rowToReplaySession(currentRow);
        const existingAction = readReplayAction(sessionId, actionId);
        if (existingAction) {
          assertReplayActionMatches(
            existingAction,
            "order_submitted",
            requestPayload,
          );
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            session,
            created: false,
            idempotent: true,
          };
        }
        if (current.revision !== expectedRevision) {
          throw createReplayStateError(
            `会话版本冲突，当前 revision 为 ${current.revision}`,
            409,
          );
        }
        if (
          current.status === "completed" ||
          current.revealedFutureBars >= current.gameLength
        ) {
          throw createReplayStateError("行情演练已结束，不能继续下单", 409);
        }
        const submittedSequence =
          current.observationBars + current.revealedFutureBars;
        const orderId = randomUUID();
        const nextRevision = current.revision + 1;
        db.prepare(
          `
          INSERT INTO replay_orders (
            id,
            session_id,
            action_id,
            side,
            quantity_type,
            requested_quantity,
            ratio,
            decision_json,
            submitted_sequence,
            scheduled_sequence,
            created_revision,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          orderId,
          sessionId,
          actionId,
          order.side,
          order.quantityType,
          order.requestedQuantity,
          order.ratio,
          order.decision == null ? null : JSON.stringify(order.decision),
          submittedSequence,
          submittedSequence + 1,
          nextRevision,
          updatedAt,
        );
        db.prepare(
          `
          UPDATE replay_sessions
          SET
            revision = ?,
            updated_at = ?
          WHERE id = ?
          `,
        ).run(nextRevision, updatedAt, sessionId);
        insertReplayEvent({
          sessionId,
          actionId,
          eventType: "order_submitted",
          sequence: submittedSequence,
          payload: {
            request: requestPayload,
            orderId,
          },
          createdAt: updatedAt,
        });
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return {
          session,
          created: true,
          idempotent: false,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    finishReplaySession({
      sessionId,
      actionId,
      expectedRevision,
      completionReason = "early",
      requestPayload,
      updatedAt,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentRow = db
          .prepare(
            "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
          )
          .get(sessionId);
        if (!currentRow) {
          db.exec("COMMIT");
          return null;
        }
        const current = rowToReplaySession(currentRow);
        const existingAction = readReplayAction(sessionId, actionId);
        if (existingAction) {
          assertReplayActionMatches(existingAction, "finished", requestPayload);
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            session,
            finished: true,
            idempotent: true,
          };
        }
        if (current.revision !== expectedRevision) {
          throw createReplayStateError(
            `会话版本冲突，当前 revision 为 ${current.revision}`,
            409,
          );
        }
        if (current.status !== "active") {
          throw createReplayStateError("行情演练已结束，不能重复交卷", 409);
        }

        const currentSequence =
          current.observationBars + current.revealedFutureBars;
        const pendingOrders = db
          .prepare(
            `
            SELECT orders.*
            FROM replay_orders AS orders
            LEFT JOIN replay_fills AS fills ON fills.order_id = orders.id
            LEFT JOIN replay_order_rejections AS rejections
              ON rejections.order_id = orders.id
            WHERE orders.session_id = ?
              AND fills.order_id IS NULL
              AND rejections.order_id IS NULL
            ORDER BY orders.created_revision ASC
            `,
          )
          .all(sessionId);
        for (const order of pendingOrders) {
          const noOpportunity = completionReason === "no_opportunity";
          rejectReplayOrder(
            order,
            currentSequence,
            noOpportunity
              ? "session_finished_no_opportunity"
              : "session_finished_early",
            noOpportunity
              ? "本局无交易机会，未执行委托已取消"
              : "提前交卷，未执行委托已取消",
            updatedAt,
          );
        }

        const nextRevision = current.revision + 1;
        db.prepare(
          `
          UPDATE replay_sessions
          SET
            status = 'completed',
            completion_reason = ?,
            revision = ?,
            updated_at = ?
          WHERE id = ?
          `,
        ).run(completionReason, nextRevision, updatedAt, sessionId);
        insertReplayEvent({
          sessionId,
          actionId,
          eventType: "finished",
          sequence: currentSequence,
          payload: {
            request: requestPayload,
            cancelledOrderCount: pendingOrders.length,
          },
          createdAt: updatedAt,
        });
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return {
          session,
          finished: true,
          idempotent: false,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    saveReplayBlindReview({
      sessionId,
      actionId,
      expectedRevision,
      review,
      requestPayload,
      updatedAt,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentRow = db
          .prepare(
            "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
          )
          .get(sessionId);
        if (!currentRow) {
          db.exec("COMMIT");
          return null;
        }
        const current = rowToReplaySession(currentRow);
        const existingAction = readReplayAction(sessionId, actionId);
        if (existingAction) {
          assertReplayActionMatches(
            existingAction,
            "blind_review_saved",
            requestPayload,
          );
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            session,
            saved: true,
            idempotent: true,
          };
        }
        if (current.revision !== expectedRevision) {
          throw createReplayStateError(
            `会话版本冲突，当前 revision 为 ${current.revision}`,
            409,
          );
        }
        if (current.status !== "completed") {
          throw createReplayStateError("请先完成行情演练再填写盲评", 409);
        }
        if (current.revealedAt) {
          throw createReplayStateError("答案已揭晓，盲评已经冻结", 409);
        }
        if (readReplayReview(sessionId).blindReview) {
          throw createReplayStateError(
            "首次盲评已经保存，请通过修正记录补充",
            409,
          );
        }
        if (current.trainingConfig?.mode === "playbook") {
          const frozen = current.trainingConfig;
          if (
            review.playbookId !== frozen.playbookId ||
            review.playbookVersionId !== frozen.playbookVersionId
          ) {
            throw createReplayStateError(
              "专项演练只能使用开局时冻结的战法版本",
              409,
            );
          }
        }

        db.prepare(
          `
          INSERT INTO replay_reviews (
            session_id,
            blind_json,
            blind_updated_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            blind_json = excluded.blind_json,
            blind_updated_at = excluded.blind_updated_at,
            updated_at = excluded.updated_at
          `,
        ).run(
          sessionId,
          JSON.stringify(review),
          updatedAt,
          updatedAt,
          updatedAt,
        );
        db.prepare(
          `
          DELETE FROM replay_review_drafts
          WHERE session_id = ? AND stage = 'blind'
          `,
        ).run(sessionId);
        const nextRevision = current.revision + 1;
        db.prepare(
          `
          UPDATE replay_sessions
          SET revision = ?, updated_at = ?
          WHERE id = ?
          `,
        ).run(nextRevision, updatedAt, sessionId);
        insertReplayEvent({
          sessionId,
          actionId,
          eventType: "blind_review_saved",
          sequence: current.observationBars + current.revealedFutureBars,
          payload: {
            request: requestPayload,
          },
          createdAt: updatedAt,
        });
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return {
          session,
          saved: true,
          idempotent: false,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    saveReplayPostReview({
      sessionId,
      actionId,
      expectedRevision,
      review,
      requestPayload,
      updatedAt,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentRow = db
          .prepare(
            "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
          )
          .get(sessionId);
        if (!currentRow) {
          db.exec("COMMIT");
          return null;
        }
        const current = rowToReplaySession(currentRow);
        const existingAction = readReplayAction(sessionId, actionId);
        if (existingAction) {
          assertReplayActionMatches(
            existingAction,
            "post_review_saved",
            requestPayload,
          );
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            session,
            saved: true,
            idempotent: true,
          };
        }
        if (current.revision !== expectedRevision) {
          throw createReplayStateError(
            `会话版本冲突，当前 revision 为 ${current.revision}`,
            409,
          );
        }
        if (!current.revealedAt) {
          throw createReplayStateError("请先揭晓答案再填写事后复盘", 409);
        }
        if (readReplayReview(sessionId).postReview) {
          throw createReplayStateError(
            "首次事后复盘已经保存，请通过修正记录补充",
            409,
          );
        }

        db.prepare(
          `
          INSERT INTO replay_reviews (
            session_id,
            post_json,
            post_updated_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            post_json = excluded.post_json,
            score_json = NULL,
            post_updated_at = excluded.post_updated_at,
            updated_at = excluded.updated_at
          `,
        ).run(
          sessionId,
          JSON.stringify(review),
          updatedAt,
          updatedAt,
          updatedAt,
        );
        db.prepare(
          `
          DELETE FROM replay_review_drafts
          WHERE session_id = ? AND stage = 'post'
          `,
        ).run(sessionId);
        const nextRevision = current.revision + 1;
        db.prepare(
          `
          UPDATE replay_sessions
          SET revision = ?, updated_at = ?
          WHERE id = ?
          `,
        ).run(nextRevision, updatedAt, sessionId);
        insertReplayEvent({
          sessionId,
          actionId,
          eventType: "post_review_saved",
          sequence: current.observationBars + current.revealedFutureBars,
          payload: {
            request: requestPayload,
          },
          createdAt: updatedAt,
        });
        const scored = readReplaySession(sessionId);
        scored.review.scoreCard = calculateReplayScoreCard(scored);
        db.prepare(
          `
          UPDATE replay_reviews
          SET score_json = ?, updated_at = ?
          WHERE session_id = ?
          `,
        ).run(
          JSON.stringify(scored.review.scoreCard),
          updatedAt,
          sessionId,
        );
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return {
          session,
          saved: true,
          idempotent: false,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    appendReplayReviewCorrection({
      sessionId,
      stage,
      actionId,
      expectedRevision,
      review,
      changeNote,
      requestPayload,
      createdAt,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentRow = db
          .prepare(
            "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
          )
          .get(sessionId);
        if (!currentRow) {
          db.exec("COMMIT");
          return null;
        }
        const current = rowToReplaySession(currentRow);
        const eventType = `${stage}_review_correction_appended`;
        const existingAction = readReplayAction(sessionId, actionId);
        if (existingAction) {
          assertReplayActionMatches(
            existingAction,
            eventType,
            requestPayload,
          );
          const correction = rowToReplayReviewCorrection(
            db.prepare(
              `
              SELECT *
              FROM replay_review_corrections
              WHERE session_id = ? AND action_id = ?
              `,
            ).get(sessionId, actionId),
          );
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            correction,
            session,
            saved: true,
            idempotent: true,
          };
        }
        if (current.revision !== expectedRevision) {
          throw createReplayStateError(
            `会话版本冲突，当前 revision 为 ${current.revision}`,
            409,
          );
        }
        const originalReview = readReplayReview(sessionId);
        if (stage === "blind" && !originalReview.blindReview) {
          throw createReplayStateError(
            "请先保存首次盲评再追加修正",
            409,
          );
        }
        if (stage === "post") {
          if (!current.revealedAt) {
            throw createReplayStateError(
              "请先揭晓答案再追加事后复盘修正",
              409,
            );
          }
          if (!originalReview.postReview) {
            throw createReplayStateError(
              "请先保存首次事后复盘再追加修正",
              409,
            );
          }
        }
        const revisionNumber =
          Number(
            db.prepare(
              `
              SELECT COALESCE(MAX(revision_number), 0) AS revision_number
              FROM replay_review_corrections
              WHERE session_id = ? AND stage = ?
              `,
            ).get(sessionId, stage)?.revision_number ?? 0,
          ) + 1;
        const correctionId = randomUUID();
        db.prepare(
          `
          INSERT INTO replay_review_corrections (
            id,
            session_id,
            action_id,
            stage,
            revision_number,
            full_review_json,
            change_note,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          correctionId,
          sessionId,
          actionId,
          stage,
          revisionNumber,
          JSON.stringify(review),
          changeNote,
          createdAt,
        );
        const nextRevision = current.revision + 1;
        db.prepare(
          `
          UPDATE replay_sessions
          SET revision = ?, updated_at = ?
          WHERE id = ?
          `,
        ).run(nextRevision, createdAt, sessionId);
        insertReplayEvent({
          sessionId,
          actionId,
          eventType,
          sequence: current.observationBars + current.revealedFutureBars,
          payload: {
            request: requestPayload,
            correctionId,
            revisionNumber,
          },
          createdAt,
        });
        const correction = rowToReplayReviewCorrection(
          db.prepare(
            "SELECT * FROM replay_review_corrections WHERE id = ?",
          ).get(correctionId),
        );
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return {
          correction,
          session,
          saved: true,
          idempotent: false,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    revealReplaySession({
      sessionId,
      actionId,
      expectedRevision,
      requestPayload,
      updatedAt,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentRow = db
          .prepare(
            "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
          )
          .get(sessionId);
        if (!currentRow) {
          db.exec("COMMIT");
          return null;
        }
        const current = rowToReplaySession(currentRow);
        const existingAction = readReplayAction(sessionId, actionId);
        if (existingAction) {
          assertReplayActionMatches(existingAction, "revealed", requestPayload);
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            session,
            revealed: true,
            idempotent: true,
          };
        }
        if (current.revision !== expectedRevision) {
          throw createReplayStateError(
            `会话版本冲突，当前 revision 为 ${current.revision}`,
            409,
          );
        }
        if (current.status !== "completed") {
          throw createReplayStateError("请先完成行情演练再揭晓答案", 409);
        }
        if (current.revealedAt) {
          throw createReplayStateError("本局行情答案已经揭晓", 409);
        }
        if (!readReplayReview(sessionId).blindReview) {
          throw createReplayStateError("请先完成盲评再揭晓答案", 409);
        }

        const nextRevision = current.revision + 1;
        const currentSequence =
          current.observationBars + current.revealedFutureBars;
        db.prepare(
          `
          UPDATE replay_sessions
          SET
            revealed_at = ?,
            revision = ?,
            updated_at = ?
          WHERE id = ?
          `,
        ).run(updatedAt, nextRevision, updatedAt, sessionId);
        insertReplayEvent({
          sessionId,
          actionId,
          eventType: "revealed",
          sequence: currentSequence,
          payload: {
            request: requestPayload,
          },
          createdAt: updatedAt,
        });
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return {
          session,
          revealed: true,
          idempotent: false,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    advanceReplaySession({
      sessionId,
      actionId,
      expectedRevision,
      requestPayload,
      updatedAt,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentRow = db
          .prepare(
            "SELECT * FROM replay_sessions WHERE id = ? AND deleted_at IS NULL",
          )
          .get(sessionId);
        if (!currentRow) {
          db.exec("COMMIT");
          return null;
        }
        const current = rowToReplaySession(currentRow);
        const existingAction = readReplayAction(sessionId, actionId);
        if (existingAction) {
          assertReplayActionMatches(
            existingAction,
            "advanced",
            requestPayload,
          );
          const session = readReplaySession(sessionId);
          db.exec("COMMIT");
          return {
            session,
            advanced: true,
            idempotent: true,
          };
        }
        if (current.revision !== expectedRevision) {
          throw createReplayStateError(
            `会话版本冲突，当前 revision 为 ${current.revision}`,
            409,
          );
        }
        if (
          current.status === "completed" ||
          current.revealedFutureBars >= current.gameLength
        ) {
          db.exec("COMMIT");
          return {
            session: readReplaySession(sessionId),
            advanced: false,
            idempotent: false,
          };
        }

        const targetIndex =
          current.observationBars + current.revealedFutureBars;
        const targetBar = current.snapshot?.bars?.[targetIndex];
        if (!targetBar) {
          throw createReplayStateError("行情演练场景缺少下一交易日数据", 500);
        }
        const targetSequence = targetIndex + 1;
        const previousBar = current.snapshot?.bars?.[targetIndex - 1] ?? null;
        const interval = String(current.snapshot?.interval ?? "1d");
        const crossedTradeDate =
          interval === "1d" ||
          String(previousBar?.tradeDate ?? "") !== String(targetBar.tradeDate ?? "");
        const account = {
          ...current.account,
          cash: Number(current.account.cash),
          positionQuantity: Number(current.account.positionQuantity),
          availableQuantity:
            Number(current.account.availableQuantity) +
            (crossedTradeDate ? Number(current.account.lockedQuantity) : 0),
          lockedQuantity: crossedTradeDate
            ? 0
            : Number(current.account.lockedQuantity),
          averageCost: Number(current.account.averageCost),
          realizedPnl: Number(current.account.realizedPnl ?? 0),
          totalFees: Number(current.account.totalFees),
        };
        const pendingOrders = db
          .prepare(
            `
            SELECT orders.*
            FROM replay_orders AS orders
            LEFT JOIN replay_fills AS fills ON fills.order_id = orders.id
            LEFT JOIN replay_order_rejections AS rejections
              ON rejections.order_id = orders.id
            WHERE orders.session_id = ?
              AND orders.scheduled_sequence = ?
              AND fills.order_id IS NULL
              AND rejections.order_id IS NULL
            ORDER BY orders.created_revision ASC
            `,
          )
          .all(sessionId, targetSequence);

        for (const orderRow of pendingOrders) {
          const order = {
            ...orderRow,
            quantityType: orderRow.quantity_type,
            requestedQuantity: orderRow.requested_quantity,
          };
          const volume = Number(targetBar.volume);
          if (!Number.isFinite(volume) || volume <= 0) {
            rejectReplayOrder(
              orderRow,
              targetSequence,
              "suspended",
              "当日停牌，委托未成交",
              updatedAt,
            );
            continue;
          }
          const open = Number(targetBar.open);
          if (!Number.isFinite(open) || open <= 0) {
            rejectReplayOrder(
              orderRow,
              targetSequence,
              "invalid_market_data",
              "开盘价数据不可用",
              updatedAt,
            );
            continue;
          }
          const prices = [
            targetBar.open,
            targetBar.high,
            targetBar.low,
            targetBar.close,
          ].map(Number);
          const onePrice =
            prices.every(Number.isFinite) &&
            prices.every((price) => price === prices[0]);
          const privatePreClose = Number(targetBar.preClose);
          const previousClose = Number(previousBar?.close);
          const preClose =
            Number.isFinite(privatePreClose) && privatePreClose > 0
              ? privatePreClose
              : previousClose;
          const privatePctChange =
            targetBar.pctChange == null
              ? null
              : Number(targetBar.pctChange);
          const confirmedPctChange =
            privatePctChange != null && Number.isFinite(privatePctChange)
              ? privatePctChange
              : Number.isFinite(preClose) && preClose > 0
                ? ((prices[0] / preClose) - 1) * 100
                : null;
          const limitType =
            typeof targetBar.limitType === "string" &&
            targetBar.limitType.trim()
              ? targetBar.limitType.trim().toUpperCase()
              : null;
          const confirmedLimitUp =
            limitType != null
              ? limitType === "U"
              : Number.isFinite(preClose) &&
                preClose > 0 &&
                prices[0] > preClose &&
                confirmedPctChange != null &&
                confirmedPctChange >= 4.8;
          const confirmedLimitDown =
            limitType != null
              ? limitType === "D"
              : Number.isFinite(preClose) &&
                preClose > 0 &&
                prices[0] < preClose &&
                confirmedPctChange != null &&
                confirmedPctChange <= -4.8;
          if (
            onePrice &&
            confirmedLimitUp &&
            orderRow.side === "buy"
          ) {
            rejectReplayOrder(
              orderRow,
              targetSequence,
              "one_price_limit_up",
              "一字上涨，买入委托未成交",
              updatedAt,
            );
            continue;
          }
          if (
            onePrice &&
            confirmedLimitDown &&
            orderRow.side === "sell"
          ) {
            rejectReplayOrder(
              orderRow,
              targetSequence,
              "one_price_limit_down",
              "一字下跌，卖出委托未成交",
              updatedAt,
            );
            continue;
          }

          const slippageDirection = orderRow.side === "buy" ? 1 : -1;
          const price = roundReplayNumber(
            open *
              (1 +
                (slippageDirection *
                  Number(current.costConfig.slippageBps)) /
                  10000),
          );
          const quantity = replayOrderQuantity(
            order,
            account,
            price,
            current.costConfig,
          );
          if (orderRow.side === "sell" && quantity <= 0) {
            rejectReplayOrder(
              orderRow,
              targetSequence,
              "insufficient_sellable",
              "没有足够的可卖数量",
              updatedAt,
            );
            continue;
          }
          if (quantity <= 0) {
            rejectReplayOrder(
              orderRow,
              targetSequence,
              "below_lot_size",
              "可买数量不足一手",
              updatedAt,
            );
            continue;
          }
          if (
            orderRow.side === "sell" &&
            quantity > account.availableQuantity
          ) {
            rejectReplayOrder(
              orderRow,
              targetSequence,
              "insufficient_sellable",
              "卖出数量超过可卖数量",
              updatedAt,
            );
            continue;
          }
          const notional = roundReplayNumber(price * quantity);
          const fees = calculateReplayFees(
            notional,
            orderRow.side,
            current.costConfig,
          );
          if (
            orderRow.side === "buy" &&
            notional + fees.totalFee > account.cash
          ) {
            rejectReplayOrder(
              orderRow,
              targetSequence,
              "insufficient_cash",
              "可用现金不足",
              updatedAt,
            );
            continue;
          }

          if (orderRow.side === "buy") {
            const originalCost =
              account.averageCost * account.positionQuantity;
            const totalCost = notional + fees.totalFee;
            account.cash = roundReplayNumber(account.cash - totalCost);
            account.positionQuantity += quantity;
            account.lockedQuantity += quantity;
            account.averageCost = roundReplayNumber(
              (originalCost + totalCost) / account.positionQuantity,
            );
          } else {
            const netProceeds = notional - fees.totalFee;
            account.cash = roundReplayNumber(account.cash + netProceeds);
            account.positionQuantity -= quantity;
            account.availableQuantity -= quantity;
            account.realizedPnl = roundReplayNumber(
              account.realizedPnl +
                netProceeds -
                account.averageCost * quantity,
            );
            if (account.positionQuantity === 0) {
              account.averageCost = 0;
              account.availableQuantity = 0;
              account.lockedQuantity = 0;
            }
          }
          account.totalFees = roundReplayNumber(
            account.totalFees + fees.totalFee,
          );
          db.prepare(
            `
            INSERT INTO replay_fills (
              id,
              session_id,
              order_id,
              sequence,
              side,
              quantity,
              reference_price,
              price,
              slippage_bps,
              notional,
              commission,
              stamp_tax,
              transfer_fee,
              total_fee,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          ).run(
            randomUUID(),
            sessionId,
            orderRow.id,
            targetSequence,
            orderRow.side,
            quantity,
            open,
            price,
            current.costConfig.slippageBps,
            notional,
            fees.commission,
            fees.stampTax,
            fees.transferFee,
            fees.totalFee,
            updatedAt,
          );
        }

        const revealedFutureBars = current.revealedFutureBars + 1;
        const status =
          revealedFutureBars >= current.gameLength ? "completed" : "active";
        const nextRevision = current.revision + 1;
        db.prepare(
          `
          UPDATE replay_sessions
          SET
            revealed_future_bars = ?,
            status = ?,
            completion_reason = ?,
            revision = ?,
            account_json = ?,
            updated_at = ?
          WHERE id = ?
          `,
        ).run(
          revealedFutureBars,
          status,
          status === "completed" ? "natural" : null,
          nextRevision,
          JSON.stringify(account),
          updatedAt,
          sessionId,
        );
        insertReplayEvent({
          sessionId,
          actionId,
          eventType: "advanced",
          sequence: targetSequence,
          payload: {
            request: requestPayload,
          },
          createdAt: updatedAt,
        });
        const session = readReplaySession(sessionId);
        db.exec("COMMIT");
        return {
          session,
          advanced: true,
          idempotent: false,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    getRun(runId) {
      const row = db
        .prepare(
          `
          SELECT *
          FROM backtest_runs
          WHERE id = ?
        `,
        )
        .get(runId);
      return rowToRun(row);
    },

    deleteRun(runId) {
      const current = this.getRun(runId);
      if (!current) {
        return null;
      }

      db.prepare(
        `
        DELETE FROM backtest_runs
        WHERE id = ?
      `,
      ).run(runId);
      db.prepare(
        `
        DELETE FROM backtest_run_tags
        WHERE run_id = ?
      `,
      ).run(runId);

      return current;
    },

    addSyncLog(log) {
      db.prepare(
        `
        INSERT INTO data_sync_logs (
          id,
          symbol,
          exchange,
          interval,
          start_date,
          end_date,
          status,
          provider,
          bars_synced,
          message,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        log.id,
        log.symbol,
        log.exchange,
        log.interval,
        log.startDate,
        log.endDate,
        log.status,
        log.provider,
        log.barsSynced,
        log.message ?? null,
        log.createdAt,
      );
      return log;
    },

    listRecentSyncLogs(limit = 10) {
      const rows = db
        .prepare(
          `
          SELECT *
          FROM data_sync_logs
          ORDER BY created_at DESC
          LIMIT ?
        `,
        )
        .all(limit);
      return rows.map(rowToSyncLog);
    },

    createTask(task) {
      const normalizedTags = normalizeTagList(task.tags);
      db.prepare(
        `
        INSERT INTO analysis_tasks (
          id,
          type,
          title,
          status,
          request_json,
          result_json,
          error_message,
          related_run_ids_json,
          tags_json,
          notes,
          starred,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        task.id,
        task.type,
        task.title,
        task.status,
        JSON.stringify(task.request ?? {}),
        task.result ? JSON.stringify(task.result) : null,
        task.errorMessage ?? null,
        JSON.stringify(task.relatedRunIds ?? []),
        JSON.stringify(normalizedTags),
        task.notes ?? "",
        task.starred ? 1 : 0,
        task.createdAt,
        task.updatedAt,
      );
      replaceTaskTags(task.id, normalizedTags);
      return this.getTask(task.id);
    },

    updateTask(taskId, patch) {
      const current = this.getTask(taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        ...patch,
      };
      const normalizedTags = normalizeTagList(next.tags);
      db.prepare(
        `
        UPDATE analysis_tasks
        SET
          type = ?,
          title = ?,
          status = ?,
          request_json = ?,
          result_json = ?,
          error_message = ?,
          related_run_ids_json = ?,
          tags_json = ?,
          notes = ?,
          starred = ?,
          updated_at = ?
        WHERE id = ?
      `,
      ).run(
        next.type,
        next.title,
        next.status,
        JSON.stringify(next.request ?? {}),
        next.result ? JSON.stringify(next.result) : null,
        next.errorMessage ?? null,
        JSON.stringify(next.relatedRunIds ?? []),
        JSON.stringify(normalizedTags),
        next.notes ?? "",
        next.starred ? 1 : 0,
        next.updatedAt,
        taskId,
      );
      replaceTaskTags(taskId, normalizedTags);
      return this.getTask(taskId);
    },

    queryTasks(filters = {}, options = {}) {
      const clauses = [];
      const values = [];
      const tagFilter = buildTagFilterSql({
        filterTag: filters.tag,
        tableAlias: "analysis_tasks",
        tagTableName: "analysis_task_tags",
        idColumn: "task_id",
      });

      if (filters.status) {
        clauses.push("status = ?");
        values.push(filters.status);
      }
      if (filters.type) {
        clauses.push("type = ?");
        values.push(filters.type);
      }
      if (Array.isArray(filters.excludeTypes) && filters.excludeTypes.length) {
        clauses.push(
          `type NOT IN (${filters.excludeTypes.map(() => "?").join(", ")})`,
        );
        values.push(...filters.excludeTypes);
      }
      if (filters.starred === true) {
        clauses.push("starred = 1");
      }
      if (filters.keyword) {
        clauses.push("(title LIKE ? OR notes LIKE ? OR request_json LIKE ?)");
        const keyword = `%${String(filters.keyword).trim()}%`;
        values.push(keyword, keyword, keyword);
      }
      if (tagFilter.whereSql) {
        clauses.push(tagFilter.whereSql);
        values.push(...tagFilter.values);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const pagination = normalizePaginationOptions(options, {
        page: 1,
        pageSize: 20,
        maxPageSize: 200,
      });
      const totalRow = db
        .prepare(
          `
          SELECT COUNT(*) AS total
          FROM analysis_tasks
          ${tagFilter.joinSql}
          ${where}
        `,
        )
        .get(...values);
      const rows = db
        .prepare(
          `
          SELECT *
          FROM analysis_tasks
          ${tagFilter.joinSql}
          ${where}
          ORDER BY created_at DESC
          LIMIT ?
          OFFSET ?
        `,
        )
        .all(...values, pagination.pageSize, pagination.offset);
      return {
        items: rows.map(rowToTask),
        total: Number(totalRow?.total ?? 0),
        page: pagination.page,
        pageSize: pagination.pageSize,
      };
    },

    listTasks(filters = {}) {
      const clauses = [];
      const values = [];
      const tagFilter = buildTagFilterSql({
        filterTag: filters.tag,
        tableAlias: "analysis_tasks",
        tagTableName: "analysis_task_tags",
        idColumn: "task_id",
      });

      if (filters.status) {
        clauses.push("status = ?");
        values.push(filters.status);
      }
      if (filters.type) {
        clauses.push("type = ?");
        values.push(filters.type);
      }
      if (Array.isArray(filters.excludeTypes) && filters.excludeTypes.length) {
        clauses.push(
          `type NOT IN (${filters.excludeTypes.map(() => "?").join(", ")})`,
        );
        values.push(...filters.excludeTypes);
      }
      if (filters.starred === true) {
        clauses.push("starred = 1");
      }
      if (filters.keyword) {
        clauses.push("(title LIKE ? OR notes LIKE ? OR request_json LIKE ?)");
        const keyword = `%${String(filters.keyword).trim()}%`;
        values.push(keyword, keyword, keyword);
      }
      if (tagFilter.whereSql) {
        clauses.push(tagFilter.whereSql);
        values.push(...tagFilter.values);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `
          SELECT *
          FROM analysis_tasks
          ${tagFilter.joinSql}
          ${where}
          ORDER BY created_at DESC
        `,
        )
        .all(...values);
      return rows.map(rowToTask);
    },

    getTask(taskId) {
      const row = db
        .prepare(
          `
          SELECT *
          FROM analysis_tasks
          WHERE id = ?
        `,
        )
        .get(taskId);
      return rowToTask(row);
    },

    deleteTask(taskId) {
      const current = this.getTask(taskId);
      if (!current) {
        return null;
      }
      db.prepare(
        `
        DELETE FROM analysis_tasks
        WHERE id = ?
      `,
      ).run(taskId);
      db.prepare(
        `
        DELETE FROM analysis_task_tags
        WHERE task_id = ?
      `,
      ).run(taskId);
      return current;
    },

    addSystemLog(log) {
      db.prepare(
        `
        INSERT INTO system_logs (
          id,
          scope,
          level,
          title,
          message,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        log.id,
        log.scope,
        log.level,
        log.title,
        log.message,
        log.payload ? JSON.stringify(log.payload) : null,
        log.createdAt,
      );
      return log;
    },

    querySystemLogs(filters = {}, options = {}) {
      const clauses = [];
      const values = [];

      if (filters.level) {
        clauses.push("level = ?");
        values.push(String(filters.level).trim());
      }
      if (filters.scope) {
        clauses.push("scope = ?");
        values.push(String(filters.scope).trim());
      }
      if (filters.keyword) {
        clauses.push(
          "(title LIKE ? OR message LIKE ? OR scope LIKE ? OR level LIKE ? OR payload_json LIKE ?)",
        );
        const keyword = `%${String(filters.keyword).trim()}%`;
        values.push(keyword, keyword, keyword, keyword, keyword);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const pagination = normalizePaginationOptions(options, {
        page: 1,
        pageSize: 50,
        maxPageSize: 500,
      });
      const totalRow = db
        .prepare(
          `
          SELECT COUNT(*) AS total
          FROM system_logs
          ${where}
        `,
        )
        .get(...values);
      const rows = db
        .prepare(
          `
          SELECT *
          FROM system_logs
          ${where}
          ORDER BY created_at DESC
          LIMIT ?
          OFFSET ?
        `,
        )
        .all(...values, pagination.pageSize, pagination.offset);
      return {
        items: rows.map(rowToSystemLog),
        total: Number(totalRow?.total ?? 0),
        page: pagination.page,
        pageSize: pagination.pageSize,
      };
    },

    listSystemLogs(limit = 100) {
      const rows = db
        .prepare(
          `
          SELECT *
          FROM system_logs
          ORDER BY created_at DESC
          LIMIT ?
        `,
        )
        .all(limit);
      return rows.map(rowToSystemLog);
    },

    deleteSystemLog(logId) {
      const current = db
        .prepare(
          `
          SELECT *
          FROM system_logs
          WHERE id = ?
        `,
        )
        .get(logId);
      if (!current) {
        return null;
      }
      db.prepare(
        `
        DELETE FROM system_logs
        WHERE id = ?
      `,
      ).run(logId);
      return rowToSystemLog(current);
    },

    clearSystemLogs() {
      const result = db
        .prepare(
          `
        DELETE FROM system_logs
      `,
        )
        .run();
      return {
        deletedCount: Number(result.changes ?? 0),
      };
    },

    saveStrategyVersion(version) {
      db.prepare(
        `
        INSERT INTO strategy_versions (
          id,
          strategy_id,
          source_path,
          source_hash,
          source_code,
          summary_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        version.id,
        version.strategyId,
        version.sourcePath,
        version.sourceHash,
        version.sourceCode,
        version.summary ? JSON.stringify(version.summary) : null,
        version.createdAt,
      );
      return this.getStrategyVersion(version.id);
    },

    findStrategyVersion(strategyId, sourcePath, sourceHash) {
      const row = db
        .prepare(
          `
          SELECT *
          FROM strategy_versions
          WHERE strategy_id = ? AND source_path = ? AND source_hash = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
        )
        .get(strategyId, sourcePath, sourceHash);
      return rowToStrategyVersion(row);
    },

    getStrategyVersion(versionId) {
      const row = db
        .prepare(
          `
          SELECT *
          FROM strategy_versions
          WHERE id = ?
        `,
        )
        .get(versionId);
      return rowToStrategyVersion(row);
    },

    queryStrategyVersions(strategyId = null, options = {}) {
      const clauses = [];
      const values = [];
      if (strategyId) {
        clauses.push("strategy_id = ?");
        values.push(strategyId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const pagination = normalizePaginationOptions(options, {
        page: 1,
        pageSize: 20,
        maxPageSize: 200,
      });
      const totalRow = db
        .prepare(
          `
          SELECT COUNT(*) AS total
          FROM strategy_versions
          ${where}
        `,
        )
        .get(...values);
      const rows = db
        .prepare(
          `
          SELECT *
          FROM strategy_versions
          ${where}
          ORDER BY created_at DESC
          LIMIT ?
          OFFSET ?
        `,
        )
        .all(...values, pagination.pageSize, pagination.offset);
      return {
        items: rows.map(rowToStrategyVersion),
        total: Number(totalRow?.total ?? 0),
        page: pagination.page,
        pageSize: pagination.pageSize,
      };
    },

    listStrategyVersions(strategyId = null) {
      const rows = strategyId
        ? db
            .prepare(
              `
            SELECT *
            FROM strategy_versions
            WHERE strategy_id = ?
            ORDER BY created_at DESC
          `,
            )
            .all(strategyId)
        : db
            .prepare(
              `
            SELECT *
            FROM strategy_versions
            ORDER BY created_at DESC
          `,
            )
            .all();
      return rows.map(rowToStrategyVersion);
    },

    deleteStrategyVersion(versionId) {
      const current = db
        .prepare(
          `
          SELECT *
          FROM strategy_versions
          WHERE id = ?
        `,
        )
        .get(versionId);
      if (!current) {
        return null;
      }
      db.prepare(
        `
        DELETE FROM strategy_versions
        WHERE id = ?
      `,
      ).run(versionId);
      return rowToStrategyVersion(current);
    },

    clearStrategyVersions(strategyId = null) {
      const result = strategyId
        ? db
            .prepare(
              `
            DELETE FROM strategy_versions
            WHERE strategy_id = ?
          `,
            )
            .run(strategyId)
        : db
            .prepare(
              `
            DELETE FROM strategy_versions
          `,
            )
            .run();
      return {
        deletedCount: Number(result.changes ?? 0),
      };
    },
  };
}
