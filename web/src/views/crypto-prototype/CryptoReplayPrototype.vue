<script setup>
// THROWAWAY UI PROTOTYPE. Question: which layout makes blind contract practice clear?
// Existing /decision/crypto-replay?prototype=ui&variant=A hosts three structural variants,
// an explicitly reconstructed before state, and a per-recommendation comparison tour.
// No business API, real session mutation, database, or prototype persistence.
import { computed, ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowRight, Check, Monitor, Smartphone, Sun, Moon, RotateCcw } from 'lucide-vue-next';
import PrototypeSwitcher from '../../components/ui/PrototypeSwitcher.vue';
import UiSelect from '../../components/ui/UiSelect.vue';
import PrototypeWorkspace from './PrototypeWorkspace.vue';
import './prototype.css';
const route=useRoute(), router=useRouter();
const variants=[{id:'A',name:'交易终端',description:'推荐 · 左图右单，下方持仓。最接近 TradingView / OKX 的操作位置。'},{id:'B',name:'专注看图',description:'全宽图表 + 左侧工具轨，下单按需展开。把观察放在第一位。'},{id:'C',name:'决策工作台',description:'上方行情，下方下单与持仓并列。更适合横向检查计划与执行。'}];
const features=[
 {id:'hierarchy',label:'01 信息层级',scene:'training',before:'账户、说明和持仓长表在前，下单需要向下寻找。',after:'压缩顶部状态；A 图左单右、持仓在下，B 图表全宽、C 操作并列。',try:'先看下单位置，再切换 B / C 比较结构。'},
 {id:'theme',label:'02 视觉一致',scene:'training',before:'深色页面中的亮白输入框；多个大标题、重边框竞争注意力。',after:'输入框随主题变化；统一40px控件、13px正文和单一主操作。',try:'切换原型的深色 / 浅色，再比较输入框与面板。'},
 {id:'setup',label:'03 简化开局',scene:'setup',before:'开局前同时展示资金、杠杆、滑点、费率和长篇说明。',after:'先选合约开始；资金与成本收进折叠设置。',try:'点击“资金与成本”，然后开始一局。'},
 {id:'data',label:'04 数据入口',scene:'setup',before:'数据覆盖长表占据左下方，未来多池会让页面更长。',after:'右上数据库图标集中收纳数据池、覆盖、缺口与版本。',try:'在“数据池”选择占位池，再切“数据来源”。'},
 {id:'rules',label:'05 说明收纳',scene:'training',before:'模型说明在账户上方、风险面板、图表与复盘重复出现。',after:'完整规则集中到抽屉；止损、保证金等当前动作保留短提示。',try:'检查“训练规则”分组，再打开下方“设置退出计划”。'},
 {id:'resume',label:'06 继续练习',scene:'setup',before:'“恢复历史练习”混合了继续、查看与复练的用途。',after:'明确“继续上次练习”；完整历史统一进入交易追踪。',try:'点击继续，再进交易追踪查看不同状态对应的操作。'},
 {id:'order',label:'07 下单抬高',scene:'training',before:'下单被13项持仓指标、手动计划与说明推到侧栏底部。',after:'下单直接可见；开平仓、市价限价、数量单位使用熟悉的分组。',try:'输入数量、切换限价并提交；到“当前委托”撤单。'},
 {id:'position',label:'08 持仓下移',scene:'training',before:'持仓占据右侧上方，空仓时也保留整页指标。',after:'图表下方切换持仓、当前委托、历史委托、成交；空仓更紧凑。',try:'装载示例持仓，调整保证金或市价平仓。'},
 {id:'plan',label:'09 计划与保护',scene:'training',before:'手动计划和自动保护分散在不同长表里，关系不易辨认。',after:'同一出口分别呈现“记录计划”和“提交自动保护”。',try:'分别保存手动计划、设置自动保护，查看下方状态标签。'},
 {id:'layout',label:'10 多图布局',scene:'training',before:'只有单图，观察多个周期需来回切换。',after:'单图、双列、双行、四图；选中图可单独放大并恢复。',try:'切换四种布局，点击一图，再点击右上放大按钮。'},
 {id:'period',label:'11 独立周期',scene:'training',before:'一个全局周期，只能一次观察一个尺度。',after:'每张图独立周期；顶部工具栏作用于有蓝色边框的当前图。',try:'关闭布局浮层，选第2张图并改周期，检查第1张不变。'},
 {id:'link',label:'12 联动与回放',scene:'training',before:'单图没有跨周期对照和联动设置。',after:'时间十字线、价格线、时间范围、周期同步独立开关；全图共用进度。',try:'移入图表看虚线；拖动用滚轮或“查看更早”，再推进5分钟。'},
 {id:'precision',label:'13 数字精度',scene:'training',before:'账户固定显示八位小数，占宽且不利于快速判断。',after:'摘要适当取舍精度，完整精度保留在详情中。',try:'点击持仓区“完整精度与详情”。'},
 {id:'records',label:'14 统一记录',scene:'records',before:'历史演练展示A股；合约完整记录仍在练习页下方。',after:'交易追踪 → 演练记录；同一列表按市场、状态、首次复练筛选。',try:'选择“加密合约”，再筛“进行中”并继续练习。'},
 {id:'review',label:'15 结束与复盘',scene:'training',before:'平仓、结束练习、长篇复盘内容的边界不够直观。',after:'平仓属于持仓操作；结束后逐步盲评、揭晓，再保存到记录。',try:'点击结束练习，完整走一遍盲评 → 揭晓 → 复盘。'},
 {id:'responsive',label:'16 小屏与收起',scene:'training',before:'长页面、侧栏与表单堆叠；关键动作更难到达。',after:'图表、下单、持仓有清晰顺序；桌面可收起下单，窄屏顺序可检查。',try:'切换“窄屏预览”；桌面A右上可收起下单，B通过左轨展开。'},
];
const variant=computed(()=>variants.some(v=>v.id===route.query.variant)?route.query.variant:'A');
const currentVariant=computed(()=>variants.find(v=>v.id===variant.value));
const feature=computed(()=>features.find(f=>f.id===route.query.focus)??features[0]);
const scene=computed(()=>['setup','training','records','review'].includes(route.query.scene)?route.query.scene:feature.value.scene);
const compare=computed(()=>['split','before','after'].includes(route.query.compare)?route.query.compare:'split');
const theme=ref('dark'), narrow=ref(false), stateOpen=ref(false), featuresOpen=ref(false), state=ref({}), beforeState=ref({}), revision=ref(0), visited=ref(new Set(['hierarchy']));
function jumpToCanvas() { document.getElementById('prototype-canvas').scrollIntoView({block:'start'}); }
onMounted(() => { if (route.hash === '#prototype-canvas') requestAnimationFrame(jumpToCanvas); });
function update(query) { router.replace({query:{...route.query,prototype:'ui',variant:variant.value,...query}}); }
function cycle(direction) { const i=variants.findIndex(v=>v.id===variant.value);update({variant:variants[(i+direction+3)%3].id}); }
function selectFeature(id) { visited.value=new Set([...visited.value,id]); update({focus:id,scene:features.find(f=>f.id===id).scene}); }
watch(variant,()=>{stateOpen.value=false;});
const relevantState=computed(()=>JSON.stringify({variant:variant.value,scene:scene.value,focus:feature.value.id,compare:compare.value,theme:theme.value,viewport:narrow.value?'390px':'自适应桌面',...state.value},null,2));
</script>
<template>
  <div class="replay-prototype" :data-proto-theme="theme">
    <div class="proto-review-toolbar"><div><span class="proto-eyebrow">DESIGN STUDY / 交互原型 / 非正式功能</span><h1>让行情回到中心。</h1><p>TradingView 的图表习惯，OKX 的操作位置，InvestFlow 的训练闭环。</p></div><div class="proto-review-tools"><button type="button" @click="theme=theme==='dark'?'light':'dark'"><Sun v-if="theme==='dark'" :size="15" /><Moon v-else :size="15" />{{ theme==='dark'?'深色':'浅色' }}</button><button type="button" :aria-pressed="narrow" @click="narrow=!narrow"><Smartphone v-if="narrow" :size="15" /><Monitor v-else :size="15" />{{ narrow?'窄屏预览':'桌面预览' }}</button><button type="button" @click="jumpToCanvas">看原型 ↓</button><button type="button" title="重置原型内演示状态" @click="revision++"><RotateCcw :size="14" />重置</button></div></div>
    <section class="proto-study-controls" aria-label="原型审阅工具"><div class="proto-variants"><button v-for="v in variants" :key="v.id" type="button" :aria-pressed="variant===v.id" @click="update({variant:v.id})"><span>{{ v.id }}</span><strong>{{ v.name }}</strong><small>{{ v.id==='A'?'推荐':v.id==='B'?'观察优先':'决策并列' }}</small></button></div><p class="proto-variant-description">{{ currentVariant.description }}</p><div class="proto-scene-controls"><div class="proto-line-tabs"><button v-for="[s,label] in [['setup','开始页面'],['training','练习中'],['records','交易追踪'],['review','结束复盘']]" :key="s" type="button" :aria-pressed="scene===s" @click="update({scene:s})">{{ label }}</button></div><div class="proto-comparison-mode"><button v-for="[m,label] in [['before','只看修改前'],['split','前后并排'],['after','完整查看方案']]" :key="m" type="button" :aria-pressed="compare===m" @click="update({compare:m})">{{ label }}</button></div></div></section>
    <section class="proto-recommendations"><div class="proto-recommendations-top"><strong>逐项核对建议 <button type="button" class="proto-feature-toggle" @click="featuresOpen=!featuresOpen">{{ featuresOpen ? '收起清单' : '展开16项清单' }}</button><small>{{ visited.size }} / {{ features.length }}</small></strong><UiSelect :model-value="feature.id" aria-label="选择前后对比建议" @update:model-value="selectFeature"><option v-for="f in features" :key="f.id" :value="f.id">{{ f.label }}</option></UiSelect></div><div v-if="featuresOpen" class="proto-feature-chips"><button v-for="f in features" :key="f.id" type="button" :aria-pressed="feature.id===f.id" @click="selectFeature(f.id)"><Check v-if="visited.has(f.id)" :size="10" />{{ f.label }}</button></div><div class="proto-diff-explanation"><div><span>修改前</span><p>{{ feature.before }}</p></div><ArrowRight :size="18" /><div><span>修改后</span><p>{{ feature.after }}</p></div></div><p class="proto-try"><strong>试一试</strong>{{ feature.try }}</p></section>
    <div v-if="compare==='split'" class="proto-compare-tip">左侧为当前页面的结构复刻，右侧为方案 {{ variant }}。内容使用骨架和模拟值；需要检查多图与下单细节时，点击“完整查看方案”。</div>
    <div id="prototype-canvas" class="proto-canvas-grid" :class="[`mode-${compare}`,{'preview-narrow':narrow}]">
      <section v-if="compare!=='after'" class="proto-canvas"><header class="proto-canvas-label"><span><i class="proto-before-dot"></i>修改前 · 当前结构复刻</span><small>原位置 / 原信息层级</small></header><div class="proto-canvas-scroll"><PrototypeWorkspace :key="`before-${revision}`" variant="before" :scene="scene" :feature="feature.id" :narrow="narrow" :theme="theme" @state="beforeState=$event" /></div></section>
      <section v-if="compare!=='before'" class="proto-canvas"><header class="proto-canvas-label"><span><i class="proto-after-dot"></i>修改后 · {{ variant }} / {{ currentVariant.name }}</span><small>可交互 / 内存演示</small></header><div class="proto-canvas-scroll"><PrototypeWorkspace :key="`${variant}-${revision}`" :variant="variant" :scene="scene" :feature="feature.id" :narrow="narrow" :theme="theme" @state="state=$event" /></div></section>
    </div>
    <section class="proto-state-inspector"><button type="button" :aria-expanded="stateOpen" @click="stateOpen=!stateOpen"><span>原型状态 · {{ state['页面']??scene }} · {{ state['训练进度']??'T+45m' }} · {{ state['图表布局']??'dual' }} · {{ state['持仓']?'有示例持仓':'空仓' }}</span><span>{{ stateOpen?'收起':'展开全部状态' }}</span></button><pre v-if="stateOpen">{{ relevantState }}</pre></section>
    <p class="proto-study-footnote">本原型用于比较布局与交互。行情为模拟曲线；所有下单、资金、复盘和筛选状态仅存于本页内存。尚未接入正式交易追踪或生产功能。</p>
    <PrototypeSwitcher :label="`${variant} / ${currentVariant.name}`" @cycle="cycle" />
  </div>
</template>
