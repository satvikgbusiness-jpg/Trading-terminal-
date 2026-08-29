import { describe, expect, it } from 'vitest';
import { COMPONENT_WEIGHTS, computeOutlook, formatOutlookLine, OUTLOOK_DISCLAIMER } from '@/lib/analysis/outlook';
import { aggregateSentiment } from '@/lib/analysis/sentiment';
import type { Candle, CandleSeries } from '@/lib/market/types';

const DAY = 86_400;

/** Deterministic bar builder: a price path with a fixed intrabar range. */
function seriesFrom(prices: number[], opts: { volume?: number[] | null; rangePct?: number } = {}): CandleSeries {
  const { volume = null, rangePct = 0.01 } = opts;
  const bars: Candle[] = prices.map((c, i) => {
    const o = i === 0 ? c : prices[i - 1]!;
    const halfRange = c * rangePct;
    return {
      t: DAY * (1000 + i),
      o,
      h: Math.max(o, c) + halfRange,
      l: Math.min(o, c) - halfRange,
      c,
      v: volume ? volume[i]! : null,
    };
  });
  return { bars, resolution: 'D', hasRange: true, hasVolume: volume !== null };
}

const uptrend = (n = 300) => Array.from({ length: n }, (_, i) => 100 * Math.pow(1.004, i));
const downtrend = (n = 300) => Array.from({ length: n }, (_, i) => 400 * Math.pow(0.996, i));
/** Sideways with no trend and no persistent momentum. */
const chop = (n = 300) => Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 1.5);

describe('computeOutlook — direction', () => {
  it('reads a sustained advance as bullish', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(uptrend()) });
    expect(o.bias).toBe('bullish');
    expect(o.score).toBeGreaterThan(12);
    expect(o.strength).toBeGreaterThan(12);
  });

  it('reads a sustained decline as bearish', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(downtrend()) });
    expect(o.bias).toBe('bearish');
    expect(o.score).toBeLessThan(-12);
  });

  it('carries no persistent bias through directionless chop', () => {
    // A single phase of an oscillator legitimately reads soft or firm depending
    // on where the last bar sits against its own mean. The property that must
    // hold is that there is no *standing* bias across phases.
    const full = chop(400);
    const scores: number[] = [];
    for (let end = 300; end <= 400; end += 5) {
      scores.push(computeOutlook({ symbol: 'TEST', series: seriesFrom(full.slice(0, end)) }).score);
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(Math.abs(mean)).toBeLessThan(12);
    expect(scores.some((s) => s > 0)).toBe(true);
    expect(scores.some((s) => s < 0)).toBe(true);
  });

  it('keeps score in [-100, 100] and strength in [0, 100]', () => {
    for (const prices of [uptrend(), downtrend(), chop()]) {
      const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(prices) });
      expect(o.score).toBeGreaterThanOrEqual(-100);
      expect(o.score).toBeLessThanOrEqual(100);
      expect(o.strength).toBeGreaterThanOrEqual(0);
      expect(o.strength).toBeLessThanOrEqual(100);
      expect(o.strength).toBe(Math.min(100, Math.round(Math.abs(o.score))));
    }
  });
});

