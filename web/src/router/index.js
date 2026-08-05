import { createRouter, createWebHistory } from "vue-router";

const MarketReplayView = () => import("../views/MarketReplayView.vue");
const TradeRecordsView = () => import("../views/TradeRecordsView.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/decision/market-replay" },
    { path: "/decision/market-replay", name: "quant-market-replay", component: MarketReplayView },
    { path: "/decision/trade-records", name: "quant-trade-records", component: TradeRecordsView },
    { path: "/:pathMatch(.*)*", redirect: "/decision/market-replay" },
  ],
});
