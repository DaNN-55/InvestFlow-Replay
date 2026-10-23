const PAGE_SIZE = 200;

function invalid(message, versionChanged = false) {
  return Object.assign(new Error(`会话数据未能一致读取：${message}`), { code: 'CRYPTO_READ_INCONSISTENT', versionChanged });
}
function readonly(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) readonly(child);
    Object.freeze(value);
  }
  return value;
}
function validateSession(session, id) {
  if (!session || session.id !== id || !Number.isSafeInteger(session.revision) || session.revision < 0 ||
    !Number.isSafeInteger(session.elapsedMinutes) || session.elapsedMinutes < 0 ||
    !Number.isSafeInteger(session.gameLength) || session.gameLength < session.elapsedMinutes) throw invalid('会话版本或进度无效');
}

// Cache only verified audit prefixes. Markets always use the captured visible cursor.
export function createCryptoSessionReader({ getSession, readMarket, readAudit }) {
  let cache = null;
  let generation = 0;
  function reset() { cache = null; generation++; }
  async function read({ session, periods }) {
    const token = ++generation, id = session?.id;
    const requested = [...new Set(periods.map(Number))];
    if (!id || !requested.length || requested.some(period => !Number.isSafeInteger(period) || period < 1)) throw invalid('会话或图表周期无效');
    if (cache?.session.id !== id) cache = null;
    let target = structuredClone(session);
    const active = () => {
      if (token !== generation) throw Object.assign(new Error('读取已被新的会话替代'), { code: 'CRYPTO_READ_SUPERSEDED' });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      active(); validateSession(target, id);
      const captured = target;
      let reading = true;
      const check = () => { active(); if (!reading) throw Object.assign(new Error('读取批次已失效'), { code: 'CRYPTO_READ_SUPERSEDED' }); };
      const base = cache && cache.session.revision <= captured.revision && cache.session.elapsedMinutes <= captured.elapsedMinutes &&
        cache.session.gameLength === captured.gameLength && (cache.session.revision !== captured.revision ||
          (cache.session.elapsedMinutes === captured.elapsedMinutes && cache.session.revealed === captured.revealed)) ? cache : null;
      const sameRevision = base?.session.revision === captured.revision;
      const marketMinute = captured.revealed ? captured.gameLength : captured.elapsedMinutes;
      async function audit(kind) {
        const prior = base?.[kind] ?? [];
        if (sameRevision) return prior;
        const added = [];
        let after = kind === 'ledger' ? base?.session.revision ?? -1 : prior.at(-1)?.sequence ?? 0;
        let lastRevision = kind === 'ledger' ? after : prior.at(-1)?.revision ?? 0;
        for (;;) {
          const page = await readAudit(id, kind, { after, limit: PAGE_SIZE }); check();
          if (!Number.isSafeInteger(page?.revision)) throw invalid('审计版本缺失');
          if (page.revision !== captured.revision) throw invalid('读取期间版本发生变化', true);
          if (page.throughMinute !== captured.elapsedMinutes || !Array.isArray(page.items) || page.items.length > PAGE_SIZE) throw invalid('审计进度或分页无效');
          for (const item of page.items) {
            const cursor = kind === 'ledger' ? item.revision : item.sequence;
            if (cursor !== after + 1 || !Number.isSafeInteger(item.revision) || item.revision < (kind === 'ledger' ? 0 : 1) ||
              item.revision > captured.revision || item.revision < lastRevision) throw invalid('审计游标缺失、重复或倒退');
            const minute = kind === 'ledger' ? item.cursorMinute : item.observedAtMinute;
            if (!Number.isSafeInteger(minute) || minute < 0 || minute > captured.elapsedMinutes) throw invalid('审计条目超出实际进度');
            after = cursor; lastRevision = item.revision; added.push(item);
          }
          if (kind === 'ledger' && after === captured.revision) break;
          if (page.items.length < PAGE_SIZE) {
            if (kind === 'ledger') throw invalid('账本未覆盖当前版本');
            break;
          }
        }
        return [...prior, ...added];
      }
      try {
        const [views, ledger, traces] = await Promise.all([
          Promise.all(requested.map(async period => {
            const value = await readMarket(id, { timeframeMinutes: period, limit: 600, elapsedMinutes: marketMinute }); check();
            if (value?.elapsedMinutes !== marketMinute || value.timeframeMinutes !== period || value.instrumentId !== captured.instrumentId ||
              !Array.isArray(value.candles?.last) || !Array.isArray(value.candles?.mark) ||
              Object.values(value.candles).some(bars => !Array.isArray(bars) || bars.some(bar => !Number.isSafeInteger(bar.knownThroughMinute) || bar.knownThroughMinute > marketMinute))) throw invalid('行情周期或可见进度不匹配');
            return [period, value];
          })), audit('ledger'), audit('traces'),
        ]);
        check();
        cache = readonly({ session: captured, markets: Object.fromEntries(views), ledger, traces });
        return cache;
      } catch (error) {
        reading = false; active();
        if (error.code === 'CRYPTO_READ_INCONSISTENT') cache = null;
        if (!error.versionChanged || attempt === 1) throw error;
        // Retry a changed read version once; never replay a write action here.
        target = structuredClone((await getSession(id)).session);
      }
    }
  }
  return { read, reset };
}
