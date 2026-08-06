<script setup>
import { Pencil, Trash2 } from "lucide-vue-next";
import { computed } from "vue";

const props = defineProps({
  title: {
    type: String,
    required: true,
  },
  bars: {
    type: Array,
    default: () => [],
  },
  series: {
    type: Array,
    default: () => [],
  },
  error: {
    type: String,
    default: "",
  },
  editable: {
    type: Boolean,
    default: false,
  },
  visibleRange: {
    type: Object,
    default: null,
  },
  sharedHoverIndex: {
    type: Number,
    default: null,
  },
});

const emit = defineEmits(["edit", "remove", "hover-index-change"]);

const width = 1120;
const height = 126;
const padding = { top: 17, right: 48, bottom: 24, left: 12 };

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

const normalizedRange = computed(() => {
  const total = props.bars.length;
  if (!total) {
    return { start: 0, endExclusive: 0, visibleCount: 0, total: 0 };
  }
  const start = clamp(
    Number(props.visibleRange?.start ?? 0),
    0,
    Math.max(total - 1, 0),
  );
  const requestedEnd = Number(
    props.visibleRange?.endExclusive ??
      start + Number(props.visibleRange?.visibleCount ?? total),
  );
  const endExclusive = clamp(requestedEnd, start + 1, total);
  return {
    start,
    endExclusive,
    visibleCount: endExclusive - start,
    total,
  };
});

const visibleBars = computed(() =>
  props.bars.slice(
    normalizedRange.value.start,
    normalizedRange.value.endExclusive,
  ),
);
const visibleSeries = computed(() =>
  props.series.map((item) => ({
    ...item,
    values: item.values.slice(
      normalizedRange.value.start,
      normalizedRange.value.endExclusive,
    ),
    ...(Array.isArray(item.fromValues)
      ? {
          fromValues: item.fromValues.slice(
            normalizedRange.value.start,
            normalizedRange.value.endExclusive,
          ),
        }
      : {}),
  })),
);

const numericValues = computed(() =>
  visibleSeries.value.flatMap((item) =>
    [...item.values, ...(item.fromValues ?? [])]
      .filter(
        (value) => value !== null && value !== undefined && value !== "",
      )
      .map(Number)
      .filter(Number.isFinite),
  ),
);

const valueRange = computed(() => {
  if (!numericValues.value.length) {
    return { min: 0, max: 1 };
  }
  let min = Math.min(...numericValues.value);
  let max = Math.max(...numericValues.value);
  if (visibleSeries.value.some((item) => item.type === "histogram")) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    const offset = Math.max(Math.abs(min) * 0.1, 1);
    return { min: min - offset, max: max + offset };
  }
  const offset = (max - min) * 0.08;
  return { min: min - offset, max: max + offset };
});

function scaleX(index) {
  const innerWidth = width - padding.left - padding.right;
  return (
    padding.left +
    (index / Math.max(visibleBars.value.length - 1, 1)) * innerWidth
  );
}

function scaleY(value) {
  const innerHeight = height - padding.top - padding.bottom;
  const ratio =
    (Number(value) - valueRange.value.min) /
    (valueRange.value.max - valueRange.value.min || 1);
  return height - padding.bottom - ratio * innerHeight;
}

