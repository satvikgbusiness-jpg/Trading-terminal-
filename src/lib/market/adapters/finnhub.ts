import { createHash } from 'node:crypto';
import type { Asset, AssetClass } from '@/lib/symbols';
import { resolveAsset } from '@/lib/symbols';
import { fetchFromProvider } from '../http';
import { env } from '../providers';
import {
  FeedError,
  type AdapterCapabilities,
  type CandleRequest,
  type CandleSeries,
  type Constituent,
  type MarketDataAdapter,
  type NewsItem,
  type Quote,
} from '../types';

const BASE = 'https://finnhub.io/api/v1';

/**
 * US index tiles served through the most liquid US-listed tracker.
 *
 * These are proxies, not the index: SPY tracks the S&P 500 but is a fund with
 * its own price, dividends and tracking error. Every value sourced this way is
 * tagged with a provenance note so the UI can say so out loud.
 */
export const INDEX_ETF_PROXIES: Record<string, { etf: string; label: string }> = {
  '^GSPC': { etf: 'SPY', label: 'SPDR S&P 500 ETF' },
  '^IXIC': { etf: 'QQQ', label: 'Invesco QQQ (Nasdaq-100)' },
  '^DJI': { etf: 'DIA', label: 'SPDR Dow Jones Industrial Average ETF' },
};

interface FinnhubQuote {
  c?: number; d?: number; dp?: number; h?: number; l?: number; o?: number; pc?: number; t?: number;
}

interface FinnhubSearchResult {
  count?: number;
  result?: Array<{ description?: string; displaySymbol?: string; symbol?: string; type?: string }>;
}

interface FinnhubNews {
  category?: string; datetime?: number; headline?: string; id?: number;
  image?: string; related?: string; source?: string; summary?: string; url?: string;
}

interface FinnhubConstituent {
  constituents?: string[];
  constituentsBreakdown?: Array<{ symbol?: string; name?: string; sector?: string; industry?: string }>;
}

/** Finnhub free tier: real-time US quotes, company news, symbol search. */
export class FinnhubAdapter implements MarketDataAdapter {
  readonly id = 'finnhub';
  readonly label = 'Finnhub';
  /**
   * Finnhub's free US quote feed is real-time for the last trade but is not an
   * exchange-consolidated SIP feed. We advertise 15 minutes, the conservative
   * assumption, and the UI shows the quote's own timestamp beside it.
   */
  readonly delayMinutes = 15;
  /** FX via OANDA: symbols needs a paid plan, so forex is left to the FX adapters. */
  readonly classes: readonly AssetClass[] = ['equity', 'index'];
  /**
   * `/stock/candle` moved behind a paid plan, so candles are served by
   * Alpha Vantage instead. Advertising `candles: false` keeps the registry from
   * routing chart requests into a guaranteed 403.
   */
  readonly capabilities: AdapterCapabilities = {
    quote: true,
    candles: false,
    search: true,
    constituents: true,
    news: true,
  };

  isConfigured(): boolean {
    return env.finnhubKey() !== null;
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
    const key = env.finnhubKey();
    if (!key) {
      throw new FeedError('no_api_key', 'FINNHUB_API_KEY is not set', this.label);
    }
    return key;
  }

  /** Canonical symbol -> the symbol Finnhub actually prices. */
  private wireSymbol(asset: Asset): string {
    const proxy = INDEX_ETF_PROXIES[asset.symbol];
    if (proxy) return proxy.etf;
    return asset.symbol;
  }

  async getQuote(asset: Asset): Promise<Quote> {
    const wire = this.wireSymbol(asset);
    const url = `${BASE}/quote?symbol=${encodeURIComponent(wire)}&token=${this.key()}`;
    const raw = await fetchFromProvider<FinnhubQuote>(this.id, url, {
      dedupeKey: `finnhub:quote:${wire}`,
    });

    // Finnhub answers unknown symbols with a 200 and an all-zero body. That is
    // an absence of data, not a price of zero.
    if (!raw || typeof raw.c !== 'number' || raw.c === 0) {
      throw new FeedError('not_found', `Finnhub has no quote for ${wire}`, this.label);
    }

    return {
      symbol: asset.symbol,
      price: raw.c,
      previousClose: num(raw.pc),
      change: num(raw.d),
      changePercent: num(raw.dp),
      dayOpen: num(raw.o),
      dayHigh: num(raw.h),
      dayLow: num(raw.l),
      timestamp: typeof raw.t === 'number' && raw.t > 0 ? raw.t * 1000 : Date.now(),
    };
  }

