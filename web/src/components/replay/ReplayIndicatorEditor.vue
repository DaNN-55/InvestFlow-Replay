<script setup>
import { reactive, watch } from "vue";

import { validateReplayAdvancedIndicatorConfig } from "../../utils/replayIndicatorEngine";

const props = defineProps({
  indicator: {
    type: Object,
    default: null,
  },
});

const emit = defineEmits(["save", "cancel"]);

const form = reactive({
  id: "",
  name: "",
  mode: "simple",
  expression: "",
  placement: "sub",
  color: "#2563eb",
  definitions: "",
  plotType: "rangeBar",
  plotLabel: "",
  plotExpression: "",
  fromExpression: "",
  toExpression: "",
  risingColor: "#ef4444",
  fallingColor: "#10b981",
  negativeColor: "#10b981",
});

const fieldErrors = reactive({
  name: "",
  expression: "",
  advanced: "",
});

function resetForm(indicator) {
  const plot = indicator?.advanced?.plot ?? {};
  form.id = indicator?.id ?? "";
  form.name = indicator?.name ?? "";
  form.mode = indicator?.mode === "advanced" ? "advanced" : "simple";
  form.expression = indicator?.expression ?? "";
  form.placement = indicator?.placement === "main" ? "main" : "sub";
  form.color = indicator?.color ?? "#2563eb";
  form.definitions = indicator?.advanced?.definitions ?? "";
  form.plotType = ["line", "histogram", "rangeBar"].includes(plot.type)
    ? plot.type
    : "rangeBar";
  form.plotLabel = plot.label ?? indicator?.name ?? "";
  form.plotExpression = plot.expression ?? "";
  form.fromExpression = plot.fromExpression ?? "";
  form.toExpression = plot.toExpression ?? "";
  form.risingColor = plot.risingColor ?? "#ef4444";
  form.fallingColor = plot.fallingColor ?? "#10b981";
  form.negativeColor = plot.negativeColor ?? "#10b981";
  fieldErrors.name = "";
  fieldErrors.expression = "";
  fieldErrors.advanced = "";
}

function buildAdvancedConfig() {
  const label = form.plotLabel.trim() || form.name.trim();
  const plot = form.plotType === "rangeBar"
    ? {
        type: "rangeBar",
        label,
        fromExpression: form.fromExpression.trim(),
        toExpression: form.toExpression.trim(),
        risingColor: form.risingColor,
        fallingColor: form.fallingColor,
      }
    : {
        type: form.plotType,
        label,
        expression: form.plotExpression.trim(),
        color: form.color,
        negativeColor: form.negativeColor,
      };
  return {
    definitions: form.definitions.trim(),
    plot,
  };
}

function submit() {
  fieldErrors.name = form.name.trim() ? "" : "请输入指标名称";
  fieldErrors.expression = "";
  fieldErrors.advanced = "";
  if (form.mode === "simple") {
    fieldErrors.expression = form.expression.trim() ? "" : "请输入指标表达式";
  } else {
    const validation = validateReplayAdvancedIndicatorConfig(
      buildAdvancedConfig(),
    );
    fieldErrors.advanced = validation.error ?? "";
  }
  if (fieldErrors.name || fieldErrors.expression || fieldErrors.advanced) {
    return;
  }

  if (form.mode === "advanced") {
    emit("save", {
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      mode: "advanced",
      placement: "sub",
      advanced: buildAdvancedConfig(),
    });
    return;
  }
  emit("save", {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    expression: form.expression.trim(),
    placement: form.placement,
    color: form.color,
  });
}

function loadBrickExample() {
  form.name ||= "砖型图";
  form.definitions = [
    "var1a = (HHV(high, 4) - close) / (HHV(high, 4) - LLV(low, 4)) * 100 - 90",
    "var2a = SMA(var1a, 4, 1) + 100",
    "var3a = (close - LLV(low, 4)) / (HHV(high, 4) - LLV(low, 4)) * 100",
    "var4a = SMA(var3a, 6, 1)",
    "var5a = SMA(var4a, 6, 1) + 100",
    "var6a = var5a - var2a",
    "brick = IF(var6a > 4, var6a - 4, 0)",
  ].join("\n");
  form.plotType = "rangeBar";
  form.plotLabel = "砖型图";
  form.fromExpression = "REF(brick, 1)";
  form.toExpression = "brick";
  form.risingColor = "#ef4444";
  form.fallingColor = "#10b981";
  fieldErrors.advanced = "";
}

watch(
  () => props.indicator,
  (indicator) => resetForm(indicator),
  { immediate: true },
);
</script>

