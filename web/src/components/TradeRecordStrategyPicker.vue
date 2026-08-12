<script setup>
import { computed } from "vue";

import UiInput from "./ui/UiInput.vue";
import UiSelect from "./ui/UiSelect.vue";
import UiTextarea from "./ui/UiTextarea.vue";

defineProps({
  playbooks: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  allowLegacy: { type: Boolean, default: false },
});

const model = defineModel({ type: Object, required: true });

function fieldModel(field) {
  return computed({
    get: () => model.value[field],
    set: (value) => {
      model.value = { ...model.value, [field]: value };
    },
  });
}

const mode = fieldModel("mode");
const playbookId = fieldModel("playbookId");
const name = fieldModel("name");
const version = fieldModel("version");
const content = fieldModel("content");
const changeSummary = fieldModel("changeSummary");
</script>

<template>
  <section class="trade-record-strategy-picker">
    <h3>战法（可选）</h3>
    <label class="trade-record-strategy-picker__mode">
      <span>关联方式</span>
      <UiSelect v-model="mode" :disabled="disabled">
        <option value="none">无战法</option>
        <option value="library">选择战法库</option>
        <option value="new">新建战法并加入战法库</option>
        <option v-if="allowLegacy" value="legacy">保留原记录中的自定义战法</option>
      </UiSelect>
    </label>

    <template v-if="mode === 'library'">
      <label class="trade-record-strategy-picker__full">
        <span>战法库</span>
        <UiSelect v-model="playbookId" :disabled="disabled || loading">
          <option value="">请选择战法</option>
          <option v-for="playbook in playbooks" :key="playbook.id" :value="playbook.id">
            {{ playbook.name }} · v{{ playbook.currentVersion?.versionNumber ?? 1 }}
          </option>
        </UiSelect>
      </label>
      <p v-if="loading" class="trade-record-strategy-picker__state">正在加载战法库…</p>
      <p v-else-if="error" class="trade-record-strategy-picker__state trade-record-strategy-picker__state--error">
        {{ error }}
      </p>
      <p v-else-if="!playbooks.length" class="trade-record-strategy-picker__state">
        战法库为空，可以选择“新建战法并加入战法库”。
      </p>
    </template>

    <template v-else-if="mode === 'new'">
      <label>
        <span>战法名称</span>
        <UiInput v-model="name" maxlength="120" placeholder="例如：趋势回踩战法" :disabled="disabled" />
      </label>
      <div class="trade-record-strategy-picker__version">
        <span>首版版本</span>
        <strong>v1</strong>
      </div>
      <label class="trade-record-strategy-picker__full">
        <span>首版正文</span>
        <UiTextarea
          v-model="content"
          maxlength="12000"
          rows="5"
          placeholder="记录适用条件、入场、退出与风控规则"
          :disabled="disabled"
        />
      </label>
      <label class="trade-record-strategy-picker__full">
        <span>创建说明</span>
        <UiInput
          v-model="changeSummary"
          maxlength="500"
          placeholder="例如：建立首版规则"
          :disabled="disabled"
        />
      </label>
    </template>

    <template v-else-if="mode === 'legacy'">
      <label>
        <span>战法名称</span>
        <UiInput v-model="name" maxlength="120" :disabled="disabled" />
      </label>
      <label>
        <span>版本</span>
        <UiInput v-model="version" maxlength="40" :disabled="disabled" />
      </label>
      <p class="trade-record-strategy-picker__state">
        这是旧记录中的自定义战法，只随该交易保存，不会自动加入战法库。
      </p>
    </template>
  </section>
</template>

<style scoped>
.trade-record-strategy-picker {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.trade-record-strategy-picker h3,
.trade-record-strategy-picker__mode,
.trade-record-strategy-picker__full,
.trade-record-strategy-picker__state {
  grid-column: 1 / -1;
}

.trade-record-strategy-picker h3,
.trade-record-strategy-picker__state {
  margin: 0;
}

.trade-record-strategy-picker h3 {
  color: var(--ql-color-text-strong);
  font-size: 13px;
}

.trade-record-strategy-picker label,
.trade-record-strategy-picker__version {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.trade-record-strategy-picker label > span,
.trade-record-strategy-picker__version > span {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.trade-record-strategy-picker__version strong {
  align-items: center;
  border: 1px solid var(--ql-color-border-strong);
  border-radius: 8px;
  color: var(--ql-color-text-strong);
  display: flex;
  min-height: 38px;
  padding: 0 12px;
}

.trade-record-strategy-picker__state {
  color: var(--ql-color-text-muted);
  font-size: 12px;
}

.trade-record-strategy-picker__state--error {
  color: var(--ql-color-danger, #b91c1c);
}

@media (max-width: 560px) {
  .trade-record-strategy-picker {
    grid-template-columns: 1fr;
  }
}
</style>
