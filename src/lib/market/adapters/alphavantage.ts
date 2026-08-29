import type { Asset, AssetClass } from '@/lib/symbols';
import { resolveAsset } from '@/lib/symbols';
import { fetchFromProvider } from '../http';
import { env } from '../providers';
import { INDEX_ETF_PROXIES } from './finnhub';
import {
  FeedError,
  type AdapterCapabilities,
  type Candle,
  type CandleRequest,
  type CandleSeries,
  type MarketDataAdapter,
  type Quote,
  type Resolution,
} from '../types';

const BASE = 'https://www.alphavantage.co/query';

type AVSeries = Record<string, Record<string, string>>;

interface AVResponse {
  'Global Quote'?: Record<string, string>;
  'Time Series (Daily)'?: AVSeries;
  'Weekly Time Series'?: AVSeries;
  'Time Series (1min)'?: AVSeries;
  'Time Series (5min)'?: AVSeries;
  'Time Series (15min)'?: AVSeries;
  'Time Series (60min)'?: AVSeries;
  bestMatches?: Array<Record<string, string>>;
  Note?: string;
  Information?: string;
  'Error Message'?: string;
}

const INTRADAY_KEY: Partial<Record<Resolution, string>> = {
  '1': 'Time Series (1min)',
  '5': 'Time Series (5min)',
  '15': 'Time Series (15min)',
  '60': 'Time Series (60min)',
};

const AV_INTERVAL: Partial<Record<Resolution, string>> = {
  '1': '1min', '5': '5min', '15': '15min', '60': '60min',
};

/**
 * Prose that means "slow down", which clears on its own.
 *
 * Checked before the entitlement test because Alpha Vantage appends the same
 * "you may subscribe to any of the premium plans" sentence to both messages, so
 * matching on the word "premium" alone reads a throttle as a permanent refusal.
 */
function isThrottled(info: string): boolean {
  return /higher API call volume|rate limit|call frequency|spreading out your free API requests|more sparingly|per day|per minute/i.test(
    info,
  );
}

/**
 * Prose that means "your plan does not include this", which never clears.
 * Matched on the specific claim about a feature, not the marketing sentence.
 */
function isPremiumOnly(info: string): boolean {
  return /is a premium (feature|endpoint|parameter)|premium (feature|endpoint) for/i.test(info);
}

/**
 * Alpha Vantage — the equity candle source.
 *
 * The free plan is 25 requests/day, so the registry treats it as a
 * candles-and-fallback-quotes provider only, and the disk cache holds daily
 * bars for a long TTL.
 */
export class AlphaVantageAdapter implements MarketDataAdapter {
  readonly id = 'alphavantage';
  readonly label = 'Alpha Vantage';
  readonly delayMinutes = 15;
  readonly classes: readonly AssetClass[] = ['equity', 'index', 'forex'];
  readonly capabilities: AdapterCapabilities = {
    quote: true,
    candles: true,
    search: true,
    constituents: false,
    news: false,
  };

  /**
   * Set once the plan rejects `outputsize=full`, so the rest of the process asks
   * for `compact` directly instead of burning a call per symbol rediscovering
   * it -- which matters on a plan that allows 25 a day. Free plans changed under
   * this adapter; paid ones never set it.
   */
  private fullOutputIsPremium = false;

  isConfigured(): boolean {
    return env.alphaVantageKey() !== null;
  }

  supports(asset: Asset): boolean {
    if (!this.classes.includes(asset.assetClass)) return false;
    if (asset.assetClass === 'index') return asset.symbol in INDEX_ETF_PROXIES;
    return true;
  }

  provenanceNote(asset: Asset): string | undefined {
    const proxy = INDEX_ETF_PROXIES[asset.symbol];
    return proxy ? `via ${proxy.etf} ETF proxy (${proxy.label}) — not the index itself` : undefined;
  }

  private key(): string {
    const key = env.alphaVantageKey();
    if (!key) throw new FeedError('no_api_key', 'ALPHAVANTAGE_API_KEY is not set', this.label);
    return key;
  }

  private wireSymbol(asset: Asset): string {
    return INDEX_ETF_PROXIES[asset.symbol]?.etf ?? asset.symbol;
  }

