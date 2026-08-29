import type { RateLimit } from './scheduler';
import { scheduler } from './scheduler';

/**
 * Free-tier limits, deliberately set a little below each provider's published
 * ceiling so a burst from the worker and the UI at the same instant still lands
 * inside the allowance.
 */
export const PROVIDER_LIMITS: Record<string, RateLimit> = {
  // Finnhub free tier: 60 calls/minute.
  finnhub: { requests: 55, windowMs: 60_000, minIntervalMs: 60, concurrency: 4 },
  // Alpha Vantage free tier: 5 calls/minute, 25/day. Serialised on purpose.
  alphavantage: { requests: 5, windowMs: 60_000, minIntervalMs: 12_000, concurrency: 1 },
  // CoinGecko public API: ~30 calls/minute for demo/keyless use.
  coingecko: { requests: 20, windowMs: 60_000, minIntervalMs: 1_200, concurrency: 2 },
  // exchangerate.host free plan.
  exchangerate: { requests: 20, windowMs: 60_000, minIntervalMs: 500, concurrency: 2 },
  // Frankfurter (ECB reference rates) is keyless; still be polite.
  frankfurter: { requests: 30, windowMs: 60_000, minIntervalMs: 300, concurrency: 2 },
  // RSS endpoints are third-party servers we do not want to hammer.
  rss: { requests: 20, windowMs: 60_000, minIntervalMs: 1_000, concurrency: 3 },
};

let applied = false;
/** Idempotently push the limit table into the process-wide scheduler. */
export function configureProviders(): void {
  if (applied) return;
  for (const [provider, limit] of Object.entries(PROVIDER_LIMITS)) {
    scheduler.configure(provider, limit);
  }
  applied = true;
}

export const env = {
  finnhubKey: () => process.env.FINNHUB_API_KEY?.trim() || null,
  alphaVantageKey: () => process.env.ALPHAVANTAGE_API_KEY?.trim() || null,
  coingeckoKey: () => process.env.COINGECKO_API_KEY?.trim() || null,
  exchangerateKey: () => process.env.EXCHANGERATE_API_KEY?.trim() || null,
  /** Comma-separated RSS feed URLs. */
  rssFeeds: (): string[] =>
    (process.env.NEWS_RSS_FEEDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
};
