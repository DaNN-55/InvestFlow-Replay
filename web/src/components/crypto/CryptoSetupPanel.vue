<script setup>
import { computed, reactive } from 'vue';
import { ShieldCheck } from 'lucide-vue-next';
import '../replay/replay-start.css';
import ReplayResumeCard from '../replay/ReplayResumeCard.vue';
import UiButton from '../ui/UiButton.vue';
import UiInput from '../ui/UiInput.vue';
import UiSelect from '../ui/UiSelect.vue';
const props = defineProps({ busy: Boolean, blocked: Boolean, pool: { type: Object, default: null }, history: {type:Array,default:()=>[]} });
const emit = defineEmits(['create','resume','records']);
const resumable = computed(()=>props.history.find(h=>h.status==='active'||h.status==='end-blocked'));
const selectedPool = computed(() => props.pool?.instruments?.find((item) => item.instrumentId === setup.instrumentId));
const exhausted = computed(() => props.pool?.mode === 'history-pool' && selectedPool.value?.unseenWindows === 0);
const unavailable = computed(() => props.pool?.mode === 'unavailable');
function submit() { if (!props.busy && !props.blocked && !exhausted.value && !unavailable.value) emit('create', { ...setup, market: 'crypto-perpetual', slippageBps: Number(setup.slippageBps) }); }
const setup = reactive({ instrumentId: 'BTC-USDT-SWAP', startingCash: '10000', leverage: '5', slippageBps: '2' });
</script>
<template>
  <section class="crypto-setup replay-setup">
    <div class="replay-setup__hero">
    <svg class="replay-setup__flow" viewBox="0 0 1040 620" preserveAspectRatio="none" aria-hidden="true">
      <path d="M-28 514C152 338 248 554 410 370S710 122 1068 294" />
      <path d="M-24 282C132 92 298 290 458 166S744 422 1066 94" />
      <path d="M-36 604C166 396 350 622 550 424S782 246 1072 394" />
    </svg>
    <div class="crypto-setup__intro replay-setup__intro">
      <span class="replay-setup__eyebrow"><ShieldCheck :size="15" />USDT 永续 · 历史盲测</span>
      <h1 class="replay-setup__title">先看行情，<br>再决定承担多少风险。</h1>
      <p class="replay-setup__description">一次只练一个合约。观察、做多或做空，再逐分钟检验你的退出计划。</p>
    </div>
    <form class="crypto-setup__form replay-setup__card" @submit.prevent="submit">
      <h2>这次怎么练？</h2>
      <label for="crypto-instrument">01 · 练习合约</label>
      <UiSelect id="crypto-instrument" v-model="setup.instrumentId" :disabled="busy || blocked"><option>BTC-USDT-SWAP</option><option>ETH-USDT-SWAP</option></UiSelect>
      <fieldset class="crypto-cost-settings">
        <legend>02 · 资金与成本</legend>
        <div class="crypto-starting-funds">
          <div><label for="crypto-cash">起始资金（USDT）</label><UiInput id="crypto-cash" v-model="setup.startingCash" inputmode="decimal" required :disabled="busy || blocked" /></div>
          <div><label for="crypto-leverage">杠杆倍数</label><UiInput id="crypto-leverage" v-model="setup.leverage" inputmode="decimal" required :disabled="busy || blocked" /></div>
        </div>
        <label for="crypto-slip">单边教学滑点</label><UiSelect id="crypto-slip" v-model="setup.slippageBps" :disabled="busy || blocked"><option value="0">0 bps · 对照</option><option value="2">2 bps · 默认</option><option value="10">10 bps · 压力</option></UiSelect>
      </fieldset>
      <div class="crypto-setup__facts"><span>固定：90 天背景</span><span>72 小时回放</span><span>逐仓 · 单向</span></div>
      <ReplayResumeCard v-if="resumable" :session-id="resumable.id" :description="`${resumable.instrumentId} · 原进度、持仓与委托保留`" :busy="busy" @resume="emit('resume',$event)" />
      <p class="muted" v-if="pool?.mode==='history-pool'">可首次盲测：{{ selectedPool?.unseenWindows??0 }} 段历史行情。<span class="crypto-pool-help">每段回放 72 小时；用完后可到演练记录复练。</span></p>
      <p v-if="exhausted" role="status" class="muted">当前合约没有尚未暴露的场景，请到演练记录选择历史场景并显式复练；不会删除首次成绩或自动重置已见状态。</p>
      <p v-if="unavailable" role="status" class="muted">本地行情尚未准备或校验失败，暂时不能开始新练习。请按项目 README 的「加密行情数据准备」导入并核验冻结小样或历史池，然后刷新页面。已有练习仍可从演练记录继续。</p>
      <UiButton class="crypto-setup__submit" type="submit" :loading="busy" :disabled="blocked || exhausted || unavailable" block>开始合约盲测</UiButton>
      <button type="button" class="replay-setup__records" @click="emit('records')">查看全部演练记录 ↗</button>
    </form>
    </div>
  </section>
</template>
<style scoped>
.crypto-setup__facts { display:flex;flex-wrap:wrap;gap:14px;margin:16px 0 0;color:var(--ql-color-text-muted);font-size:12px; }
.crypto-setup__form { padding:24px;border:1px solid var(--ql-color-border-soft);border-radius:12px;background:var(--ql-panel); }
h2 { margin:0 0 20px;font-size:24px;letter-spacing:-.035em; }
.crypto-setup__form label { display:block;margin:14px 0 7px;color:var(--ql-color-text-muted);font-size:11px;font-weight:700;letter-spacing:.04em; }
.muted { color:var(--ql-color-text-muted);font-size:12px;line-height:1.7;margin:16px 0; }
.crypto-setup__submit { margin-top:18px;min-height:48px; }
.crypto-cost-settings { min-width:0;border:0;border-top:1px solid var(--ql-line);padding:4px 0 0;margin:16px 0 0; }
.crypto-cost-settings legend { padding:0 8px 0 0;color:var(--ql-color-text-muted);font-size:11px; }
.crypto-starting-funds { display:grid;grid-template-columns:1.4fr 1fr;gap:12px; }
.crypto-starting-funds>div { min-width:0; }
.crypto-pool-help { display:block;font-size:11px;margin-top:3px; }
@media(max-width:780px) { .crypto-setup__intro { padding-inline:20px; }.crypto-setup__form { width:min(calc(100% - 32px),500px);box-sizing:border-box; } }
</style>
