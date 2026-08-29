import { describe, expect, it } from 'vitest';
import {
  atr, bollinger, ema, lastCross, macd, percentileRank, realizedVolatility, rsi, sma, trueRange,
} from '@/lib/analysis/indicators';
import type { Candle } from '@/lib/market/types';

/** Wilder's worked RSI example — the dataset every charting package checks against. */
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89,
  46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25,
  45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];

function candle(o: number, h: number, l: number, c: number, t = 0): Candle {
  return { t, o, h, l, c, v: 1000 };
}

describe('sma', () => {
  it('is null through the warm-up and correct after it', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(2, 10);
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it('does not drift over a long rolling window', () => {
    const values = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 100 + 500);
    const out = sma(values, 50);
    const manual = values.slice(950, 1000).reduce((a, b) => a + b, 0) / 50;
    expect(out[999]!).toBeCloseTo(manual, 8);
  });

  it('returns all nulls when there are fewer bars than the period', () => {
    expect(sma([1, 2], 5).every((v) => v === null)).toBe(true);
  });
});

describe('ema', () => {
  it('seeds from the SMA of the first period', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, 10); // (1+2+3)/3
    // k = 2/(3+1) = 0.5 -> 4*0.5 + 2*0.5 = 3
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it('converges to a constant input', () => {
    const out = ema(new Array(200).fill(42), 20);
    expect(out[199]).toBeCloseTo(42, 10);
  });
});

describe('rsi', () => {
  it('matches Wilder\'s published example', () => {
    const out = rsi(WILDER_CLOSES, 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    // Published first value for this series is ~70.5.
    expect(out[14]!).toBeGreaterThan(70.0);
    expect(out[14]!).toBeLessThan(71.0);
    // and the series ends in the high-30s after the late sell-off.
    expect(out[32]!).toBeGreaterThan(36);
    expect(out[32]!).toBeLessThan(39);
  });

  it('pins at 100 for an unbroken advance and 0 for an unbroken decline', () => {
    const up = rsi(Array.from({ length: 40 }, (_, i) => 100 + i), 14);
    const down = rsi(Array.from({ length: 40 }, (_, i) => 100 - i), 14);
    expect(up[39]).toBeCloseTo(100, 6);
    expect(down[39]).toBeCloseTo(0, 6);
  });

  it('oscillates tightly around 50 when gains and losses are symmetric', () => {
    // Wilder smoothing weights the most recent bar, so an alternating series
    // straddles 50 rather than sitting exactly on it.
    const values = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
    const out = rsi(values, 14);
    const afterUpBar = out[59]!;
    const afterDownBar = out[58]!;
    expect(afterUpBar).toBeGreaterThan(50);
    expect(afterDownBar).toBeLessThan(50);
    expect((afterUpBar + afterDownBar) / 2).toBeCloseTo(50, 0);
    expect(Math.abs(afterUpBar - 50)).toBeLessThan(3);
  });

  it('reports 50, not NaN, for a perfectly flat series', () => {
    const out = rsi(new Array(40).fill(100), 14);
    expect(out[39]).toBe(50);
  });
});

describe('macd', () => {
  it('keeps histogram = macd - signal wherever both exist', () => {
    const values = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 10) * 20);
    const { macd: line, signal, histogram } = macd(values);
    for (let i = 0; i < values.length; i += 1) {
      if (line[i] !== null && signal[i] !== null) {
        expect(histogram[i]!).toBeCloseTo(line[i]! - signal[i]!, 10);
      } else {
        expect(histogram[i]).toBeNull();
      }
    }
  });

  it('starts the signal line 8 bars after the MACD line, not at bar 0', () => {
    const values = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
    const { macd: line, signal } = macd(values, 12, 26, 9);
    const firstMacd = line.findIndex((v) => v !== null);
    const firstSignal = signal.findIndex((v) => v !== null);
    expect(firstMacd).toBe(25); // slow EMA seeds at index 25
    expect(firstSignal).toBe(firstMacd + 8); // 9-period EMA over MACD values
  });

  it('is positive for a rising series and negative for a falling one', () => {
    const rising = macd(Array.from({ length: 120 }, (_, i) => 100 + i));
    const falling = macd(Array.from({ length: 120 }, (_, i) => 300 - i));
    expect(rising.macd[119]!).toBeGreaterThan(0);
    expect(falling.macd[119]!).toBeLessThan(0);
  });
});

