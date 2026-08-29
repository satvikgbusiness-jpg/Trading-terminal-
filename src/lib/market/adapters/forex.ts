import type { Asset, AssetClass } from '@/lib/symbols';
import { FOREX_MAJORS } from '@/lib/symbols';
import { fetchFromProvider } from '../http';
import { env } from '../providers';
import {
  FeedError,
  type AdapterCapabilities,
  type Candle,
  type CandleRequest,
  type CandleSeries,
  type MarketDataAdapter,
  type Quote,
} from '../types';

const EXCHANGERATE_BASE = 'https://api.exchangerate.host';
const FRANKFURTER_BASE = 'https://api.frankfurter.app';

interface LiveResponse {
  success?: boolean;
  source?: string;
  quotes?: Record<string, number>;
  timestamp?: number;
  error?: { code?: number; type?: string; info?: string };
}

interface TimeframeResponse {
  success?: boolean;
  source?: string;
  quotes?: Record<string, Record<string, number>>;
  error?: { code?: number; type?: string; info?: string };
}

interface FrankfurterLatest {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

interface FrankfurterSeries {
  base?: string;
  rates?: Record<string, Record<string, number>>;
}

function splitPair(asset: Asset): [string, string] {
  const [base, quote] = asset.symbol.split('/');
  if (!base || !quote) {
    throw new FeedError('unsupported', `${asset.symbol} is not a currency pair`, 'FX');
  }
  return [base, quote];
}

/**
 * A reference rate is one published number per day, not a traded range. We
 * build candles with o=h=l=c so the series stays usable by close-based
 * indicators, and set `hasRange: false` so the chart draws a line and
 * range-based indicators (ATR) are skipped rather than fed a zero-width bar.
 */
function referenceCandle(tSeconds: number, rate: number): Candle {
  return { t: tSeconds, o: rate, h: rate, l: rate, c: rate, v: null };
}

/** exchangerate.host — the configured-key FX source. */
export class ExchangeRateHostAdapter implements MarketDataAdapter {
  readonly id = 'exchangerate';
  readonly label = 'exchangerate.host';
  readonly delayMinutes = 60;
  readonly classes: readonly AssetClass[] = ['forex'];
  readonly capabilities: AdapterCapabilities = {
    quote: true, candles: true, search: true, constituents: false, news: false,
  };

  isConfigured(): boolean {
    return env.exchangerateKey() !== null;
  }

  supports(asset: Asset): boolean {
    return asset.assetClass === 'forex';
  }

  provenanceNote(): string {
    return 'daily reference rate — no intraday range or volume';
  }

  private key(): string {
    const key = env.exchangerateKey();
    if (!key) throw new FeedError('no_api_key', 'EXCHANGERATE_API_KEY is not set', this.label);
    return key;
  }

  private assertOk(raw: { success?: boolean; error?: { info?: string; code?: number } }): void {
    if (raw.success === false) {
      const info = raw.error?.info ?? 'exchangerate.host reported an error';
      const throttled = raw.error?.code === 106 || /limit/i.test(info);
      throw new FeedError(throttled ? 'rate_limited' : 'upstream_error', info, this.label);
    }
  }

  async getQuote(asset: Asset): Promise<Quote> {
    const [base, quote] = splitPair(asset);
    const url = `${EXCHANGERATE_BASE}/live?access_key=${this.key()}&source=${base}&currencies=${quote}`;
    const raw = await fetchFromProvider<LiveResponse>(this.id, url, {
      dedupeKey: `erh:live:${asset.symbol}`,
    });
    this.assertOk(raw);

    const rate = raw.quotes?.[`${base}${quote}`];
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      throw new FeedError('not_found', `No rate for ${asset.symbol}`, this.label);
    }
    return {
      symbol: asset.symbol,
      price: rate,
      previousClose: null,
      change: null,
      changePercent: null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      timestamp: raw.timestamp ? raw.timestamp * 1000 : Date.now(),
    };
  }

