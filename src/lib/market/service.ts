import type { Asset } from '@/lib/symbols';
import { resolveAsset } from '@/lib/symbols';
import { searchLocal } from '@/lib/universe';
import { diskCache } from './cache';
import { adaptersFor, candidateAdapters, coingecko, type Capability } from './registry';
import { fetchAllFeeds } from './adapters/rss';
import {
  FeedError,
  type CandleRequest,
  type CandleSeries,
  type Constituent,
  type FeedErrorCode,
  type MarketDataAdapter,
  type NewsItem,
  type Provenance,
  type Quote,
  type Resolution,
  type Result,
} from './types';

/**
 * The read-through layer every route and worker uses.
 *
 * Its job is to make a single promise true: what the terminal displays is either
 * a value that a named source actually returned, or an explicit gap. There is no
 * third path. When a refresh fails and a previous payload exists, the previous
 * payload is returned flagged `stale` with the reason — never a placeholder,
 * never an interpolation, never a zero.
 */

const TTL = {
  quoteCrypto: 15_000,
  quoteEquity: 30_000,
  quoteForex: 5 * 60_000,
  candlesIntraday: 5 * 60_000,
  /** Alpha Vantage allows 25 calls/day, so daily bars are cached hard. */
  candlesDaily: 4 * 60 * 60_000,
  candlesWeekly: 12 * 60 * 60_000,
  constituents: 24 * 60 * 60_000,
  news: 10 * 60_000,
  markets: 60_000,
} as const;

function quoteTtl(asset: Asset): number {
  switch (asset.assetClass) {
    case 'crypto': return TTL.quoteCrypto;
    case 'forex': return TTL.quoteForex;
    default: return TTL.quoteEquity;
  }
}

function candleTtl(resolution: Resolution): number {
  if (resolution === 'D') return TTL.candlesDaily;
  if (resolution === 'W') return TTL.candlesWeekly;
  return TTL.candlesIntraday;
}

function provenanceFor(
  adapter: MarketDataAdapter,
  asset: Asset | null,
  fetchedAt: number,
  stale: boolean,
  staleReason?: string,
): Provenance {
  const note = asset ? adapter.provenanceNote?.(asset) : undefined;
  return {
    source: adapter.label,
    fetchedAt,
    delayMinutes: adapter.delayMinutes,
    stale,
    ...(staleReason ? { staleReason } : {}),
    ...(note ? { note } : {}),
  };
}

interface CachedPayload<T> {
  value: T;
  adapterId: string;
  adapterLabel: string;
  delayMinutes: number;
  note?: string;
}

/**
 * Try each candidate adapter in turn; fall back to the disk cache when they all
 * fail. Returns the last error so the UI can say *why* a value is missing.
 */
