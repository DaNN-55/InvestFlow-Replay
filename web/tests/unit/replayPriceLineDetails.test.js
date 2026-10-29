import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLAY_PRICE_LINE_OVERLAY as overlay } from '../../src/utils/replayPriceLines.js';
import { normalizeCryptoPreferences } from '../../src/utils/cryptoWorkspacePreferences.js';

const render = (extra = {}, y = 80) => overlay.createPointFigures({ coordinates: [{ y }], bounding: { width: 400, height: 200 }, overlay: { extendData: { id: 'stop', price: '49000', label: '止损说明', color: 'red', hideDetails: true, cancellable: true, measureLabel: () => 80, ...extra } } });
test('hiding descriptions retains the exact line and hover hit area, without text or cancellation controls', () => {
  const figures = render();
  assert.deepEqual(figures.map(figure => figure.key), ['price-line']);
  assert.deepEqual(figures[0].attrs.coordinates, [{ x: 0, y: 80 }, { x: 400, y: 80 }]);
  assert.equal(figures[0].ignoreEvent, false);
  assert.equal(render({ dashed: true })[0].styles.style, 'dashed');
});
test('hover and pending previews reveal descriptions and cancellation without changing the actual price', () => {
  for (const value of [{ detailsExpanded: true }, { preview: true }, { hideDetails: false }]) {
    const figures = render(value);
    assert.ok(figures.some(figure => figure.key === 'price-tag'));
    assert.ok(figures.some(figure => figure.key === 'price-cancel'));
    assert.equal(figures[0].attrs.coordinates[0].y, 80);
  }
});
test('off-screen levels retain an unobtrusive hover marker without drawing a fake line at the chart edge', () => {
  assert.deepEqual(render({}, -50).map(figure => figure.key), ['price-edge']);
  assert.equal(render({}, -50)[0].attrs.text, '↑');
  assert.equal(render({}, 250)[0].attrs.text, '↓');
});
test('old preferences retain visible details while a saved boolean choice is preserved', () => {
  assert.equal(normalizeCryptoPreferences({}).lineDetails, true);
  assert.equal(normalizeCryptoPreferences({ lineDetails: false }).lineDetails, false);
  assert.equal(normalizeCryptoPreferences({ lineDetails: 'false' }).lineDetails, true);
});
