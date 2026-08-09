import { buildReplayCustomIndicatorRows } from "./replayKlineAdapter.js";
import {
  REPLAY_FALL_COLOR,
  REPLAY_RISE_COLOR,
} from "./replayKlineConfig.js";

const BUILTIN_PARAMS = Object.freeze({
  VOL: [5, 10, 20],
  MA: [5, 10, 30, 60],
  BOLL: [20, 2],
  MACD: [12, 26, 9],
  RSI: [6, 12, 24],
  KDJ: [9, 3, 3],
});

function volumeFigures() {
  return [
    { key: "ma1", title: "MA5: ", type: "line" },
    { key: "ma2", title: "MA10: ", type: "line" },
    { key: "ma3", title: "MA20: ", type: "line" },
    {
      key: "volume",
      title: "VOL: ",
      type: "bar",
      baseValue: 0,
      styles: ({ current }) => {
        const row = current?.kLineData;
        return {
          color: Number(row?.close) >= Number(row?.open)
            ? REPLAY_RISE_COLOR
            : REPLAY_FALL_COLOR,
        };
      },
    },
  ];
}

function macdFigures() {
  return [
    { key: "dif", title: "DIF: ", type: "line" },
    { key: "dea", title: "DEA: ", type: "line" },
    {
      key: "macd",
      title: "MACD: ",
      type: "bar",
      baseValue: 0,
      styles: ({ prev, current }) => {
        const value = Number(current?.indicatorData?.macd);
        const previous = Number(prev?.indicatorData?.macd);
        const color = value >= 0 ? REPLAY_RISE_COLOR : REPLAY_FALL_COLOR;
        const sameSide = Number.isFinite(previous) && Math.sign(previous) === Math.sign(value);
        const expanding = !sameSide || Math.abs(value) >= Math.abs(previous);
        return {
          style: expanding ? "fill" : "stroke",
          color,
          borderColor: color,
          borderSize: 1,
        };
      },
    },
  ];
}

function hiddenTooltipDataSource() {
  return { name: "", calcParamsText: "", values: [], icons: [] };
}

export function createReplayBuiltinIndicatorConfig(name, placement = "sub") {
  return {
    name,
    calcParams: BUILTIN_PARAMS[name],
    ...(name === "VOL" ? { figures: volumeFigures() } : {}),
    ...(name === "MACD" ? { figures: macdFigures() } : {}),
    ...(placement === "main"
      ? { createTooltipDataSource: hiddenTooltipDataSource }
      : {}),
  };
}

export function replayCustomIndicatorName(id) {
  const suffix = String(id ?? "indicator")
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/gu, "") || "indicator";
  return `REPLAY_CUSTOM_${suffix}`;
}

function figureStyles(series) {
  if (series.type === "histogram") {
    return ({ current }) => {
      const value = Number(current?.indicatorData?.[series.key]);
      return {
        color: value >= 0
          ? (series.positiveColor ?? series.color ?? "#ef4444")
          : (series.negativeColor ?? "#10b981"),
      };
    };
  }
  return () => ({ color: series.color ?? "#2563eb", size: 1.5 });
}

function rangeBarFigure(series) {
  return {
    key: series.key,
    title: series.label ?? series.key,
    type: "bar",
    attrs: ({ data, coordinate, barSpace, yAxis }) => {
      const from = Number(data.current?.[`${series.key}From`]);
      const to = Number(data.current?.[series.key]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return null;
      }
      const yFrom = yAxis.convertToPixel(from);
      const yTo = yAxis.convertToPixel(to);
      return {
        x: coordinate.current.x - barSpace.halfGapBar,
        y: Math.min(yFrom, yTo),
        width: Math.max(2, barSpace.gapBar),
        height: Math.max(1, Math.abs(yTo - yFrom)),
      };
    },
    styles: ({ current }) => {
      const from = Number(current?.indicatorData?.[`${series.key}From`]);
      const to = Number(current?.indicatorData?.[series.key]);
      return {
        color: to >= from
          ? (series.risingColor ?? series.color ?? "#ef4444")
          : (series.fallingColor ?? "#10b981"),
      };
    },
  };
}

export function createReplayCustomIndicatorTemplate(indicator, dataLength) {
  const series = Array.isArray(indicator?.series)
    ? indicator.series.map((item, index) => ({
        ...item,
        key: String(item?.key ?? `series${index + 1}`),
        type: item?.type ?? "line",
      }))
    : [];
  const rows = buildReplayCustomIndicatorRows(series, dataLength);
  return {
    name: replayCustomIndicatorName(indicator?.id),
    shortName: String(indicator?.name ?? "自定义指标"),
    precision: 2,
    shouldOhlc: false,
    shouldFormatBigNumber: false,
    figures: series.flatMap((item) => {
      if (item.type === "rangeBar") {
        return [rangeBarFigure(item)];
      }
      return [{
        key: item.key,
        title: item.label ?? item.key,
        type: item.type === "histogram" ? "bar" : "line",
        ...(item.type === "histogram" ? { baseValue: 0 } : {}),
        styles: figureStyles(item),
      }];
    }),
    calc: () => rows,
    ...(indicator?.placement === "main"
      ? { createTooltipDataSource: hiddenTooltipDataSource }
      : {}),
    draw: null,
  };
}

function legend(title, value, color) {
  return {
    title: { text: `${String(title ?? "").trim()}: `, color },
    value: { text: Number(value).toFixed(2), color },
  };
}

export function buildReplayMainIndicatorLegends({
  model = {},
  replayIndex,
  builtins = [],
} = {}) {
  if (!Number.isSafeInteger(replayIndex) || replayIndex < 0) {
    return [];
  }
  const result = [];
  for (const indicator of builtins) {
    const row = indicator?.result?.[replayIndex] ?? {};
    const figures = Array.isArray(indicator?.figures) ? indicator.figures : [];
    figures.forEach((figure, index) => {
      const value = Number(row?.[figure.key]);
      if (!Number.isFinite(value) || typeof figure.title !== "string") {
        return;
      }
      const color = indicator.colors?.[index] ?? "#64748b";
      result.push(legend(figure.title.replace(/:\s*$/u, ""), value, color));
    });
  }
  for (const indicator of model.custom ?? []) {
    if (indicator?.placement !== "main" || indicator?.error) {
      continue;
    }
    for (const series of indicator.series ?? []) {
      const value = Number(series?.values?.[replayIndex]);
      if (!Number.isFinite(value)) {
        continue;
      }
      result.push(legend(
        series.label ?? indicator.name,
        value,
        series.color ?? "#2563eb",
      ));
    }
  }
  return result;
}
