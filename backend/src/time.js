const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toBeijingDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + BEIJING_OFFSET_MS);
}

export function formatBeijingDateTime(value = new Date()) {
  const beijingDate = toBeijingDate(value);
  return (
    [
      beijingDate.getUTCFullYear(),
      pad2(beijingDate.getUTCMonth() + 1),
      pad2(beijingDate.getUTCDate()),
    ].join("-") +
    ` ${pad2(beijingDate.getUTCHours())}:${pad2(beijingDate.getUTCMinutes())}:${pad2(beijingDate.getUTCSeconds())}`
  );
}

export function formatBeijingDate(value = new Date()) {
  return formatBeijingDateTime(value).slice(0, 10);
}

export function formatBeijingFileStamp(value = new Date()) {
  return formatBeijingDateTime(value).replace(" ", "T").replaceAll(":", "-");
}
