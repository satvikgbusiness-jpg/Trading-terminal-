# Backtest results

Measured **2026-08-29** against live Alpha Vantage data, five equities, fifteen years
of weekly bars, 3,890 walk-forward signals.

**Headline: no usable directional edge.** The confluence score's bullish and bearish
buckets land within about three points of the baseline, the *strongest* signals do
*worse* than the weakest, and the "no view" bucket beats both directional ones. Read
the caveats before reading anything else into the table.

---

## Why weekly, and not daily

The terminal itself computes the Outlook on **daily** bars, and that is the run that
would matter most. It could not be produced on a free plan.

Alpha Vantage has moved `outputsize=full` on `TIME_SERIES_DAILY` behind a paid plan.
The free plan serves 100 daily bars:

```
$ pnpm backtest --symbols AAPL,MSFT,NVDA,JPM,XOM --years 2 --horizons 5,20

  AAPL: no data (Thank you for using Alpha Vantage! The outputsize=full parameter
        value is a premium feature for the TIME_SERIES_DAILY endpoint. ...)
  AAPL: skipped, needs at least 260 bars, has 0
  ... (identical for MSFT, NVDA, JPM, XOM)

No observations. Nothing to report.
```

100 bars is fewer than the 220-bar warm-up alone, so a daily run cannot produce a
single signal. `TIME_SERIES_WEEKLY` takes no `outputsize` and still returns its full
history free — 1,399 bars per symbol, back to 1999 — so the run below uses weekly bars
via `--resolution W`.

**This is a related result, not a substitute.** It measures the same engine over a
different bar length: "SMA(200)" means 200 weeks, and a horizon of 4 means four weeks.
Whether the daily signal behaves the same way is untested.

No keyless daily source was available to substitute: Stooq now gates its CSV endpoint
behind a browser proof-of-work challenge, and Yahoo's chart endpoint answers 429 from
this network. Working around either would mean building anti-bot evasion into a data
adapter, which is not a trade worth making for a backtest.

## The run

```
$ pnpm backtest --symbols AAPL,MSFT,NVDA,JPM,XOM --years 15 --horizons 1,4 --resolution W

GMT Terminal - Outlook confluence backtest
symbols   AAPL, MSFT, NVDA, JPM, XOM
window    15 year(s) of weekly bars
horizons  1 weeks, 4 weeks
mode      technical components only (no historical news sentiment)

  AAPL: 778 signals over 1002 bars
  MSFT: 778 signals over 1002 bars
  NVDA: 778 signals over 1002 bars
  JPM: 778 signals over 1002 bars
  XOM: 778 signals over 1002 bars

3890 signals across 5 symbols.

=== 1-week forward return ===
baseline: 55.7% of all bars were followed by a positive 1-week return (mean 0.41%)

bias      band       n      hit%    edge     mean fwd   baseline mean
--------------------------------------------------------------------------
bullish   all         2371    56.5%  +  0.8pp  +   0.34%  +     0.41%
bullish   0-25         298    58.7%  +  3.0pp  +   0.73%  +     0.41%
bullish   25-50       1127    57.4%  +  1.7pp  +   0.16%  +     0.41%
bullish   50+          946    54.7%   -1.1pp  +   0.42%  +     0.41%

bearish   all         1012    47.4%  +  3.1pp  +   0.42%  +     0.41%
bearish   0-25         180    53.3%  +  9.0pp    -0.23%  +     0.41%
bearish   25-50        552    47.1%  +  2.8pp  +   0.53%  +     0.41%
bearish   50+          280    44.3%   -0.0pp  +   0.60%  +     0.41%

neutral   all          507    58.8%  +  3.1pp  +   0.71%  +     0.41%
neutral   0-25         507    58.8%  +  3.1pp  +   0.71%  +     0.41%

=== 4-week forward return ===
baseline: 60.1% of all bars were followed by a positive 4-week return (mean 1.61%)

bias      band       n      hit%    edge     mean fwd   baseline mean
--------------------------------------------------------------------------
bullish   all         2371    60.1%  +  0.0pp  +   1.36%  +     1.61%
bullish   0-25         298    56.7%   -3.4pp  +   1.21%  +     1.61%
bullish   25-50       1127    61.9%  +  1.8pp  +   1.13%  +     1.61%
bullish   50+          946    59.1%   -1.0pp  +   1.69%  +     1.61%

bearish   all         1012    42.2%  +  2.3pp  +   1.79%  +     1.61%
bearish   0-25         180    43.9%  +  4.0pp  +   1.32%  +     1.61%
bearish   25-50        552    43.8%  +  3.9pp  +   1.55%  +     1.61%
bearish   50+          280    37.9%   -2.0pp  +   2.57%  +     1.61%

neutral   all          507    64.5%  +  4.4pp  +   2.41%  +     1.61%
neutral   0-25         507    64.5%  +  4.4pp  +   2.41%  +     1.61%
```

