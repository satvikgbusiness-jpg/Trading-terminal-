# GMT Terminal

A dense, keyboard-driven market terminal for US equities (including the S&P 500 and
its constituents), major crypto pairs and FX majors. Live and delayed quotes,
candlestick charts with technical overlays, a news feed with per-headline sentiment,
and a per-ticker **Outlook** that states a bullish/bearish/neutral bias together with
the explicit reasons behind it.

It also contains a sandboxed **ExecutionGateway** for an external trading agent.
Paper trading only, with a human approval queue for anything flagged live.

> **Signals are descriptive, not predictive. Not investment advice.**
> Nothing here forecasts prices or estimates returns. The Outlook describes the
> state a market is currently in, and shows its working.

---

## Quick start

```bash
pnpm install
cp .env.example .env.local     # optional: works with no keys, with gaps
pnpm db:migrate                # create the schema + append-only audit triggers
pnpm seed                      # demo watchlist, paper account, first news pull
pnpm dev                       # web app + background worker
```

Open <http://localhost:3000>. `Cmd/Ctrl+K` jumps to any symbol.

**It runs with no API keys at all.** Crypto (CoinGecko) and FX (ECB via Frankfurter)
are keyless and work immediately. Equities and indices need a key; without one the
terminal shows an explicit gap naming the missing key, never a zero or a placeholder.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next dev server plus the worker, output interleaved |
| `pnpm dev:web` | Web app only |
| `pnpm worker` | Worker only (news, approval expiry, cache warming, pruning) |
| `pnpm test` | 117 unit and integration tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm backtest` | Replay the Outlook score over daily bars (see below) |
| `pnpm token:issue -- --name my-bot` | Issue a gateway token for a bot |

---

## The screens

**Markets** (`/`) — index tiles, an S&P 500 sector heatmap, top movers, a scrolling
ticker tape, and the persisted watchlist.

**Ticker** (`/ticker/AAPL`) — candlestick chart with SMA(20/50/200), EMA(21) and
Bollinger overlays, plus RSI(14), MACD and volume sub-panes. Quote header with day
range, 52-week range and ATR. Outlook panel, news stream, and the external-factors
strip.

**Bot** (`/bot`) — paper P&L, the approval queue, the hard limits in force, token
management, the kill switch, and the audit log with a live hash-chain verification.

**Demo** (`/demo`) — an embedded third-party canvas, sandboxed and labelled
`DEMO CANVAS — SYNTHETIC DATA, NOT LIVE`. **No value from it enters the terminal.**
It is not a data source for quotes, charts, the Outlook, sentiment, or the ledger.

---

## Data sources and their limits

Adapters sit behind one `MarketDataAdapter` interface (`getQuote`, `getCandles`,
`searchSymbols`, `getIndexConstituents`). Routing is per *capability*, not per
provider, because the free tiers do not line up cleanly.

| Source | Serves | Key | Real limit you will hit |
| --- | --- | --- | --- |
| **Finnhub** | Equity/ETF quotes, company news, search, constituents | required | 60 req/min. `/stock/candle` is now a **paid** endpoint, so charts do not come from here |
| **Alpha Vantage** | Equity, ETF and FX **candles**; fallback quotes | required | **25 req/day**, 5/min. This is the tightest constraint in the app |
| **CoinGecko** | Crypto quotes and candles, top-20 by market cap | optional | ~30 req/min keyless. Public `/ohlc` returns 4-day bars beyond 30 days — see below |
| **exchangerate.host** | FX quotes and daily history | optional | 365-day window per call |
| **Frankfurter (ECB)** | FX fallback — daily reference rates | none | One fixing per business day. **Keyless, so FX works on a clean checkout** |
| **RSS** | Reuters, FT, CoinDesk, WSJ Markets headlines | none | Publisher-set; deduplicated by normalised URL hash |

### Things the free tiers genuinely cannot do

These are limits of the data, not bugs, and the UI says so where each one bites:

- **Indices are ETF proxies.** No free tier prices `^GSPC` directly, so the S&P 500,
  Nasdaq and Dow tiles are served through SPY, QQQ and DIA. Every such value carries
  the provenance note *"via SPY ETF proxy — not the index itself"*. SPY is a fund
  with its own price, dividends and tracking error.
- **FTSE 100, DAX and Nikkei have no configured feed.** Their tiles render an
  explicit gap rather than being quietly dropped from the grid.
- **Crypto daily history is capped at ~30 days without a paid key.** CoinGecko's
  public `/ohlc` returns 4-day bars for longer windows. The adapter refuses to pass
  those off as daily bars — coarser bars cannot be split into finer ones without
  inventing prices — so it returns an explicit `unsupported` error instead.
- **FX has no intraday range and no volume.** ECB and exchangerate.host publish one
  reference rate per day. `CandleSeries.hasRange` is `false` for those feeds, the
  chart draws a **line** rather than zero-height candles, and ATR is skipped in
  favour of close-to-close volatility, labelled as such.
- **The bundled S&P 500 list is a partial snapshot.** `data/sp500.json` carries 448
  of roughly 500 members, hand-compiled, with the caveat inside the file. It exists so
  search and the heatmap work with no key. The heatmap prices a sample (default 60,
  spread across all 11 sectors) and states its coverage on screen; it is not
  index-weighted and is not index performance.

### The rule the whole data layer is built around

**A number on screen either came from a named source, or it is not there.**

- Every value carries provenance: source, feed delay, and how long ago it was fetched.
  The footer reads `AAPL · delayed 15m · Finnhub · 12s ago`.
- If a refresh fails and a previous value exists, it is served with a **STALE** badge
  and the failure reason in the tooltip. It is never silently refreshed-looking.
- If there is no value at all, the UI renders `NO DATA` with the reason and, where
  applicable, the missing environment variable. There is no code path that produces a
  zero, an interpolation, or a placeholder price.
- A rate-limited scheduler (token bucket, minimum interval, concurrency cap,
  single-flight deduplication, 429 parking) fronts every provider, backed by a
  two-tier memory/disk cache.

---

## The Outlook engine

For each ticker the engine produces `bias ∈ {bullish, bearish, neutral}`,
`strength 0–100`, and a list of human-readable reasons:

```
▲ BULLISH 62 — MACD above zero with momentum building (histogram +0.04% of price);
price 4.2% above SMA(200); SMA(50)/SMA(200) golden cross 6 bars ago;
RSI(14) at 61.3 — momentum firm; news sentiment +0.41 (3 positive, 1 neutral
headlines, recency-weighted); MEDIUM volatility — ATR(14) is 1.9% of price,
54th percentile of the last 252 bars
```

### How the score is built

Seven components, each producing a signed reading in `[-1, 1]` and a weight:

| Component | Weight | Reads |
| --- | --- | --- |
| RSI(14) regime | 1.0 | Level, plus whether an extreme is actually turning |
| MACD(12,26,9) | 1.2 | The line's side of zero **and** the histogram, plus recent crosses |
| Price vs SMA(50) | 1.0 | Distance, and a reclaim/loss within 5 bars |
| Price vs SMA(200) | 1.2 | Distance, plus a 50/200 golden or death cross |
| Bollinger(20,2) %B | 0.8 | Position in the band, including breaks either side |
| Volume vs 20-bar average | 0.6 | Whether participation confirms the day's move |
| News sentiment | 1.5 | Recency-weighted lexicon score (below) |

`score = 100 × Σ(weightᵢ × readingᵢ) / Σ(weight of available components)`,
`|score| < 12` reports neutral, `strength = round(|score|)`.

Three design decisions worth stating plainly:

1. **Missing components are excluded from the denominator, not counted as zero.**
   A feed with no volume yields a read based on what exists rather than one diluted
   toward neutral by an absent input. Below a minimum evidence weight the engine
   refuses to express a bias at all and says why.
2. **Every contributing component must produce a reason string.** If the engine
   cannot say why, it does not get to contribute. The panel shows the full
   component-by-component breakdown.
3. **Volatility is reported, never scored.** ATR(14) as a percentage of price,
   ranked against its own 252-bar history, becomes a LOW/MEDIUM/HIGH badge — the
   "can this name fluctuate" indicator. It does not move the bias, because how much
   something moves is a different question from which way it is leaning.

### Three modelling flaws found while testing, and what was done

- **RSI treated every extreme as a reversal**, scoring an unbroken collapse as
  *bullish* because RSI was near zero. It now requires a confirmed turn; oversold and
  still falling reads as sustained selling.
- **MACD read the histogram alone**, which turns positive in *any* decelerating
  decline because MACD is denominated in price and the absolute gap narrows as price
  compounds lower. It now reads the zero line too, the standard two-part interpretation.
- **SMA(50)/SMA(200) crossings fired on noise** in a flat tape, where the two averages
  sit on top of each other. A cross now requires the averages to have separated by at
  least 0.5% of price.

### News sentiment

Scored locally by lexicon — **no LLM, no external call**. `wink-sentiment` supplies
AFINN weights, overlaid with a finance lexicon, because the general-purpose lexicon
misreads market copy badly:

| Headline | AFINN alone | With the finance overlay |
| --- | --- | --- |
| "Regulators **fine** bank over failures" | +2 (positive) | negative |
| "Nvidia **beats** estimates" | −1 (negative) | strongly positive |
| "Shares **plunge**" / "**surge**" / "**downgrade**" | 0 (not in lexicon) | correctly signed |
| "Fed announces **rate cut**" | negative | neutral |
| "**Shares outstanding** unchanged" | positive | neutral |

Multi-word phrases are matched ahead of tokens (so "record high" is not scored as
"record" plus "high"), negation flips and weakens polarity, and intensifiers scale in
both directions — including trailing ones, since headlines say "fell sharply" far more
often than "sharply fell".

Headline scores aggregate with a 24-hour recency half-life over a 7-day window, then
shrink toward neutral by `n / (n + 2)`, so one stray headline cannot produce a
"strongly bearish" read.

**Its limitation, stated plainly:** this is a bag-of-words model with no notion of
sentence subject. *"Rival to Apple collapses"* scores negative for AAPL. That is why
news is one input of seven rather than a signal on its own, and why the note appears
under the news pane in the UI.

### External factors

A strip of scheduled events — central bank decisions, CPI and payroll prints, GDP —
shown as context and **deliberately not scored**. Knowing a CPI print lands on
Thursday tells you when the tape is likely to be unpredictable, not which way it will
go. Dates come from a static calendar with its compile date shown; confirm against the
official schedule before relying on them.

### Backtest

```bash
pnpm backtest -- --symbols AAPL,MSFT,NVDA --years 2 --horizons 5,20
```

Walks daily bars, computes the confluence score at each bar using **only** data
available up to that bar, and reports how often the bias was followed by a move in the
same direction.

**This README publishes no hit rate, because none has been measured on real market
data.** The development environment had no outbound access to any data provider, so
the script has been verified to run correctly end to end — but running it on invented
data and quoting the result would be exactly the dishonesty this project is built to
avoid. Run it against your own key and read the output.

What the output gives you:

- A **baseline** beside every hit rate: the unconditional rate at which forward
  returns were positive over the same bars. A 56% hit rate on bullish signals is not a
  finding if the market rose on 56% of days.
- An **edge** column (hit rate minus baseline). This is the only column that says
  anything, and its sign is what matters.
- Breakdowns by strength band, so you can see whether higher strength does anything.

Known limitations, printed by the script itself: overlapping signals are not
independent observations; there are no transaction costs, slippage or borrow fees; and
the news component is excluded because historical headline scores are not archived, so
the backtest and the live Outlook are not computing quite the same number. Parameters
were chosen by hand rather than fitted — which avoids overfitting, but also means
nothing here has been optimised.

*(As a sanity check on the machinery: run against a synthetic random walk, the engine
produces a clearly **negative** edge, which is the correct answer on pure noise.)*

---

## Bot gateway — the security model

Built as an isolation boundary for a future external agent, **assumed to be untrusted,
self-modifying code**. The gateway's job is to make the worst case boring.

### What a compromised bot token can do

Read its own paper portfolio. Read quotes for allowlisted symbols. Queue order intents
that fill on paper or wait for a human. **That is the entire blast radius.**

### What it cannot do

- **Reach any credential.** There are no broker or exchange credentials in the
  codebase, none in `.env.example`, and no endpoint that would return one. The scope
  vocabulary is four strings — `portfolio:read`, `quote:read`, `order:submit`,
  `order:read` — and there is no scope for secrets, configuration, funds or withdrawal,
  because there is no endpoint for one to reach.
- **Move money.** v1 has **no real-money execution path**. An intent flagged `live`
  queues for approval; once a human approves it, it terminates in
  `blocked_no_broker`, because no broker adapter exists. The approval queue is wired
  end to end and fully audited, and there is deliberately nothing behind it.
- **Raise its own limits.** Hard limits live server-side and are re-read on every
  order. The bot cannot read them, and no bearer-token route unlocks the gateway.
- **Talk the gateway into anything.** Every field is validated by a strict zod schema:
  unknown keys are *rejected*, not stripped and ignored; strings are length-capped;
  numbers must be finite. No bot-supplied string is ever evaluated or interpolated —
  values reach SQLite only through parameterised statements. There is no `eval`, no
  template execution, no dynamic import driven by input.

### Endpoints

| Method | Path | Scope |
| --- | --- | --- |
| `GET` | `/api/gateway/portfolio` | `portfolio:read` |
| `GET` | `/api/gateway/quote?symbol=` | `quote:read` (allowlisted symbols only) |
| `POST` | `/api/gateway/orders` | `order:submit` |
| `GET` | `/api/gateway/orders/:id` | `order:read` |

```bash
pnpm token:issue -- --name my-bot          # secret printed once, only its hash is stored

