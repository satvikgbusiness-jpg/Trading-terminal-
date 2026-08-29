import { describe, expect, it } from 'vitest';
import {
  GranularityError, bucketStart, canResample, inferSpacingSeconds, resample, resampleChecked,
} from '@/lib/market/resample';
import type { Candle } from '@/lib/market/types';

const HOUR = 3_600;
const DAY = 86_400;

/** Bars at a fixed spacing, each with a distinct OHLC so aggregation is checkable. */
function bars(count: number, spacingSeconds: number, start = DAY * 20_000): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i;
    return { t: start + i * spacingSeconds, o: base, h: base + 2, l: base - 2, c: base + 1, v: 10 };
  });
}

describe('inferSpacingSeconds', () => {
  it('measures the spacing of a regular series', () => {
    expect(inferSpacingSeconds(bars(10, 4 * HOUR))).toBe(4 * HOUR);
    expect(inferSpacingSeconds(bars(10, DAY))).toBe(DAY);
    expect(inferSpacingSeconds(bars(10, 4 * DAY))).toBe(4 * DAY);
  });

  it('uses the median, so weekend gaps in a daily series do not skew it', () => {
    // Five weekdays then a three-day jump, repeated -- as a real daily feed looks.
    const out: Candle[] = [];
    let t = DAY * 20_000;
    for (let week = 0; week < 6; week += 1) {
      for (let day = 0; day < 5; day += 1) {
        out.push({ t, o: 100, h: 101, l: 99, c: 100, v: 1 });
        t += DAY;
      }
      t += 2 * DAY;
    }
    expect(inferSpacingSeconds(out)).toBe(DAY);
  });

  it('returns null when there are too few bars to measure', () => {
    expect(inferSpacingSeconds([])).toBeNull();
    expect(inferSpacingSeconds(bars(2, DAY))).toBeNull();
  });
});

describe('resample', () => {
  it('rolls 4-hour bars up into daily ones correctly', () => {
    const source = bars(12, 4 * HOUR); // two full days
    const daily = resample(source, 'D');
    expect(daily).toHaveLength(2);

    const firstSix = source.slice(0, 6);
    expect(daily[0]!.o).toBe(firstSix[0]!.o);
    expect(daily[0]!.c).toBe(firstSix[5]!.c);
    expect(daily[0]!.h).toBe(Math.max(...firstSix.map((b) => b.h)));
    expect(daily[0]!.l).toBe(Math.min(...firstSix.map((b) => b.l)));
    expect(daily[0]!.v).toBe(60); // volume sums
  });

  it('aligns weekly buckets to Monday', () => {
    // 2024-01-01 was a Monday.
    const monday = Date.UTC(2024, 0, 1) / 1000;
    expect(bucketStart(monday, 'W')).toBe(monday);
    expect(bucketStart(monday + 3 * DAY, 'W')).toBe(monday);
    expect(bucketStart(monday + 7 * DAY, 'W')).toBe(monday + 7 * DAY);
  });

  it('carries volume through as null when the source has none', () => {
    const source = bars(6, 4 * HOUR).map((b) => ({ ...b, v: null }));
    expect(resample(source, 'D')[0]!.v).toBeNull();
  });
});

/**
 * The guard that matters.
 *
 * CoinGecko's public OHLC endpoint returns 4-day bars for wide windows. The
 * original adapter trusted a hard-coded table saying a 90-day window was daily,
 * which meant those 4-day bars would have been bucketed into daily slots and
 * returned as a daily series -- one bar every fourth day, presented as if the
 * gaps were simply days the market did not trade.
 */
describe('resampleChecked', () => {
  it('allows aggregation when the source is finer than the target', () => {
    expect(resampleChecked(bars(12, 4 * HOUR), 'D')).toHaveLength(2);
    expect(resampleChecked(bars(24, HOUR), 'D')).toHaveLength(1);
  });

  it('allows a source at exactly the target resolution', () => {
    expect(resampleChecked(bars(5, DAY), 'D')).toHaveLength(5);
  });

  it('refuses to pass 4-day bars off as daily bars', () => {
    expect(() => resampleChecked(bars(10, 4 * DAY), 'D')).toThrow(GranularityError);
    expect(() => resampleChecked(bars(10, 4 * DAY), 'D')).toThrow(/coarser than the requested/i);
  });

  it('names both the native and the requested resolution in the error', () => {
    try {
      resampleChecked(bars(10, 4 * DAY), 'D');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GranularityError);
      const granularity = err as GranularityError;
      expect(granularity.nativeSeconds).toBe(4 * DAY);
      expect(granularity.targetSeconds).toBe(DAY);
      expect(granularity.message).toMatch(/without inventing prices/);
    }
  });

  it('tolerates weekend gaps in a genuinely daily series', () => {
    const out: Candle[] = [];
    let t = Date.UTC(2024, 0, 1) / 1000;
    for (let week = 0; week < 8; week += 1) {
      for (let day = 0; day < 5; day += 1) {
        out.push({ t, o: 100, h: 101, l: 99, c: 100, v: 1 });
        t += DAY;
      }
      t += 2 * DAY;
    }
    expect(() => resampleChecked(out, 'D')).not.toThrow();
  });

  it('refuses an hourly request fed with daily bars', () => {
    expect(() => resampleChecked(bars(10, DAY), '60')).toThrow(GranularityError);
  });

  it('does not throw on a series too short to measure', () => {
    // Two bars carry no reliable spacing; refusing here would reject sparse but
    // legitimate responses.
    expect(() => resampleChecked(bars(2, 4 * DAY), 'D')).not.toThrow();
  });
});

describe('canResample', () => {
  it('permits finer-to-coarser only', () => {
    expect(canResample('60', 'D')).toBe(true);
    expect(canResample('D', 'D')).toBe(true);
    expect(canResample('D', '60')).toBe(false);
    expect(canResample('W', 'D')).toBe(false);
  });
});
