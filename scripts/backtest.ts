/**
 * Backtest the Outlook confluence score.
 *
 *   pnpm backtest -- --symbols AAPL,MSFT,NVDA --years 2 --horizons 5,20
 *
 * Walks two years of daily bars, computes the confluence score at each bar using
 * only the data available up to that bar, and reports how often the bias was
 * followed by a move in the same direction.
 *
 * Three things about how this reports, because a backtest that flatters itself
 * is worse than none:
 *
 *  1. It prints a BASELINE alongside every hit rate -- the unconditional rate at
 *     which forward returns were positive over the same bars. A 56% hit rate on
 *     bullish signals is not a finding if the market rose on 56% of days. The
 *     number to look at is the edge (hit rate minus baseline), and its sign.
 *  2. It is technical-only. The news component needs historical headlines scored
 *     at the time, which this project does not archive, so the live Outlook and
 *     this backtest are not computing quite the same number.
 *  3. There are no transaction costs, no slippage, no borrow costs on shorts,
 *     and every signal is evaluated independently, so overlapping signals are
 *     not independent observations. The confidence intervals are therefore
 *     optimistic even where the point estimate is honest.
 */
import { computeOutlook, type Bias } from '@/lib/analysis/outlook';
import { getCandles } from '@/lib/market/service';
import { persistCandles, readPersistedCandles } from '@/lib/candles-store';
import type { Candle, CandleSeries } from '@/lib/market/types';
import { tryResolveAsset } from '@/lib/symbols';

/* ---------------------------------------------------------------- args --- */

function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const symbols = arg('--symbols', 'AAPL,MSFT,NVDA,AMZN,JPM,XOM')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((s) => s && tryResolveAsset(s) !== null);

const years = Number(arg('--years', '2'));
const horizons = arg('--horizons', '5,20')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** Bars of history required before the engine is allowed to express a view. */
const WARMUP_BARS = 220;

/* ------------------------------------------------------------- results --- */

interface Observation {
  symbol: string;
  barIndex: number;
  bias: Bias;
  strength: number;
  score: number;
  /** Forward simple return by horizon. */
  forward: Record<number, number | null>;
}

interface Bucket {
  n: number;
  hits: number;
  sumReturn: number;
}

const emptyBucket = (): Bucket => ({ n: 0, hits: 0, sumReturn: 0 });

async function loadSeries(symbol: string): Promise<CandleSeries | null> {
  const stored = readPersistedCandles(symbol, 'D');
  const needed = Math.ceil(years * 252) + WARMUP_BARS;
  if (stored && stored.bars.length >= needed) return stored;

  const lookbackDays = Math.ceil(years * 365) + Math.ceil(WARMUP_BARS * 1.5);
  const fetched = await getCandles(symbol, { resolution: 'D', lookbackDays });
  if (!fetched.ok) {
    console.log(`  ${symbol}: no data (${fetched.message})`);
    return stored;
  }
  persistCandles(symbol, fetched.data, fetched.provenance.source);
  return fetched.data;
}

function forwardReturn(bars: Candle[], index: number, horizon: number): number | null {
  const future = bars[index + horizon];
  const now = bars[index];
  if (!future || !now || now.c === 0) return null;
  return future.c / now.c - 1;
}