async function readThrough<T>(
  namespace: string,
  cacheKey: string,
  ttlMs: number,
  asset: Asset | null,
  adapters: MarketDataAdapter[],
  call: (adapter: MarketDataAdapter) => Promise<T>,
  noAdapterMessage: () => { code: FeedErrorCode; message: string; source: string },
): Promise<Result<T>> {
  const cached = await diskCache.get<CachedPayload<T>>(namespace, cacheKey);

  if (cached && !cached.expired) {
    return {
      ok: true,
      data: cached.payload.value,
      provenance: {
        source: cached.payload.adapterLabel,
        fetchedAt: cached.storedAt,
        delayMinutes: cached.payload.delayMinutes,
        stale: false,
        ...(cached.payload.note ? { note: cached.payload.note } : {}),
      },
    };
  }

  if (adapters.length === 0) {
    const miss = noAdapterMessage();
    if (cached) {
      return {
        ok: true,
        data: cached.payload.value,
        provenance: {
          source: cached.payload.adapterLabel,
          fetchedAt: cached.storedAt,
          delayMinutes: cached.payload.delayMinutes,
          stale: true,
          staleReason: miss.message,
          ...(cached.payload.note ? { note: cached.payload.note } : {}),
        },
      };
    }
    return { ok: false, ...miss };
  }

  let lastError: FeedError | null = null;
  for (const adapter of adapters) {
    try {
      const value = await call(adapter);
      const note = asset ? adapter.provenanceNote?.(asset) : undefined;
      await diskCache.set<CachedPayload<T>>(
        namespace,
        cacheKey,
        { value, adapterId: adapter.id, adapterLabel: adapter.label, delayMinutes: adapter.delayMinutes, ...(note ? { note } : {}) },
        ttlMs,
      );
      return { ok: true, data: value, provenance: provenanceFor(adapter, asset, Date.now(), false) };
    } catch (err) {
      lastError =
        err instanceof FeedError
          ? err
          : new FeedError('upstream_error', err instanceof Error ? err.message : String(err), adapter.label);
    }
  }

  // Every source failed. Serve the last known good payload, clearly marked.
  if (cached) {
    return {
      ok: true,
      data: cached.payload.value,
      provenance: {
        source: cached.payload.adapterLabel,
        fetchedAt: cached.storedAt,
        delayMinutes: cached.payload.delayMinutes,
        stale: true,
        staleReason: lastError ? `${lastError.source}: ${lastError.message}` : 'refresh failed',
        ...(cached.payload.note ? { note: cached.payload.note } : {}),
      },
    };
  }

  return {
    ok: false,
    code: lastError?.code ?? 'upstream_error',
    message: lastError?.message ?? 'No data source returned a value',
    source: lastError?.source ?? 'none',
    ...(lastError?.retryAfterMs ? { retryAfterMs: lastError.retryAfterMs } : {}),
  };
}

/** Explain an empty adapter list in terms the operator can act on. */
function explainNoAdapter(asset: Asset, capability: Capability) {
  return () => {
    const candidates = candidateAdapters(asset, capability);
    if (candidates.length === 0) {
      return {
        code: 'unsupported' as const,
        message: `No configured data source serves ${capability} for ${asset.assetClass} ${asset.symbol}`,
        source: 'none',
      };
    }
    const names = candidates.map((c) => c.label).join(' or ');
    return {
      code: 'no_api_key' as const,
      message: `${names} can serve ${capability} for ${asset.symbol} but no API key is configured — see .env.example`,
      source: candidates[0]!.label,
    };
  };
}

export async function getQuote(symbol: string): Promise<Result<Quote>> {
  const asset = resolveAsset(symbol);
  return readThrough<Quote>(
    'quote',
    asset.symbol,
    quoteTtl(asset),
    asset,
    adaptersFor(asset, 'quote'),
    (adapter) => adapter.getQuote(asset),
    explainNoAdapter(asset, 'quote'),
  );
}

