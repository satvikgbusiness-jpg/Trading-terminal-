import type { Asset, AssetClass } from '@/lib/symbols';
import { CRYPTO_BASES } from '@/lib/symbols';
import { fetchFromProvider } from '../http';
import { env } from '../providers';
import { canResample, resample } from '../resample';
import {
  FeedError,
  type AdapterCapabilities,
  type Candle,
  type CandleRequest,
  type CandleSeries,
  type Constituent,
  type MarketDataAdapter,
  type Quote,
  type Resolution,
} from '../types';

const PUBLIC_BASE = 'https://api.coingecko.com/api/v3';
const PRO_BASE = 'https://pro-api.coingecko.com/api/v3';

interface SimplePrice {
  [id: string]: {
    usd?: number;
    usd_24h_change?: number;
    usd_24h_vol?: number;
    last_updated_at?: number;
    [k: string]: number | undefined;
  };
}

interface MarketRow {
  id?: string; symbol?: string; name?: string; current_price?: number;
  price_change_percentage_24h?: number; high_24h?: number; low_24h?: number;
  market_cap?: number; total_volume?: number; last_updated?: string;
}

/**
 * CoinGecko's public `/ohlc` endpoint picks its own granularity from the `days`
 * window. We only ever request a window whose native bars are at least as fine
 * as what the caller asked for, then roll them up — never the other way round.
 */
const OHLC_WINDOWS: Array<{ days: number; nativeResolution: Resolution }> = [
  { days: 1, nativeResolution: '15' },   // ~30-minute bars; treated as <=30m
  { days: 7, nativeResolution: '60' },   // 4-hour bars
  { days: 14, nativeResolution: '60' },
  { days: 30, nativeResolution: '60' },
  { days: 90, nativeResolution: 'D' },   // 4-day bars — coarser than daily
];

export class CoinGeckoAdapter implements MarketDataAdapter {
  readonly id = 'coingecko';
  readonly label = 'CoinGecko';
  /** Public crypto prices update roughly every minute. */
  readonly delayMinutes = 1;
  readonly classes: readonly AssetClass[] = ['crypto'];
  readonly capabilities: AdapterCapabilities = {
    quote: true,
    candles: true,
    search: true,
    constituents: false,
    news: false,
  };

  /** The public API needs no key; a demo/pro key just raises the limits. */
  isConfigured(): boolean {
    return true;
  }

  supports(asset: Asset): boolean {
    return asset.assetClass === 'crypto';
  }

  private base(): string {
    return env.coingeckoKey() && process.env.COINGECKO_PLAN === 'pro' ? PRO_BASE : PUBLIC_BASE;
  }

  private headers(): Record<string, string> {
    const key = env.coingeckoKey();
    if (!key) return {};
    return process.env.COINGECKO_PLAN === 'pro'
      ? { 'x-cg-pro-api-key': key }
      : { 'x-cg-demo-api-key': key };
  }

  private coinId(asset: Asset): string {
    const base = asset.symbol.split('-')[0]!;
    const known = CRYPTO_BASES[base];
    if (!known) {
      throw new FeedError('not_found', `No CoinGecko id mapped for ${base}`, this.label);
    }
    return known.coingeckoId;
  }

  private vsCurrency(asset: Asset): string {
    return (asset.symbol.split('-')[1] ?? 'USD').toLowerCase();
  }

  async getQuote(asset: Asset): Promise<Quote> {
    const id = this.coinId(asset);
    const vs = this.vsCurrency(asset);
    const url =
      `${this.base()}/simple/price?ids=${id}&vs_currencies=${vs}` +
      `&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true`;

    const raw = await fetchFromProvider<SimplePrice>(this.id, url, {
      headers: this.headers(),
      dedupeKey: `cg:price:${id}:${vs}`,
    });

    const row = raw[id];
    const price = row?.[vs];
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      throw new FeedError('not_found', `CoinGecko has no ${vs.toUpperCase()} price for ${id}`, this.label);
    }

    const changePct = row?.[`${vs}_24h_change`] ?? null;
    // 24h change is a percentage; derive the absolute move and the reference
    // price from it rather than leaving the header blank.
    const previousClose =
      typeof changePct === 'number' && Number.isFinite(changePct) && changePct !== -100
        ? price / (1 + changePct / 100)
        : null;

