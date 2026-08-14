import { formatDisplayDate } from "./datePresentation.js";

export function formatCacheBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(1)} ${unit}`;
}

export function formatCacheCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Number(value) || 0));
}

export function formatCacheTime(value) {
  if (!value) return "暂无";
  return formatDisplayDate(value);
}

export function replayCacheProgress(payload) {
  const task = payload?.activeTask;
  const completed = Math.max(0, Number(task?.completed) || 0);
  const total = Math.max(0, Number(task?.total) || 0);
  if (task?.state !== "running" || total <= 0) return null;
  return {
    completed,
    total,
    percent: Math.min(100, Math.round((completed / total) * 100)),
  };
}