<template>
  <form class="replay-indicator-editor" @submit.prevent="submit">
    <div class="replay-indicator-editor__field">
      <label for="replay-indicator-name">指标名称</label>
      <input
        id="replay-indicator-name"
        v-model="form.name"
        type="text"
        maxlength="30"
        placeholder="例如：砖型图"
      />
      <span v-if="fieldErrors.name" class="replay-indicator-editor__error">
        {{ fieldErrors.name }}
      </span>
    </div>

    <div class="replay-indicator-editor__field">
      <label for="replay-indicator-mode">公式类型</label>
      <select id="replay-indicator-mode" v-model="form.mode">
        <option value="simple">简单公式</option>
        <option value="advanced">高级公式</option>
      </select>
    </div>

    <div class="replay-indicator-editor__field">
      <label for="replay-indicator-placement">显示位置</label>
      <select
        v-if="form.mode === 'simple'"
        id="replay-indicator-placement"
        v-model="form.placement"
      >
        <option value="main">主图叠加</option>
        <option value="sub">副图展示</option>
      </select>
      <div v-else class="replay-indicator-editor__fixed-value">副图展示</div>
    </div>

    <div
      v-if="form.mode === 'simple'"
      class="replay-indicator-editor__field replay-indicator-editor__color"
    >
      <label for="replay-indicator-color">颜色</label>
      <input
        id="replay-indicator-color"
        v-model="form.color"
        type="color"
        aria-label="指标颜色"
      />
    </div>

    <div class="replay-indicator-editor__actions">
      <button type="button" @click="emit('cancel')">取消</button>
      <button type="submit" class="replay-indicator-editor__save">
        保存指标
      </button>
    </div>

    <template v-if="form.mode === 'simple'">
      <div class="replay-indicator-editor__field replay-indicator-editor__formula">
        <label for="replay-indicator-expression">函数表达式</label>
        <input
          id="replay-indicator-expression"
          v-model="form.expression"
          type="text"
          spellcheck="false"
          placeholder="例如：MA(close, 5) - MA(close, 20)"
        />
        <span v-if="fieldErrors.expression" class="replay-indicator-editor__error">
          {{ fieldErrors.expression }}
        </span>
      </div>
      <p class="replay-indicator-editor__help">
        可用字段：open、high、low、close、volume、amount；函数：REF、MA、EMA、MAX、MIN。
      </p>
    </template>

    <section v-else class="replay-indicator-editor__advanced">
      <div class="replay-indicator-editor__advanced-heading">
        <div>
          <strong>计算步骤</strong>
          <p>每行使用“变量名 = 表达式”，后面的变量可以引用前面已定义的变量。</p>
        </div>
        <button type="button" @click="loadBrickExample">载入砖型图示例</button>
      </div>
      <textarea
        v-model="form.definitions"
        aria-label="高级公式计算步骤"
        rows="8"
        spellcheck="false"
        placeholder="change = close - REF(close, 1)"
      />

      <div class="replay-indicator-editor__plot-grid">
        <div class="replay-indicator-editor__field">
          <label for="replay-indicator-plot-type">绘图方式</label>
          <select id="replay-indicator-plot-type" v-model="form.plotType">
            <option value="line">折线</option>
            <option value="histogram">柱状</option>
            <option value="rangeBar">区间柱</option>
          </select>
        </div>
        <div class="replay-indicator-editor__field">
          <label for="replay-indicator-plot-label">图例名称</label>
          <input
            id="replay-indicator-plot-label"
            v-model="form.plotLabel"
            type="text"
            maxlength="30"
            placeholder="默认使用指标名称"
          />
        </div>
        <template v-if="form.plotType === 'rangeBar'">
          <div class="replay-indicator-editor__field">
            <label for="replay-indicator-from">起点表达式</label>
            <input
              id="replay-indicator-from"
              v-model="form.fromExpression"
              type="text"
              spellcheck="false"
              placeholder="REF(brick, 1)"
            />
          </div>
          <div class="replay-indicator-editor__field">
            <label for="replay-indicator-to">终点表达式</label>
            <input
              id="replay-indicator-to"
              v-model="form.toExpression"
              type="text"
              spellcheck="false"
              placeholder="brick"
            />
          </div>
          <div class="replay-indicator-editor__field replay-indicator-editor__color">
            <label for="replay-indicator-rising-color">上升颜色</label>
            <input
              id="replay-indicator-rising-color"
              v-model="form.risingColor"
              type="color"
            />
          </div>
          <div class="replay-indicator-editor__field replay-indicator-editor__color">
            <label for="replay-indicator-falling-color">下降颜色</label>
            <input
              id="replay-indicator-falling-color"
              v-model="form.fallingColor"
              type="color"
            />
          </div>
        </template>
        <template v-else>
          <div class="replay-indicator-editor__field replay-indicator-editor__plot-expression">
            <label for="replay-indicator-plot-expression">绘图表达式</label>
            <input
              id="replay-indicator-plot-expression"
              v-model="form.plotExpression"
              type="text"
              spellcheck="false"
              placeholder="例如：change"
            />
          </div>
          <div class="replay-indicator-editor__field replay-indicator-editor__color">
            <label for="replay-indicator-advanced-color">{{ form.plotType === "histogram" ? "正值颜色" : "颜色" }}</label>
            <input
              id="replay-indicator-advanced-color"
              v-model="form.color"
              type="color"
            />
          </div>
          <div
            v-if="form.plotType === 'histogram'"
            class="replay-indicator-editor__field replay-indicator-editor__color"
          >
            <label for="replay-indicator-negative-color">负值颜色</label>
            <input
              id="replay-indicator-negative-color"
              v-model="form.negativeColor"
              type="color"
            />
          </div>
        </template>
      </div>

      <span v-if="fieldErrors.advanced" class="replay-indicator-editor__error">
        {{ fieldErrors.advanced }}
      </span>
      <p class="replay-indicator-editor__help">
        高级函数：HHV、LLV、SMA、IF；同时支持简单公式中的全部字段和函数。
      </p>
    </section>
  </form>