    return {
      symbol: asset.symbol,
      price,
      previousClose,
      change: previousClose === null ? null : price - previousClose,
      changePercent: typeof changePct === 'number' ? changePct : null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      timestamp: row?.last_updated_at ? row.last_updated_at * 1000 : Date.now(),
    };
  }

  async getCandles(asset: Asset, req: CandleRequest): Promise<CandleSeries> {
    const id = this.coinId(asset);
    const vs = this.vsCurrency(asset);
    const spanDays = Math.ceil((req.to - req.from) / 86_400);

    const window = OHLC_WINDOWS.find(
      (w) => w.days >= spanDays && canResample(w.nativeResolution, req.resolution),
    );

    if (!window) {
      const finest = OHLC_WINDOWS.filter((w) => canResample(w.nativeResolution, req.resolution))
        .map((w) => w.days)
        .pop();
      throw new FeedError(
        'unsupported',
        finest
          ? `CoinGecko's public OHLC feed only returns bars at or finer than ${req.resolution} for windows up to ${finest} days. ` +
            `A ${spanDays}-day window would come back as coarser bars, which cannot be split into ${req.resolution} bars without inventing prices. ` +
            `Set COINGECKO_API_KEY with COINGECKO_PLAN=pro for longer daily history.`
          : `CoinGecko cannot serve ${req.resolution} bars.`,
        this.label,
      );
    }

    const url = `${this.base()}/coins/${id}/ohlc?vs_currency=${vs}&days=${window.days}`;
    const raw = await fetchFromProvider<Array<[number, number, number, number, number]>>(this.id, url, {
      headers: this.headers(),
      dedupeKey: `cg:ohlc:${id}:${vs}:${window.days}`,
    });

    if (!Array.isArray(raw) || raw.length === 0) {
      throw new FeedError('not_found', `CoinGecko returned no OHLC for ${id}`, this.label);
    }

    const native: Candle[] = raw
      .filter((row) => Array.isArray(row) && row.length >= 5 && row.every((n) => Number.isFinite(n)))
      .map(([ms, o, h, l, c]) => ({ t: Math.floor(ms / 1000), o, h, l, c, v: null }));

    const bars = resample(native, req.resolution).filter((b) => b.t >= req.from && b.t <= req.to);
    if (bars.length === 0) {
      throw new FeedError('not_found', `No ${req.resolution} bars for ${asset.symbol} in window`, this.label);
    }
    // CoinGecko's OHLC endpoint carries no volume at all.
    return { bars, resolution: req.resolution, hasRange: true, hasVolume: false };
  }

  async searchSymbols(query: string): Promise<Asset[]> {
    const q = query.trim().toUpperCase();
    return Object.entries(CRYPTO_BASES)
      .filter(([base, meta]) => base.includes(q) || meta.name.toUpperCase().includes(q))
      .map(([base, meta]) => ({
        symbol: `${base}-USD`,
        assetClass: 'crypto' as const,
        name: meta.name,
        currency: 'USD',
        continuous: true,
      }))
      .slice(0, 25);
  }

  /** Top-N by market cap — the crypto analogue of an index constituent list. */
  async getTopByMarketCap(limit = 20): Promise<Constituent[]> {
    const url =
      `${this.base()}/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=${Math.min(limit, 250)}&page=1&sparkline=false`;
    const raw = await fetchFromProvider<MarketRow[]>(this.id, url, {
      headers: this.headers(),
      dedupeKey: `cg:markets:${limit}`,
    });
    if (!Array.isArray(raw)) {
      throw new FeedError('bad_response', 'CoinGecko /coins/markets returned a non-array', this.label);
    }
    return raw
      .filter((r) => r.symbol && r.name)
      .map((r) => ({
        symbol: `${r.symbol!.toUpperCase()}-USD`,
        name: r.name!,
        sector: 'Crypto',
      }));
  }

  /** Market rows keep price + cap together, which the overview grid needs. */
  async getMarkets(limit = 20): Promise<Array<{ symbol: string; name: string; price: number; changePercent: number | null; marketCap: number | null; volume: number | null; timestamp: number }>> {
    const url =
      `${this.base()}/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=${Math.min(limit, 250)}&page=1&sparkline=false&price_change_percentage=24h`;
    const raw = await fetchFromProvider<MarketRow[]>(this.id, url, {
      headers: this.headers(),
      dedupeKey: `cg:marketsfull:${limit}`,
    });
    if (!Array.isArray(raw)) {
      throw new FeedError('bad_response', 'CoinGecko /coins/markets returned a non-array', this.label);
    }
    return raw
      .filter((r) => r.symbol && typeof r.current_price === 'number')
      .map((r) => ({
        symbol: `${r.symbol!.toUpperCase()}-USD`,
        name: r.name ?? r.symbol!.toUpperCase(),
        price: r.current_price!,
        changePercent: typeof r.price_change_percentage_24h === 'number' ? r.price_change_percentage_24h : null,
        marketCap: typeof r.market_cap === 'number' ? r.market_cap : null,
        volume: typeof r.total_volume === 'number' ? r.total_volume : null,
        timestamp: r.last_updated ? Date.parse(r.last_updated) || Date.now() : Date.now(),
      }));
  }
}
