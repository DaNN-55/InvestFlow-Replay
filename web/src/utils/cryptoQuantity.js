// Convert display units to the exchange lot step without floating-point rounding up.
function decimal(value) {
  const text=String(value??'');
  if(text.length>64||!/^\d+(?:\.\d{1,18})?$/.test(text)) return null;
  const [whole,fraction='']=text.split('.');return {n:BigInt(whole+fraction),d:10n**BigInt(fraction.length),scale:fraction.length};
}
export function cryptoQuantityToContracts(quantity,unit,contract,price) {
  if(unit==='contracts') return quantity;
  const amount=decimal(quantity),val=decimal(contract.ctVal),mult=decimal(contract.ctMult),lot=decimal(contract.lotSz),rate=decimal(unit==='quote'?price:'1');
  if(!amount||!val||!mult||!lot||!rate||val.n===0n||mult.n===0n||lot.n===0n||rate.n===0n) return null;
  const numerator=amount.n*val.d*mult.d*rate.d*lot.d;
  const denominator=amount.d*val.n*mult.n*rate.n*lot.n;
  const scaled=(numerator/denominator)*lot.n;
  if(!lot.scale) return String(scaled);
  const padded=String(scaled).padStart(lot.scale+1,'0');
  return `${padded.slice(0,-lot.scale)}.${padded.slice(-lot.scale)}`.replace(/\.?0+$/,'')||'0';
}