  async getCandles(_asset: Asset, _req: CandleRequest): Promise<CandleSeries> {
    throw new FeedError(
      'unsupported',
      'Finnhub /stock/candle requires a paid plan; candles are served by Alpha Vantage',
      this.label,
    );
  }

  async searchSymbols(query: string): Promise<Asset[]> {
    const url = `${BASE}/search?q=${encodeURIComponent(query)}&exchange=US&token=${this.key()}`;
    const raw = await fetchFromProvider<FinnhubSearchResult>(this.id, url, {
      dedupeKey: `finnhub:search:${query.toLowerCase()}`,
    });
    const out: Asset[] = [];
    for (const row of raw.result ?? []) {
      const symbol = row.symbol ?? row.displaySymbol;
      if (!symbol || row.type === 'Crypto') continue;
      // Finnhub returns venue-qualified symbols like "AAPL.MX"; keep plain US lines.
      if (symbol.includes('.')) continue;
      try {
        const asset = resolveAsset(symbol);
        out.push({ ...asset, name: row.description || asset.name });
      } catch {
        /* shape we do not model */
      }
    }
    return out.slice(0, 25);
  }

  async getIndexConstituents(indexSymbol: string): Promise<Constituent[]> {
    // Finnhub keys this endpoint on the caret-less index name.
    const wire = indexSymbol === '^GSPC' ? '^GSPC' : indexSymbol;
    const url = `${BASE}/index/constituents?symbol=${encodeURIComponent(wire)}&token=${this.key()}`;
    const raw = await fetchFromProvider<FinnhubConstituent>(this.id, url, {
      dedupeKey: `finnhub:constituents:${wire}`,
    });

    if (raw.constituentsBreakdown?.length) {
      return raw.constituentsBreakdown
        .filter((c): c is { symbol: string; name?: string; sector?: string } => Boolean(c.symbol))
        .map((c) => ({ symbol: c.symbol, name: c.name ?? c.symbol, sector: c.sector ?? 'Unknown' }));
    }
    if (raw.constituents?.length) {
      return raw.constituents.map((s) => ({ symbol: s, name: s, sector: 'Unknown' }));
    }
    throw new FeedError(
      'unsupported',
      `Finnhub returned no constituents for ${indexSymbol} (this endpoint requires a paid plan)`,
      this.label,
    );
  }

  async getNews(asset: Asset | null, from: number, to: number): Promise<NewsItem[]> {
    const url = asset
      ? `${BASE}/company-news?symbol=${encodeURIComponent(this.wireSymbol(asset))}` +
        `&from=${isoDate(from)}&to=${isoDate(to)}&token=${this.key()}`
      : `${BASE}/news?category=general&token=${this.key()}`;

    const raw = await fetchFromProvider<FinnhubNews[]>(this.id, url, {
      dedupeKey: `finnhub:news:${asset?.symbol ?? 'general'}:${isoDate(from)}`,
    });
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((n) => n.url && n.headline)
      .map((n) => ({
        id: newsId(n.url!),
        headline: n.headline!,
        url: n.url!,
        source: n.source ?? 'Finnhub',
        summary: n.summary?.trim() || null,
        publishedAt: typeof n.datetime === 'number' ? n.datetime * 1000 : Date.now(),
        symbol: asset?.symbol ?? null,
      }));
  }
}

function num(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Stable dedupe id: sha256 of the URL with tracking noise removed. */
export function newsId(url: string): string {
  let normalized = url.trim();
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const p of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|fbclid|gclid|mc_cid|mc_eid)/i.test(p)) parsed.searchParams.delete(p);
    }
    parsed.hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    normalized = parsed.toString();
  } catch {
    /* not a URL we can parse — hash it verbatim */
  }
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
