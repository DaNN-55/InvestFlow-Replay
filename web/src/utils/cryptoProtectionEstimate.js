import { moneyAmount } from './cryptoMoneyPresentation.js';
// Display-only conditional price PnL. Never quote a fill or change account state.
export function cryptoProtectionEstimate(session,price) {
  const p=session?.account?.position,contract=session?.contract;
  if(!p||!['long','short'].includes(p.side)) return null;
  const quantity=Number(p.contracts),face=Number(contract?.ctVal)*Number(contract?.ctMult),exit=Number(price),entry=Number(p.entryPrice),leverage=Number(session.config?.leverage);
  if(![quantity,face,exit,entry,leverage].every(v=>Number.isFinite(v)&&v>0)) return null;
  // The server keeps remaining entry cost separately to avoid rounded weighted-entry drift.
  const cost=p.entryNotional==null?quantity*face*entry:Number(p.entryNotional);
  if(!Number.isFinite(cost)||cost<=0) return null;
  const pnl=(quantity*face*exit-cost)*(p.side==='long'?1:-1),initialMargin=cost/leverage,returnPercent=pnl/initialMargin*100;
  return [pnl,initialMargin,returnPercent].every(Number.isFinite)?{pnl,returnPercent,initialMargin}:null;
}
const signed=value=>{
  const rounded=Number(value.toFixed(2));
  return rounded===0?'0.00':`${rounded>0?'+':''}${rounded.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
};
export const formatProtectionEstimate=estimate=>estimate?`预计 ${estimate.pnl>0?'+':''}${moneyAmount(estimate.pnl)} USDT · ${signed(estimate.returnPercent)}%`:'';
export function repriceProtectionLine(line,price) {
  if(!line.estimateContext) return {...line,price};
  const estimate=cryptoProtectionEstimate(line.estimateContext,price);
  return {...line,price,estimate,moneyTitle:estimate?`${estimate.pnl} USDT`:line.moneyTitle,estimateText:formatProtectionEstimate(estimate),compactLabel:estimate?`${line.estimateLeg==='stopLoss'?'止损':'止盈'} ${formatProtectionEstimate(estimate).replace('预计 ','')}`:line.compactLabel};
}

export function cryptoProtectionRewardRisk(session,preview=null) {
  const protection=session?.protection;
  if(!session?.account?.position||!protection?.stopLoss||!protection.takeProfit) return null;
  if(protection.triggeredLeg) return {ratio:null,reason:'保护已触发'};
  const price=leg=>preview?.leg===leg?preview.price:protection[leg].price;
  const stop=cryptoProtectionEstimate(session,price('stopLoss')),profit=cryptoProtectionEstimate(session,price('takeProfit'));
  if(!stop||!profit) return {ratio:null,reason:'当前无法估算'};
  // Money is stored to eight decimals; zero loss is not an infinite reward/risk ratio.
  if(stop.pnl>=-1e-8) return {ratio:null,reason:'止损不在亏损区'};
  if(profit.pnl<=1e-8) return {ratio:null,reason:'止盈不在盈利区'};
  const ratio=profit.pnl/-stop.pnl;
  return Number.isFinite(ratio)?{ratio,reward:profit.pnl,risk:-stop.pnl,reason:''}:{ratio:null,reason:'当前无法估算'};
}
export const formatProtectionRewardRisk=value=>value?.ratio!=null?`${value.ratio.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} : 1`:'—';
