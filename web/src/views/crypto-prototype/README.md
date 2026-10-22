# THROWAWAY: contract replay UI study

Question: which information hierarchy makes contract practice easier to use while
retaining TradingView chart habits, OKX trading locations, and the blind-review loop?

Branch: `codex/crypto-ui-prototype`. The user selected A (terminal) on 2026-10-22:
charts on the left, orders on the right, positions below, same-contract multi-period
charts and a unified filtered practice history. Archive this study here and rewrite
the selected behavior on `codex/crypto-terminal-ui`. This prototype is not production delivery.

## Run

From the repository root:

```sh
npm --prefix web run prototype:ui
```

Or use the existing web development server:

`/decision/crypto-replay?prototype=ui&variant=A&compare=split`

No API calls or stored sessions are used by the prototype. All sample actions,
records and playback live in memory and reset on reload or the Reset button.
The existing app shell still uses its normal theme preference. Prototype theme
controls are separate and only affect the study.

The query-only development entry renders the study instead of mounting the live
crypto view. Normal URLs render the original page. Production builds exclude the
study and render the original page regardless of the prototype query.

## Review

- `variant=A`: recommended terminal, charts left, order right, positions below.
- `variant=B`: chart-first, left tool rail, order drawer on demand.
- `variant=C`: charts above, order and positions side by side below.
- `compare=before|split|after`: reconstructed current structure versus proposals.
- `focus=` selects one of the 16 comparisons. The selector also moves to its scene.
- `scene=setup|training|records|review`: review a specific part of the flow.
- `#prototype-canvas`: jump directly to the compared screens.
- Floating arrows and keyboard left/right switch variants. Form controls and
  dialogs retain their own keyboard behavior.
- The state inspector exposes the selected layout, periods, sync settings,
  timeline, orders, positions, filters, settings and review state.

The before panel is a skeleton reconstruction based on CryptoReplayView,
CryptoSetupPanel, CryptoTradingPanel, CryptoReviewPanel and TradeRecordsView.
It is not a pixel-exact screenshot or a second mounted live session.

## Comparison coverage

| Focus | Observable change / interaction |
| --- | --- |
| hierarchy | Large notices/long sidebar versus compact trading workspace |
| theme | Bright original fields versus theme-aware fields, same control sizes |
| setup | Exposed settings versus expandable funds and costs |
| data | Inline coverage versus top-right database drawer; pool placeholder |
| rules | Repeated notices versus grouped rules and contextual reminders |
| resume | Ambiguous history dropdown versus continue-last + unified records |
| order | Order below long risk column versus immediately accessible order UI |
| position | Sidebar risk list versus positions/orders/fills below charts |
| plan | Explicit distinction between manual plan and automatic protection |
| layout | Single, dual columns, dual rows, quad, maximize and restore |
| period | Active-chart period selector, independent periods by default |
| link | Time crosshair, same-source price, time position, range and period sync |
| precision | Short summaries versus full precision in record details |
| records | Unified market/status/attempt filters and type-specific details |
| review | Close-position versus end-session; blind review/reveal/post-review |
| responsive | Collapsible trading panel, focus drawer and narrow layout |

Charts are illustrative SVG curves, not an implementation of market aggregation.
They use one simulated visible-time cutoff across all panes. Changing price type
demonstrates isolation of price crosshairs, not a real mark-price data feed.
Real freezing, idempotency, order execution, recovery, no-future-data enforcement,
and durable cross-market history remain responsibilities of production code.

## Reference

- [TradingView: chart synchronization](https://www.tradingview.com/support/solutions/43000629992-how-to-sync-the-charts-of-my-layout/)
- [TradingView: same symbol, different periods](https://www.tradingview.com/support/solutions/43000762821-how-to-display-the-same-symbol-at-different-time-frames/)
- [OKX: multiple charts and synchronization](https://www.okx.com/en-eu/help/how-do-i-turn-on-and-sync-multiple-charts-on-a-screen)

## Verification

- Scoped ESLint and production build.
- Browser checked: market-order position update, independent second-chart period,
  linked time crosshair, shared playback cutoff, synchronized time offset,
  end/blind/reveal/post-review flow, crypto + completed filtering, data/rules drawer,
  B order drawer, C bottom-side-by-side layout, and 390px horizontal overflow.
- No unit tests added for this throwaway UI study.
