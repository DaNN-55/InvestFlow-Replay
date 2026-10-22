export const CRYPTO_PERIODS = [[1, '1min'], [3, '3min'], [5, '5min'], [15, '15min'], [30, '30min'], [60, '1h'], [120, '2h'], [240, '4h'], [360, '6h'], [720, '12h'], [1440, '1day']];
export const amount = (value, digits = 2) => value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const exact = (value) => value == null ? '未知' : String(value);
export const relativeTime = (minute) => minute < 0 ? `背景 ${Math.ceil(-minute / 1440)}天前` : `第${Math.floor(minute / 1440) + 1}天 ${String(Math.floor(minute % 1440 / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}`;
export function cryptoChartTime(minute) {
  const day = Math.floor(minute / 1440);
  const withinDay = ((minute % 1440) + 1440) % 1440;
  const clock = `${String(Math.floor(withinDay / 60)).padStart(2,'0')}:${String(withinDay % 60).padStart(2,'0')}`;
  return { day: minute < 0 ? `${day}D` : `D${day + 1}`, clock };
}
export function cryptoChartBars(view, kind = 'last') {
  const trades = new Map((view?.candles?.last ?? []).map(bar => [bar.startMinute,bar]));
  return (view?.candles?.[kind] ?? []).map(bar => {
    const trade = kind === 'last' ? bar : trades.get(bar.startMinute);
    const matched = Boolean(trade) && trade.knownThroughMinute === bar.knownThroughMinute;
    const time = cryptoChartTime(bar.startMinute);
    return { ...bar, period:'minute', volume:matched ? trade.volumeContracts ?? null : null, amount:matched ? trade.volumeQuote ?? null : null,
      startSequence:bar.startMinute, endSequence:bar.knownThroughMinute - 1,
      displayLabel:`${time.day} ${time.clock}${bar.complete ? '' : ' · 形成中'}`,
      axisLabel:view.timeframeMinutes >= 1440 ? time.day : view.timeframeMinutes >= 60 ? `${time.day} ${time.clock}` : time.clock === '00:00' ? time.day : time.clock };
  });
}

export function riskPlan(session) {
  const position = session?.account?.position;
  const stop = session?.protection?.stopLoss;
  if (stop) return { mode: 'automatic', label: session.protection.triggeredLeg ? '止损已触发，待成交余量' : '自动止损', price: stop.price, reference: stop.reference, detail: '触发后按市价减仓；可能滑点或部分成交，不保证在触发价退出。' };
  const plan = session?.trainingJournal?.plan;
  if (plan?.mode === 'manual') return { mode: 'manual', label: '手动退出计划', price: plan.manualExitPrice, reference: 'last', detail: '仅记录判断，不会自动下单；到价仍需手动平仓。' };
  return { mode: 'none', label: '未设退出价', price: null, detail: position ? '缺少计划损失比较基准，不能理解为零风险。允许继续持仓。' : '允许不设自动止损开仓；成交后风险按实际持仓显示。' };
}
export function plannedPricePnl(session) {
  const p = session?.account?.position, plan = riskPlan(session);
  if (!p || plan.price == null) return null;
  const base = Number(p.contracts) * Number(session.contract.ctVal) * Number(session.contract.ctMult);
  return (Number(plan.price) - Number(p.entryPrice)) * base * (p.side === 'long' ? 1 : -1);
}
export const eventName = (type) => ({ 'order-amended': '委托价格已调整', 'order-submitted': '委托已提交', 'order-filled': '普通成交', 'order-cancelled': '委托已撤销', 'order-rejected': '委托被拒绝', 'protection-triggered': '保护已触发', 'protection-filled': '保护成交', 'protection-armed': '保护已设置', 'protection-cancelled': '保护已取消', 'protection-leg-cancelled': '保护单腿已取消', 'protection-resized': '保护数量已联动', 'order-clipped': '减仓量已联动', 'limit-waiting': '限价等待', 'margin-added': '手动追加保证金', 'funding-settled': '资金费结算', 'funding-skipped': '空仓未收付资金费', 'risk-triggered': '风险阈值触发', 'risk-rechecked': '撤单后风险复核', 'teaching-liquidation': '教学强平接管', 'intraminute-ambiguity': '分钟内次序不明', 'end-filled': '结束平仓成交', 'training-ended': '练习已结束', 'end-blocked': '结束受阻，仍有仓位' })[type] ?? type;
export function errorText(error) {
  const msg = error?.message ?? '请求失败';
  if (/cash|afford|balance/i.test(msg)) return '可用资金不足，请减少张数或撤销待成交委托后再试。';
  if (/step|tick|multiple|lot/i.test(msg)) return '价格或张数不符合合约步长，请按下方规格调整。';
  if (/opposite|one.way/i.test(msg)) return '当前为单向持仓；反向开仓前请先平掉现有仓位。';
  return msg;
}

