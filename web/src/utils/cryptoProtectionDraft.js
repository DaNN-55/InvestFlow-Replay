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
