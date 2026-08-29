import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAsset } from '@/lib/symbols';

/**
 * CoinGecko adapter behaviour against a stand-in for the real endpoint.
 *
 * The stub reproduces the behaviour that broke the adapter: `/ohlc` picks its own
 * bar granularity from the `days` value, returning coarse 4-day bars for wide
 * windows and 4-hour bars for narrow ones. The adapter must walk down to a window
 * it can actually use rather than either failing outright or passing coarse bars
 * off as daily ones.
 */

const DAY = 86_400;
const HOUR = 3_600;

/** Granularity by window, matching what the public endpoint does. */
function granularityFor(days: number): number {
  if (days >= 91) return 4 * DAY;
  if (days >= 2) return 4 * HOUR;
  return 30 * 60;
}

const requestedWindows: number[] = [];
/** Windows the stub should answer with an empty body, to test skipping. */
let emptyWindows = new Set<number>();

vi.mock('@/lib/market/http', () => ({
  fetchFromProvider: async (_provider: string, url: string) => {
    const days = Number(new URL(url).searchParams.get('days'));
    requestedWindows.push(days);
    if (emptyWindows.has(days)) return [];

    const spacing = granularityFor(days);
    const count = Math.max(3, Math.floor((days * DAY) / spacing));
    const end = Math.floor(Date.now() / 1000);
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
  emptyWindows = new Set();
});

describe('getCandles window selection', () => {
  it('walks down from a coarse window to one it can actually use', async () => {
    // The ticker page asks for 400 days. 365 and 180 come back as 4-day bars,
    // which cannot become daily bars; 90 and below are 4-hourly and can.
    const series = await adapter.getCandles(btc, request(400));

    expect(requestedWindows[0]).toBe(365);
    expect(requestedWindows).toContain(180);
    expect(requestedWindows).toContain(90);
    expect(series.bars.length).toBeGreaterThan(0);
    expect(series.resolution).toBe('D');
  });

  it('returns daily bars that really are one day apart', async () => {
    const series = await adapter.getCandles(btc, request(400));
    const spacings = series.bars.slice(1).map((bar, i) => bar.t - series.bars[i]!.t);
    for (const spacing of spacings) expect(spacing).toBe(DAY);
  });

  it('serves partial coverage rather than failing on a long request', async () => {
    // This is the regression: a 400-day request used to throw, which left crypto
    // charts and the Outlook permanently unavailable on the keyless tier.
    const series = await adapter.getCandles(btc, request(400));
    expect(series.bars.length).toBeGreaterThanOrEqual(20);
  });

  it('prefers the widest usable window over a narrower one', async () => {
    await adapter.getCandles(btc, request(400));
    const wideRequestWindows = [...requestedWindows];
    requestedWindows.length = 0;

    const ninetyDay = await adapter.getCandles(btc, request(90));

    // Both settle on the 90-day window: it is the widest whose bars are fine
    // enough to become daily. Coverage matches to within the boundary bar that
    // the wider request's earlier `from` lets through.
    expect(wideRequestWindows).toContain(90);
    expect(requestedWindows[0]).toBe(90);
    expect(ninetyDay.bars.length).toBeGreaterThan(80);
  });

  it('uses the smallest window when the request is narrower than any of them', async () => {
    const series = await adapter.getCandles(btc, request(1, '60'));
    expect(requestedWindows).toContain(1);
    expect(series.bars.length).toBeGreaterThan(0);
  });

  it('skips a window that returns an empty body', async () => {
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
    const series = await adapter.getCandles(btc, request(90));
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
