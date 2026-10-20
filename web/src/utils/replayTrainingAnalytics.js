export const REPLAY_ISSUE_TAGS = Object.freeze(["提前入场", "追涨", "仓位过大", "退出犹豫", "偏离计划", "无明确依据"]);

export function formatTrainingMetric(value, suffix = "%") {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toFixed(2)}${suffix}`;
}

export function trainingCohortLabel(cohort) {
  if (!cohort?.n) return "暂无样本";
  return `${cohort.from || '—'} 至 ${cohort.to || '—'} · ${cohort.n} 次`;
}

export function trainingBucketWidth(count, total) {
  if (!(Number(total) > 0)) return "0%";
  return `${Math.max(0, Math.min(100, Number(count) / Number(total) * 100))}%`;
}

export function trainingSampleDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