/** Quotes for many symbols, resolved concurrently under the scheduler's limits. */
export async function getQuotes(symbols: string[]): Promise<Record<string, Result<Quote>>> {
  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        return [symbol, await getQuote(symbol)] as const;
      } catch (err) {
        return [
          symbol,
          {
            ok: false as const,
            code: 'unsupported' as const,
            message: err instanceof Error ? err.message : String(err),
            source: 'none',
          },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

export interface CandleQuery {
  resolution: Resolution;
  /** Days of history to request, counted back from now. */
  lookbackDays: number;
}

export async function getCandles(symbol: string, query: CandleQuery): Promise<Result<CandleSeries>> {
  const asset = resolveAsset(symbol);
  const to = Math.floor(Date.now() / 1000);
  const from = to - Math.max(1, query.lookbackDays) * 86_400;
  const req: CandleRequest = { resolution: query.resolution, from, to };

  return readThrough<CandleSeries>(
    'candles',
    `${asset.symbol}:${query.resolution}:${query.lookbackDays}`,
    candleTtl(query.resolution),
    asset,
    adaptersFor(asset, 'candles'),
    (adapter) => adapter.getCandles(asset, req),
    explainNoAdapter(asset, 'candles'),
  );
}

export async function getIndexConstituents(indexSymbol: string): Promise<Result<Constituent[]>> {
  const asset = resolveAsset(indexSymbol);
  return readThrough<Constituent[]>(
    'constituents',
    asset.symbol,
    TTL.constituents,
    asset,
    adaptersFor(asset, 'constituents').filter((a) => typeof a.getIndexConstituents === 'function'),
    (adapter) => adapter.getIndexConstituents!(asset.symbol),
    explainNoAdapter(asset, 'constituents'),
  );
}

export async function searchSymbols(query: string): Promise<Asset[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const seen = new Map<string, Asset>();
  // Local tables answer instantly and cost no rate budget.
  for (const asset of searchLocal(trimmed, 20)) seen.set(asset.symbol, asset);

  const probe = resolveAsset('AAPL');
  for (const adapter of adaptersFor(probe, 'search')) {
    try {
      for (const asset of await adapter.searchSymbols(trimmed)) {
        if (!seen.has(asset.symbol)) seen.set(asset.symbol, asset);
      }
      break; // one remote provider is enough
    } catch {
      /* try the next provider */
    }
  }
  return [...seen.values()].slice(0, 30);
}

export interface NewsQuery {
  symbol?: string;
  /** How far back to look, in days. */
  days?: number;
  limit?: number;
}

/**
 * Company news from the quote provider plus the configured RSS feeds, deduped
 * by normalised URL. RSS failures degrade the feed rather than emptying it.
 */
export async function getNews(query: NewsQuery = {}): Promise<Result<NewsItem[]>> {
  const days = query.days ?? 7;
  const limit = query.limit ?? 60;
  const to = Date.now();
  const from = to - days * 86_400_000;

  const asset = query.symbol ? resolveAsset(query.symbol) : null;
  const cacheKey = `${asset?.symbol ?? 'general'}:${days}`;

  const newsAdapters = asset
    ? adaptersFor(asset, 'news').filter((a) => typeof a.getNews === 'function')
    : [];

  return readThrough<NewsItem[]>(
    'news',
    cacheKey,
    TTL.news,
    asset,
    // The RSS pseudo-adapter always participates, so news works with no keys.
    [...newsAdapters, RSS_ADAPTER],
    async (adapter) => {
      if (adapter === RSS_ADAPTER) {
        const { items, results } = await fetchAllFeeds();
        const failures = results.filter((r) => r.error);
        if (items.length === 0) {
          throw new FeedError(
            'upstream_error',
            failures.length > 0
              ? `All ${failures.length} RSS feeds failed: ${failures[0]!.error}`
              : 'RSS feeds returned no items',
            'RSS',
          );
        }
        return filterNews(items, from, limit);
      }
      const items = await adapter.getNews!(asset, from, to);
      // Merge the company feed with the general RSS stream when both work.
      const rss = await fetchAllFeeds().catch(() => ({ items: [] as NewsItem[], results: [] }));
      return filterNews(dedupe([...items, ...rss.items]), from, limit);
    },
    () => ({
      code: 'upstream_error' as const,
      message: 'No news source is available',
      source: 'none',
    }),
  );
}

function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function filterNews(items: NewsItem[], from: number, limit: number): NewsItem[] {
  return items
    .filter((i) => i.publishedAt >= from)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}

/**
 * RSS is not a MarketDataAdapter — it has no quotes — but routing it through the
 * same read-through path gives it the same caching, provenance and stale
 * semantics as every other source.
 */
const RSS_ADAPTER: MarketDataAdapter = {
  id: 'rss',
  label: 'RSS feeds',
  delayMinutes: 0,
  classes: ['equity', 'index', 'crypto', 'forex'],
  capabilities: { quote: false, candles: false, search: false, constituents: false, news: true },
  isConfigured: () => true,
  supports: () => true,
  getQuote: () => Promise.reject(new FeedError('unsupported', 'RSS has no quotes', 'RSS')),
  getCandles: () => Promise.reject(new FeedError('unsupported', 'RSS has no candles', 'RSS')),
  searchSymbols: () => Promise.resolve([]),
};

/** Crypto market rows for the overview grid. */
export async function getCryptoMarkets(limit = 20) {
  return readThrough(
    'markets',
    `crypto:${limit}`,
    TTL.markets,
    null,
    [coingecko],
    () => coingecko.getMarkets(limit),
    () => ({ code: 'upstream_error' as const, message: 'CoinGecko unavailable', source: 'CoinGecko' }),
  );
}
