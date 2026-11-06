# trading

## BTC option odds (`web/`)

A page that shows, for every Bybit BTC option expiry and strike, how likely BTC is to
finish beyond the strike (and to touch it before expiry) based on price history, next to
the probability implied by the option's own price. It also shows the option's "fair value"
under each model and where that beats the bid/ask.

Two models run side by side:

| | V1 · raw history | V2 · adjusted |
|---|---|---|
| History used | All Bybit BTCUSD daily bars (late 2018 →) | Lookback: 1 / 2 / 4 years / all |
| Weights | Equal | Recency half-life: none / 6 mo / 1 yr / 2 yr |
| Volatility | Whatever history had | Each window rescaled to today's vol (EWMA, mean-reverting) or the market's ATM IV |
| Drift | Historical trend, centred on spot | Zero (expected price = forward) or historical |

### Run it

```bash
node server.js
```

Then open http://localhost:8000 (Node 18+, no dependencies). The page calls Bybit's public API straight from the browser
and falls back to the local proxy in `server.js` if the browser can't reach it. No API key needed.

- `?demo=1` uses synthetic data (works offline).
- `?host=api.bytick.com` uses an alternate Bybit API domain if `api.bybit.com` is blocked where you are.

### Read it carefully

History is not the future; overlapping windows overstate the sample size (the "independent"
count under each vol tile is the honest number); a high win rate is not profit; fees are not included.
A gap between history and the market is a question to investigate, not a trade.

### Tests

```bash
node tests/model.test.js
```
