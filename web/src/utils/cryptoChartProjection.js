import { cryptoChartBars, cryptoChartLines } from './cryptoReplayPresentation.js';
import {
  repriceProtectionLine, cryptoProtectionEstimate, formatProtectionEstimate,
  cryptoProtectionRewardRisk, formatProtectionRewardRisk,
} from './cryptoProtectionEstimate.js';

// Compose display models only. Gestures, confirmation and execution remain with their owners.
export function projectCryptoCharts({ session, markets = {}, display, interaction = {} }) {
  const { busy, blocked, draggingIndex, movingPrice, priceDraft } = interaction;
  const models = display.periods.map((period, index) => {
    const kind = display.kinds[index];
    const bars = cryptoChartBars(markets[period], kind);
    const editable = !busy && !blocked && !priceDraft && session.status === 'active' && !session.ending &&
      (draggingIndex == null || draggingIndex === index);
    const lines = cryptoChartLines(session, kind).map(line => ({
      ...line,
      draggable: Boolean(editable && (line.orderId != null ||
        (line.protectionLeg && session.account.position && !session.protection?.triggeredLeg))),
      cancellable: Boolean(editable && (line.orderId != null ||
        (line.protectionLeg && session.account.position &&
          (!session.protection?.triggeredLeg || session.protection.triggeredLeg === line.protectionLeg)))),
      cancelLabel: line.orderId != null ? `限价委托 #${line.orderId}，${line.price}` :
        `${line.protectionLeg === 'stopLoss' ? '自动止损' : '自动止盈'}，${line.price}`,
    }));
    const base = priceDraft && lines.find(line => priceDraft.kind === 'order' ?
      line.orderId === priceDraft.orderId : line.protectionLeg === priceDraft.leg);
    if (base) lines.push({
      ...repriceProtectionLine(base, priceDraft.price),
      id: `${base.id}:draft`, price: priceDraft.price,
      ...(priceDraft.remainingContracts ? {
        contracts: priceDraft.remainingContracts, compactLabel: `待确认 · ${priceDraft.remainingContracts}张`,
      } : {}),
      label: `待确认${priceDraft.kind === 'order' ? '委托' : priceDraft.leg === 'stopLoss' ? '止损' : '止盈'}`,
      draggable: false, cancellable: false, protectionLeg: null, orderId: null, dashed: true, preview: true,
    });
    return { bars, lines, showVolume: bars.length > 0 && bars.every(bar => bar.volume != null) };
  });
  const draftEstimate = priceDraft && priceDraft.kind !== 'order' ?
    formatProtectionEstimate(cryptoProtectionEstimate(session, priceDraft.price)) : '';
  const ratioPreview = movingPrice?.leg ? movingPrice :
    priceDraft?.kind !== 'order' && priceDraft?.leg ? priceDraft : null;
  const rewardRisk = cryptoProtectionRewardRisk(session, ratioPreview);
  return {
    models, draftEstimate,
    rewardRisk: rewardRisk ? { ...rewardRisk, text: formatProtectionRewardRisk(rewardRisk), preview: Boolean(ratioPreview) } : null,
  };
}
