export const REPLAY_CANDLE_PANE_OPTIONS = Object.freeze({
  id: "candle_pane",
  gap: Object.freeze({ top: 0.12, bottom: 0.08 }),
  axisOptions: Object.freeze({ scrollZoomEnabled: false }),
});

export const REPLAY_RISE_COLOR = "#df7180";
export const REPLAY_FALL_COLOR = "#38ae86";

const BASE_CANDLE_TOOLTIP_LEGENDS = Object.freeze([
  Object.freeze({ title: "time", value: "{time}" }),
  Object.freeze({ title: "open", value: "{open}" }),
  Object.freeze({ title: "high", value: "{high}" }),
  Object.freeze({ title: "low", value: "{low}" }),
  Object.freeze({ title: "close", value: "{close}" }),
  Object.freeze({ title: "volume", value: "{volume}" }),
]);

export function createReplayChartStyles({
  background,
  grid,
  text,
  rise = REPLAY_RISE_COLOR,
  fall = REPLAY_FALL_COLOR,
  mainIndicatorLegends = () => [],
}) {
  return {
    grid: {
      horizontal: { color: grid },
      vertical: { color: grid },
    },
    candle: {
      bar: {
        upColor: rise,
        downColor: fall,
        noChangeColor: text,
        upBorderColor: rise,
        downBorderColor: fall,
        noChangeBorderColor: text,
        upWickColor: rise,
        downWickColor: fall,
        noChangeWickColor: text,
      },
      tooltip: {
        custom: (data) => [
          ...BASE_CANDLE_TOOLTIP_LEGENDS,
          ...(mainIndicatorLegends(data.current?.replayIndex) ?? []),
        ],
      },
    },
    xAxis: {
      axisLine: { color: grid },
      tickLine: { color: grid },
      tickText: { color: text },
    },
    yAxis: {
      type: "normal",
      position: "right",
      inside: false,
      reverse: false,
      axisLine: { color: grid },
      tickLine: { color: grid },
      tickText: { color: text },
    },
    separator: { color: grid, fill: true, activeBackgroundColor: background },
    crosshair: {
      show: true,
      horizontal: {
        show: true,
        line: { show: true, color: text },
        text: {
          show: true,
          color: "#ffffff",
          borderColor: text,
          backgroundColor: text,
        },
      },
      vertical: {
        show: true,
        line: { show: true, color: text },
        text: {
          show: true,
          color: "#ffffff",
          borderColor: text,
          backgroundColor: text,
        },
      },
    },
  };
}