</template>

<style scoped>
.replay-indicator-editor {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) 110px 110px 60px auto;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 9px;
  background: var(--ql-color-bg-muted);
}

.replay-indicator-editor__field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.replay-indicator-editor label,
.replay-indicator-editor__advanced strong {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  font-weight: 680;
}

.replay-indicator-editor input,
.replay-indicator-editor select,
.replay-indicator-editor textarea,
.replay-indicator-editor__fixed-value {
  min-width: 0;
  min-height: 34px;
  box-sizing: border-box;
  border: 1px solid var(--ql-line-strong);
  border-radius: 7px;
  padding: 0 9px;
  outline: none;
  color: var(--ql-ink);
  background: var(--ql-color-bg-surface-strong);
  font-size: 12px;
}

.replay-indicator-editor textarea {
  width: 100%;
  min-height: 156px;
  resize: vertical;
  padding: 9px 10px;
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  line-height: 1.55;
}

.replay-indicator-editor input:focus,
.replay-indicator-editor select:focus,
.replay-indicator-editor textarea:focus {
  border-color: rgba(37, 99, 235, 0.55);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.08);
}

.replay-indicator-editor__fixed-value {
  display: flex;
  align-items: center;
  color: var(--ql-color-text-muted);
}

.replay-indicator-editor input[type="color"] {
  width: 44px;
  padding: 4px;
}

.replay-indicator-editor__formula,
.replay-indicator-editor__advanced,
.replay-indicator-editor__help {
  grid-column: 1 / -1;
}

.replay-indicator-editor__formula {
  display: grid;
}

.replay-indicator-editor__error {
  color: #b91c1c;
  font-size: 10px;
}

.replay-indicator-editor__actions {
  display: flex;
  grid-column: -2 / -1;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 6px;
}

.replay-indicator-editor__actions button,
.replay-indicator-editor__advanced-heading button {
  min-height: 34px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 7px;
  padding: 0 10px;
  color: var(--ql-color-text-muted);
  background: var(--ql-color-bg-surface-strong);
  font-size: 11px;
  font-weight: 680;
  cursor: pointer;
}

.replay-indicator-editor__actions .replay-indicator-editor__save {
  border-color: var(--ql-accent);
  color: #fff;
  background: var(--ql-accent);
}

.replay-indicator-editor__advanced {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
  padding-top: 2px;
}

.replay-indicator-editor__advanced-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.replay-indicator-editor__advanced-heading p,
.replay-indicator-editor__help {
  margin: 3px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.replay-indicator-editor__plot-grid {
  display: grid;
  grid-template-columns: 110px minmax(130px, 0.8fr) repeat(2, minmax(150px, 1fr)) 70px 70px;
  gap: 10px;
}

.replay-indicator-editor__plot-expression {
  grid-column: span 2;
}

@media (max-width: 760px) {
  .replay-indicator-editor,
  .replay-indicator-editor__plot-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .replay-indicator-editor__actions,
  .replay-indicator-editor__advanced,
  .replay-indicator-editor__formula {
    grid-column: 1 / -1;
  }

  .replay-indicator-editor__plot-expression {
    grid-column: 1 / -1;
  }

  .replay-indicator-editor__advanced-heading {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
