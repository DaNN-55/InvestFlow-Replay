import Decimal from 'decimal.js';
import { createCryptoCalculator } from './replay-crypto-calculations.js';
import { cryptoPersistenceError } from './replay-crypto-persistence.js';
const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
const money = value => new D(value).toFixed(8);
const fail = message => { throw cryptoPersistenceError('INVALID_REQUEST', message, 400); };
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function positive(value, label) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || value.replace('.', '').length > 32 || !new D(value).gt(0)) fail(`${label}须为正十进制数`);
  return new D(value);
}

// Read-only estimates: use only the current known prices and this session's rules.
export function previewCryptoOrder({ rules, instrumentId, state, prices, engine, input }) {
  const calc = createCryptoCalculator({ rules, instrumentId }), spec = rules.instruments[instrumentId].spec;
  const { intent, orderType, sizingMode, amount, exitPrice } = input;
  if (!['long', 'short', 'reduce'].includes(intent) || !['market', 'limit'].includes(orderType) || !['contracts', 'margin', 'risk'].includes(sizingMode)) fail('请选择操作、委托类型和仓位输入方式');
  if (intent === 'reduce' && sizingMode !== 'contracts') fail('减仓请直接填写张数');
  if (input.exitReference && !['last', 'mark'].includes(input.exitReference)) fail('退出参考只支持 last 或 mark');
  const entered = positive(amount, sizingMode === 'contracts' ? '张数' : '金额');
  if (sizingMode !== 'contracts' && entered.decimalPlaces() > 8) fail('USDT 金额最多保留 8 位小数');
  if (intent === 'reduce' && !state.account.position) fail('当前没有可减仓持仓');
  const side = intent === 'reduce' ? state.account.position.side : intent;
  const buy = intent === 'reduce' ? side === 'short' : side === 'long';
  const reference = orderType === 'limit' ? positive(input.limitPrice, '限价').toFixed() : prices.last;
  const quote = quantity => orderType === 'market'
    ? calc.quoteMarketFill({ contracts: quantity, action: buy ? 'buy' : 'sell', referencePrice: reference, slippageBps: state.slippageBps, leverage: state.leverage })
    : { ...calc.quoteFill({ contracts: quantity, fillPrice: reference, liquidityRole: 'taker', leverage: state.leverage }), slippageAttribution: '0.00000000' };
  const unit = quote(spec.minSz), unitContracts = new D(spec.minSz);
  const closingQuote = q => intent !== 'reduce' && exitPrice ? calc.quoteMarketFill({ contracts: q.contracts, action: side === 'long' ? 'sell' : 'buy', referencePrice: positive(exitPrice, '计划退出价').toFixed(), slippageBps: state.slippageBps }) : null;
  const planLoss = q => {
    const close = closingQuote(q); if (!close) return null;
    const pnl = new D(close.fillPrice).minus(q.fillPrice).times(q.baseQuantity).times(side === 'long' ? 1 : -1);
    return D.max(0, pnl.negated().plus(q.fee).plus(close.fee));
  };
  let contracts = entered.toFixed(), rawContracts = contracts;
  if (sizingMode === 'margin') rawContracts = entered.div(new D(unit.initialMargin).div(unitContracts)).toFixed();
  if (sizingMode === 'risk') {
    if (!exitPrice) fail('按风险预算估仓需要明确计划退出价');
    const exit = positive(exitPrice, '计划退出价');
    if (side === 'long' ? exit.gte(unit.fillPrice) : exit.lte(unit.fillPrice)) fail('风险预算的退出价须位于入场价的不利方向');
    rawContracts = entered.div(planLoss(unit).div(unitContracts)).toFixed();
  }
  if (sizingMode !== 'contracts') {
    contracts = calc.floorContracts(new D(rawContracts).toNearest(spec.lotSz, D.ROUND_FLOOR).toFixed());
    // Rounded per-fill fees can cross a budget by a money unit; size down again.
    while (new D(contracts).gt(0)) {
      const q = quote(contracts), cost = sizingMode === 'margin' ? new D(q.initialMargin) : planLoss(q);
      if (cost.lte(entered)) break;
      contracts = calc.floorContracts(new D(contracts).minus(spec.lotSz).toFixed());
    }
  }
  if (!new D(contracts).gt(0)) fail('预算不足以达到最小合约张数');
  const q = quote(contracts);
  const command = { type: `${orderType}-${intent === 'reduce' ? 'close' : 'open'}`, contracts, ...(intent === 'reduce' ? {} : { side }), ...(orderType === 'limit' ? { limitPrice: reference } : {}) };
  const simulated = engine.apply(state, command).state;
  const account = intent === 'reduce'
    ? calc.reducePosition(state.account, { contracts, fillPrice: q.fillPrice, liquidityRole: 'taker' }).account
    : (state.account.position ? calc.addPosition : calc.openPosition)(state.account, { contracts, side, leverage: state.leverage, fillPrice: q.fillPrice, liquidityRole: 'taker' }).account;
  const close = closingQuote(q);
  const plannedPricePnl = close ? new D(close.fillPrice).minus(q.fillPrice).times(q.baseQuantity).times(side === 'long' ? 1 : -1) : null;
  return { contracts, sizingMode, rawContracts, roundedDown: !new D(rawContracts).eq(contracts), ...q,
    initialMargin: intent === 'reduce' ? '0.00000000' : q.initialMargin,
    makerFee: money(new D(q.notional).times(rules.feeBaseline.makerRate)), takerFee: q.fee,
    requiredAvailable: money(new D(simulated.reservedBalance).minus(state.reservedBalance)),
    estimatedPlanLoss: close ? money(planLoss(q)) : null, plannedPricePnl: plannedPricePnl == null ? null : money(plannedPricePnl),
    estimatedExitFee: close?.fee ?? null, estimatedExitPrice: close?.fillPrice ?? null,
    projectedRisk: account.position ? calc.assessPosition(account.position, prices.mark) : null,
    currentLast: prices.last, currentMark: prices.mark, pricesAreKnownPrefix: true, estimateIsNotFill: true,
    planReference: input.exitReference ?? 'last', markBasisUnknown: input.exitReference === 'mark',
    fundingUnknown: true, limitLiquidityRoleUnknown: orderType === 'limit' };
}