async function main() {
  if (symbols.length === 0) {
    console.error('No valid symbols. Use --symbols AAPL,MSFT');
    process.exit(1);
  }

  console.log('GMT Terminal - Outlook confluence backtest');
  console.log(`symbols   ${symbols.join(', ')}`);
  console.log(`window    ${years} year(s) of daily bars`);
  console.log(`horizons  ${horizons.map((h) => `${h}d`).join(', ')}`);
  console.log('mode      technical components only (no historical news sentiment)\n');

  const observations: Observation[] = [];
  const allForward: Record<number, number[]> = Object.fromEntries(horizons.map((h) => [h, []]));
  let barsEvaluated = 0;

  for (const symbol of symbols) {
    const series = await loadSeries(symbol);
    if (!series || series.bars.length < WARMUP_BARS + Math.max(...horizons) + 20) {
      console.log(
        `  ${symbol}: skipped, needs at least ${WARMUP_BARS + Math.max(...horizons) + 20} bars, has ${series?.bars.length ?? 0}`,
      );
      continue;
    }

    const bars = series.bars;
    const lastEvaluable = bars.length - Math.max(...horizons) - 1;
    let evaluated = 0;

    for (let i = WARMUP_BARS; i <= lastEvaluable; i += 1) {
      // Only bars up to and including i are visible, which is what makes this
      // walk-forward rather than a look-ahead.
      const visible: CandleSeries = {
        bars: bars.slice(0, i + 1),
        resolution: series.resolution,
        hasRange: series.hasRange,
        hasVolume: series.hasVolume,
      };

      const outlook = computeOutlook({ symbol, series: visible });
      const forward: Record<number, number | null> = {};
      for (const horizon of horizons) {
        const value = forwardReturn(bars, i, horizon);
        forward[horizon] = value;
        if (value !== null) allForward[horizon]!.push(value);
      }

      observations.push({
        symbol,
        barIndex: i,
        bias: outlook.bias,
        strength: outlook.strength,
        score: outlook.score,
        forward,
      });
      evaluated += 1;
    }

    barsEvaluated += evaluated;
    console.log(`  ${symbol}: ${evaluated} signals over ${bars.length} bars`);
  }

  if (observations.length === 0) {
    console.log('\nNo observations. Nothing to report.');
    console.log(
      'This usually means no equity data source is configured -- see .env.example.\n' +
        'No numbers are printed for a run that produced no data.',
    );
    process.exit(0);
  }

  console.log(`\n${observations.length} signals across ${symbols.length} symbols.\n`);

  for (const horizon of horizons) {
    const universe = allForward[horizon]!;
    // The baseline every hit rate must be read against.
    const baseline = universe.filter((r) => r > 0).length / universe.length;
    const baselineMean = universe.reduce((a, b) => a + b, 0) / universe.length;

    console.log(`=== ${horizon}-day forward return ===`);
    console.log(
      `baseline: ${(baseline * 100).toFixed(1)}% of all bars were followed by a positive ` +
        `${horizon}-day return (mean ${(baselineMean * 100).toFixed(2)}%)`,
    );
    console.log('');
    console.log(
      'bias      band       n      hit%    edge     mean fwd   baseline mean',
    );
    console.log('-'.repeat(74));

    const bands: Array<[string, (o: Observation) => boolean]> = [
      ['all', () => true],
      ['0-25', (o) => o.strength < 25],
      ['25-50', (o) => o.strength >= 25 && o.strength < 50],
      ['50+', (o) => o.strength >= 50],
    ];

    for (const bias of ['bullish', 'bearish', 'neutral'] as const) {
      for (const [bandName, predicate] of bands) {
        const bucket = emptyBucket();
        for (const observation of observations) {
          if (observation.bias !== bias || !predicate(observation)) continue;
          const value = observation.forward[horizon];
          if (value === null || value === undefined) continue;
          bucket.n += 1;
          bucket.sumReturn += value;
          // "Hit" means the move went the way the bias leaned. Neutral has no
          // direction to be right about, so it is scored against "positive"
          // purely to show it lands near the baseline.
          const hit = bias === 'bearish' ? value < 0 : value > 0;
          if (hit) bucket.hits += 1;
        }

        if (bucket.n === 0) continue;

        const hitRate = bucket.hits / bucket.n;
        const expected = bias === 'bearish' ? 1 - baseline : baseline;
        const edge = hitRate - expected;
        const meanReturn = bucket.sumReturn / bucket.n;

        console.log(
          `${bias.padEnd(9)} ${bandName.padEnd(9)} ${String(bucket.n).padStart(6)}  ` +
            `${(hitRate * 100).toFixed(1).padStart(6)}%  ` +
            `${(edge * 100 >= 0 ? '+' : '') + (edge * 100).toFixed(1).padStart(5)}pp  ` +
            `${(meanReturn * 100 >= 0 ? '+' : '') + (meanReturn * 100).toFixed(2).padStart(7)}%  ` +
            `${(baselineMean * 100 >= 0 ? '+' : '') + (baselineMean * 100).toFixed(2).padStart(9)}%`,
        );
      }
      console.log('');
    }
  }

  console.log('Reading this table');
  console.log('-'.repeat(74));
  console.log(
    'hit%  how often the forward return went the way the bias leaned.\n' +
      'edge  hit% minus the baseline for that direction. This is the only column\n' +
      '      that says anything. A positive hit% with a negative edge means the\n' +
      '      signal did worse than not looking at it at all.\n',
  );
  console.log(
    `Caveats: ${barsEvaluated} overlapping signals are not independent observations;\n` +
      'there are no costs, slippage or borrow fees; the news component is excluded\n' +
      'because historical headline scores are not archived; and the parameters were\n' +
      'chosen by hand rather than fitted, which avoids overfitting but also means\n' +
      'nothing here has been optimised.\n',
  );
  console.log('Signals are descriptive, not predictive. Not investment advice.');
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
