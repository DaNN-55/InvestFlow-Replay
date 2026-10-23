// A chart gesture is local until the exact captured revision is confirmed.
export function snapProtectionPrice(value, tick) {
  const text=String(tick??'');
  if(!/^\d+(?:\.\d{1,12})?$/.test(text)||Number(text)<=0||!Number.isFinite(value)||value<=0||value>=1e15) return null;
  const [whole,fraction='']=text.split('.'),scale=fraction.length;
  const [mantissa,exponent='0']=String(value).toLowerCase().split('e');
  const [integer,decimals='']=mantissa.split('.');
  const rawScale=decimals.length-Number(exponent);
  const numerator=BigInt(integer+decimals)*10n**BigInt(scale+Math.max(0,-rawScale));
  const step=BigInt(whole+fraction),denominator=step*10n**BigInt(Math.max(0,rawScale));
  const ticks=(2n*numerator+denominator)/(2n*denominator),result=ticks*step;
  if(result<=0n) return null;
  const padded=String(result).padStart(scale+1,'0');
  return scale?`${padded.slice(0,-scale)}.${padded.slice(-scale)}`.replace(/\.?0+$/,''):padded;
}

export function createProtectionDraft(session,leg,value) {
  if(!['stopLoss','takeProfit'].includes(leg)||session?.status!=='active'||session.ending||!session.account?.position||session.protection?.triggeredLeg||!session.protection?.[leg]) return null;
  const price=snapProtectionPrice(value,session.contract.tickSz);
  if(!price||Number(price)===Number(session.protection[leg].price)) return null;
  return {sessionId:session.id,revision:session.revision,leg,price,oldPrice:session.protection[leg].price,
    protection:structuredClone(session.protection),position:structuredClone(session.account.position)};
}

export function protectionDraftCurrent(session,draft) {
  return Boolean(draft&&session?.id===draft.sessionId&&session.revision===draft.revision&&session.status==='active'&&!session.ending&&!session.protection?.triggeredLeg&&
    JSON.stringify(session.protection)===JSON.stringify(draft.protection)&&JSON.stringify(session.account?.position)===JSON.stringify(draft.position));
}

export function protectionDraftCommand(session,draft) {
  if(!protectionDraftCurrent(session,draft)) return null;
  const legs=Object.fromEntries(['stopLoss','takeProfit'].filter(leg=>draft.protection[leg]).map(leg=>[leg,{...draft.protection[leg],...(leg===draft.leg?{price:draft.price}:{})}]));
  return {expectedRevision:draft.revision,command:{type:'set-protection',...legs}};
}

export function protectionDraftTriggered(session,draft) {
  if(!draft) return false;
  const current=Number(session.currentPrices[draft.protection[draft.leg].reference]),price=Number(draft.price),long=draft.position.side==='long';
  return draft.leg==='stopLoss'?(long?price>=current:price<=current):(long?price<=current:price>=current);
}

export function createPriceDraft(session,target,value) {
  if(target.orderId==null) return createProtectionDraft(session,target.leg,value);
  const order=session?.orders?.find(order=>order.id===target.orderId);
  if(session?.status!=='active'||session.ending||order?.type!=='limit'||Number(order.remainingContracts)<=0) return null;
  const price=snapProtectionPrice(value,session.contract.tickSz);
  if(!price||Number(price)===Number(order.limitPrice)) return null;
  return {kind:'order',sessionId:session.id,revision:session.revision,orderId:order.id,price,oldPrice:order.limitPrice,order:structuredClone(order)};
}

export function priceDraftCurrent(session,draft) {
  if(draft?.kind!=='order') return protectionDraftCurrent(session,draft);
  return Boolean(session?.id===draft.sessionId&&session.revision===draft.revision&&session.status==='active'&&!session.ending&&
    JSON.stringify(session.orders?.find(order=>order.id===draft.orderId))===JSON.stringify(draft.order));
}

export function priceDraftCommand(session,draft) {
  if(!priceDraftCurrent(session,draft)) return null;
  return draft.kind==='order'?{expectedRevision:draft.revision,command:{type:'amend-limit',orderId:draft.orderId,limitPrice:draft.price}}:protectionDraftCommand(session,draft);
}

export function priceDraftReached(session,draft) {
  if(draft?.kind!=='order') return protectionDraftTriggered(session,draft);
  const buy=(draft.order.side==='long')!==(draft.order.intent==='reduce');
  return buy?Number(draft.price)>=Number(session.currentPrices.last):Number(draft.price)<=Number(session.currentPrices.last);
}

export function createPriceCancellation(session,target) {
  if(session?.status!=='active'||session.ending) return null;
  if(target.orderId!=null) {
    const order=session.orders?.find(order=>order.id===target.orderId);
    return ['limit','market'].includes(order?.type)&&Number(order.remainingContracts)>0?{kind:'order',sessionId:session.id,revision:session.revision,orderId:order.id,order:structuredClone(order)}:null;
  }
  const leg=target.leg;
  if(!['stopLoss','takeProfit'].includes(leg)||!session.account?.position||!session.protection?.[leg]||(session.protection.triggeredLeg&&session.protection.triggeredLeg!==leg)) return null;
  return {kind:'protection',sessionId:session.id,revision:session.revision,leg,protection:structuredClone(session.protection),position:structuredClone(session.account.position)};
}

export function priceCancellationCurrent(session,draft) {
  if(draft?.kind==='order') return priceDraftCurrent(session,draft);
  return Boolean(draft&&session?.id===draft.sessionId&&session.revision===draft.revision&&session.status==='active'&&!session.ending&&
    JSON.stringify(session.protection)===JSON.stringify(draft.protection)&&JSON.stringify(session.account?.position)===JSON.stringify(draft.position));
}

export function priceCancellationCommand(session,draft) {
  if(!priceCancellationCurrent(session,draft)) return null;
  return {expectedRevision:draft.revision,command:draft.kind==='order'?{type:'cancel-order',orderId:draft.orderId}:{type:'cancel-protection',leg:draft.leg}};
}
