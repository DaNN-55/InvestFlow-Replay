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
export const formatProtectionEstimate=estimate=>estimate?`预计 ${signed(estimate.pnl)} USDT · ${signed(estimate.returnPercent)}%`:'';
export function repriceProtectionLine(line,price) {
  if(!line.estimateContext) return {...line,price};
  const estimate=cryptoProtectionEstimate(line.estimateContext,price);
  return {...line,price,estimate,estimateText:formatProtectionEstimate(estimate)};
}
