<script setup>
import { computed, ref } from 'vue';
const props = defineProps({ index: { type: Number, default: 0 }, period: { type: String, default: '15m' }, symbol: { type: String, default: 'BTCUSDT' }, spanMinutes: { type: Number, default: 0 }, crosshair: { type: Object, default: null }, linked: Boolean, priceLinked: Boolean, active: Boolean, clock: { type: Number, default: 45 }, offset: { type: Number, default: 0 }, zoom: { type: Number, default: 1 }, source: { type: String, default: '最新价' } });
const emit = defineEmits(['crosshair', 'activate', 'pan']);
const local = ref(null);
const periodMinutes = computed(() => ({ '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440 })[props.period]);
const span = computed(() => props.spanMinutes || periodMinutes.value * 44 / props.zoom);
const end = computed(() => props.clock - props.offset);
const start = computed(() => end.value - span.value);
const candles = computed(() => Array.from({ length: 44 }, (_, i) => {
  const t = start.value + i / 43 * span.value;
  const base = 162 - Math.sin(t / 90) * 44 - Math.sin(t / 27) * 16 - Math.sin(t / 900) * 12;
  const close = base + Math.sin(t * .7) * 13;
  return { x: 13 + i * 10.5, y: Math.min(base, close), h: Math.max(2, Math.abs(base - close)), base, close, up: close < base, volume: 4 + Math.abs(Math.sin(t / 17)) * 24 };
}));
const hair = computed(() => props.linked ? props.crosshair : local.value);
const crossX = computed(() => hair.value ? (hair.value.time - start.value) / span.value * 451 + 13 : -1);
const crossY = computed(() => hair.value && (props.priceLinked || hair.value.index === props.index) ? hair.value.y : null);
function move(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = Math.max(13, Math.min(464, (event.clientX - rect.left) / rect.width * 520));
  const point = { time: Math.round(start.value + (x - 13) / 451 * span.value), y: Math.max(28, Math.min(235, (event.clientY - rect.top) / rect.height * 300)), index: props.index };
  local.value = point; emit('crosshair', point);
}
const timeLabel = computed(() => hair.value ? `T${hair.value.time >= 0 ? '+' : '−'}${Math.abs(hair.value.time)}m` : '移入图表查看联动');
</script>
<template>
  <div class="proto-chart" :class="{ 'is-active': active }" role="group" :aria-label="`图${index+1}，${period}，按回车选中`" tabindex="0" @click="emit('activate')" @keydown.enter="emit('activate')">
    <div class="proto-chart-title"><strong>{{ symbol }} <span>永续</span></strong><span>{{ period }} · {{ source }}</span><span v-if="active" class="proto-dot">当前图</span></div>
    <svg viewBox="0 0 520 300" preserveAspectRatio="none" role="img" :aria-label="`${period} 演示K线，当前只展示到 T+${clock} 分钟`" @pointermove="move" @wheel.prevent="emit('pan', $event.deltaY > 0 ? 15 : -15)">
      <g class="proto-gridlines"><line v-for="n in 5" :key="`h${n}`" x1="0" :y1="n * 46" x2="474" :y2="n * 46" /><line v-for="n in 7" :key="`v${n}`" :x1="n * 65" y1="0" :x2="n * 65" y2="270" /></g>
      <path d="M0 188 Q60 152 130 174 T260 116 T380 145 T465 109" fill="none" stroke="#c6a959" stroke-width="1.2" opacity=".65" />
      <g v-for="(c,i) in candles" :key="i" :fill="c.up ? '#33b89b' : '#e76f85'" :stroke="c.up ? '#33b89b' : '#e76f85'"><line :x1="c.x" :x2="c.x" :y1="c.y-6" :y2="c.y+c.h+7" stroke-width="1" /><rect :x="c.x-2.5" :y="c.y" width="5" :height="c.h" stroke="none" /><rect :x="c.x-3" :y="268-c.volume" width="6" :height="c.volume" opacity=".35" stroke="none" /></g>
      <line x1="0" y1="127" x2="474" y2="127" stroke="#33b89b" stroke-dasharray="2 4" opacity=".65" />
      <g class="proto-chart-axis"><text x="480" y="49">84,800</text><text x="480" y="96">84,600</text><text x="480" y="142">84,400</text><text x="480" y="188">84,200</text><text x="10" y="289">历史背景</text><text x="351" y="289">T+{{ end }}m</text></g>
      <g v-if="hair && crossX >= 0 && crossX <= 474" class="proto-crosshair"><line :x1="crossX" y1="22" :x2="crossX" y2="271" /><line v-if="crossY != null" x1="0" :y1="crossY" x2="474" :y2="crossY" /><rect :x="Math.min(crossX, 385)" y="272" width="83" height="18" fill="#354559" stroke="none" /><text :x="Math.min(crossX, 385) + 5" y="284" fill="#fff" stroke="none" font-size="9">{{ timeLabel }}</text></g>
    </svg>
    <div class="proto-chart-foot"><span>{{ timeLabel }}</span><span>可见上限 T+{{ clock }}m · 含形成中K线</span></div>
  </div>
</template>
