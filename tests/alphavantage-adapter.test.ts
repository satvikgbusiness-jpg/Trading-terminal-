import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAsset } from '@/lib/symbols';
import { FeedError } from '@/lib/market/types';

/**
 * Alpha Vantage answers a plan limit, a throttle and a bad symbol with HTTP 200
 * and a sentence of prose. Telling those apart is the whole job of this file.
 *
 * Both the throttle and the entitlement message end with the same "you may
 * subscribe to any of the premium plans" sentence, so matching on the word
 * "premium" classified a throttle as a permanent refusal. The two need opposite
 * handling: a throttle clears in a minute and should be retried, an entitlement
 * refusal never clears and the caller has to ask for something else.
 */

const THROTTLE =
  'Thank you for using Alpha Vantage! Please consider spreading out your free API requests ' +
  'more sparingly (1 request per second). You may subscribe to any of the premium plans at ' +
  'https://www.alphavantage.co/premium/ to instantly unlock all premium features';

const DAILY_CAP =
  'We have detected your API key as X and our standard API rate limit is 25 requests per day. ' +
  'Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/';

const OUTPUTSIZE_PREMIUM =
  'Thank you for using Alpha Vantage! The outputsize=full parameter value is a premium feature ' +
  'for the TIME_SERIES_DAILY endpoint. You may subscribe to any of the premium plans at ' +
  'https://www.alphavantage.co/premium/ to instantly unlock all premium features';

const requested: string[] = [];
/** Prose to answer with, keyed by the outputsize on the request. */
let informationFor: (url: URL) => string | null = () => null;

function dailySeries(count: number): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (let i = 0; i < count; i += 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out[day] = {
      '1. open': '100.0', '2. high': '102.0', '3. low': '99.0', '4. close': '101.0', '5. volume': '1000',
    };
  }
  return out;
}

vi.mock('@/lib/market/http', () => ({
  fetchFromProvider: async (_provider: string, url: string) => {
    const parsed = new URL(url);
    requested.push(parsed.searchParams.get('outputsize') ?? 'none');
    const information = informationFor(parsed);
    if (information) return { Information: information };
    return { 'Time Series (Daily)': dailySeries(100) };
  },
  redact: (url: string) => url,
}));

const { AlphaVantageAdapter } = await import('@/lib/market/adapters/alphavantage');
const aapl = resolveAsset('AAPL');

const request = (lookbackDays: number) => {
  const to = Math.floor(Date.now() / 1000);
  return { resolution: 'D' as const, from: to - lookbackDays * 86_400, to };
};

beforeEach(() => {
  requested.length = 0;
  informationFor = () => null;
  process.env.ALPHAVANTAGE_API_KEY = 'test-key';
});

describe('prose classification', () => {
  it('reads a burst throttle as rate limiting, with a retry hint', async () => {
    informationFor = () => THROTTLE;
    const adapter = new AlphaVantageAdapter();
    const error = await adapter.getQuote(aapl).catch((e) => e);

    expect(error).toBeInstanceOf(FeedError);
    expect((error as FeedError).code).toBe('rate_limited');
    expect((error as FeedError).retryAfterMs).toBeGreaterThan(0);
  });

  it('reads the daily cap as rate limiting too', async () => {
    informationFor = () => DAILY_CAP;
    const adapter = new AlphaVantageAdapter();
    const error = await adapter.getQuote(aapl).catch((e) => e);
    expect((error as FeedError).code).toBe('rate_limited');
  });

  it('reads a plan restriction as unsupported, with no retry hint', async () => {
    informationFor = () => OUTPUTSIZE_PREMIUM;
    const adapter = new AlphaVantageAdapter();
    const error = await adapter.getQuote(aapl).catch((e) => e);

    expect((error as FeedError).code).toBe('unsupported');
    // Nothing to wait for: retrying this in a minute produces the same answer.
    expect((error as FeedError).retryAfterMs).toBeUndefined();
  });
});

describe('daily candles on a plan without outputsize=full', () => {
  it('retries as compact rather than returning nothing', async () => {
    informationFor = (url) => (url.searchParams.get('outputsize') === 'full' ? OUTPUTSIZE_PREMIUM : null);
    const adapter = new AlphaVantageAdapter();

    const series = await adapter.getCandles(aapl, request(400));

    expect(requested).toEqual(['full', 'compact']);
    expect(series.bars.length).toBe(100);
    expect(series.hasRange).toBe(true);
  });

  it('does not keep re-asking for full once the plan has refused it', async () => {
    informationFor = (url) => (url.searchParams.get('outputsize') === 'full' ? OUTPUTSIZE_PREMIUM : null);
    const adapter = new AlphaVantageAdapter();

    await adapter.getCandles(aapl, request(400));
    requested.length = 0;
    await adapter.getCandles(aapl, request(400));

    // The wasted call happens once, not once per symbol, which matters on a
    // plan that allows 25 requests a day.
    expect(requested).toEqual(['compact']);
  });

  it('does not swallow a throttle as if it were a plan limit', async () => {
    informationFor = () => THROTTLE;
    const adapter = new AlphaVantageAdapter();
    const error = await adapter.getCandles(aapl, request(400)).catch((e) => e);

    // One attempt, surfaced as retryable -- not a second call spending budget on
    // a request that was never going to be answered differently.
    expect(requested).toEqual(['full']);
    expect((error as FeedError).code).toBe('rate_limited');
  });
});