export const commandName = (type) => ({ 'market-open':'市价开仓或加仓', 'limit-open':'限价开仓或加仓', 'market-close':'市价减仓或平仓', 'limit-close':'限价减仓或平仓', 'set-protection':'更新持仓保护', 'cancel-protection':'取消保护', 'amend-limit':'调整限价委托', 'cancel-order':'撤销委托', 'cancel-all-orders':'撤销全部委托', 'add-margin':'手动追加保证金', 'set-plan':'更新手动退出计划', finish:'结束练习' })[type] ?? '操作记录';
export const eventReason = (reason) => ({ 'user-cancelled':'手动撤销', 'user-cancel-all':'手动撤销全部', 'user-finish':'主动结束', 'window-expired':'回放窗口结束', 'IOC-unfilled-remainder':'市价单未成交余量已撤销', 'protective-exit-triggered':'保护触发，撤销相关普通委托', 'NO_MINUTE_CAPACITY':'该分钟没有足够成交容量', 'NO_AFFORDABLE_OR_TIER_CAPACITY':'资金或档位不足以继续成交', 'position-flat':'已空仓，清理相关保护', 'flat-at-source-event-time':'原始资金费时点为空仓', 'reduce-only-position-shrank':'持仓减少，仅减仓委托同步缩量' })[reason] ?? reason;

export function cryptoRiskDetails(session) {
  const risk = session?.risk, equity = Number(session?.summary?.accountEquity), mark = Number(session?.currentPrices?.mark), price = Number(risk?.estimatedLiquidationPrice);
  return { baseQuantity: risk?.baseQuantity ?? null, notional: risk?.notional ?? null,
    unrealizedEquityPercent: risk && equity > 0 ? Number(risk.unrealizedPnl) / equity * 100 : null,
    liquidationDistancePercent: risk?.estimatedLiquidationPrice != null && mark > 0 ? (session.account.position.side === 'long' ? mark - price : price - mark) / mark * 100 : null };
}
export function cryptoChartLines(session, kind) {
  if (!session) return [];
  const lines = [], add = (id, price, label, reference, style, contracts = null) => {
    if (price == null || price === '' || !Number.isFinite(Number(price)) || (kind && reference !== 'entry' && reference !== kind)) return;
    const basis=reference==='entry'?'':` · ${reference}`;
    lines.push({ id: `${session.id}:${id}`, price, label: `${label}${contracts ? ` · ${contracts}张` : ''}${basis}`, reference, contracts, ...style });
  };
  const position=session.account?.position;
  if(position) {
    const pnl=session.risk?.unrealizedPnl;
    const floating=pnl==null?'':` · mark浮盈 ${Number(pnl)>0?'+':''}${amount(pnl)} USDT`;
    add('position',position.entryPrice,`${position.side==='long'?'多仓':'空仓'}均价${floating}`,'entry',{color:'#2563eb',dashed:false},position.contracts);
  }
  const plan = session.trainingJournal?.plan;
  if (plan?.mode === 'manual') add('manual', plan.manualExitPrice, '手动计划（不执行）', 'last', { color: '#a16207', dashed: true });
  for (const order of session.orders ?? []) {
    if (order.type === 'limit') add(`order-${order.id}`, order.limitPrice, `待成交 · ${order.intent === 'reduce' ? '减仓' : order.side === 'long' ? '开多' : '开空'}`, 'last', { color: '#2563eb', dashed: true, orderId:order.id }, order.remainingContracts);
    if(!order.protectionApplied) for(const [leg,label] of [['stopLoss','止损'],['takeProfit','止盈']]) {
      const protection=order.attachedProtection?.[leg];
      if(protection) add(`order-${order.id}-${leg}`,protection.price,`待成交后${label}`,protection.reference,{color:leg==='stopLoss'?'#d55d70':'#159875',dashed:true},order.remainingContracts);
    }
  }
  for (const [leg, label] of [['stopLoss', '自动止损'], ['takeProfit', '自动止盈']]) {
    const protection = session.protection?.[leg];
    if (protection) add(leg, protection.price, `${label}${session.protection.triggeredLeg === leg ? ' · 已触发待退出' : ''}`, protection.reference, { color: leg === 'stopLoss' ? '#d55d70' : '#159875', dashed: false, protectionLeg:leg }, session.protection.contracts);
  }
  return lines;
}
