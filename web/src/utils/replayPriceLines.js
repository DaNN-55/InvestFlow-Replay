export const REPLAY_PRICE_LINE_GROUP = 'replay-controlled-price-lines';
export const REPLAY_PRICE_LINE_OVERLAY = {
  name: 'replayControlledPriceLine', totalStep: 1, lock: true,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: true,
  createPointFigures({ coordinates = [], bounding = {}, overlay }) {
    const point = coordinates[0], line = overlay.extendData;
    if (!point || point.y < 0 || point.y > bounding.height) return [];
    return [{ type: 'line', attrs: { coordinates: [{ x: 0, y: point.y }, { x: bounding.width, y: point.y }] },
      styles: { color: line.color, size: 1.5, style: line.dashed ? 'dashed' : 'solid', dashedValue: [6, 4] }, ignoreEvent: true },
    { type: 'text', attrs: { x: 8, y: point.y - 5, text: line.label, align: 'left', baseline: 'bottom' },
      styles: { color: line.color, size: 11, backgroundColor: 'rgba(255,255,255,.92)', paddingLeft: 3, paddingRight: 3 }, ignoreEvent: true }];
  },
};
