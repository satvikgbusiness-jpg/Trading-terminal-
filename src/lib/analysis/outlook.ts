import type { CandleSeries } from '@/lib/market/types';
import {
  atr, bollinger, closes, last, lastCross, macd, percentileRank, realizedVolatility, rsi, sma, valueAt,
} from './indicators';
import type { AggregateResult } from './sentiment';

/**
 * The Outlook engine.
 *
 * It describes the state a market is in right now, as a weighted sum of
 * independent technical readings plus a news-sentiment term. It does not
 * forecast. A "bullish 62" means the confluence of the inputs currently leans
 * bullish and is 62% of the way to the maximum the model can express — not that
 * the price is expected to rise, and not with any stated probability.
 *
 * Design rules:
 *  - Every component is either computed from real bars or marked unavailable.
 *    Unavailable components are excluded from the weighted mean rather than
 *    counted as zero, so thin data yields a weak read, not a false neutral.
 *  - Every non-zero component must produce a human-readable reason. If the
 *    engine cannot say why, it does not get to contribute.
 *  - Volatility is reported, never scored. It tells the user how much the name
 *    moves, which is a different question from which way it is leaning.
 */

export const OUTLOOK_DISCLAIMER =
  'Signals are descriptive, not predictive. Not investment advice.';

export type Bias = 'bullish' | 'bearish' | 'neutral';
export type VolatilityLevel = 'low' | 'medium' | 'high' | 'unknown';

/** |score| below this is reported as neutral. */
export const NEUTRAL_BAND = 12;

/** Minimum summed weight of available components before a bias is asserted. */
const MIN_EVIDENCE_WEIGHT = 2.0;

/**
 * Minimum gap between SMA(50) and SMA(200), as a fraction of price, before a
 * crossing counts as a golden/death cross rather than sideways noise.
 */
const MIN_CROSS_SEPARATION = 0.005;

export const COMPONENT_WEIGHTS = {
  rsi: 1.0,
  macd: 1.2,
  sma50: 1.0,
  sma200: 1.2,
  bollinger: 0.8,
  volume: 0.6,
  news: 1.5,
} as const;

export type ComponentId = keyof typeof COMPONENT_WEIGHTS;

export interface OutlookComponent {
  id: ComponentId;
  label: string;
  /** Signed strength of this reading, in [-1, 1]. */
  contribution: number;
  weight: number;
  /** Weighted contribution — what actually enters the score. */
  weighted: number;
  available: boolean;
  /** Why this component reads the way it does. Null only when unavailable. */
  reason: string | null;
}

export interface VolatilityRead {
  level: VolatilityLevel;
  /** ATR(14) in price terms, when a true high/low range exists. */
  atr: number | null;
  /** ATR as a percentage of the last close. */
  atrPercent: number | null;
  /** Annualised close-to-close volatility, as a percentage. */
  realizedPercent: number | null;
  /** Rank of the current reading within its own history, 0–1. */
  percentile: number | null;
  basis: 'atr' | 'close-to-close' | 'none';
  reason: string;
}

export interface Outlook {
  symbol: string;
  bias: Bias;
  /** 0–100. How far the weighted confluence sits from neutral. */
  strength: number;
  /** Signed score in [-100, 100]. */
  score: number;
  /** Ordered strongest-first, for display. */
  reasons: string[];
  components: OutlookComponent[];
  volatility: VolatilityRead;
  news: AggregateResult | null;
  /** Timestamp of the last bar the read is based on (ms). */
  asOf: number;
  barsUsed: number;
  /** Things the engine could not evaluate, and why. */
  gaps: string[];
  disclaimer: string;
}

