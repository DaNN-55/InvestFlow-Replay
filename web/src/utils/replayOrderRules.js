export const isReplayBarOrderModel = (version) => ["bar-orders-v1", "bar-orders-v2"].includes(version);

export function replayQuantityError({ rules, side, quantity, holding = 0, available = holding, orderType = "market" }) {
  if (!rules) return Number.isSafeInteger(quantity) && quantity >= 100 ? "" : "委托股数至少100股";
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return "委托股数必须为正整数";
  const maximum = orderType === "limit" ? rules.maxLimitQuantity : rules.maxMarketQuantity;
  if (quantity > maximum) return `该类单笔委托最多${maximum}股`;
  if (side === "buy") return quantity < rules.minimumBuy || quantity % rules.quantityStep
    ? rules.board === "star" ? "科创板买入至少200股，超过部分可逐股递增" : "买入须为100股或其整数倍" : "";
  if (rules.board === "star") return quantity < 200 && quantity !== holding && quantity !== available ? "余额不足200股时须一次性卖出" : "";
  return quantity % 100 && quantity % 100 !== holding % 100 && quantity % 100 !== available % 100 ? "零股余额须一次性卖出，不能拆分" : "";
}
