import type { Asset } from '@/lib/symbols';
import { AlphaVantageAdapter } from './adapters/alphavantage';
import { CoinGeckoAdapter } from './adapters/coingecko';
import { ExchangeRateHostAdapter, FrankfurterAdapter } from './adapters/forex';
import { FinnhubAdapter } from './adapters/finnhub';
import { configureProviders } from './providers';
import type { AdapterCapabilities, MarketDataAdapter } from './types';

export const finnhub = new FinnhubAdapter();
export const alphaVantage = new AlphaVantageAdapter();
export const coingecko = new CoinGeckoAdapter();
export const exchangerate = new ExchangeRateHostAdapter();
export const frankfurter = new FrankfurterAdapter();

/**
 * Preference order per capability.
 *
 * Ordering encodes which free tier actually serves what: Finnhub for equity
 * quotes and news, Alpha Vantage for equity candles (Finnhub moved those behind
 * a paid plan), CoinGecko for crypto, and exchangerate.host with a keyless
 * Frankfurter fallback so FX still works on a clean checkout.
 */
const PREFERENCE: Record<keyof AdapterCapabilities, MarketDataAdapter[]> = {
  quote: [finnhub, coingecko, exchangerate, frankfurter, alphaVantage],
  candles: [alphaVantage, coingecko, exchangerate, frankfurter],
  search: [finnhub, coingecko, frankfurter, alphaVantage],
  constituents: [finnhub],
  news: [finnhub],
};

export type Capability = keyof AdapterCapabilities;

/** Every adapter that is configured, supports the asset, and has the capability. */
export function adaptersFor(asset: Asset, capability: Capability): MarketDataAdapter[] {
  configureProviders();
  return PREFERENCE[capability].filter(
    (a) => a.capabilities[capability] && a.supports(asset) && a.isConfigured(),
  );
}

/** Adapters that *would* serve this asset if configured — used for setup hints. */
export function candidateAdapters(asset: Asset, capability: Capability): MarketDataAdapter[] {
  return PREFERENCE[capability].filter((a) => a.capabilities[capability] && a.supports(asset));
}

export function allAdapters(): MarketDataAdapter[] {
  return [finnhub, alphaVantage, coingecko, exchangerate, frankfurter];
}

/** Setup status for the UI's data-source panel. */
export function adapterStatus(): Array<{
  id: string;
  label: string;
  configured: boolean;
  classes: string[];
  capabilities: string[];
  requiresKey: boolean;
}> {
  return allAdapters().map((a) => ({
    id: a.id,
    label: a.label,
    configured: a.isConfigured(),
    classes: [...a.classes],
    capabilities: Object.entries(a.capabilities)
      .filter(([, on]) => on)
      .map(([name]) => name),
    requiresKey: a.id === 'finnhub' || a.id === 'alphavantage' || a.id === 'exchangerate',
  }));
}