export interface OutlookInput {
  symbol: string;
  series: CandleSeries;
  news?: AggregateResult | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function computeOutlook({ symbol, series, news }: OutlookInput): Outlook {
  const bars = series.bars;
  const price = closes(bars);
  const components: OutlookComponent[] = [];
  const gaps: string[] = [];

  const push = (
    id: ComponentId,
    label: string,
    result: { contribution: number; reason: string } | { unavailable: string },
  ) => {
    const weight = COMPONENT_WEIGHTS[id];
    if ('unavailable' in result) {
      gaps.push(`${label}: ${result.unavailable}`);
      components.push({ id, label, contribution: 0, weight, weighted: 0, available: false, reason: null });
      return;
    }
    const contribution = clamp(result.contribution, -1, 1);
    components.push({
      id,
      label,
      contribution,
      weight,
      weighted: contribution * weight,
      available: true,
      reason: result.reason,
    });
  };

  push('rsi', 'RSI(14)', rsiComponent(price));
  push('macd', 'MACD(12,26,9)', macdComponent(price));
  push('sma50', 'Price vs SMA(50)', smaComponent(price, 50));
  push('sma200', 'Price vs SMA(200)', sma200Component(price));
  push('bollinger', 'Bollinger(20,2)', bollingerComponent(price));
  push(
    'volume',
    'Volume vs 20-bar average',
    series.hasVolume ? volumeComponent(bars.map((b) => b.v), price) : { unavailable: 'this feed reports no volume' },
  );
  push('news', 'News sentiment', newsComponent(news ?? null));

  const available = components.filter((c) => c.available);
  const evidenceWeight = available.reduce((sum, c) => sum + c.weight, 0);

  let score = 0;
  let bias: Bias = 'neutral';

  if (evidenceWeight >= MIN_EVIDENCE_WEIGHT) {
    // Normalising by the weight actually present means a missing feed produces a
    // read based on what exists, not one diluted toward zero by absent inputs.
    score = (available.reduce((sum, c) => sum + c.weighted, 0) / evidenceWeight) * 100;
    if (score >= NEUTRAL_BAND) bias = 'bullish';
    else if (score <= -NEUTRAL_BAND) bias = 'bearish';
  } else {
    gaps.push(
      `Not enough inputs to form a view (${available.length} of ${components.length} available; ` +
        `needs weight ${MIN_EVIDENCE_WEIGHT}, has ${round2(evidenceWeight)}).`,
    );
  }

  const volatility = volatilityRead(series);

  const reasons = available
    .filter((c) => c.reason && Math.abs(c.weighted) > 0.001)
    .sort((a, b) => Math.abs(b.weighted) - Math.abs(a.weighted))
    .map((c) => c.reason!);
  reasons.push(volatility.reason);

  return {
    symbol,
    bias,
    strength: Math.min(100, Math.round(Math.abs(score))),
    score: round2(score),
    reasons,
    components,
    volatility,
    news: news ?? null,
    asOf: (bars[bars.length - 1]?.t ?? 0) * 1000,
    barsUsed: bars.length,
    gaps,
    disclaimer: OUTLOOK_DISCLAIMER,
  };
}

type ComponentResult = { contribution: number; reason: string } | { unavailable: string };

function rsiComponent(price: number[]): ComponentResult {
  const series = rsi(price, 14);
  const current = last(series);
  if (!current) return { unavailable: 'needs at least 15 bars' };

  const r = current.value;
  const shown = r.toFixed(1);

  // A completed crossing of 30/70 is the strongest form of "the extreme broke".
  const crossed30 = crossedLevel(series, 30, 5);
  const crossed70 = crossedLevel(series, 70, 5);

  if (crossed30 === 'up') {
    return { contribution: 0.8, reason: `RSI(14) recovering from oversold (now ${shown})` };
  }
  if (crossed70 === 'down') {
    return { contribution: -0.7, reason: `RSI(14) rolling over from overbought (now ${shown})` };
  }

  // Inside an extreme, direction decides the reading. An oversold market that is
  // still falling is sustained selling, not a bounce waiting to happen — reading
  // every low RSI as bullish would score a collapse as a buying opportunity.
  const slope = rsiSlope(series, 3);

  if (r < 30) {
    return slope > 0
      ? { contribution: 0.4, reason: `RSI(14) at ${shown} — oversold and turning up` }
      : { contribution: -0.5, reason: `RSI(14) at ${shown} — oversold and still falling, sustained selling` };
  }
  if (r > 70) {
    return slope < 0
      ? { contribution: -0.4, reason: `RSI(14) at ${shown} — overbought and rolling over` }
      : { contribution: 0.2, reason: `RSI(14) at ${shown} — overbought, momentum intact` };
  }
  if (r > 55) return { contribution: 0.5, reason: `RSI(14) at ${shown} — momentum firm` };
  if (r < 45) return { contribution: -0.5, reason: `RSI(14) at ${shown} — momentum soft` };
  return { contribution: 0, reason: `RSI(14) at ${shown} — neutral` };
}

/** Change in RSI over the last `bars` readings; 0 when history is too short. */
function rsiSlope(series: Array<number | null>, bars: number): number {
  const current = last(series);
  if (!current) return 0;
  const earlier = valueAt(series, current.index - bars);
  return earlier === null ? 0 : current.value - earlier;
}

/** Direction of the most recent crossing of a fixed level, within `lookback`. */
function crossedLevel(series: Array<number | null>, level: number, lookback: number): 'up' | 'down' | null {
  const flat = series.map((v) => (v === null ? null : level));
  return lastCross(series, flat, lookback)?.direction ?? null;
}

function macdComponent(price: number[]): ComponentResult {
  const { macd: line, signal, histogram } = macd(price);
  const currentHist = last(histogram);
  const currentLine = last(line);
  if (!currentHist || !currentLine) return { unavailable: 'needs at least 34 bars' };

  const h = currentHist.value;
  const m = currentLine.value;
  const spot = price[price.length - 1]!;
  // MACD is denominated in price, so a $400 stock and a $4 stock produce
  // histograms two orders of magnitude apart. Show it relative to price.
  const relative = spot === 0 ? 0 : (h / spot) * 100;
  const shown = `${signed(relative)}% of price`;

  const cross = lastCross(line, signal, 5);
  if (cross) {
    // A cross below the zero line is a weaker signal than one above it: it says
    // a downtrend is decelerating, not that an uptrend has begun.
    const aboveZero = m > 0;
    if (cross.direction === 'up') {
      return {
        contribution: aboveZero ? 1 : 0.5,
        reason:
          `MACD bullish cross ${barsAgoLabel(cross.barsAgo)} ` +
          `${aboveZero ? 'above' : 'below'} the zero line (histogram ${shown})`,
      };
    }
    return {
      contribution: aboveZero ? -0.5 : -1,
      reason:
        `MACD bearish cross ${barsAgoLabel(cross.barsAgo)} ` +
        `${aboveZero ? 'above' : 'below'} the zero line (histogram ${shown})`,
    };
  }

  // Standard two-part reading: the line's side of zero gives the trend, the
  // histogram gives whether momentum is building or fading within it. Reading
  // the histogram alone flips bullish in any decelerating decline, because the
  // absolute gap between the averages narrows as price compounds lower.
  if (m > 0 && h > 0) return { contribution: 1, reason: `MACD above zero with momentum building (histogram ${shown})` };
  if (m > 0 && h < 0) return { contribution: 0.3, reason: `MACD above zero but momentum fading (histogram ${shown})` };
  if (m < 0 && h > 0) return { contribution: -0.3, reason: `MACD below zero, decline decelerating (histogram ${shown})` };
  if (m < 0 && h < 0) return { contribution: -1, reason: `MACD below zero with momentum falling (histogram ${shown})` };
  return { contribution: 0, reason: `MACD flat at the zero line (histogram ${shown})` };
}

function smaComponent(price: number[], period: number): ComponentResult {
  const series = sma(price, period);
  const current = last(series);
  if (!current || current.index !== price.length - 1) {
    return { unavailable: `needs at least ${period} bars` };
  }
  const spot = price[price.length - 1]!;
  const level = current.value;
  const gap = (spot - level) / level;
  const cross = lastCross(price.map((p) => p as number | null), series, 5);

  if (cross?.direction === 'up') {
    return {
      contribution: 1,
      reason: `price reclaimed SMA(${period}) ${barsAgoLabel(cross.barsAgo)} (${pct(gap)} above)`,
    };
  }
  if (cross?.direction === 'down') {
    return {
      contribution: -1,
      reason: `price lost SMA(${period}) ${barsAgoLabel(cross.barsAgo)} (${pct(gap)} below)`,
    };
  }
  return gap >= 0
    ? { contribution: 0.6, reason: `price ${pct(gap)} above SMA(${period})` }
    : { contribution: -0.6, reason: `price ${pct(Math.abs(gap))} below SMA(${period})` };
}

function sma200Component(price: number[]): ComponentResult {
  const base = smaComponent(price, 200);
  if ('unavailable' in base) return base;

  // A 50/200 crossing inside the last 20 bars is the headline event; fold it in
  // rather than reporting the same trend twice.
  const fast = sma(price, 50);
  const slow = sma(price, 200);
  const cross = lastCross(fast, slow, 20);
  if (!cross) return base;

  // In a flat market the two averages sit on top of each other and cross on
  // noise. Require them to have actually separated before calling it a golden
  // or death cross, otherwise a sideways tape produces a crossing every week.
  const fastNow = last(fast);
  const slowNow = last(slow);
  const spot = price[price.length - 1]!;
  const separation =
    fastNow && slowNow && spot !== 0 ? Math.abs(fastNow.value - slowNow.value) / spot : 0;
  if (separation < MIN_CROSS_SEPARATION) return base;

  const label = cross.direction === 'up' ? 'golden cross' : 'death cross';
  const bonus = cross.direction === 'up' ? 0.6 : -0.6;
  return {
    contribution: clamp(base.contribution + bonus, -1, 1),
    reason: `${base.reason}; SMA(50)/SMA(200) ${label} ${barsAgoLabel(cross.barsAgo)}`,
  };
}

function bollingerComponent(price: number[]): ComponentResult {
  const { percentB } = bollinger(price, 20, 2);
  const current = last(percentB);
  if (!current || current.index !== price.length - 1) {
    return { unavailable: 'needs at least 20 bars with a non-flat window' };
  }
  const b = current.value;
  const shown = b.toFixed(2);

  if (b > 1) return { contribution: -0.4, reason: `price above the upper Bollinger band (%B ${shown}) — extended` };
  if (b < 0) return { contribution: 0.4, reason: `price below the lower Bollinger band (%B ${shown}) — washed out` };
  if (b > 0.9) return { contribution: 0.2, reason: `price riding the upper Bollinger band (%B ${shown})` };
  if (b > 0.5) return { contribution: 0.5, reason: `price in the upper half of the Bollinger range (%B ${shown})` };
  if (b > 0.1) return { contribution: -0.5, reason: `price in the lower half of the Bollinger range (%B ${shown})` };
  return { contribution: -0.2, reason: `price hugging the lower Bollinger band (%B ${shown})` };
}

function volumeComponent(volumes: Array<number | null>, price: number[]): ComponentResult {
  const clean = volumes.map((v) => (v === null ? null : v));
  if (clean.length < 21 || clean.slice(-21).some((v) => v === null)) {
    return { unavailable: 'needs 21 bars of volume' };
  }
  const numeric = clean.map((v) => v as number);
  const average = last(sma(numeric, 20));
  const latest = numeric[numeric.length - 1]!;
  if (!average || average.value === 0) return { unavailable: 'no volume baseline' };

  const ratio = latest / average.value;
  const previous = price[price.length - 2];
  const spot = price[price.length - 1]!;
  if (previous === undefined || previous === 0) return { unavailable: 'needs two bars of price' };

  const move = spot / previous - 1;
  if (move === 0) {
    return { contribution: 0, reason: `volume ${ratio.toFixed(2)}x the 20-bar average on an unchanged close` };
  }

  const direction = move > 0 ? 1 : -1;
  const word = move > 0 ? 'advance' : 'decline';

  // Heavy volume confirms the day's move; thin volume argues against it.
  if (ratio >= 1.5) {
    return {
      contribution: 0.8 * direction,
      reason: `volume ${ratio.toFixed(2)}x the 20-bar average confirming the ${word}`,
    };
  }
  if (ratio >= 1.2) {
    return {
      contribution: 0.5 * direction,
      reason: `volume ${ratio.toFixed(2)}x the 20-bar average on the ${word}`,
    };
  }
  if (ratio <= 0.7) {
    return {
      contribution: -0.3 * direction,
      reason: `only ${ratio.toFixed(2)}x average volume behind the ${word} — thin participation`,
    };
  }
  return { contribution: 0, reason: `volume ${ratio.toFixed(2)}x the 20-bar average — unremarkable` };
}

function newsComponent(news: AggregateResult | null): ComponentResult {
  if (!news || news.counts.total === 0) {
    return { unavailable: 'no headlines in the scoring window' };
  }
  const { counts } = news;
  const parts: string[] = [];
  if (counts.positive) parts.push(`${counts.positive} positive`);
  if (counts.negative) parts.push(`${counts.negative} negative`);
  if (counts.neutral) parts.push(`${counts.neutral} neutral`);

  return {
    contribution: news.score,
    reason:
      `news sentiment ${signed(news.score)} ` +
      `(${parts.join(', ')} ${counts.total === 1 ? 'headline' : 'headlines'}, recency-weighted)`,
  };
}

/**
 * Volatility is measured, labelled, and kept out of the score.
 *
 * ATR needs a real high/low range. Feeds that publish one reference price per
 * period (ECB FX fixings) have no intraday range at all, so those fall back to
 * annualised close-to-close volatility — a different statistic, named as such,
 * rather than an ATR computed over zero-width bars.
 */
export function volatilityRead(series: CandleSeries): VolatilityRead {
  const bars = series.bars;
  const price = closes(bars);
  const spot = price[price.length - 1];

  if (series.hasRange && bars.length >= 30 && spot) {
    const atrSeries = atr(bars, 14);
    const current = last(atrSeries);
    if (current) {
      const atrPercentSeries: number[] = [];
      for (let i = 0; i < atrSeries.length; i += 1) {
        const a = valueAt(atrSeries, i);
        const c = price[i];
        if (a !== null && c) atrPercentSeries.push(a / c);
      }
      const window = atrPercentSeries.slice(-252);
      const currentPct = current.value / spot;
      const percentile = percentileRank(window, currentPct);
      const level = levelFor(percentile);
      return {
        level,
        atr: round2(current.value),
        atrPercent: currentPct * 100,
        realizedPercent: null,
        percentile,
        basis: 'atr',
        reason:
          `${level.toUpperCase()} volatility — ATR(14) is ${pct(currentPct)} of price, ` +
          `${ordinal(percentile)} percentile of the last ${window.length} bars`,
      };
    }
  }

  const realized = realizedVolatility(price.slice(-60));
  if (realized !== null && price.length >= 40) {
    const rolling: number[] = [];
    for (let i = 40; i <= price.length; i += 1) {
      const v = realizedVolatility(price.slice(Math.max(0, i - 40), i));
      if (v !== null) rolling.push(v);
    }
    const percentile = percentileRank(rolling, realized);
    const level = levelFor(percentile);
    const basisNote = series.hasRange ? '' : ' (no intraday range in this feed)';
    return {
      level,
      atr: null,
      atrPercent: null,
      realizedPercent: realized * 100,
      percentile,
      basis: 'close-to-close',
      reason:
        `${level.toUpperCase()} volatility — ${pct(realized)} annualised close-to-close, ` +
        `${ordinal(percentile)} percentile of its own history${basisNote}`,
    };
  }

  return {
    level: 'unknown',
    atr: null,
    atrPercent: null,
    realizedPercent: null,
    percentile: null,
    basis: 'none',
    reason: `volatility not measurable — only ${bars.length} bars available`,
  };
}

function levelFor(percentile: number | null): VolatilityLevel {
  if (percentile === null) return 'unknown';
  if (percentile < 1 / 3) return 'low';
  if (percentile < 2 / 3) return 'medium';
  return 'high';
}

function ordinal(percentile: number | null): string {
  if (percentile === null) return 'unknown';
  const n = Math.round(percentile * 100);
  const suffix =
    n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

function barsAgoLabel(barsAgo: number): string {
  if (barsAgo === 0) return 'on the latest bar';
  if (barsAgo === 1) return '1 bar ago';
  return `${barsAgo} bars ago`;
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The one-line form used in dense lists: "▲ BULLISH 62 — reason; reason". */
export function formatOutlookLine(outlook: Outlook, maxReasons = 4): string {
  const arrow = outlook.bias === 'bullish' ? '▲' : outlook.bias === 'bearish' ? '▼' : '▬';
  const head = `${arrow} ${outlook.bias.toUpperCase()} ${outlook.strength}`;
  const reasons = outlook.reasons.slice(0, maxReasons).join('; ');
  return reasons ? `${head} — ${reasons}` : head;
}
