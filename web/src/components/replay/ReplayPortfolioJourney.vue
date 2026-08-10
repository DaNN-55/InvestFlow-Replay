<script setup>
import { computed } from "vue";

const props = defineProps({
  marketProvider: {
    type: String,
    default: "tdx",
  },
});

const isFixtureMarket = computed(() => props.marketProvider === "fixture");
const marketMode = computed(() =>
  isFixtureMarket.value
    ? {
        label: "离线 Demo · 合成数据",
        description: "使用固定合成行情演示完整流程，不对应真实证券或真实市场。",
      }
    : {
        label: "通达信模式 · 真实历史数据",
        description: "优先使用本地缓存，按需连接通达信补齐，再随机匿名抽取行情。",
      },
);
const journeySteps = computed(() => [
  { title: "研究假设", description: "先定义待验证的交易规则" },
  {
    title: "行情演练",
    description: isFixtureMarket.value ? "盲看固定合成行情" : "盲看随机历史片段",
  },
  { title: "模拟执行", description: "按统一撮合与成本执行" },
  { title: "复盘", description: "回看决策、持仓与偏差" },
  { title: "规则迭代", description: "提炼下一版规则" },
]);
</script>

<template>
  <section class="portfolio-journey" aria-labelledby="portfolio-journey-title">
    <div class="portfolio-journey__header">
      <div>
        <span class="portfolio-journey__eyebrow">交付闭环</span>
        <h2 id="portfolio-journey-title" class="portfolio-journey__title">
          一轮训练，完成一次规则验证
        </h2>
      </div>
      <div
        class="portfolio-journey__mode"
        :class="{ 'portfolio-journey__mode--fixture': isFixtureMarket }"
      >
        <strong class="portfolio-journey__mode-title">{{ marketMode.label }}</strong>
        <span class="portfolio-journey__mode-description">{{ marketMode.description }}</span>
      </div>
    </div>

    <ol class="portfolio-journey__steps">
      <li
        v-for="(step, index) in journeySteps"
        :key="step.title"
        class="portfolio-journey__step"
      >
        <span class="portfolio-journey__number">0{{ index + 1 }}</span>
        <strong class="portfolio-journey__step-title">{{ step.title }}</strong>
        <small class="portfolio-journey__step-description">{{ step.description }}</small>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.portfolio-journey {
  margin-bottom: 14px;
  padding: 13px 14px;
  border: 1px solid var(--ql-line);
  border-radius: 12px;
  background: var(--ql-paper-soft);
}

.portfolio-journey__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 10px;
}

.portfolio-journey__eyebrow {
  color: var(--ql-accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.12em;
}

.portfolio-journey__title {
  margin: 2px 0 0;
  color: var(--ql-ink);
  font-size: 16px;
  line-height: 1.35;
}

.portfolio-journey__mode {
  display: grid;
  max-width: 310px;
  gap: 3px;
  padding-left: 12px;
  border-left: 2px solid var(--ql-accent);
}

.portfolio-journey__mode-title {
  color: var(--ql-accent);
  font-size: 11px;
}

.portfolio-journey__mode-description {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.portfolio-journey__mode--fixture {
  border-left-color: var(--ql-color-warning);
}

.portfolio-journey__mode--fixture .portfolio-journey__mode-title {
  color: var(--ql-color-warning);
}

.portfolio-journey__steps {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.portfolio-journey__step {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 3px;
  padding: 8px 9px;
  border: 1px solid var(--ql-line);
  border-radius: 8px;
  background: var(--ql-color-bg-surface-strong);
}

.portfolio-journey__number {
  color: var(--ql-accent);
  font-family: var(--ql-font-mono, monospace);
  font-size: 10px;
  font-weight: 700;
}

.portfolio-journey__step-title {
  color: var(--ql-ink);
  font-size: 12px;
}

.portfolio-journey__step-description {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  line-height: 1.45;
}

@media (max-width: 640px) {
  .portfolio-journey__header {
    display: grid;
    gap: 10px;
  }

  .portfolio-journey__mode {
    max-width: none;
  }

  .portfolio-journey__steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .portfolio-journey__step:last-child {
    grid-column: 1 / -1;
  }
}
</style>
