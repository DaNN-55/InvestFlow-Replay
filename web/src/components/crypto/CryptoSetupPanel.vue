<script setup>
import { computed, reactive } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiInput from '../ui/UiInput.vue';
import UiSelect from '../ui/UiSelect.vue';
import CryptoModelNotice from './CryptoModelNotice.vue';
const props = defineProps({ busy: Boolean, blocked: Boolean, pool: { type: Object, default: null } });
const emit = defineEmits(['create']);
const selectedPool = computed(() => props.pool?.instruments?.find((item) => item.instrumentId === setup.instrumentId));
const exhausted = computed(() => props.pool?.mode === 'history-pool' && selectedPool.value?.unseenWindows === 0);
const unavailable = computed(() => props.pool?.mode === 'unavailable');
function submit() { if (!props.busy && !props.blocked && !exhausted.value && !unavailable.value) emit('create', { ...setup, market: 'crypto-perpetual', slippageBps: Number(setup.slippageBps) }); }
const setup = reactive({ instrumentId: 'BTC-USDT-SWAP', startingCash: '10000', leverage: '5', slippageBps: '2' });
</script>
<template>
  <section class="crypto-setup">
    <div class="crypto-setup__intro">
      <p class="eyebrow">OKX / USDT 永续 · 历史盲测</p>
      <h1>先看行情，<br>再决定承担多少风险。</h1>
      <p>一次只练一个合约。观察、做多或做空，再逐分钟检验你的退出计划。</p>
      <div class="crypto-setup__facts"><span>90 天背景</span><span>72 小时回放</span><span>逐仓 · 单向持仓</span></div>
      <section v-if="pool?.mode === 'history-pool'" class="pool-coverage" aria-label="历史数据池覆盖">
        <h2>已核对的 2024–2025 历史池</h2>
        <p>{{ pool.admittedWindows }} 个 72h 场景已准入；每个都带 90 天背景和一个结束分钟。原始日期覆盖与可练场景分别统计。</p>
        <ul><li v-for="item in pool.coverage.instruments" :key="item.instrumentId"><strong>{{ item.instrumentId }}</strong><span v-for="year in item.years" :key="year.year">{{ year.year }}：普通 {{ year.lastDays }}/{{ year.targetDays }} 天，mark {{ year.markDays }}/{{ year.targetDays }} 天，资金费归档 {{ year.fundingArchiveDays }}/{{ year.targetDays }} 天</span></li></ul>
        <p>{{ pool.note }}</p>
      </section>
      <CryptoModelNotice location="setup" />
    </div>
    <form class="crypto-setup__form" @submit.prevent="submit">
      <h2>这次怎么练？</h2>
      <label for="crypto-instrument">合约</label>
      <UiSelect id="crypto-instrument" v-model="setup.instrumentId" :disabled="busy || blocked"><option>BTC-USDT-SWAP</option><option>ETH-USDT-SWAP</option></UiSelect>
      <label for="crypto-cash">起始资金（USDT）</label><UiInput id="crypto-cash" v-model="setup.startingCash" inputmode="decimal" required :disabled="busy || blocked" />
      <label for="crypto-leverage">杠杆倍数</label><UiInput id="crypto-leverage" v-model="setup.leverage" inputmode="decimal" required :disabled="busy || blocked" />
      <label for="crypto-slip">单边教学滑点</label><UiSelect id="crypto-slip" v-model="setup.slippageBps" :disabled="busy || blocked"><option value="0">0 bps · 对照</option><option value="2">2 bps · 默认</option><option value="10">10 bps · 压力</option></UiSelect>
      <p class="muted">固定训练费率：Maker 0.02% / Taker 0.05%。<template v-if="pool?.mode === 'history-pool'">只从当前尚未暴露的场景选取；当前合约可用 {{ selectedPool?.unseenWindows ?? 0 }} 个。版本 {{ pool.poolVersion }}。来源缺口与未准入场景不作为可用样本。</template><template v-else-if="pool?.mode === 'legacy-sample'">当前仍为两个冻结小样，不代表完整历史池；同窗再次练习会列为复练。</template></p>
      <p v-if="exhausted" role="status" class="muted">当前合约没有尚未暴露的场景，请在上方恢复历史练习并显式复练；不会删除首次成绩或自动重置已见状态。</p>
      <p v-if="unavailable" role="status" class="muted">本地行情尚未准备或校验失败，暂时不能开始新练习。请按项目 README 的「加密行情数据准备」导入并核验冻结小样或历史池，然后刷新页面。已有练习仍可从上方恢复。</p>
      <UiButton type="submit" :loading="busy" :disabled="blocked || exhausted || unavailable" block>开始合约盲测</UiButton>
    </form>
  </section>
</template>
<style scoped>
.crypto-setup { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(280px, .8fr); gap: clamp(28px,6vw,100px); padding: 55px 0; align-items: center; }
h1 { font-size: clamp(28px,3.5vw,48px); line-height: 1.2; letter-spacing: -.04em; margin: 20px 0; }
.crypto-setup__intro > p:not(.eyebrow) { color: var(--ql-color-text-muted); line-height: 1.9; }
.eyebrow { font-size: 12px; font-weight: 700; color: var(--ql-accent); letter-spacing: .08em; }
.crypto-setup__facts { display: flex; flex-wrap: wrap; gap: 18px; margin: 26px 0; font-size: 13px; }
.crypto-setup__form { padding: 26px; border: 1px solid var(--ql-line-strong); border-radius: 12px; background: var(--ql-panel); }
h2 { margin: 0 0 22px; font-size: 19px; }
label { display: block; font-size: 13px; margin: 18px 0 7px; }
.pool-coverage { margin: 20px 0; padding: 14px 0; border-block: 1px solid var(--ql-line); font-size: 12px; line-height: 1.8; }.pool-coverage h2 { font-size: 15px; margin: 0 0 8px; }.pool-coverage ul { padding-left: 18px; }.pool-coverage li { margin-bottom: 10px; }.pool-coverage li span { display: block; color: var(--ql-color-text-muted); }
.muted { color: var(--ql-color-text-muted); font-size: 12px; line-height: 1.7; margin: 20px 0; }
@media(max-width:760px) { .crypto-setup { grid-template-columns: 1fr; padding: 22px 0; gap: 25px; } }
</style>
