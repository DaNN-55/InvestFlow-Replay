const TRADE_ACTIONS = new Set(["buy", "add", "reduce", "sell"]);
const BUY_ACTIONS = new Set(["buy", "add"]);
const SELL_ACTIONS = new Set(["reduce", "sell"]);

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function ledgerError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function orderedEvents(events) {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(String(left.event?.eventAt ?? ""));
      const rightTime = Date.parse(String(right.event?.eventAt ?? ""));
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.index - right.index;
    })
    .map(({ event }) => event);
}

export function calculateTradeLedger(events = []) {
  let buyQuantity = 0;
  let sellQuantity = 0;
  let positionQuantity = 0;
  let positionCost = 0;
  let grossBuyAmount = 0;
  let grossSellAmount = 0;
  let totalBuyCost = 0;
  let netSellProceeds = 0;
  let totalFees = 0;
  let realizedPnl = 0;
  let lastPrice = null;
  let tradeEventCount = 0;
  let unplannedEventCount = 0;

  for (const event of orderedEvents(Array.isArray(events) ? events : [])) {
    const action = String(event?.action ?? "").trim().toLowerCase();
    const price = event?.price == null ? null : Number(event.price);
    const quantity = event?.quantity == null ? null : Number(event.quantity);
    const fee = event?.fee == null ? 0 : Number(event.fee);

    if (!Number.isFinite(fee) || fee < 0) {
      throw ledgerError("交易费用必须是大于等于 0 的数字");
    }
    if (!TRADE_ACTIONS.has(action)) {
      if (price != null && Number.isFinite(price) && price > 0) {
        lastPrice = price;
      }
      continue;
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw ledgerError("买卖动作必须填写大于 0 的成交价格");
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw ledgerError("买卖动作必须填写大于 0 的成交数量");
    }

    tradeEventCount += 1;
    totalFees += fee;
    lastPrice = price;
    if (event.planStatus === "unplanned") {
      unplannedEventCount += 1;
    }

    const notional = price * quantity;
    if (BUY_ACTIONS.has(action)) {
      buyQuantity += quantity;
      positionQuantity += quantity;
      grossBuyAmount += notional;
      totalBuyCost += notional + fee;
      positionCost += notional + fee;
      continue;
    }

    if (SELL_ACTIONS.has(action)) {
      if (quantity > positionQuantity) {
        throw ledgerError(
          `卖出数量 ${quantity} 股超过当前持仓 ${round(positionQuantity)} 股`,
        );
      }
      const averageCostBeforeSale = positionQuantity > 0
        ? positionCost / positionQuantity
        : 0;
      const releasedCost = averageCostBeforeSale * quantity;
      const proceeds = notional - fee;
      sellQuantity += quantity;
      positionQuantity -= quantity;
      positionCost -= releasedCost;
      grossSellAmount += notional;
      netSellProceeds += proceeds;
      realizedPnl += proceeds - releasedCost;
      if (Math.abs(positionQuantity) < 1e-8) {
        positionQuantity = 0;
        positionCost = 0;
      }
    }
  }

  const averageCost = positionQuantity > 0 ? positionCost / positionQuantity : 0;
  const marketValue = lastPrice == null ? 0 : positionQuantity * lastPrice;
  const unrealizedPnl = lastPrice == null
    ? 0
    : marketValue - positionCost;
  const totalPnl = realizedPnl + unrealizedPnl;
  const state = tradeEventCount === 0
    ? "not_started"
    : positionQuantity > 0
      ? "open"
      : "closed";

  return {
    state,
    buyQuantity: round(buyQuantity),
    sellQuantity: round(sellQuantity),
    positionQuantity: round(positionQuantity),
    averageCost: round(averageCost),
    grossBuyAmount: round(grossBuyAmount),
    grossSellAmount: round(grossSellAmount),
    totalBuyCost: round(totalBuyCost),
    netSellProceeds: round(netSellProceeds),
    totalFees: round(totalFees),
    realizedPnl: round(realizedPnl),
    lastPrice: lastPrice == null ? null : round(lastPrice),
    marketValue: round(marketValue),
    unrealizedPnl: round(unrealizedPnl),
    totalPnl: round(totalPnl),
    returnPct: totalBuyCost > 0 ? round((totalPnl / totalBuyCost) * 100) : 0,
    tradeEventCount,
    unplannedEventCount,
  };
}
