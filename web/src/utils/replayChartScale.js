function finiteValues(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
}

function paddedRange(values) {
  if (!values.length) {
    return null;
  }
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(
    (rawMax - rawMin) * 0.08,
    Math.abs(rawMax) * 0.01,
    0.2,
  );
  return {
    min: rawMin - padding,
    max: rawMax + padding,
  };
}

export function resolveReplayMainChartRange({
  lows = [],
  highs = [],
  overlays = [],
} = {}) {
  const overlayValues = overlays.flatMap((overlay) =>
    finiteValues(overlay?.values),
  );
  return (
    paddedRange([
      ...finiteValues(lows),
      ...finiteValues(highs),
      ...overlayValues,
    ]) ?? { min: 0, max: 1 }
  );
}

export function resolveReplayChartPointer({
  clientX,
  clientY,
  bounds,
  chartWidth,
  chartHeight,
  padding,
  visibleCount,
  visibleStart = 0,
  priceRange,
} = {}) {
  if (
    !bounds ||
    !padding ||
    !priceRange ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isSafeInteger(visibleCount) ||
    visibleCount <= 0
  ) {
    return null;
  }

  const x = ((clientX - bounds.left) / bounds.width) * chartWidth;
  const y = ((clientY - bounds.top) / bounds.height) * chartHeight;
  const plotRight = chartWidth - padding.right;
  const plotBottom = chartHeight - padding.bottom;
  if (
    x < padding.left ||
    x > plotRight ||
    y < padding.top ||
    y > plotBottom
  ) {
    return null;
  }

  const innerWidth = plotRight - padding.left;
  const innerHeight = plotBottom - padding.top;
  const rawIndex =
    ((x - padding.left) / Math.max(innerWidth, 1)) * visibleCount - 0.5;
  const localIndex = Math.min(
    Math.max(Math.round(rawIndex), 0),
    visibleCount - 1,
  );
  const price =
    priceRange.max -
    ((y - padding.top) / Math.max(innerHeight, 1)) *
      (priceRange.max - priceRange.min);

  return {
    x,
    y,
    price,
    localIndex,
    globalIndex: visibleStart + localIndex,
  };
}
