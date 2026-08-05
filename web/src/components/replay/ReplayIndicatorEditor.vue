<script setup>
import { reactive, watch } from "vue";

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
  expression: "",
  placement: "sub",
  color: "#2563eb",
});

const fieldErrors = reactive({
  name: "",
  expression: "",
});

function resetForm(indicator) {
  form.id = indicator?.id ?? "";
  form.name = indicator?.name ?? "";
  form.expression = indicator?.expression ?? "";
  form.placement = indicator?.placement === "main" ? "main" : "sub";
  form.color = indicator?.color ?? "#2563eb";
  fieldErrors.name = "";
  fieldErrors.expression = "";
}

function submit() {
  fieldErrors.name = form.name.trim() ? "" : "请输入指标名称";
  fieldErrors.expression = form.expression.trim() ? "" : "请输入指标表达式";
  if (fieldErrors.name || fieldErrors.expression) {
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
        placeholder="例如：五日均价"
      />
      <span v-if="fieldErrors.name" class="replay-indicator-editor__error">
        {{ fieldErrors.name }}
      </span>
    </div>

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

    <div class="replay-indicator-editor__field">
      <label for="replay-indicator-placement">显示位置</label>
      <select id="replay-indicator-placement" v-model="form.placement">
        <option value="main">主图叠加</option>
        <option value="sub">副图展示</option>
      </select>
    </div>

    <div class="replay-indicator-editor__field replay-indicator-editor__color">
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

    <p class="replay-indicator-editor__help">
      可用字段：open、high、low、close、volume、amount；函数：REF、MA、EMA、MAX、MIN。
    </p>
  </form>
</template>

<style scoped>
.replay-indicator-editor {
  display: grid;
  grid-template-columns:
    minmax(110px, 0.8fr) minmax(210px, 1.8fr) minmax(100px, 0.7fr)
    64px auto;
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

.replay-indicator-editor label {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  font-weight: 680;
}

.replay-indicator-editor input,
.replay-indicator-editor select {
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

.replay-indicator-editor input:focus,
.replay-indicator-editor select:focus {
  border-color: rgba(37, 99, 235, 0.55);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.08);
}

.replay-indicator-editor input[type="color"] {
  width: 44px;
  padding: 4px;
}

.replay-indicator-editor__error {
  color: #b91c1c;
  font-size: 10px;
}

.replay-indicator-editor__actions {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.replay-indicator-editor__actions button {
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

.replay-indicator-editor__help {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--ql-color-text-muted);
  font-size: 10px;
}

@media (max-width: 760px) {
  .replay-indicator-editor {
    grid-template-columns: minmax(0, 1fr) 64px;
  }

  .replay-indicator-editor__formula {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .replay-indicator-editor__actions {
    grid-column: 1 / -1;
  }
}
</style>