  async getCandles(asset: Asset, req: CandleRequest): Promise<CandleSeries> {
    if (req.resolution !== 'D') {
      throw new FeedError('unsupported', 'exchangerate.host serves daily reference rates only', this.label);
    }
    const [base, quote] = splitPair(asset);
    // The free timeframe endpoint caps each call at 365 days.
    const from = Math.max(req.from, req.to - 365 * 86_400);
    const url =
      `${EXCHANGERATE_BASE}/timeframe?access_key=${this.key()}` +
      `&start_date=${iso(from)}&end_date=${iso(req.to)}&source=${base}&currencies=${quote}`;
    const raw = await fetchFromProvider<TimeframeResponse>(this.id, url, {
      dedupeKey: `erh:tf:${asset.symbol}:${iso(from)}:${iso(req.to)}`,
    });
    this.assertOk(raw);

    const bars: Candle[] = [];
    for (const [date, row] of Object.entries(raw.quotes ?? {})) {
      const rate = row?.[`${base}${quote}`];
      const ms = Date.parse(`${date}T00:00:00Z`);
      if (typeof rate === 'number' && Number.isFinite(rate) && Number.isFinite(ms)) {
        bars.push(referenceCandle(Math.floor(ms / 1000), rate));
      }
    }
    if (bars.length === 0) {
      throw new FeedError('not_found', `No FX history for ${asset.symbol}`, this.label);
    }
    bars.sort((a, b) => a.t - b.t);
    return { bars, resolution: 'D', hasRange: false, hasVolume: false };
  }

  async searchSymbols(query: string): Promise<Asset[]> {
    return searchMajors(query);
  }
}

/**
 * Frankfurter — ECB daily reference rates, no key required.
 *
 * This is the fallback that keeps the FX column alive on a clean checkout. It is
 * an official-fixing feed: one rate per business day, published ~16:00 CET.
 */
export class FrankfurterAdapter implements MarketDataAdapter {
  readonly id = 'frankfurter';
  readonly label = 'Frankfurter (ECB)';
  /** Rates are a daily fixing, so "delay" is bounded by the publication cycle. */
  readonly delayMinutes = 24 * 60;
  readonly classes: readonly AssetClass[] = ['forex'];
  readonly capabilities: AdapterCapabilities = {
    quote: true, candles: true, search: true, constituents: false, news: false,
  };

  isConfigured(): boolean {
    return true;
  }

  supports(asset: Asset): boolean {
    return asset.assetClass === 'forex';
  }

  provenanceNote(): string {
    return 'ECB daily reference fixing — not a tradable intraday quote';
  }

  async getQuote(asset: Asset): Promise<Quote> {
    const [base, quote] = splitPair(asset);
    const url = `${FRANKFURTER_BASE}/latest?from=${base}&to=${quote}`;
    const raw = await fetchFromProvider<FrankfurterLatest>(this.id, url, {
      dedupeKey: `frank:latest:${asset.symbol}`,
    });
    const rate = raw.rates?.[quote];
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      throw new FeedError('not_found', `No ECB fixing for ${asset.symbol}`, this.label);
    }
    const asOf = raw.date ? Date.parse(`${raw.date}T00:00:00Z`) : Date.now();
    return {
      symbol: asset.symbol,
      price: rate,
      previousClose: null,
      change: null,
      changePercent: null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      timestamp: Number.isFinite(asOf) ? asOf : Date.now(),
    };
  }

  async getCandles(asset: Asset, req: CandleRequest): Promise<CandleSeries> {
    if (req.resolution !== 'D' && req.resolution !== 'W') {
      throw new FeedError('unsupported', 'ECB publishes one fixing per business day', this.label);
    }
    const [base, quote] = splitPair(asset);
    const url = `${FRANKFURTER_BASE}/${iso(req.from)}..${iso(req.to)}?from=${base}&to=${quote}`;
    const raw = await fetchFromProvider<FrankfurterSeries>(this.id, url, {
      dedupeKey: `frank:series:${asset.symbol}:${iso(req.from)}:${iso(req.to)}`,
    });

    const bars: Candle[] = [];
    for (const [date, row] of Object.entries(raw.rates ?? {})) {
      const rate = row?.[quote];
      const ms = Date.parse(`${date}T00:00:00Z`);
      if (typeof rate === 'number' && Number.isFinite(rate) && Number.isFinite(ms)) {
        bars.push(referenceCandle(Math.floor(ms / 1000), rate));
      }
    }
    if (bars.length === 0) {
      throw new FeedError('not_found', `No ECB history for ${asset.symbol}`, this.label);
    }
    bars.sort((a, b) => a.t - b.t);
    return { bars, resolution: 'D', hasRange: false, hasVolume: false };
  }

  async searchSymbols(query: string): Promise<Asset[]> {
    return searchMajors(query);
  }
}

function searchMajors(query: string): Asset[] {
  const q = query.trim().toUpperCase().replace(/[^A-Z/]/g, '');
  if (!q) return [];
  return FOREX_MAJORS.filter(
    (m) => m.symbol.includes(q) || m.symbol.replace('/', '').includes(q) || m.name.toUpperCase().includes(q),
  ).map((m) => {
    const [, quote] = m.symbol.split('/');
    return {
      symbol: m.symbol,
      assetClass: 'forex' as const,
      name: m.name,
      currency: quote!,
      continuous: false,
    };
  });
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
