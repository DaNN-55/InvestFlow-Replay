const SYNTHETIC_START = Date.UTC(2000, 0, 3);
const PERIOD_STEPS = Object.freeze({
  minute: 60_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 31 * 86_400_000,
});

export class ReplayKlineDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplayKlineDataError";
  }
}

function finiteNumber(value, field, index) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ReplayKlineDataError(
      `第 ${index + 1} 根 K 线的 ${field} 不是有效数字。`,
    );
  }
  return numeric;
}

function optionalFiniteNumber(value, fallback, field, index) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return finiteNumber(value, field, index);
}

function resolvePeriod(bars) {
  const period = String(bars[0]?.period ?? "day");
  return PERIOD_STEPS[period] ? period : "day";
}

function createReplayKey(bar, index, period) {
  const sequence = Number(bar?.startSequence);
  return `${period}:${Number.isFinite(sequence) ? sequence : index + 1}`;
}

export function adaptReplayBars(bars = []) {
  if (!Array.isArray(bars)) {
    throw new ReplayKlineDataError("K 线数据必须是数组。");
  }
  const period = resolvePeriod(bars);
  const step = PERIOD_STEPS[period];
  const labelByTimestamp = new Map();
  const data = bars.map((bar, index) => {
    const open = finiteNumber(bar?.open, "开盘价", index);
    const high = finiteNumber(bar?.high, "最高价", index);
    const low = finiteNumber(bar?.low, "最低价", index);
    const close = finiteNumber(bar?.close, "收盘价", index);
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw new ReplayKlineDataError(
        `第 ${index + 1} 根 K 线的高低价与开收盘价不一致。`,
      );
    }
    const timestamp = SYNTHETIC_START + index * step;
    const replayLabel = String(
      bar?.datetime ?? bar?.displayLabel ?? `第${index + 1}根`,
    );
    labelByTimestamp.set(timestamp, replayLabel);
    return {
      timestamp,
      open,
      high,
      low,
      close,
      volume: optionalFiniteNumber(bar?.volume, 0, "成交量", index),
      amount: optionalFiniteNumber(bar?.amount, 0, "成交额", index),
      replayIndex: index,
      replayKey: createReplayKey(bar, index, period),
      replayLabel,
      startSequence: optionalFiniteNumber(
        bar?.startSequence,
        index + 1,
        "起始序号",
        index,
      ),
      endSequence: optionalFiniteNumber(
        bar?.endSequence,
        index + 1,
        "结束序号",
        index,
      ),
    };
  });
  return { data, labelByTimestamp, period };
}

export function classifyReplayKlineUpdate(previous = [], next = []) {
  if (!previous.length || !next.length || previous.length > next.length) {
    return "replace";
  }
  if (next.length === previous.length + 1) {
    const prefixMatches = previous.every(
      (item, index) => item.replayKey === next[index]?.replayKey,
    );
    return prefixMatches ? "append" : "replace";
  }
  if (next.length !== previous.length) {
    return "replace";
  }
  const stablePrefix = previous
    .slice(0, -1)
    .every((item, index) => item.replayKey === next[index]?.replayKey);
  if (
    stablePrefix &&
    previous.at(-1)?.replayKey === next.at(-1)?.replayKey
  ) {
    return JSON.stringify(previous.at(-1)) === JSON.stringify(next.at(-1))
      ? "noop"
      : "tail-update";
  }
  return "replace";
}

export function getReplayWheelZoomScale(event = {}) {
  if (!event.ctrlKey && !event.metaKey) {
    return null;
  }
  const deltaY = Number(event.deltaY);
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return null;
  }
  return deltaY < 0 ? 1.08 : 0.92;
}

export function adaptReplayTrades(trades = [], data = []) {
  const barByLabel = new Map(
    data.map((item) => [String(item.replayLabel), item]),
  );
  return (Array.isArray(trades) ? trades : []).flatMap((trade, index) => {
    const sequence = Number(trade?.sequence);
    const sequenceBar = Number.isFinite(sequence)
      ? data.find(
          (item) =>
            sequence >= item.startSequence && sequence <= item.endSequence,
        )
      : null;
    const matchedBar = sequenceBar ??
      barByLabel.get(String(trade?.datetime ?? ""));
    const executionPrice = Number(trade?.price);
    if (!matchedBar || !Number.isFinite(executionPrice)) {
      return [];
    }
    const direction = String(trade?.direction ?? "").toLowerCase();
    const side = direction.includes("sell") || direction.includes("short")
      ? "sell"
      : "buy";
    return [{
      id: `replay-trade-${String(trade?.id ?? index)}`,
      timestamp: matchedBar.timestamp,
      value: side === "sell" ? matchedBar.high : matchedBar.low,
      side,
      text: side === "buy" ? "B" : "S",
      price: executionPrice,
      quantity: Number(trade?.quantity) || 0,
    }];
  });
}

