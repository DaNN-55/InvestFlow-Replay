const DATE_PREFIX_PATTERN = /^(\d{4})(?:([-/])(\d{1,2})\2(\d{1,2})|(\d{2})(\d{2}))(?:[T\s].*)?$/;

function getDateParts(value) {
  const match = String(value ?? "").trim().match(DATE_PREFIX_PATTERN);
  if (!match) return null;
  return {
    year: match[1],
    month: (match[3] ?? match[5]).padStart(2, "0"),
    day: (match[4] ?? match[6]).padStart(2, "0"),
  };
}

export function toDateInput(value) {
  const parts = getDateParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
}

export function formatDisplayDate(value, fallback = "--") {
  if (!value) return fallback;
  const parts = getDateParts(value);
  return parts ? `${parts.year}/${parts.month}/${parts.day}` : String(value);
}
