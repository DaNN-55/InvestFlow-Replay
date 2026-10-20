import { inspectBoardBar, maximumOrderQuantity, quantityError, resolveBoardQuantity } from "./replay-board-rules.js";

// Deterministic bar-level execution; persistence stays in the session transaction.
export const BAR_ORDER_MODEL = "bar-orders-v1";
export const LEGACY_ORDER_MODEL = "legacy-next-open";
export const isBarOrderModel = (version) => [BAR_ORDER_MODEL, "bar-orders-v2"].includes(version);
export const isOpenOrder = (state) => ["pending", "partially_filled"].includes(state?.status);
const round = (value) => Number(Number(value).toFixed(10));
const lot = (value) => Math.floor(Math.max(0, Number(value) || 0) / 100) * 100;

export function newOrderState(order) {
  return {
    orderType: order.orderType ?? "market",
    limitPrice: order.limitPrice ?? null,
    stopPrice: order.stopPrice ?? null,
    status: "pending",
    targetQuantity: null,
    filledQuantity: 0,
    triggeredSequence: null,
    triggerPrice: null,
    expirySequence: null,
    feeByDay: {},
  };
}

export function closeOrder(order, status, reasonCode, reasonMessage, sequence) {
  Object.assign(order.state, { status, reasonCode, reasonMessage, closedSequence: sequence });
}

