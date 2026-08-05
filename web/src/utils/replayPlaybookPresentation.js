const candidateStatusPresentation = {
  pending: { label: "待处理", tone: "warning" },
  accepted: { label: "已采纳", tone: "success" },
  rejected: { label: "已拒绝", tone: "neutral" },
};

export function getPlaybookVersionNumber(playbook) {
  return Number(
    playbook?.currentVersion?.versionNumber ??
      playbook?.currentVersionNumber ??
      0,
  );
}

export function getCandidateStatusPresentation(status) {
  return (
    candidateStatusPresentation[status] ?? {
      label: status || "未知状态",
      tone: "neutral",
    }
  );
}

export function getCandidateSuggestion(candidate) {
  return String(
    candidate?.suggestion ??
      candidate?.strategyAdjustment ??
      candidate?.content ??
      "",
  ).trim();
}

export function getCandidateSessionId(candidate) {
  return String(
    candidate?.sessionId ??
      candidate?.sourceSessionId ??
      candidate?.replaySessionId ??
      "",
  );
}

export function buildCandidateVersionDraft(playbook, candidate) {
  const currentContent = String(playbook?.currentVersion?.content ?? "").trim();
  const suggestion = getCandidateSuggestion(candidate);
  const sections = [currentContent];
  if (suggestion) {
    sections.push(`候选改进：\n${suggestion}`);
  }
  return {
    expectedVersionNumber: getPlaybookVersionNumber(playbook),
    content: sections.filter(Boolean).join("\n\n"),
    changeSummary: suggestion
      ? `采纳源演练候选：${suggestion.slice(0, 80)}`
      : "采纳源演练候选改进",
  };
}

export function formatPlaybookTime(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
