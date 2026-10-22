// Chart timestamps are deliberately synthetic. Cross-period linking must use
// replay-minute ranges, never array indexes or hidden calendar timestamps.
export function findReplayMinuteIndex(data, minute) {
  if (!data.length || !Number.isFinite(minute)) return -1;
  let low = 0, high = data.length - 1, found = -1;
  while (low <= high) { const mid = (low + high) >> 1; if (data[mid].startSequence <= minute) { found = mid; low = mid + 1; } else high = mid - 1; }
  return found >= 0 && minute <= data[found].endSequence ? found : -1;
}
export function replayRange(data, range) {
  if (!data.length) return null;
  const first = data[Math.max(0, Math.floor(range.from))];
  const last = data[Math.min(data.length - 1, Math.ceil(range.to) - 1)];
  return first && last ? { fromMinute:first.startSequence, toMinute:last.endSequence } : null;
}
