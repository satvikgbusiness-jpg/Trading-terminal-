import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAsset } from '@/lib/symbols';
import { FeedError } from '@/lib/market/types';

/**
 * CoinGecko adapter behaviour against a stand-in for the real endpoints.
 *
 * The stub reproduces what the public API was measured to do, not what its docs
 * once said. `/ohlc` picks its own bar granularity from the `days` value and
 * turns coarse above a month: `days=365` and `days=90` both come back four days
 * apart, so neither can become a daily bar, and the widest window that still
 * yields daily bars is 30. `/market_chart` is the other half of the picture --
 * it reaches a full year but publishes one sampled price per period with no
 * high or low, which is why the series it produces declares `hasRange: false`.
 */

const DAY = 86_400;
const HOUR = 3_600;

/** OHLC granularity by window, as measured against the live public endpoint. */
function granularityFor(days: number): number {
  if (days >= 31) return 4 * DAY;
  if (days >= 2) return 4 * HOUR;
  return 30 * 60;
}

const requestedWindows: number[] = [];
const marketChartWindows: number[] = [];
/** Windows the stub should answer with an empty body, to test skipping. */
let emptyWindows = new Set<number>();
/** Set to make `/market_chart` unavailable, as it is for spans over a year. */
let marketChartFails = false;

vi.mock('@/lib/market/http', () => ({
  fetchFromProvider: async (_provider: string, url: string) => {
    const parsed = new URL(url);
    const days = Number(parsed.searchParams.get('days'));
    const end = Math.floor(Date.now() / 1000);

    if (parsed.pathname.endsWith('/market_chart')) {
      marketChartWindows.push(days);
      if (marketChartFails) throw new FeedError('upstream_error', 'market_chart unavailable', 'CoinGecko');
      // One sampled price per day, no high or low -- the real shape.
      const count = days + 1;
      return {
        prices: Array.from({ length: count }, (_, i) => [
          (end - (count - 1 - i) * DAY) * 1000,
          50_000 + i * 10,
        ]),
      };
    }

    requestedWindows.push(days);
    if (emptyWindows.has(days)) return [];

    const spacing = granularityFor(days);
    const count = Math.max(3, Math.floor((days * DAY) / spacing));
    return Array.from({ length: count }, (_, i) => {
      const t = (end - (count - 1 - i) * spacing) * 1000;
      const base = 50_000 + i * 10;
      return [t, base, base + 200, base - 200, base + 50];
    });
  },
  redact: (url: string) => url,
}));

const { CoinGeckoAdapter } = await import('@/lib/market/adapters/coingecko');
const adapter = new CoinGeckoAdapter();
const btc = resolveAsset('BTC-USD');

const request = (lookbackDays: number, resolution: 'D' | '60' = 'D') => {
  const to = Math.floor(Date.now() / 1000);
  return { resolution, from: to - lookbackDays * DAY, to };
};

beforeEach(() => {
  requestedWindows.length = 0;
  marketChartWindows.length = 0;
  emptyWindows = new Set();
  marketChartFails = false;
});

describe('long daily history', () => {
  it('serves a year of daily bars for the 400-day request the ticker page makes', async () => {
    // The regression this guards: `/ohlc` turns coarse above a month, so the
    // step-down landed on `days=30` and a 400-day chart rendered 31 bars --
    // fewer than SMA(50) needs, let alone the Outlook's 220-bar warm-up.
    const series = await adapter.getCandles(btc, request(400));

    expect(marketChartWindows[0]).toBe(365);
    expect(series.bars.length).toBeGreaterThan(300);
    expect(series.resolution).toBe('D');
  });

  it('declares no range, because the feed reports one price per period', async () => {
    const series = await adapter.getCandles(btc, request(400));
    expect(series.hasRange).toBe(false);
    // A series that says it has no range must not carry one, or the chart draws
    // a candle body out of two arbitrary snapshots.
    for (const bar of series.bars) {
      expect(bar.o).toBe(bar.c);
      expect(bar.h).toBe(bar.c);
      expect(bar.l).toBe(bar.c);
    }
  });

  it('returns daily bars that really are one day apart', async () => {
    const series = await adapter.getCandles(btc, request(400));
    const spacings = series.bars.slice(1).map((bar, i) => bar.t - series.bars[i]!.t);
    for (const spacing of spacings) expect(spacing).toBe(DAY);
  });

  it('caps the window at the year the keyless plan allows', async () => {
    await adapter.getCandles(btc, request(900));
    expect(marketChartWindows[0]).toBe(365);
  });

  it('falls back to the real-range feed when the price history is unavailable', async () => {
    marketChartFails = true;
    const series = await adapter.getCandles(btc, request(400));

    // Shorter, but with a genuine high and low -- better than nothing at all.
    expect(requestedWindows.length).toBeGreaterThan(0);
    expect(series.bars.length).toBeGreaterThan(0);
    expect(series.hasRange).toBe(true);
  });
});

describe('getCandles window selection', () => {
  it('uses the real-range feed for a window it can serve at daily granularity', async () => {
    const series = await adapter.getCandles(btc, request(30));

    expect(marketChartWindows).toHaveLength(0);
    expect(requestedWindows[0]).toBe(30);
    expect(series.hasRange).toBe(true);
    expect(series.bars.length).toBeGreaterThan(0);
  });

  it('uses the smallest window when the request is narrower than any of them', async () => {
    const series = await adapter.getCandles(btc, request(1, '60'));
    expect(requestedWindows).toContain(1);
    expect(series.bars.length).toBeGreaterThan(0);
  });

  it('skips a window that returns an empty body', async () => {
    marketChartFails = true;
    emptyWindows = new Set([365, 180, 90]);
    const series = await adapter.getCandles(btc, request(400));
    expect(requestedWindows).toContain(30);
    expect(series.bars.length).toBeGreaterThan(0);
  });

  it('never returns bars outside the requested window', async () => {
    const req = request(30);
    const series = await adapter.getCandles(btc, req);
    for (const bar of series.bars) {
      expect(bar.t).toBeGreaterThanOrEqual(req.from);
      expect(bar.t).toBeLessThanOrEqual(req.to);
    }
  });

  it('reports no volume, because the OHLC endpoint carries none', async () => {
    const series = await adapter.getCandles(btc, request(30));
    expect(series.hasVolume).toBe(false);
    expect(series.hasRange).toBe(true);
    for (const bar of series.bars) expect(bar.v).toBeNull();
  });

  it('degrades an hourly request to the one-day window, which can serve it', async () => {
    // Wide windows return 4-hour bars, too coarse for an hourly request; the
    // 1-day window returns 30-minute bars, which aggregate up cleanly.
    const series = await adapter.getCandles(btc, request(400, '60'));
    expect(requestedWindows[requestedWindows.length - 1]).toBe(1);
    expect(series.resolution).toBe('60');
    const spacings = series.bars.slice(1).map((bar, i) => bar.t - series.bars[i]!.t);
    for (const spacing of spacings) expect(spacing).toBe(HOUR);
  });

  it('fails with a granularity explanation when every window is too coarse', async () => {
    // A minute-resolution request cannot be met by any window CoinGecko offers.
    await expect(adapter.getCandles(btc, request(400, '1' as '60'))).rejects.toThrow(
      /coarser than the requested|could not supply/i,
    );
  });
});
