const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/;

export function toDateInput(value) {
  const match = String(value ?? "").trim().match(DATE_PATTERN);
  return match ? match[1] : "";
}

export function toExecutionEventDate(value) {
  return toDateInput(value);
}