  /**
   * Alpha Vantage signals throttling, bad keys and plan limits with a 200 plus a
   * prose field. Turn those into errors before any parsing happens.
   *
   * Throttling and entitlement have to be told apart. Both arrive as prose, but
   * "you have hit today's 25 calls" clears by itself and "this parameter is a
   * premium feature" never will. Both used to come back as `rate_limited` with a
   * 60-second retry, so the caller kept re-asking for something the plan is
   * never going to serve, and the UI told the user to wait for a limit that was
   * not the problem.
   */
  private assertPayload(raw: AVResponse): void {
    if (raw['Error Message']) {
      throw new FeedError('not_found', raw['Error Message'], this.label);
    }
    if (raw.Note) {
      throw new FeedError('rate_limited', raw.Note, this.label, 60_000);
    }
    if (raw.Information) {
      const info = raw.Information;
      if (isThrottled(info)) {
        throw new FeedError('rate_limited', info, this.label, 60_000);
      }
      if (isPremiumOnly(info)) {
        throw new FeedError('unsupported', info, this.label);
      }
      throw new FeedError('upstream_error', info, this.label);
    }
  }

  async getQuote(asset: Asset): Promise<Quote> {
    if (asset.assetClass === 'forex') return this.getForexQuote(asset);
    const wire = this.wireSymbol(asset);
    const url = `${BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(wire)}&apikey=${this.key()}`;
    const raw = await fetchFromProvider<AVResponse>(this.id, url, { dedupeKey: `av:quote:${wire}` });
    this.assertPayload(raw);

    const q = raw['Global Quote'];
    const price = pick(q, '05. price');
    if (!q || price === null) {
      throw new FeedError('not_found', `Alpha Vantage has no quote for ${wire}`, this.label);
    }
    const prev = pick(q, '08. previous close');
    return {
      symbol: asset.symbol,
      price,
      previousClose: prev,
      change: pick(q, '09. change'),
      changePercent: pickPercent(q, '10. change percent'),
      dayOpen: pick(q, '02. open'),
      dayHigh: pick(q, '03. high'),
      dayLow: pick(q, '04. low'),
      timestamp: Date.parse(q['07. latest trading day'] ?? '') || Date.now(),
    };
  }

  private async getForexQuote(asset: Asset): Promise<Quote> {
    const [from, to] = asset.symbol.split('/');
    const url = `${BASE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${from}&to_currency=${to}&apikey=${this.key()}`;
    const raw = await fetchFromProvider<Record<string, Record<string, string>>>(this.id, url, {
      dedupeKey: `av:fx:${asset.symbol}`,
    });
    this.assertPayload(raw as AVResponse);
    const q = raw['Realtime Currency Exchange Rate'];
    const price = pick(q, '5. Exchange Rate');
    if (price === null) {
      throw new FeedError('not_found', `Alpha Vantage has no FX rate for ${asset.symbol}`, this.label);
    }
    return {
      symbol: asset.symbol,
      price,
      previousClose: null,
      change: null,
      changePercent: null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      timestamp: Date.parse(`${q?.['6. Last Refreshed'] ?? ''}Z`) || Date.now(),
    };
  }

  async getCandles(asset: Asset, req: CandleRequest): Promise<CandleSeries> {
    if (asset.assetClass === 'forex') return this.getForexCandles(asset, req);
    const wire = this.wireSymbol(asset);

    let { url, seriesKey, outputsize } = this.candleUrl(wire, req);
    let raw: AVResponse;
    try {
      raw = await fetchFromProvider<AVResponse>(this.id, url, {
        dedupeKey: `av:candles:${wire}:${req.resolution}:${outputsize ?? 'default'}`,
      });
      this.assertPayload(raw);
    } catch (err) {
      // `outputsize=full` moved behind a paid plan for TIME_SERIES_DAILY. The
      // free plan still serves the last 100 bars, so ask for those rather than
      // returning nothing at all -- a 100-bar chart is short, and the Outlook
      // says which of its components that starves, but it beats a blank screen.
      // The rejection is remembered so the wasted call happens once per process.
      if (!(err instanceof FeedError) || err.code !== 'unsupported' || outputsize !== 'full') throw err;
      this.fullOutputIsPremium = true;
      ({ url, seriesKey, outputsize } = this.candleUrl(wire, req));
      raw = await fetchFromProvider<AVResponse>(this.id, url, {
        dedupeKey: `av:candles:${wire}:${req.resolution}:${outputsize ?? 'default'}`,
      });
      this.assertPayload(raw);
    }

    const series = (raw as unknown as Record<string, AVSeries | undefined>)[seriesKey];
    if (!series || Object.keys(series).length === 0) {
      throw new FeedError('not_found', `Alpha Vantage returned no ${req.resolution} bars for ${wire}`, this.label);
    }

    const bars = parseSeries(series, req);
    if (bars.length === 0) {
      throw new FeedError('not_found', `No ${req.resolution} bars for ${wire} in the requested window`, this.label);
    }
    return { bars, resolution: req.resolution, hasRange: true, hasVolume: true };
  }