describe('computeOutlook — contract', () => {
  it('gives every contributing component a human-readable reason', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(uptrend()) });
    for (const c of o.components) {
      if (c.available) expect(c.reason, `${c.id} contributed without a reason`).toBeTruthy();
      else expect(c.reason).toBeNull();
    }
    expect(o.reasons.length).toBeGreaterThan(2);
  });

  it('always carries the descriptive-not-predictive framing', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(uptrend()) });
    expect(o.disclaimer).toBe(OUTLOOK_DISCLAIMER);
    expect(o.disclaimer).toMatch(/not predictive/i);
    expect(o.disclaimer).toMatch(/not investment advice/i);
  });

  it('never asserts a bias on too little history', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom([100, 101, 102, 103, 104]) });
    expect(o.bias).toBe('neutral');
    expect(o.score).toBe(0);
    expect(o.gaps.join(' ')).toMatch(/Not enough inputs/i);
  });

  it('marks unavailable components rather than scoring them as zero', () => {
    // 100 bars: SMA(200) cannot exist, everything else can.
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(uptrend(100)) });
    const sma200 = o.components.find((c) => c.id === 'sma200')!;
    expect(sma200.available).toBe(false);
    expect(sma200.weighted).toBe(0);
    expect(o.gaps.some((g) => g.includes('SMA(200)'))).toBe(true);
    // The read still commits, because the remaining components carry enough weight.
    expect(o.bias).toBe('bullish');
  });

  it('excludes missing components from the denominator instead of diluting toward zero', () => {
    // Same bullish path, with and without volume. Dropping volume must not pull
    // the score toward neutral — it just leaves that term out of the mean.
    const prices = uptrend();
    const withVolume = computeOutlook({
      symbol: 'TEST',
      series: seriesFrom(prices, { volume: prices.map(() => 1_000_000) }),
    });
    const withoutVolume = computeOutlook({ symbol: 'TEST', series: seriesFrom(prices) });
    expect(withoutVolume.components.find((c) => c.id === 'volume')!.available).toBe(false);
    expect(withoutVolume.score).toBeGreaterThan(12);
    // Flat volume contributes 0, so including it *does* dilute; excluding it must not.
    expect(withoutVolume.score).toBeGreaterThan(withVolume.score);
  });

  it('reports bars used and the timestamp of the last bar', () => {
    const series = seriesFrom(uptrend(300));
    const o = computeOutlook({ symbol: 'TEST', series });
    expect(o.barsUsed).toBe(300);
    expect(o.asOf).toBe(series.bars[299]!.t * 1000);
  });
});

describe('computeOutlook — news', () => {
  const now = Date.now();
  const headlines = (score: number, n: number) =>
    aggregateSentiment(Array.from({ length: n }, () => ({ score, publishedAt: now })), { now });

  it('lets bullish news lift the score above bearish news on the same bars', () => {
    // The score is a weighted mean, so news pulls it toward the news reading
    // rather than always pushing further in one direction. The invariant that
    // must hold is the ordering.
    const series = seriesFrom(chop());
    const good = computeOutlook({ symbol: 'TEST', series, news: headlines(0.9, 8) });
    const bad = computeOutlook({ symbol: 'TEST', series, news: headlines(-0.9, 8) });
    expect(good.score).toBeGreaterThan(bad.score);

    // Monotone in the news reading, on identical bars.
    const scores = [-0.9, -0.4, 0, 0.4, 0.9].map(
      (n) => computeOutlook({ symbol: 'T', series, news: headlines(n, 8) }).score,
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }

    // And the news component itself always carries the sign of the headlines.
    expect(good.components.find((c) => c.id === 'news')!.contribution).toBeGreaterThan(0);
    expect(bad.components.find((c) => c.id === 'news')!.contribution).toBeLessThan(0);
  });

  it('describes the headline mix in the reason string', () => {
    const o = computeOutlook({
      symbol: 'TEST',
      series: seriesFrom(chop()),
      news: aggregateSentiment(
        [
          { score: 0.8, publishedAt: now },
          { score: 0.7, publishedAt: now },
          { score: -0.6, publishedAt: now },
        ],
        { now },
      ),
    });
    const reason = o.components.find((c) => c.id === 'news')!.reason!;
    expect(reason).toMatch(/news sentiment [+-]\d/);
    expect(reason).toMatch(/2 positive/);
    expect(reason).toMatch(/1 negative/);
    expect(reason).toMatch(/recency-weighted/);
  });

  it('marks news unavailable when there are no headlines', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(chop()) });
    expect(o.components.find((c) => c.id === 'news')!.available).toBe(false);
  });

  it('cannot invert a strong technical read on its own', () => {
    // News carries weight 1.5 of a possible 6.7 — enough to pull a read toward
    // neutral, never enough to turn a clean advance into a bearish call.
    const series = seriesFrom(uptrend(), { volume: uptrend().map(() => 1_000_000) });
    const o = computeOutlook({ symbol: 'TEST', series, news: headlines(-1, 20) });
    expect(o.bias).not.toBe('bearish');
    expect(o.score).toBeGreaterThan(-12);
  });
});

