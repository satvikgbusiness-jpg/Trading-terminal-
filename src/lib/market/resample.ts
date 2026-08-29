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
    // Align weeks to Monday 00:00 UTC. 1970-01-01 was a Thursday, so shift by 4d.
    const shift = 4 * 86_400;
    return Math.floor((tSeconds + shift) / size) * size - shift;
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
