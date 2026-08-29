import type { Candle, Resolution } from './types';

export const RESOLUTION_SECONDS: Record<Resolution, number> = {
  '1': 60,
  '5': 300,
  '15': 900,
  '60': 3_600,
  D: 86_400,
  W: 604_800,
};

/** Start of the bucket a timestamp belongs to, aligned to the UTC epoch. */
export function bucketStart(tSeconds: number, resolution: Resolution): number {
  const size = RESOLUTION_SECONDS[resolution];
  if (resolution === 'W') {
    // Align weeks to Monday 00:00 UTC. The epoch fell on a Thursday, so the first
    // Monday is four days in; subtract that offset before flooring and add it
    // back. Adding it instead (the intuitive-looking version) lands on Sunday.
    const mondayOffset = 4 * 86_400;
    return Math.floor((tSeconds - mondayOffset) / size) * size + mondayOffset;
  }
  return Math.floor(tSeconds / size) * size;
}

/**
 * Aggregate finer bars into coarser ones.
 *
 * Only ever called when the source granularity divides into the target — rolling
 * up 4-hour bars into daily is arithmetic, whereas splitting a 4-day bar into
 * four daily bars would be invention. `canResample` is the guard.
 */
export function resample(bars: Candle[], to: Resolution): Candle[] {
  if (bars.length === 0) return [];
  const out: Candle[] = [];
  let current: Candle | null = null;
  let currentBucket = -1;

  for (const bar of [...bars].sort((a, b) => a.t - b.t)) {
    const bucket = bucketStart(bar.t, to);
    if (current === null || bucket !== currentBucket) {
      if (current) out.push(current);
      current = { t: bucket, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v };
      currentBucket = bucket;
      continue;
    }
    current.h = Math.max(current.h, bar.h);
    current.l = Math.min(current.l, bar.l);
    current.c = bar.c;
    if (bar.v !== null) current.v = (current.v ?? 0) + bar.v;
  }
  if (current) out.push(current);
  return out;
}

/** True when `from` bars can be legitimately rolled up into `to` bars. */
export function canResample(from: Resolution, to: Resolution): boolean {
  return RESOLUTION_SECONDS[from] <= RESOLUTION_SECONDS[to];
}

/**
 * Median spacing between consecutive bars, in seconds.
 *
 * Providers document their granularity and then change it. Measuring the bars
 * actually returned is the only way to know what a response really contains, so
 * this is used to validate a response rather than trusting a lookup table.
 * The median (not the mean) so a single weekend gap does not skew the result.
 */
export function inferSpacingSeconds(bars: Candle[]): number | null {
  if (bars.length < 3) return null;
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i]!.t - sorted[i - 1]!.t;
    if (delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 0 ? (deltas[mid - 1]! + deltas[mid]!) / 2 : deltas[mid]!;
}

export class GranularityError extends Error {
  constructor(
    public readonly nativeSeconds: number,
    public readonly targetSeconds: number,
  ) {
    super(
      `Source returned bars roughly ${Math.round(nativeSeconds / 3600)}h apart, which is coarser ` +
        `than the requested ${Math.round(targetSeconds / 3600)}h resolution. Coarser bars cannot be ` +
        'split into finer ones without inventing prices.',
    );
    this.name = 'GranularityError';
  }
}

/**
 * Aggregate to `to`, but only after confirming the bars really are fine enough.
 *
 * Rolling 4-hour bars up into daily is arithmetic. Spreading 4-day bars across
 * four daily buckets would produce a sparse series that claims to be daily, so
 * this throws instead. A 20% tolerance absorbs weekend and holiday gaps in a
 * daily series without letting a genuinely coarser feed through.
 */
export function resampleChecked(bars: Candle[], to: Resolution): Candle[] {
  const spacing = inferSpacingSeconds(bars);
  const target = RESOLUTION_SECONDS[to];
  if (spacing !== null && spacing > target * 1.2) {
    throw new GranularityError(spacing, target);
  }
  return resample(bars, to);
}
