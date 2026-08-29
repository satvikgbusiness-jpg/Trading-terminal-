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
  // CoinGecko publishes ~30 calls/minute for keyless use but enforces a burst
  // limit well under that: five calls inside six seconds drew a 429 in testing.
  // Spaced out and capped low enough that a page load and the worker together
  // still stay inside it.
  coingecko: { requests: 10, windowMs: 60_000, minIntervalMs: 2_500, concurrency: 1 },
  // exchangerate.host free plan.
  exchangerate: { requests: 20, windowMs: 60_000, minIntervalMs: 500, concurrency: 2 },
  // Frankfurter (ECB reference rates) is keyless; still be polite.
  frankfurter: { requests: 30, windowMs: 60_000, minIntervalMs: 300, concurrency: 2 },
  // RSS endpoints are third-party servers we do not want to hammer.
  rss: { requests: 20, windowMs: 60_000, minIntervalMs: 1_000, concurrency: 3 },
};

let applied = false;
/**
 * Idempotently push the limit table into the process-wide scheduler.
 *
 * Called at the bottom of this module as well as from the registry. Configuring
 * it lazily from `adaptersFor()` alone was not enough: several call sites reach
 * an adapter directly -- the earnings calendar, the crypto market grid -- and
 * never go through the registry, so in a process where one of those ran first
 * the scheduler fell back to its unconfigured default of 30 requests a minute.
 * For Alpha Vantage, whose free plan allows five, that is six times the
 * allowance and the provider answers by throttling.
 */
export function configureProviders(): void {
  if (applied) return;
  for (const [provider, limit] of Object.entries(PROVIDER_LIMITS)) {
    scheduler.configure(provider, limit);
  }
  applied = true;
}

// Every adapter imports `env` from this module, so configuring here means the
// limits are in place before any adapter can issue its first request.
configureProviders();

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
