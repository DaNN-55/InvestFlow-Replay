import { buildReplayScoreDimensions } from "./replayScorePresentation.js";

const REVIEW_STATES = {
  active: {
    label: "演练中",
    tone: "active",
  },
  awaiting_blind: {
    label: "待盲评",
    tone: "warning",
  },
  awaiting_reveal: {
    label: "待揭晓",
    tone: "warning",
  },
  awaiting_post: {
    label: "待事后复盘",
    tone: "warning",
  },
  reviewed: {
    label: "已评分",
    tone: "success",
  },
  skipped: {
    label: "主动空仓",
    tone: "neutral",
  },
};

export function getReplayHistoryStatePresentation(state) {
  return (
    REVIEW_STATES[state] ?? {
      label: "未知状态",
      tone: "neutral",
    }
  );
}

export function formatReplayHistoryIdentity(item) {
  if (!item?.revealed) {
    return `匿名演练 · ${String(item?.id ?? "").slice(0, 8)}`;
  }

  const name = item.reveal?.name || "未知标的";
  const code = item.reveal?.tsCode || item.reveal?.symbol || "未知代码";
  return `${name} · ${code}`;
}

export function formatReplayCompletionReason(reason) {
  if (reason === "early") {
    return "提前交卷";
  }
  if (reason === "natural") {
    return "自然完成";
  }
  if (reason === "no_opportunity") {
    return "无交易机会";
  }
  return "尚未完成";
}

export function getReplayAttemptPresentation(attemptInfo) {
  if (attemptInfo?.kind === "retrain") {
    const attemptNumber = Math.max(2, Number(attemptInfo.attemptNumber) || 2);
    return {
      kind: "retrain",
      attemptNumber,
      label: `已知场景复练 · 第 ${attemptNumber} 次`,
      shortLabel: `复练 · 第 ${attemptNumber} 次`,
      scoreNote: "复练成绩，不计入首次盲测统计",
      countsTowardFirstScore: false,
    };
  }
  return {
    kind: "first",
    attemptNumber: 1,
    label: "首次盲测 · 计入首次成绩",
    shortLabel: "首次盲测",
    scoreNote: "计入首次盲测统计",
    countsTowardFirstScore: true,
  };
}

export function buildReplayHistoryScoreDimensions(scoreCard) {
  return buildReplayScoreDimensions(scoreCard);
}
