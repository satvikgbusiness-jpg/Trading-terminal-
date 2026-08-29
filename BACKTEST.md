# Backtest results

**Status: not yet measured. No numbers below, because none have been produced from
real market data.**

The backtest harness is written, tested and verified to run end to end. What is
missing is data: the environment this was built and verified in has no outbound
network access to any market data provider, and no API keys were present.

Publishing a table here filled from synthetic bars would be worse than publishing
nothing, so this file records the attempt, the blocker, and exactly how to fill it in.

---

## What was attempted

```
$ pnpm backtest --symbols AAPL,MSFT,NVDA,JPM,XOM --years 2 --horizons 5,20

  AAPL: no data (Alpha Vantage can serve candles for AAPL but no API key is configured)
  AAPL: skipped, needs at least 260 bars, has 0
  MSFT: no data (Alpha Vantage can serve candles for MSFT but no API key is configured)
  MSFT: skipped, needs at least 260 bars, has 0
  NVDA: no data (Alpha Vantage can serve candles for NVDA but no API key is configured)
  NVDA: skipped, needs at least 260 bars, has 0
  JPM:  no data (Alpha Vantage can serve candles for JPM but no API key is configured)
  JPM:  skipped, needs at least 260 bars, has 0
  XOM:  no data (Alpha Vantage can serve candles for XOM but no API key is configured)
  XOM:  skipped, needs at least 260 bars, has 0

No observations. Nothing to report.
This usually means no equity data source is configured -- see .env.example.
No numbers are printed for a run that produced no data.
```

Two independent blockers, both verified:

1. **No API keys.** No `.env` file exists in the repository, and `FINNHUB_API_KEY` /
   `ALPHAVANTAGE_API_KEY` are not set in the process environment.
2. **No network egress to data providers.** The environment's egress gateway denies
   `CONNECT` to every market data host with HTTP 403. Package registries and GitHub
   are reachable; `finnhub.io`, `www.alphavantage.co`, `api.coingecko.com`,
   `api.frankfurter.app` and the RSS feed hosts are not:

   ```
   200  registry.npmjs.org
   400  github.com
   000  finnhub.io              CONNECT tunnel failed, response 403
   000  www.alphavantage.co     CONNECT tunnel failed, response 403
   000  api.coingecko.com       CONNECT tunnel failed, response 403
   000  api.frankfurter.app     CONNECT tunnel failed, response 403
   000  feeds.reuters.com       CONNECT tunnel failed, response 403
   ```

   Supplying a key would not have been sufficient on its own.

## To fill this in

```bash
echo "ALPHAVANTAGE_API_KEY=your-key" >> .env.local
pnpm backtest --symbols AAPL,MSFT,NVDA,JPM,XOM --years 2 --horizons 5,20
```

Then paste the output below, unedited, whatever it shows.

Alpha Vantage's free tier allows **25 requests per day**, so five symbols is close to
a full day's budget. Bars are written to the `candles` table on first fetch and read
from there on subsequent runs, so re-running the analysis costs no further requests —
only adding new symbols does. If the run hits the daily cap it will report a rate-limit
error per symbol and skip it; that is the honest outcome, and it should be recorded
here rather than worked around.

## Reading the table when you have one

```
bias      band       n      hit%    edge     mean fwd   baseline mean
```

- **hit%** — how often the forward return went the way the bias leaned.
- **baseline** — the unconditional rate at which forward returns were positive over
  the same bars, printed above the table.
- **edge** — hit% minus the baseline for that direction. **This is the only column
  that says anything.** A 56% hit rate is not a finding if the market rose on 56% of
  days. A positive hit% with a negative edge means the signal did worse than ignoring
  it.

## Caveats the script prints with every run

- Overlapping signals are not independent observations, so any confidence interval
  computed from `n` is optimistic.
- No transaction costs, no slippage, no borrow costs on shorts.
- **Technical components only.** The news term is excluded because historical headline
  scores are not archived, so the backtest and the live Outlook are not computing quite
  the same number.
- Parameters were chosen by hand rather than fitted. That avoids overfitting, but it
  also means nothing here has been optimised — a poor result is a poor result, not
  evidence that tuning would fix it.

## Machinery verification

The walk-forward loop itself has been exercised offline against a deterministic random
walk of 700 bars, to confirm it computes signals using only data available up to each
bar and evaluates forward returns correctly:

```
walk-forward completed: 475 signals (167 bull / 247 bear / 61 neutral)
bullish hit rate 38.3% vs baseline 49.5%
```

On pure noise the engine produces a clearly **negative** edge (−11.2pp). That is the
correct answer on a random walk and a useful signal that the harness does not flatter
itself — but it is a test of the code, **not a result**, and says nothing about
behaviour on real price series.

---

**Signals are descriptive, not predictive. Not investment advice.**