// Derive review from committed requests. Never migrate or write execution state.
export function deriveCryptoReview({ engine, rules, instrumentId, config, actions, expectedState }) {
  const corrupt = () => { throw cryptoPersistenceError('REPLAY_ACCOUNTING_CORRUPT', '派生复盘与原提交状态不一致，未替换历史结果', 500); };
  const face = new D(rules.instruments[instrumentId].spec.ctVal).times(rules.instruments[instrumentId].spec.ctMult);
  let state = engine.create(config), peak = new D(config.startingCash), maxDrawdown = new D(0), drawdownAmount = new D(0), samples = 0;
  let plan = { mode: 'none' }, episode = null; const orders = new Map(), trades = [];
  function sample() {
    const equity = new D(state.summary.accountEquity); peak = D.max(peak, equity);
    const amount = peak.minus(equity), percent = amount.div(peak).times(100);
    if (percent.gt(maxDrawdown)) { maxDrawdown = percent; drawdownAmount = amount; }
    samples++;
  }
  function closeEpisode(kind, minute) {
    if (!episode) return;
    trades.push({ entryMinute: episode.minute, exitMinute: minute, side: episode.side, contracts: episode.contracts.toFixed(),
      plannedPricePnl: episode.hasPlan ? money(episode.planned) : null,
      actualPricePnl: kind === 'teaching-liquidation' ? null : money(episode.actual),
      pricePnlDifference: kind === 'teaching-liquidation' || !episode.hasPlan ? null : money(episode.actual.minus(episode.planned)),
      exitKind: kind, comparisonStatus: kind === 'teaching-liquidation' ? 'different-settlement-model' : episode.hasPlan ? 'comparable' : 'missing-entry-plan',
      planReferences: [...episode.references] });
    episode = null;
  }
  function consume(events, before) {
    for (const event of events) {
      if (event.type === 'order-submitted') {
        const stop = event.order.attachedProtection ? event.order.attachedProtection.stopLoss : before.protection?.stopLoss;
        orders.set(event.order.id, stop ? { price: stop.price, reference: stop.reference } : plan.mode === 'manual' ? { price: plan.manualExitPrice, reference: 'last' } : null);
      }
      if (event.quote && ['order-filled', 'protection-filled', 'end-filled'].includes(event.type)) {
        if (event.intent === 'increase') {
          if (!episode) episode = { minute: event.observedAtMinute, side: event.side, contracts: new D(0), remaining: new D(0), planned: new D(0), actual: new D(0), hasPlan: true, references: new Set() };
          const quantity = new D(event.quote.contracts), entryPlan = orders.get(event.orderId);
          episode.contracts = episode.contracts.plus(quantity); episode.remaining = episode.remaining.plus(quantity);
          if (!entryPlan) episode.hasPlan = false;
          else { episode.references.add(entryPlan.reference); episode.planned = episode.planned.plus(new D(entryPlan.price).minus(event.quote.fillPrice).times(quantity).times(face).times(event.side === 'long' ? 1 : -1)); }
        } else if (episode) {
          episode.actual = episode.actual.plus(event.realizedPnl); episode.remaining = episode.remaining.minus(event.quote.contracts);
          if (episode.remaining.isZero()) closeEpisode(event.type === 'end-filled' ? 'training-end' : event.type === 'protection-filled' ? 'protection' : 'user-exit', event.observedAtMinute);
        }
      }
      if (event.type === 'teaching-liquidation') closeEpisode('teaching-liquidation', event.observedAtMinute);
    }
  }
  function apply(command) { const before = state, result = engine.apply(state, command); state = result.state; consume(result.events, before); sample(); }
  sample();
  for (const action of actions) {
    const command = action.request?.command;
    if (command?.type === 'set-plan') plan = { mode: command.mode, manualExitPrice: command.manualExitPrice };
    else if (command?.type === 'advance') {
      while (state.elapsedMinutes < action.state.elapsedMinutes) apply({ type: 'advance', minutes: 1, stopOnEvent: false });
    } else if (command && !['blind-review', 'reveal', 'post-review'].includes(command.type)) {
      apply(command);
      if (command.type === 'finish') while (state.elapsedMinutes < action.state.elapsedMinutes) apply({ type: 'advance', minutes: 1, stopOnEvent: false });
    }
    if (canonical(state) !== canonical(action.state)) corrupt();
  }
  if (canonical(state) !== canonical(expectedState) || episode) corrupt();
  return { version: 'okx-derived-review-v1', finalEquity: state.summary.accountEquity,
    returnPercent: money(new D(state.summary.netPnl).div(config.startingCash).times(100)),
    maxDrawdownPercent: money(maxDrawdown), drawdownAmountAtMaximum: money(drawdownAmount), equitySamples: samples,
    sampledThroughMinute: state.elapsedMinutes, sampling: 'executed-minute-close-and-action-end; not-tick-or-intraminute',
    slippageAttribution: state.totals.slippageAttribution, deficitWaiverMemo: state.totals.deficitWaiverMemo,
    waiverIsNotTradingProfit: true, teachingSettlementIncludedInAccountReturn: true,
    planBenchmark: 'entry-order-plan-at-submission; actual-filled-quantity; price-pnl-only; excludes-fees-funding', trades };
}