function buildLinePath(values) {
  let drawing = false;
  return values
    .map((value, index) => {
      if (value == null || !Number.isFinite(Number(value))) {
        drawing = false;
        return "";
      }
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command} ${scaleX(index).toFixed(2)} ${scaleY(value).toFixed(2)}`;
    })
    .filter(Boolean)
    .join(" ");
}

const renderedSeries = computed(() =>
  visibleSeries.value.map((item) => ({
    ...item,
    path: ["histogram", "rangeBar"].includes(item.type)
      ? ""
      : buildLinePath(item.values),
  })),
);

const histogramBars = computed(() => {
  const histogram = visibleSeries.value.find(
    (item) => item.type === "histogram",
  );
  if (!histogram || visibleBars.value.length === 0) {
    return [];
  }
  const baseY = scaleY(0);
  const barWidth = Math.max(
    Math.min(
      (width - padding.left - padding.right) / visibleBars.value.length - 1,
      7,
    ),
    1,
  );
  return histogram.values.flatMap((value, index) => {
    if (value == null || !Number.isFinite(Number(value))) {
      return [];
    }
    const y = scaleY(value);
    return [
      {
        x: scaleX(index) - barWidth / 2,
        y: Math.min(y, baseY),
        width: barWidth,
        height: Math.max(Math.abs(baseY - y), 1),
        color:
          Number(value) >= 0
            ? histogram.positiveColor ?? "#ef4444"
            : histogram.negativeColor ?? "#10b981",
      },
    ];
  });
});

const rangeBars = computed(() => {
  if (visibleBars.value.length === 0) {
    return [];
  }
  const barWidth = Math.max(
    Math.min(
      (width - padding.left - padding.right) / visibleBars.value.length - 1,
      7,
    ),
    1,
  );
  return visibleSeries.value.flatMap((item) => {
    if (item.type !== "rangeBar" || !Array.isArray(item.fromValues)) {
      return [];
    }
    return item.values.flatMap((value, index) => {
      const fromValue = item.fromValues[index];
      if (
        value == null ||
        fromValue == null ||
        !Number.isFinite(Number(value)) ||
        !Number.isFinite(Number(fromValue)) ||
        Number(value) === Number(fromValue)
      ) {
        return [];
      }
      const fromY = scaleY(fromValue);
      const toY = scaleY(value);
      return [{
        x: scaleX(index) - barWidth / 2,
        y: Math.min(fromY, toY),
        width: barWidth,
        height: Math.max(Math.abs(fromY - toY), 1),
        color:
          Number(value) > Number(fromValue)
            ? item.risingColor
            : item.fallingColor,
      }];
    });
  });
});

const latestValues = computed(() =>
  visibleSeries.value.map((item) => {
    const hoverLocalIndex =
      props.sharedHoverIndex == null
        ? -1
        : props.sharedHoverIndex - normalizedRange.value.start;
    const hoverValue =
      hoverLocalIndex >= 0 && hoverLocalIndex < item.values.length
        ? item.values[hoverLocalIndex]
        : null;
    const last =
      hoverValue ??
      item.values.findLast(
        (value) => value != null && Number.isFinite(Number(value)),
      );
    return {
      label: item.label,
      color: item.color,
      value: last == null ? "--" : Number(last).toFixed(2),
    };
  }),
);

const hoverLocalIndex = computed(() => {
  if (props.sharedHoverIndex == null) {
    return null;
  }
  const index = props.sharedHoverIndex - normalizedRange.value.start;
  return index >= 0 && index < visibleBars.value.length ? index : null;
});
const hoverX = computed(() =>
  hoverLocalIndex.value == null ? 0 : scaleX(hoverLocalIndex.value),
);

const tickLabels = computed(() => {
  if (!visibleBars.value.length) {
    return [];
  }
  const steps = Math.min(7, visibleBars.value.length);
  return Array.from({ length: steps }, (_, index) => {
    const barIndex = Math.min(
      Math.round(
        (index / Math.max(steps - 1, 1)) * (visibleBars.value.length - 1),
      ),
      visibleBars.value.length - 1,
    );
    const text = String(visibleBars.value[barIndex]?.datetime ?? "");
    return {
      x: scaleX(barIndex),
      label: /^\d{4}-\d{2}-\d{2}/u.test(text)
        ? text.slice(5, 10)
        : text,
    };
  });
});

function pointerToGlobalIndex(event) {
  const bounds = event.currentTarget?.getBoundingClientRect?.();
  if (!bounds || !visibleBars.value.length) {
    return null;
  }
  const viewBoxX =
    ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * width;
  const ratio = clamp(
    (viewBoxX - padding.left) / (width - padding.left - padding.right),
    0,
    1,
  );
  const localIndex = Math.round(ratio * (visibleBars.value.length - 1));
  return normalizedRange.value.start + localIndex;
}

function updateHover(event) {
  const index = pointerToGlobalIndex(event);
  if (index !== props.sharedHoverIndex) {
    emit("hover-index-change", index);
  }
}

function clearHover() {
  if (props.sharedHoverIndex !== null) {
    emit("hover-index-change", null);
  }
}
</script>

<template>
  <article class="replay-indicator-panel">
    <header class="replay-indicator-panel__header">
      <div class="replay-indicator-panel__heading">
        <h3>{{ title }}</h3>
        <span
          v-for="item in latestValues"
          :key="item.label"
          :style="{ color: item.color }"
        >
          {{ item.label }} {{ item.value }}
        </span>
      </div>
      <div v-if="editable" class="replay-indicator-panel__actions">
        <button type="button" aria-label="编辑指标" @click="emit('edit')">
          <Pencil :size="13" />
        </button>
        <button type="button" aria-label="删除指标" @click="emit('remove')">
          <Trash2 :size="13" />
        </button>
      </div>
    </header>

    <div v-if="error" class="replay-indicator-panel__error" role="status">
      表达式无法计算：{{ error }}
    </div>
    <div v-else-if="!visibleBars.length" class="replay-indicator-panel__empty">
      暂无已揭示行情
    </div>
    <svg
      v-else
      :viewBox="`0 0 ${width} ${height}`"
      preserveAspectRatio="none"
      class="replay-indicator-panel__chart"
      role="img"
      :aria-label="`${title} 指标图`"
      @pointermove="updateHover"
      @pointerleave="clearHover"
    >
      <line
        v-for="ratio in [0.25, 0.5, 0.75]"
        :key="ratio"
        :x1="padding.left"
        :x2="width - padding.right"
        :y1="padding.top + (height - padding.top - padding.bottom) * ratio"
        :y2="padding.top + (height - padding.top - padding.bottom) * ratio"
        stroke="rgba(148, 163, 184, 0.17)"
        stroke-dasharray="4 6"
      />
      <line
        v-if="histogramBars.length"
        :x1="padding.left"
        :x2="width - padding.right"
        :y1="scaleY(0)"
        :y2="scaleY(0)"
        stroke="rgba(100, 116, 139, 0.32)"
      />
      <rect
        v-for="(bar, index) in histogramBars"
        :key="index"
        v-bind="bar"
        :fill="bar.color"
        fill-opacity="0.62"
        rx="0.5"
      />
      <rect
        v-for="(bar, index) in rangeBars"
        :key="`range-${index}`"
        v-bind="bar"
        :fill="bar.color"
        fill-opacity="0.82"
        rx="0.5"
      />
      <path
        v-for="item in renderedSeries.filter((entry) => entry.path)"
        :key="item.label"
        :d="item.path"
        fill="none"
        :stroke="item.color"
        stroke-width="1.8"
        vector-effect="non-scaling-stroke"
      />
      <line
        v-if="hoverLocalIndex !== null"
        :x1="hoverX"
        :x2="hoverX"
        :y1="padding.top"
        :y2="height - padding.bottom"
        stroke="#94a3b8"
        stroke-dasharray="4 5"
        stroke-width="1"
      />
      <circle
        v-for="item in renderedSeries.filter(
          (entry) =>
            hoverLocalIndex !== null &&
            entry.values[hoverLocalIndex] != null &&
            Number.isFinite(Number(entry.values[hoverLocalIndex])),
        )"
        :key="`hover-${item.label}`"
        :cx="hoverX"
        :cy="scaleY(item.values[hoverLocalIndex])"
        r="3"
        :fill="item.color"
        stroke="#fff"
        stroke-width="1"
      />
      <text
        :x="width - padding.right + 7"
        :y="padding.top + 4"
        class="replay-indicator-panel__axis"
      >
        {{ valueRange.max.toFixed(2) }}
      </text>
      <text
        :x="width - padding.right + 7"
        :y="height - padding.bottom + 3"
        class="replay-indicator-panel__axis"
      >
        {{ valueRange.min.toFixed(2) }}
      </text>
      <text
        v-for="label in tickLabels"
        :key="`${label.x}-${label.label}`"
        :x="label.x"
        :y="height - 7"
        text-anchor="middle"
        class="replay-indicator-panel__axis"
      >
        {{ label.label }}
      </text>
    </svg>
  </article>
</template>

<style scoped>
.replay-indicator-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ql-line);
  border-radius: 9px;
  background: var(--ql-color-bg-surface-strong);
}

.replay-indicator-panel__header {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 9px 5px 12px;
  border-bottom: 1px solid var(--ql-line);
}

.replay-indicator-panel__heading {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.replay-indicator-panel h3 {
  margin: 0;
  color: var(--ql-ink);
  font-size: 11px;
  font-weight: 740;
}

.replay-indicator-panel__heading span {
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 10px;
  font-weight: 650;
}

.replay-indicator-panel__actions {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.replay-indicator-panel__actions button {
  display: grid;
  width: 26px;
  min-height: 26px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  color: var(--ql-color-text-muted);
  background: transparent;
  cursor: pointer;
}

.replay-indicator-panel__actions button:hover {
  color: var(--ql-accent);
  background: var(--ql-color-primary-soft);
}

.replay-indicator-panel__chart {
  display: block;
  width: 100%;
  height: 126px;
  background: var(--ql-color-bg-muted);
}

.replay-indicator-panel__axis {
  fill: var(--ql-color-text-subtle);
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 9px;
}

.replay-indicator-panel__error,
.replay-indicator-panel__empty {
  display: flex;
  min-height: 86px;
  align-items: center;
  justify-content: center;
  padding: 12px;
  text-align: center;
  font-size: 11px;
}

.replay-indicator-panel__error {
  color: #b91c1c;
  background: var(--ql-color-danger-soft);
}

.replay-indicator-panel__empty {
  color: var(--ql-color-text-muted);
}
</style>