describe('bollinger', () => {
  it('collapses to the mean on a flat series and leaves %B undefined', () => {
    const { upper, middle, lower, percentB } = bollinger(new Array(40).fill(50), 20);
    expect(upper[39]).toBeCloseTo(50, 10);
    expect(lower[39]).toBeCloseTo(50, 10);
    expect(middle[39]).toBeCloseTo(50, 10);
    // Zero-width band: %B would divide by zero, so it must be null not Infinity.
    expect(percentB[39]).toBeNull();
  });

  it('computes population sigma', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9]; // mean 5, population sd 2
    const { upper, lower, middle } = bollinger(values, 8, 2);
    expect(middle[7]).toBeCloseTo(5, 10);
    expect(upper[7]).toBeCloseTo(9, 10);
    expect(lower[7]).toBeCloseTo(1, 10);
  });

  it('puts %B above 1 when price breaks the upper band', () => {
    const values = [...new Array(20).fill(100), 130];
    const { percentB } = bollinger(values, 20);
    expect(percentB[20]!).toBeGreaterThan(1);
  });
});

describe('trueRange / atr', () => {
  it('takes the widest of range and the two gaps', () => {
    const candles = [candle(10, 12, 8, 11), candle(11, 13, 10, 12), candle(12, 20, 19, 19)];
    const tr = trueRange(candles);
    expect(tr[0]).toBe(4); // first bar: plain high-low
    expect(tr[1]).toBe(3); // 13-10 = 3 vs |13-11|=2 vs |10-11|=1
    expect(tr[2]).toBe(8); // |20-12| gap beats the 1-wide bar
  });

  it('is null through warm-up then Wilder-smoothed', () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(100, 102, 98, 100, i));
    const out = atr(candles, 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(out[14]).toBeCloseTo(4, 10); // every true range is 4
    expect(out[29]).toBeCloseTo(4, 10);
  });
});

describe('percentileRank', () => {
  it('splits ties in half', () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBeCloseTo((2 + 0.5) / 4, 10);
  });
  it('scores 0.5 when every observation is equal', () => {
    expect(percentileRank([5, 5, 5, 5], 5)).toBeCloseTo(0.5, 10);
  });
  it('returns null for an empty sample', () => {
    expect(percentileRank([], 1)).toBeNull();
  });
  it('is 1 for a value above everything', () => {
    expect(percentileRank([1, 2, 3], 10)).toBe(1);
  });
});

describe('lastCross', () => {
  it('finds an upward cross and how long ago it happened', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [5, 4, 3.5, 3, 2];
    const cross = lastCross(a, b, 5);
    expect(cross).toEqual({ direction: 'up', barsAgo: 1 });
  });

  it('returns null when the lines never touch inside the lookback', () => {
    expect(lastCross([1, 1, 1, 1], [9, 9, 9, 9], 4)).toBeNull();
  });

  it('ignores nulls in the warm-up region', () => {
    const a = [null, null, 1, 5];
    const b = [null, null, 3, 3];
    expect(lastCross(a, b, 4)).toEqual({ direction: 'up', barsAgo: 0 });
  });
});

describe('realizedVolatility', () => {
  it('is zero for a flat series', () => {
    expect(realizedVolatility(new Array(50).fill(100))!).toBeCloseTo(0, 10);
  });
  it('scales with the size of the moves', () => {
    const calm = Array.from({ length: 100 }, (_, i) => 100 + (i % 2) * 0.1);
    const wild = Array.from({ length: 100 }, (_, i) => 100 + (i % 2) * 10);
    expect(realizedVolatility(wild)!).toBeGreaterThan(realizedVolatility(calm)!);
  });
  it('returns null when there are too few points', () => {
    expect(realizedVolatility([100])).toBeNull();
  });
});
