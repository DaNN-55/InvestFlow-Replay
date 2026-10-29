import { CRYPTO_PERIODS } from './cryptoReplayPresentation.js';
export const CRYPTO_WORKSPACE_KEY = 'investflow-crypto-workspace-v1';
export const CRYPTO_PLAYBACK_SPEEDS = [1,2,4,8];
const defaults = () => ({layout:'dual',periods:[60,5,15,240],kinds:['last','last','last','last'],crosshair:true,price:true,time:true,dateRange:false,period:false,collapsed:false,lineDetails:true,playbackSpeed:1});
export function normalizeCryptoPreferences(value = {}) {
  const result=defaults();
  if(['single','dual','rows','quad'].includes(value.layout)) result.layout=value.layout;
  if(CRYPTO_PLAYBACK_SPEEDS.includes(Number(value.playbackSpeed))) result.playbackSpeed=Number(value.playbackSpeed);
  result.periods=result.periods.map((p,i)=>CRYPTO_PERIODS.some(([v])=>v===Number(value.periods?.[i]))?Number(value.periods[i]):p);
  result.kinds=result.kinds.map((k,i)=>['last','mark'].includes(value.kinds?.[i])?value.kinds[i]:k);
  for(const key of ['crosshair','price','time','dateRange','period','collapsed','lineDetails']) if(typeof value[key]==='boolean') result[key]=value[key];
  return result;
}
export function loadCryptoPreferences(storage) { try { return normalizeCryptoPreferences(JSON.parse(storage.getItem(CRYPTO_WORKSPACE_KEY)??'{}')); } catch { return defaults(); } }
export function cryptoVisiblePeriods(preferences) { return [...new Set(preferences.periods.slice(0,preferences.layout==='quad'?4:preferences.layout==='single'?1:2))]; }