describe('volatility is reported, not scored', () => {
  it('does not change the bias when only the bar range changes', () => {
    const prices = uptrend();
    const calm = computeOutlook({ symbol: 'TEST', series: seriesFrom(prices, { rangePct: 0.002 }) });
    const wild = computeOutlook({ symbol: 'TEST', series: seriesFrom(prices, { rangePct: 0.05 }) });
    expect(calm.score).toBeCloseTo(wild.score, 10);
    expect(calm.bias).toBe(wild.bias);
  });

  it('uses ATR when the feed has a real high/low range', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(uptrend()) });
    expect(o.volatility.basis).toBe('atr');
    expect(o.volatility.atr).not.toBeNull();
    expect(o.volatility.reason).toMatch(/ATR\(14\)/);
    expect(['low', 'medium', 'high']).toContain(o.volatility.level);
  });

  it('falls back to close-to-close for reference-rate feeds with no range', () => {
    const prices = chop();
    const flat = seriesFrom(prices);
    // Simulate an ECB-style fixing: one price per day, no intraday range.
    const fixings: CandleSeries = {
      bars: flat.bars.map((b) => ({ ...b, o: b.c, h: b.c, l: b.c })),
      resolution: 'D',
      hasRange: false,
      hasVolume: false,
    };
    const o = computeOutlook({ symbol: 'EUR/USD', series: fixings });
    expect(o.volatility.basis).toBe('close-to-close');
    expect(o.volatility.atr).toBeNull();
    expect(o.volatility.reason).toMatch(/close-to-close/);
    expect(o.volatility.reason).toMatch(/no intraday range/);
  });

  it('says so plainly when volatility cannot be measured', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom([100, 101, 102]) });
    expect(o.volatility.level).toBe('unknown');
    expect(o.volatility.reason).toMatch(/not measurable/);
  });

  it('always appends the volatility read to the reason list', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(uptrend()) });
    expect(o.reasons[o.reasons.length - 1]).toBe(o.volatility.reason);
  });
});

describe('formatOutlookLine', () => {
  it('renders the dense one-line form', () => {
    const o = computeOutlook({ symbol: 'TEST', series: seriesFrom(uptrend()) });
    const line = formatOutlookLine(o);
    expect(line).toMatch(/^▲ BULLISH \d+ — /);
    expect(line.split('; ').length).toBeLessThanOrEqual(4);
  });

  it('uses a marker that matches the bias it reports', () => {
    const marker = { bullish: '▲', bearish: '▼', neutral: '▬' } as const;
    for (const prices of [uptrend(), downtrend(), chop(), chop(400)]) {
      const o = computeOutlook({ symbol: 'T', series: seriesFrom(prices) });
      expect(formatOutlookLine(o).startsWith(`${marker[o.bias]} ${o.bias.toUpperCase()} ${o.strength}`)).toBe(true);
    }
    expect(formatOutlookLine(computeOutlook({ symbol: 'T', series: seriesFrom(downtrend()) }))).toMatch(/^▼ BEARISH/);
    expect(formatOutlookLine(computeOutlook({ symbol: 'T', series: seriesFrom(uptrend()) }))).toMatch(/^▲ BULLISH/);
  });
});

describe('weights', () => {
  it('keeps news a minority of total weight', () => {
    const total = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(COMPONENT_WEIGHTS.news / total).toBeLessThan(0.25);
  });
});