  private candleUrl(
    wire: string,
    req: CandleRequest,
  ): { url: string; seriesKey: string; outputsize: 'full' | 'compact' | null } {
    const key = this.key();
    if (req.resolution === 'D') {
      const wantsHistory = req.to - req.from > 100 * 86_400;
      const span = wantsHistory && !this.fullOutputIsPremium ? 'full' : 'compact';
      return {
        url: `${BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(wire)}&outputsize=${span}&apikey=${key}`,
        seriesKey: 'Time Series (Daily)',
        outputsize: span,
      };
    }
    if (req.resolution === 'W') {
      // TIME_SERIES_WEEKLY takes no outputsize and returns its whole history --
      // 20+ years -- on the free plan.
      return {
        url: `${BASE}?function=TIME_SERIES_WEEKLY&symbol=${encodeURIComponent(wire)}&apikey=${key}`,
        seriesKey: 'Weekly Time Series',
        outputsize: null,
      };
    }
    const interval = AV_INTERVAL[req.resolution];
    const seriesKey = INTRADAY_KEY[req.resolution];
    if (!interval || !seriesKey) {
      throw new FeedError('unsupported', `Resolution ${req.resolution} is not supported`, this.label);
    }
    const span = this.fullOutputIsPremium ? 'compact' : 'full';
    return {
      url: `${BASE}?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(wire)}&interval=${interval}&outputsize=${span}&apikey=${key}`,
      seriesKey,
      outputsize: span,
    };
  }

  private async getForexCandles(asset: Asset, req: CandleRequest): Promise<CandleSeries> {
    const [from, to] = asset.symbol.split('/');
    if (req.resolution !== 'D' && req.resolution !== 'W') {
      throw new FeedError('unsupported', `Alpha Vantage FX supports daily/weekly only`, this.label);
    }
    const fn = req.resolution === 'D' ? 'FX_DAILY' : 'FX_WEEKLY';
    const seriesKey = req.resolution === 'D' ? 'Time Series FX (Daily)' : 'Time Series FX (Weekly)';
    const url = `${BASE}?function=${fn}&from_symbol=${from}&to_symbol=${to}&outputsize=full&apikey=${this.key()}`;
    const raw = await fetchFromProvider<Record<string, AVSeries | string>>(this.id, url, {
      dedupeKey: `av:fxcandles:${asset.symbol}:${req.resolution}`,
    });
    this.assertPayload(raw as AVResponse);

    const series = raw[seriesKey];
    if (!series || typeof series === 'string') {
      throw new FeedError('not_found', `No FX bars for ${asset.symbol}`, this.label);
    }
    const bars = parseSeries(series, req);
    // FX_DAILY carries a real OHLC range but no volume.
    return { bars, resolution: req.resolution, hasRange: true, hasVolume: false };
  }

  async searchSymbols(query: string): Promise<Asset[]> {
    const url = `${BASE}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${this.key()}`;
    const raw = await fetchFromProvider<AVResponse>(this.id, url, {
      dedupeKey: `av:search:${query.toLowerCase()}`,
    });
    this.assertPayload(raw);
    const out: Asset[] = [];
    for (const m of raw.bestMatches ?? []) {
      const symbol = m['1. symbol'];
      if (!symbol || symbol.includes('.')) continue;
      try {
        const asset = resolveAsset(symbol);
        out.push({ ...asset, name: m['2. name'] || asset.name });
      } catch {
        /* not a shape we model */
      }
    }
    return out.slice(0, 25);
  }
}

function pick(row: Record<string, string> | undefined, key: string): number | null {
  const v = row?.[key];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickPercent(row: Record<string, string> | undefined, key: string): number | null {
  const v = row?.[key];
  if (v === undefined) return null;
  const n = Number(v.replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

/** Alpha Vantage keys bars by date string, newest first. */
function parseSeries(series: AVSeries, req: CandleRequest): Candle[] {
  const bars: Candle[] = [];
  for (const [stamp, row] of Object.entries(series)) {
    // Daily keys are "YYYY-MM-DD" (no zone); intraday are "YYYY-MM-DD HH:mm:ss"
    // in US/Eastern. Parse both as UTC — consistent ordering is what matters for
    // indicators, and the chart labels bars from these same timestamps.
    const ms = Date.parse(stamp.includes(' ') ? `${stamp.replace(' ', 'T')}Z` : `${stamp}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    const t = Math.floor(ms / 1000);
    if (t < req.from || t > req.to) continue;

    const o = Number(row['1. open']);
    const h = Number(row['2. high']);
    const l = Number(row['3. low']);
    const c = Number(row['4. close']);
    const vRaw = row['5. volume'] ?? row['6. volume'];
    if (![o, h, l, c].every(Number.isFinite)) continue;

    const v = vRaw === undefined ? null : Number(vRaw);
    bars.push({ t, o, h, l, c, v: v !== null && Number.isFinite(v) ? v : null });
  }
  return bars.sort((a, b) => a.t - b.t);
}