export function executeReplayOrders({
  orders: inputOrders, account: inputAccount, bars, sequence, sessionEnding,
  costConfig, calculateFees, resolveQuantity, roundPrice, createId, boardRules = null, snapshot = null,
}) {
  const orders = structuredClone(inputOrders);
  const account = { ...inputAccount };
  const bar = bars[sequence - 1];
  const previousBar = bars[sequence - 2];
  const fills = [];
  const fillQuantity = boardRules ? (value) => Math.floor(Math.max(0, Number(value) || 0)) : lot;
  let capacity = fillQuantity(bar.volume);
  const active = () => orders.filter((order) => isOpenOrder(order.state));
  const waiting = (order, code, message) => Object.assign(order.state, { reasonCode: code, reasonMessage: message });
  const dayEnd = !bars[sequence] || bars[sequence].tradeDate !== bar.tradeDate;

  function blocked(side) {
    if (boardRules) {
      const market = inspectBoardBar(snapshot, bars, sequence);
      if (market.status === "rule_unavailable") return ["rule_unavailable", "历史交易规则信息不足，本根K线暂不撮合"];
      if (market.status === "suspended") return ["suspended", "当前行情无成交量，等待可成交机会"];
      if (market.status === "invalid_market_data") return ["invalid_market_data", "行情价格不可用"];
      if (market.onePrice && ((side === "buy" && market.status === "limit_up") || (side === "sell" && market.status === "limit_down"))) {
        return [side === "buy" ? "one_price_limit_up" : "one_price_limit_down", "一字涨跌停，等待可成交机会"];
      }
      return null;
    }
    if (!Number.isFinite(Number(bar.volume)) || Number(bar.volume) <= 0) return ["suspended", "当前行情无成交量，等待可成交机会"];
    const prices = [bar.open, bar.high, bar.low, bar.close].map(Number);
    if (!prices.every((p) => Number.isFinite(p) && p > 0)) return ["invalid_market_data", "行情价格不可用"];
    const onePrice = prices.every((p) => p === prices[0]);
    const preClose = Number(bar.preClose ?? previousBar?.close);
    const pct = bar.pctChange == null ? (prices[0] / preClose - 1) * 100 : Number(bar.pctChange);
    const flag = bar.limitType || null;
    const up = flag ? flag === "U" : pct >= 4.8 && prices[0] > preClose;
    const down = flag ? flag === "D" : pct <= -4.8 && prices[0] < preClose;
    if (onePrice && ((side === "buy" && up) || (side === "sell" && down))) {
      return [side === "buy" ? "one_price_limit_up" : "one_price_limit_down", "一字涨跌停，等待可成交机会"];
    }
    return null;
  }

  function referencePrice(order) {
    const state = order.state;
    if (state.orderType === "stop") {
      if (state.triggeredSequence == null) return null;
      return state.triggeredSequence === sequence ? Math.min(Number(bar.open), state.stopPrice) : Number(bar.open);
    }
    if (state.orderType === "market") return Number(bar.open);
    const limit = state.limitPrice;
    if (order.side === "buy") return Number(bar.open) <= limit ? Number(bar.open) : Number(bar.low) <= limit ? limit : null;
    return Number(bar.open) >= limit ? Number(bar.open) : Number(bar.high) >= limit ? limit : null;
  }

  function feesFor(order, quantity, price) {
    const notional = round(quantity * price);
    const prior = order.state.feeByDay[String(bar.tradeDate)] ?? { notional: 0, commission: 0 };
    const cumulative = calculateFees(prior.notional + notional, order.side, costConfig);
    const current = calculateFees(notional, order.side, costConfig);
    const commission = round(cumulative.commission - prior.commission);
    return { notional, commission, stampTax: current.stampTax, transferFee: current.transferFee,
      totalFee: round(commission + current.stampTax + current.transferFee) };
  }

  function protectPosition(parent) {
    const price = parent.decision?.stopLossPrice;
    if (!(price > 0) || parent.state.protectionCreated || parent.state.protectionSuppressed) return;
    for (const existing of active().filter((item) => item.state.orderType === "stop")) {
      closeOrder(existing, "cancelled", "protection_replaced", "持仓止损已由新的买入计划更新", sequence);
    }
    const id = createId();
    orders.push({
      id, action_id: createId(), side: "sell", quantity_type: "position_ratio", requested_quantity: null, ratio: 1,
      submitted_sequence: sequence, scheduled_sequence: sequence,
      decision: { ...parent.decision, exitType: "stop_loss", remainingPositionPlan: "触发后持续退出剩余持仓" },
      state: { ...newOrderState({ orderType: "stop", stopPrice: price }), sourceOrderId: parent.id,
        targetQuantity: account.positionQuantity },
      created: true,
    });
    parent.state.protectionCreated = true;
  }

  function trigger(order) {
    const state = order.state;
    if (state.orderType !== "stop") return;
    state.targetQuantity = state.filledQuantity + account.positionQuantity;
    if (account.positionQuantity <= 0) {
      closeOrder(order, state.filledQuantity ? "filled" : "cancelled", "position_closed", "持仓已归零，止损保护结束", sequence);
    } else if (state.triggeredSequence == null && Number(bar.volume) > 0 && Number(bar.low) > 0 && Number(bar.low) <= state.stopPrice) {
      state.triggeredSequence = sequence;
      state.triggerPrice = Math.min(Number(bar.open), state.stopPrice);
      waiting(order, "stop_triggered", "止损已触发，将持续尝试退出剩余持仓");
      for (const buy of active().filter((item) => item.side === "buy")) {
        closeOrder(buy, "cancelled", "stop_cancelled_buy", "止损已触发，未成交买入余量已取消，避免自动重新开仓", sequence);
      }
    }
  }

  function execute(order) {
    const state = order.state;
    if (!isOpenOrder(state) || order.scheduled_sequence > sequence) return;
    if (state.orderType !== "stop" && state.expirySequence == null) {
      let last = sequence;
      while (bars[last] && bars[last].tradeDate === bar.tradeDate) last += 1;
      state.expirySequence = last;
    }
    if (state.orderType === "stop") trigger(order);
    if (!isOpenOrder(state)) return;
    const reference = referencePrice(order);
    if (reference == null) {
      waiting(order, state.orderType === "stop" ? "stop_armed" : "limit_not_reached", state.orderType === "stop" ? "止损保护中，尚未触发" : "未到限价，继续等待");
      return;
    }
    if (order.side === "buy" && active().some((item) => item.state.orderType === "stop" && item.state.triggeredSequence != null)) {
      waiting(order, "stop_exit_active", "止损退出进行中，暂停继续买入");
      return;
    }
    const unavailable = blocked(order.side);
    if (unavailable) {
      if (state.orderType === "market" && state.filledQuantity === 0) closeOrder(order, "rejected", ...unavailable, sequence);
      else waiting(order, ...unavailable);
      return;
    }
    let price = roundPrice(reference * (1 + (order.side === "buy" ? 1 : -1) * costConfig.slippageBps / 10000), order.side);
    price = Math.max(Number(bar.low), Math.min(Number(bar.high), price));
    if (state.orderType === "limit") price = order.side === "buy" ? Math.min(price, state.limitPrice) : Math.max(price, state.limitPrice);
    price = round(price);
    if (state.targetQuantity == null) {
      if (boardRules && order.quantity_type === "shares") {
        const error = quantityError(boardRules, order.side, order.requested_quantity, account.positionQuantity, state.orderType, account.availableQuantity);
        if (error) { closeOrder(order, "rejected", "invalid_quantity", error, sequence); return; }
      }
      const quantityOrder = { ...order, quantityType: order.quantity_type, requestedQuantity: order.requested_quantity };
      state.targetQuantity = boardRules
        ? resolveBoardQuantity(quantityOrder, account, price, costConfig, boardRules, calculateFees)
        : resolveQuantity(quantityOrder, account, price, costConfig);
      if (state.targetQuantity <= 0) {
        closeOrder(order, "rejected", order.side === "sell" ? "insufficient_sellable" : "below_lot_size", "可执行数量不足申报起点或没有可卖持仓", sequence);
        return;
      }
      if (order.side === "buy") {
        const planned = feesFor(order, state.targetQuantity, price);
        if (planned.notional + planned.totalFee > account.cash) {
          closeOrder(order, "rejected", "insufficient_cash", "可用现金不足", sequence);
          return;
        }
      } else if (state.targetQuantity > account.positionQuantity) {
        closeOrder(order, "rejected", "insufficient_sellable", "卖出数量超过持仓数量", sequence);
        return;
      }
    }
    const remaining = Math.max(0, state.targetQuantity - state.filledQuantity);
    let quantity = fillQuantity(Math.min(remaining, capacity, boardRules ? maximumOrderQuantity(boardRules, state.orderType) : Infinity, order.side === "sell" ? account.availableQuantity : Infinity));
    const minimumAvailable = boardRules ? 1 : 100;
    if (quantity <= 0) {
      if (state.orderType === "market" && state.filledQuantity === 0 && order.side === "sell" && account.availableQuantity < minimumAvailable) {
        closeOrder(order, "rejected", "insufficient_sellable", "没有足够的可卖数量", sequence);
        return;
      }
      waiting(order, order.side === "sell" && account.availableQuantity < minimumAvailable ? "insufficient_sellable" : "volume_capacity", order.side === "sell" && account.availableQuantity < minimumAvailable ? "受T+1或可卖数量限制，等待可卖" : "当前K线成交容量已用完，余量继续等待");
      return;
    }
    let fees = feesFor(order, quantity, price);
    while (order.side === "buy" && quantity > 0 && fees.notional + fees.totalFee > account.cash) {
      quantity -= boardRules ? 1 : 100;
      fees = feesFor(order, quantity, price);
    }
    if (quantity <= 0) { waiting(order, "insufficient_cash", "可用现金不足，余量等待处理"); return; }
    const priorFee = state.feeByDay[String(bar.tradeDate)] ?? { notional: 0, commission: 0 };
    state.feeByDay[String(bar.tradeDate)] = { notional: round(priorFee.notional + fees.notional), commission: round(priorFee.commission + fees.commission) };
    if (order.side === "buy") {
      const originalCost = account.averageCost * account.positionQuantity;
      account.cash = round(account.cash - fees.notional - fees.totalFee);
      account.positionQuantity += quantity;
      account.lockedQuantity += quantity;
      account.averageCost = round((originalCost + fees.notional + fees.totalFee) / account.positionQuantity);
    } else {
      const proceeds = fees.notional - fees.totalFee;
      account.cash = round(account.cash + proceeds);
      account.positionQuantity -= quantity;
      account.availableQuantity -= quantity;
      account.realizedPnl = round((account.realizedPnl ?? 0) + proceeds - account.averageCost * quantity);
      if (account.positionQuantity === 0) Object.assign(account, { averageCost: 0, availableQuantity: 0, lockedQuantity: 0 });
    }
    capacity -= quantity;
    account.totalFees = round(account.totalFees + fees.totalFee);
    state.filledQuantity += quantity;
    state.status = state.filledQuantity >= state.targetQuantity ? "filled" : "partially_filled";
    state.reasonCode = null;
    state.reasonMessage = null;
    fills.push({ orderId: order.id, sequence, side: order.side, quantity, referencePrice: reference, price, ...fees });
    if (order.side === "buy") protectPosition(order);
  }

  // Existing protection gets first use of capacity; ordinary orders then follow submission order.
  for (const order of active().filter((item) => item.state.orderType === "stop")) execute(order);
  for (const order of [...active()].filter((item) => item.state.orderType !== "stop")) execute(order);
  for (const order of active().filter((item) => item.state.orderType === "stop")) {
    trigger(order);
    if (order.state.triggeredSequence === sequence && account.availableQuantity === 0) waiting(order, "insufficient_sellable", "止损已触发，受T+1限制，将在可卖时继续退出");
  }
  for (const order of active()) {
    if (sessionEnding) closeOrder(order, "cancelled", "session_finished", "演练结束，未完成委托已停止", sequence);
    else if (dayEnd && order.state.orderType !== "stop" && order.state.expirySequence <= sequence) {
      closeOrder(order, "expired", "day_expired", "当日结束，未成交余量已到期", sequence);
    }
  }
  return { account, orders, fills };
}