export function createReplayTradeMarkerFigures({
  overlay,
  coordinates = [],
  bounding = {},
} = {}) {
  const point = coordinates[0];
  if (!point) {
    return [];
  }
  const side = overlay?.extendData?.side === "sell" ? "sell" : "buy";
  const color = side === "buy" ? REPLAY_RISE_COLOR : REPLAY_FALL_COLOR;
  const mutedColor = side === "buy"
    ? "rgba(223, 113, 128, 0.72)"
    : "rgba(56, 174, 134, 0.72)";
  const width = Number(bounding.width) || 0;
  const height = Number(bounding.height) || 0;
  const x = Math.max(14, Math.min(width - 14, point.x));
  const y = Math.max(14, Math.min(
    height - 14,
    point.y + (side === "buy" ? 26 : -26),
  ));
  const expanded = Boolean(overlay?.extendData?.expanded);
  const figures = [{
    key: "badge",
    type: "circle",
    attrs: { x, y, r: 11 },
    styles: {
      style: "stroke_fill",
      color: "rgba(255, 255, 255, 0.88)",
      borderColor: mutedColor,
      borderSize: 3,
    },
    ignoreEvent: false,
  }, {
    key: "badge-label",
    type: "text",
    attrs: {
      x,
      y,
      text: overlay?.extendData?.text ?? (side === "buy" ? "B" : "S"),
      align: "center",
      baseline: "middle",
    },
    styles: {
      color: mutedColor,
      size: 12,
      weight: "800",
      borderSize: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      backgroundColor: "transparent",
    },
    ignoreEvent: false,
  }];
  if (!expanded) {
    return figures;
  }

  const price = Number(overlay?.extendData?.price);
  const quantity = Number(overlay?.extendData?.quantity);
  const detail = [
    Number.isFinite(price) ? `¥${price.toFixed(2)}` : "",
    quantity > 0 ? `${quantity}股` : "",
  ].filter(Boolean).join(" · ");
  if (!detail) {
    return figures;
  }
  const openToLeft = x > width - 118;
  const lineEndX = x + (openToLeft ? -20 : 20);
  figures.push({
    key: "detail-line",
    type: "line",
    attrs: { coordinates: [{ x, y }, { x: lineEndX, y }] },
    styles: { style: "solid", size: 2, color },
    ignoreEvent: true,
  }, {
    key: "detail-label",
    type: "text",
    attrs: {
      x: lineEndX + (openToLeft ? -5 : 5),
      y,
      text: detail,
      align: openToLeft ? "right" : "left",
      baseline: "middle",
    },
    styles: {
      color: "#ffffff",
      size: 11,
      weight: "700",
      borderSize: 0,
      borderRadius: 4,
      backgroundColor: color,
      paddingLeft: 6,
      paddingRight: 6,
      paddingTop: 4,
      paddingBottom: 4,
    },
    ignoreEvent: true,
  });
  return figures;
}

function normalizeIndicatorValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function buildReplayCustomIndicatorRows(series = [], dataLength = 0) {
  if (!Number.isSafeInteger(dataLength) || dataLength < 0) {
    throw new Error("K 线长度必须是非负整数。");
  }
  const keys = new Set();
  for (const item of series) {
    const key = String(item?.key ?? "").trim();
    if (!key || keys.has(key)) {
      throw new Error("自定义指标序列必须使用唯一 key。");
    }
    keys.add(key);
    if (!Array.isArray(item.values) || item.values.length !== dataLength) {
      throw new Error(`指标序列“${key}”长度必须与 K 线一致。`);
    }
    if (
      item.type === "rangeBar" &&
      (!Array.isArray(item.fromValues) || item.fromValues.length !== dataLength)
    ) {
      throw new Error(`指标序列“${key}”的起始值长度必须与 K 线一致。`);
    }
  }
  return Array.from({ length: dataLength }, (_, index) => {
    const row = {};
    for (const item of series) {
      const key = String(item.key).trim();
      row[key] = normalizeIndicatorValue(item.values[index]);
      if (item.type === "rangeBar") {
        row[`${key}From`] = normalizeIndicatorValue(item.fromValues[index]);
      }
    }
    return row;
  });
}
import {
  REPLAY_FALL_COLOR,
  REPLAY_RISE_COLOR,
} from "./replayKlineConfig.js";
