export function buildReplayIntradaySeries(
  bars,
  { previousClose = 0, totalMinutes = 240 } = {},
) {
  const normalizedBars = Array.isArray(bars) ? bars : [];
  const priceValues = normalizedBars.map((bar) => Number(bar.close));
  const averageValues = [];
  let cumulativeAmount = 0;
  let cumulativeVolume = 0;
  for (const bar of normalizedBars) {
    cumulativeAmount += Number(bar.amount ?? 0);
    cumulativeVolume += Number(bar.volume ?? 0);
    averageValues.push(
      cumulativeVolume > 0
        ? cumulativeAmount / cumulativeVolume
        : Number(bar.close),
    );
  }

  const referencePrice = Number(previousClose) > 0
    ? Number(previousClose)
    : Number(priceValues[0] ?? 0);
  const maximumDeviation = Math.max(
    referencePrice * 0.01,
    ...priceValues.map((price) => Math.abs(price - referencePrice)),
    ...averageValues.map((price) => Math.abs(price - referencePrice)),
  ) * 1.05;

  return {
    priceValues,
    averageValues,
    xRatios: normalizedBars.map(
      (_, index) => index / Math.max(1, Number(totalMinutes) - 1),
    ),
    priceMin: referencePrice - maximumDeviation,
    priceMax: referencePrice + maximumDeviation,
    referencePrice,
    maxVolume: Math.max(0, ...normalizedBars.map((bar) => Number(bar.volume ?? 0))),
  };
}