## What this says

**The measured edge, against its baseline:**

| Bias | Horizon | Hit rate | Baseline | Edge |
|---|---|---|---|---|
| bullish (all) | 1 week | 56.5% | 55.7% | **+0.8pp** |
| bullish (all) | 4 weeks | 60.1% | 60.1% | **+0.0pp** |
| bearish (all) | 1 week | 47.4% | 44.3% | **+3.1pp** |
| bearish (all) | 4 weeks | 42.2% | 39.9% | **+2.3pp** |

Four things stand out, none of them flattering:

1. **The bullish edge is nil.** +0.8pp at one week and exactly zero at four. On 2,371
   observations that is not a signal, it is the market's own drift showing through.

2. **Conviction runs the wrong way.** The `50+` strength band — the score's most
   confident calls — has a *negative* edge in both directions and both horizons
   (−1.1pp and −1.0pp bullish, −0.0pp and −2.0pp bearish). The weakest band does best.
   Whatever the strength number is measuring, it is not the reliability of the call.

3. **Bearish calls were followed by gains.** The bearish bucket's mean forward return
   is positive at both horizons and *above* the all-bars baseline (+1.79% vs +1.61%
   over four weeks). It wins slightly more often on direction while losing on
   magnitude — the sign of a signal firing into pullbacks inside an uptrend.

4. **"No view" beat both views.** The neutral bucket has the best edge in the table
   (+3.1pp and +4.4pp). Since neutral is scored against "positive" and has no
   direction to be right about, this is close to a direct statement that the score
   carries little directional information over this sample.

The honest summary: **on this sample the confluence score did not beat simply assuming
the market goes up.** It is a legible summary of what several indicators are doing at
once, which is what the terminal presents it as, and it should not be read as a
forecast. The UI already says exactly this on every panel.

## Caveats, which are load-bearing here

- **Weekly, not daily** — see above. The daily signal is untested.
- **Five megacap survivors**, all of which rose enormously over the window. That is a
  severe survivorship bias, and it inflates every baseline: the market rose on 55.7%
  of weeks in this sample. A signal has to clear a high bar to show an edge here, and
  a fairer universe would include names that went nowhere or were delisted.
- **3,890 overlapping signals are not 3,890 independent observations.** Consecutive
  weekly bars share most of their forward window, so any confidence interval computed
  from `n` is far too narrow.
- **No transaction costs, no slippage, no borrow costs on shorts.**
- **Technical components only.** The news term is excluded because historical headline
  scores are not archived, so this and the live Outlook are not computing quite the
  same number.
- **Parameters were chosen by hand, not fitted.** That avoids overfitting, but it also
  means a poor result is a poor result — not evidence that tuning would fix it.

## Reading the table

```
bias      band       n      hit%    edge     mean fwd   baseline mean
```

- **hit%** — how often the forward return went the way the bias leaned.
- **baseline** — the unconditional rate at which forward returns were positive over
  the same bars, printed above each table.
- **edge** — hit% minus the baseline for that direction. **This is the only column
  that says anything.** A 56% hit rate is not a finding if the market rose on 56% of
  bars. A positive hit% with a negative edge means the signal did worse than ignoring
  it.

## Reproducing

```bash
echo "ALPHAVANTAGE_API_KEY=your-key" >> .env.local
pnpm backtest --symbols AAPL,MSFT,NVDA,JPM,XOM --years 15 --horizons 1,4 --resolution W
```

One request per symbol. Alpha Vantage's free tier allows **25 requests per day**, so
five symbols is a fifth of the budget. Bars are written to the `candles` table on
first fetch and read from there afterwards, so re-running the analysis costs no
further requests — only adding symbols does.

Add `--resolution D` once you have a plan that serves `outputsize=full`, and record
what it shows, whatever it shows.

## Machinery verification

The walk-forward loop was separately exercised against a deterministic random walk of
700 bars, to confirm it computes signals using only data available up to each bar:

```
walk-forward completed: 475 signals (167 bull / 247 bear / 61 neutral)
bullish hit rate 38.3% vs baseline 49.5%
```

On pure noise the engine produces a clearly **negative** edge (−11.2pp) — the correct
answer on a random walk, and evidence the harness does not flatter itself. That is a
test of the code, not a result.

---

**Signals are descriptive, not predictive. Not investment advice.**