curl -X POST http://localhost:3000/api/gateway/orders \
  -H "Authorization: Bearer gmt_<id>_<secret>" \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","side":"buy","quantity":10,"orderType":"market","clientRef":"abc-1"}'
```

### The order pipeline

Every intent runs the same path, in this order:

1. **Authenticated** — bearer token, sha256-stored, compared with `timingSafeEqual`.
   An unknown token id is compared against a dummy hash so a wrong id and a wrong
   secret take the same time to reject.
2. **Gateway unlocked** — a locked gateway refuses everything.
3. **Schema-validated** — strict zod, unknown keys rejected.
4. **Pre-price limits** — instrument allowlist, order rate, daily loss. These run
   *before* any outbound request, because the allowlist is a security control: an
   untrusted caller must not be able to make the gateway fetch a quote for a symbol it
   is not permitted to trade.
5. **Priced from a real quote** — no quote, no fill. `no_market_data` rather than a
   fill at a stale or interpolated price. A paper ledger with invented fills teaches a
   bot the wrong thing.
6. **Size limits** — order notional, position notional, concentration, evaluated
   against the position the order *would produce*, so a sequence of small orders
   cannot walk past the cap. Reducing exposure is always permitted, so a tightened
   limit can never trap the account in a position it cannot exit.
7. **Filled on paper, or queued for a human** if flagged `live`.

### Hard limits

Instrument allowlist, max order notional, max position notional, max position
concentration, max daily loss, max orders per minute, max orders per day — all in
`.env.local`, all enforced server-side.

**Any breach locks the gateway** and requires a human to clear it on `/bot`. That is
deliberately strict: for an agent capable of rewriting its own code, an attempt to
exceed a position cap is a signal that something is wrong, not a routine rejection to
retry past. Order rate is counted from *submitted intents*, not fills, so a bot cannot
evade it by sending orders certain to be rejected downstream.

### Approval queue

Intents flagged `live` queue with a **10-minute** deadline, enforced on every read
rather than only by a background sweeper — so a lapsed intent can never be approved
because the sweeper happened not to have run. Each is decided individually. **There is
no auto-approve setting and no bulk-approve endpoint.**

### Kill switch

One button: revokes every token, cancels every open intent, locks the gateway.

### Audit log

Append-only and hash-chained. Each row's hash covers its own contents plus the
previous row's, so altering or removing any entry invalidates every hash after it and
`verifyChain()` names the first broken link. `UPDATE` and `DELETE` are additionally
blocked by **SQL triggers**, not by convention in application code — verified by a
test that drops the triggers to simulate direct database access and confirms the chain
detects the tampering. The `/bot` screen shows live verification.

---

## Testing

```bash
pnpm test        # 117 tests
```

- **Indicators** — verified against Wilder's published RSI example and hand-computed
  SMA/EMA/ATR/Bollinger cases, plus warm-up alignment and degenerate inputs
  (flat series, zero-width bands, too little history).
- **Sentiment** — every AFINN misread above is pinned as a regression test.
- **Outlook** — direction on trending and trendless series, the "unavailable inputs
  are excluded rather than zeroed" contract, the guarantee that every contributing
  component carries a reason, the disclaimer's presence, monotonicity in news, and the
  invariant that volatility never moves the bias.
- **Accounting** — long/short/flip-through-zero arithmetic, including a property test
  that any sequence returning to flat leaves cash exactly equal to realised P&L.
- **Gateway** — a real SQLite database with the real schema and the real triggers,
  covering auth, limits, the lock, expiry, the kill switch and the audit chain.

Two real bugs the gateway tests caught, both worth knowing about:

- Token secrets are `base64url`, whose alphabet contains `_`. Splitting the token on
  every underscore rejected roughly half of all valid tokens.
- The instrument allowlist was checked *after* fetching a quote, letting an untrusted
  caller make the gateway issue outbound requests for symbols it was not permitted to
  trade. This is why limit checking is now split into pre-price and priced phases.

---

## Architecture

```
src/lib/
  symbols.ts            canonical symbol model (AAPL, ^GSPC, BTC-USD, EUR/USD)
  universe.ts           bundled S&P 500 snapshot + instant local search
  market/
    types.ts            MarketDataAdapter, provenance, Result<T>
    scheduler.ts        token bucket, concurrency, single-flight, 429 parking
    cache.ts            two-tier memory + disk cache
    registry.ts         per-capability adapter routing
    service.ts          read-through layer; the stale-vs-gap decision lives here
    adapters/           finnhub, alphavantage, coingecko, forex, rss
  analysis/
    indicators.ts       SMA, EMA, Bollinger, RSI, MACD, ATR, percentile rank
    sentiment.ts        lexicon scorer + recency aggregation
    finance-lexicon.ts  the finance overlay on AFINN
    outlook.ts          the confluence engine
    macro.ts            scheduled-event calendar (context, not scored)
  gateway/
    schemas.ts          the trust boundary: strict validation of all bot input
    auth.ts             scoped tokens, constant-time comparison
    limits.ts           hard limits, two-phase; lock state
    accounting.ts       pure position arithmetic
    paper.ts            the paper engine
    service.ts          the order pipeline
    audit.ts            hash-chained append-only log
```

**Stack:** Next.js 16 (App Router) · TypeScript (strict, `noUncheckedIndexedAccess`) ·
Tailwind v4 · SQLite via Drizzle · lightweight-charts · SSE for quote push.

---

## Non-goals for v1

No real-money execution path. No broker API keys anywhere in the codebase. No futures
or options. No LLM-based prediction claims. No scraping of paid data sources — the RSS
feeds are the publishers' own syndication endpoints, and articles are linked, not
reproduced.
