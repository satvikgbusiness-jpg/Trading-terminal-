import type { Candle } from '@/lib/market/types';

/**
 * Technical indicators.
 *
 * Every function returns an array the same length as its input, with `null` for
 * bars inside the warm-up period. Keeping the alignment means a chart overlay
 * and an Outlook lookup index the same series the same way, and a short history
 * produces nulls rather than a silently wrong number computed from too few bars.
 */

export type Series = Array<number | null>;

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values, the standard convention.
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface BollingerBands {
  upper: Series;
  middle: Series;
  lower: Series;
  /** (price - lower) / (upper - lower). <0 below the band, >1 above it. */
  percentB: Series;
  /** (upper - lower) / middle — band width as a fraction of the mean. */
  bandwidth: Series;
}

export function bollinger(values: number[], period = 20, stdDevs = 2): BollingerBands {
  const middle = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  const percentB: Series = new Array(values.length).fill(null);
  const bandwidth: Series = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i += 1) {
    const mean = middle[i];
    if (mean === null || mean === undefined) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = values[j]! - mean;
      variance += d * d;
    }
    // Population standard deviation, which is what Bollinger's original
    // formulation uses.
    const sd = Math.sqrt(variance / period);
    const up = mean + stdDevs * sd;
    const low = mean - stdDevs * sd;
    upper[i] = up;
    lower[i] = low;
    const width = up - low;
    // A flat window has zero width; %B is undefined there rather than infinite.
    percentB[i] = width === 0 ? null : (values[i]! - low) / width;
    bandwidth[i] = mean === 0 ? null : width / mean;
  }
  return { upper, middle, lower, percentB, bandwidth };
}

/**
 * Wilder's RSI: the smoothing every charting package means when it says RSI(14).
 */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  // No losses in the window means an unbroken advance: RSI pins at 100.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface Macd {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);

  const macdLine: Series = values.map((_, i) => {
    const f = fastEma[i];
    const s = slowEma[i];
    return f === null || f === undefined || s === null || s === undefined ? null : f - s;
  });

  // The signal line is an EMA of the MACD line, which only exists from the slow
  // period onward. Seed it from the first defined value so the 9-period EMA is
  // computed over MACD values rather than over leading nulls.
  const firstDefined = macdLine.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  if (firstDefined !== -1) {
    const compact = macdLine.slice(firstDefined).map((v) => v as number);
    const compactSignal = ema(compact, signalPeriod);
    for (let i = 0; i < compactSignal.length; i += 1) {
      signal[firstDefined + i] = compactSignal[i] ?? null;
    }
  }

  const histogram: Series = values.map((_, i) => {
    const m = macdLine[i];
    const s = signal[i];
    return m === null || m === undefined || s === null || s === undefined ? null : m - s;
  });

  return { macd: macdLine, signal, histogram };
}

/** True Range: the widest of today's range and the two gaps against yesterday. */
export function trueRange(candles: Candle[]): Series {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prevClose = candles[i - 1]!.c;
    return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
  });
}

/** Wilder-smoothed Average True Range. */
export function atr(candles: Candle[], period = 14): Series {
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  const tr = trueRange(candles).map((v) => v as number);
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i]!;
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Where `value` sits within `sample`, as a 0–1 fraction.
 *
 * Uses the "fraction of observations strictly below, plus half the ties"
 * definition so a value equal to every sample scores 0.5 rather than 0 or 1.
 */
export function percentileRank(sample: number[], value: number): number | null {
  const clean = sample.filter((n) => Number.isFinite(n));
  if (clean.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const n of clean) {
    if (n < value) below += 1;
    else if (n === value) equal += 1;
  }
  return (below + equal / 2) / clean.length;
}

/** Latest non-null value of a series, with its index. */
export function last(series: Series): { index: number; value: number } | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return { index: i, value: v };
  }
  return null;
}

/** Value `back` bars before the end, or null if not available. */
export function valueAt(series: Series, index: number): number | null {
  if (index < 0 || index >= series.length) return null;
  const v = series[index];
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/**
 * Most recent bar index where `a` crossed `b`, within `lookback` bars of the end.
 * Returns the direction and how many bars ago it happened.
 */
export function lastCross(
  a: Series,
  b: Series,
  lookback: number,
): { direction: 'up' | 'down'; barsAgo: number } | null {
  const end = Math.min(a.length, b.length) - 1;
  const start = Math.max(1, end - lookback + 1);
  for (let i = end; i >= start; i -= 1) {
    const aNow = a[i];
    const bNow = b[i];
    const aPrev = a[i - 1];
    const bPrev = b[i - 1];
    if (aNow == null || bNow == null || aPrev == null || bPrev == null) continue;
    if (aPrev <= bPrev && aNow > bNow) return { direction: 'up', barsAgo: end - i };
    if (aPrev >= bPrev && aNow < bNow) return { direction: 'down', barsAgo: end - i };
  }
  return null;
}

/** Standard deviation of simple returns, annualised from `periodsPerYear` bars. */
export function realizedVolatility(values: number[], periodsPerYear = 252): number | null {
  if (values.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1]!;
    if (prev === 0) continue;
    returns.push(values[i]! / prev - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

export const closes = (candles: Candle[]): number[] => candles.map((c) => c.c);
