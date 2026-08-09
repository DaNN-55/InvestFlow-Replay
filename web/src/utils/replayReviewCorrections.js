const OUTCOME_LABELS = {
  correct: "正确",
  partial: "部分正确",
  wrong: "错误",
};

function formatTime(value) {
  if (!value) {
    return "时间未记录";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function blindFields(snapshot) {
  return [
    { label: "战法名称", value: snapshot.strategyName || "未指定" },
    { label: "判断信心", value: `${snapshot.confidence ?? "—"} / 5` },
    {
      label: "判断理由",
      value: formatReplayReasonTags(snapshot.reasonTags),
    },
    { label: "核心判断", value: snapshot.thesis || "未填写" },
    { label: "交易计划", value: snapshot.tradePlan || "未填写" },
    { label: "风险计划", value: snapshot.riskPlan || "未填写" },
  ];
}

function postFields(snapshot) {
  const fields = [
    {
      label: "判断结果",
      value:
        OUTCOME_LABELS[snapshot.outcome] || snapshot.outcome || "未填写",
    },
    {
      label: "执行纪律",
      value: `${snapshot.disciplineScore ?? "—"} / 5`,
    },
    {
      label: "风险控制",
      value:
        snapshot.riskControlScore == null
          ? "旧记录未保存"
          : `${snapshot.riskControlScore} / 5`,
    },
    { label: "执行复盘", value: snapshot.executionReview || "未填写" },
    { label: "错误与不足", value: snapshot.mistakes || "未填写" },
    { label: "经验总结", value: snapshot.lessons || "未填写" },
  ];
  if (snapshot.playbookFitScore != null) {
    fields.splice(3, 0, {
      label: "战法复核",
      value: `${snapshot.playbookFitScore} / 5`,
    });
    fields.push({
      label: "战法调整建议",
      value: snapshot.strategyAdjustment || "未填写",
    });
  }
  return fields;
}

export function getLatestReplayReviewSnapshot({
  stage,
  originalReview,
  corrections,
}) {
  const stageCorrections = Array.isArray(corrections)
    ? corrections.filter((correction) => correction.stage === stage)
    : [];
  return stageCorrections.at(-1)?.fullReviewSnapshot ?? originalReview ?? null;
}

export function buildReplayReviewCorrectionPayload({
  stage,
  snapshot,
  form,
  playbookFitApplicable = false,
}) {
  if (stage === "blind") {
    const payload = {
      strategyName: form.strategyName.trim(),
      thesis: form.thesis.trim(),
      tradePlan: form.tradePlan.trim(),
      riskPlan: form.riskPlan.trim(),
      confidence: Number(form.confidence),
      reasonTags: [...form.reasonTags].slice(0, 8),
      stopLossPrice: snapshot.stopLossPrice ?? null,
      invalidationRule: snapshot.invalidationRule ?? null,
      changeNote: form.changeNote.trim(),
    };
    if (form.playbookId && form.playbookVersionId) {
      payload.playbookId = form.playbookId;
      payload.playbookVersionId = form.playbookVersionId;
    }
    return payload;
  }
  const payload = {
    outcome: form.outcome,
    executionReview: form.executionReview.trim(),
    mistakes: form.mistakes.trim(),
    lessons: form.lessons.trim(),
    disciplineScore: Number(form.disciplineScore),
    riskControlScore: Number(form.riskControlScore),
    changeNote: form.changeNote.trim(),
  };
  if (playbookFitApplicable) {
    payload.playbookFitScore = Number(form.playbookFitScore);
    payload.strategyAdjustment = form.strategyAdjustment.trim();
  }
  return payload;
}

function buildStage(stage, originalReview, corrections, includeOriginal) {
  if (!originalReview) {
    return null;
  }
  const stageCorrections = corrections
    .filter((correction) => correction.stage === stage)
    .map((correction) => ({
      id: correction.id,
      correction,
      title: `第 ${correction.revisionNumber} 次修正`,
      time: formatTime(correction.createdAt),
      changeNote: correction.changeNote,
      fields:
        stage === "blind"
          ? blindFields(correction.fullReviewSnapshot ?? {})
          : postFields(correction.fullReviewSnapshot ?? {}),
    }));
  const entries = [
    ...(includeOriginal
      ? [
          {
            id: `${stage}-original`,
            title: stage === "blind" ? "原始盲评" : "原始事后复盘",
            time: "首次保存记录",
            changeNote: "",
            fields:
              stage === "blind"
                ? blindFields(originalReview)
                : postFields(originalReview),
          },
        ]
      : []),
    ...stageCorrections,
  ];
  if (!entries.length) {
    return null;
  }
  return {
    stage,
    title: stage === "blind" ? "盲评记录" : "事后复盘记录",
    entries,
  };
}

export function buildReplayReviewTimeline({
  blindReview,
  postReview,
  corrections = [],
  revealed = false,
  includeOriginal = true,
}) {
  return [
    buildStage("blind", blindReview, corrections, includeOriginal),
    revealed
      ? buildStage("post", postReview, corrections, includeOriginal)
      : null,
  ].filter(Boolean);
}
import { formatReplayReasonTags } from "./replayReviewPresentation.js";
