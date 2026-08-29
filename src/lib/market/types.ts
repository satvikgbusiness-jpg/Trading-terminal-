import type { Asset, AssetClass } from '@/lib/symbols';

/** Candle resolutions the terminal understands. */
export type Resolution = '1' | '5' | '15' | '60' | 'D' | 'W';

export interface Candle {
  /** Unix seconds, start of bar. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume. Null where the feed does not report it (most FX). */
  v: number | null;
}

export interface Quote {
  symbol: string;
  price: number;
  /** Previous session close, when the feed reports it. */
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  /** Unix ms of the quote itself as reported by the feed. */
  timestamp: number;
}

export interface Constituent {
  symbol: string;
  name: string;
  /** GICS sector, or "Unknown" when the source does not classify. */
  sector: string;
}

export interface NewsItem {
  /** sha256 of the normalised URL — the dedupe key. */
  id: string;
  headline: string;
  url: string;
  source: string;
  summary: string | null;
  /** Unix ms. */
  publishedAt: number;
  /** Canonical symbol this item was fetched for, or null for general feeds. */
  symbol: string | null;
}

/**
 * Where a value came from and how old it is.
 *
 * Every value the terminal renders carries one of these. The UI shows it in the
 * footer so a user can always tell live data from a cached copy. `stale: true`
 * means the origin refresh failed and this is a previously fetched value — it is
 * never a substitute or an estimate.
 */
export interface Provenance {
  /** Display name of the origin, e.g. "Finnhub". */
  source: string;
  /** Unix ms when this payload was retrieved from the origin. */
  fetchedAt: number;
  /** Declared feed delay in minutes. 0 for real-time, 15 for delayed equities. */
  delayMinutes: number;
  /** True when the origin refresh failed and a cached copy is being served. */
  stale: boolean;
  /** Why the data is stale, for the UI badge tooltip. */
  staleReason?: string;
  /**
   * Caveat the UI must show alongside the value, e.g. "via SPY ETF proxy" or
   * "ECB daily reference rate". Used wherever the number is not literally the
   * thing the label names.
   */
  note?: string;
}

/** A successfully resolved value plus its provenance. */
export interface Sourced<T> {
  ok: true;
  data: T;
  provenance: Provenance;
}

/**
 * A value the terminal could not obtain. Rendered as an explicit gap.
 * There is deliberately no `data` field: nothing downstream can accidentally
 * read a placeholder number out of a failure.
 */
export interface Unavailable {
  ok: false;
  /** Machine-readable reason, e.g. "no_api_key", "rate_limited", "upstream_error". */
  code: FeedErrorCode;
  message: string;
  source: string;
  /** Set when the adapter told us when to try again. */
  retryAfterMs?: number;
}

export type Result<T> = Sourced<T> | Unavailable;

export type FeedErrorCode =
  | 'no_api_key'
  | 'rate_limited'
  | 'upstream_error'
  | 'not_found'
  | 'unsupported'
  | 'network_error'
  | 'bad_response'
  | 'disabled';

export class FeedError extends Error {
  constructor(
    public readonly code: FeedErrorCode,
    message: string,
    public readonly source: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}

/**
 * A candle series plus the honest shape of what the feed actually returned.
 *
 * `hasRange: false` means the source publishes one reference price per period
 * (ECB FX fixings, for instance). o/h/l are then all equal to c; the chart must
 * draw a line, not a candlestick, and range-dependent indicators (ATR) must be
 * skipped rather than computed against a fabricated zero-width bar.
 */
export interface CandleSeries {
  bars: Candle[];
  /** The resolution actually delivered, which may be coarser than requested. */
  resolution: Resolution;
  hasRange: boolean;
  hasVolume: boolean;
}

export interface CandleRequest {
  resolution: Resolution;
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, inclusive. */
  to: number;
}

/**
 * The single interface every data source implements. Adapters are responsible
 * for provider encoding, auth and response parsing; they must throw `FeedError`
 * rather than returning partial or invented values.
 */
/** Which of the five data surfaces an adapter can actually serve. */
export interface AdapterCapabilities {
  quote: boolean;
  candles: boolean;
  search: boolean;
  constituents: boolean;
  news: boolean;
}

export interface MarketDataAdapter {
  /** Stable id used for cache keys and the rate-limit bucket. */
  readonly id: string;
  /** Display name shown in the provenance footer. */
  readonly label: string;
  /** Declared delay of this feed, in minutes. */
  readonly delayMinutes: number;
  /** Asset classes this adapter can serve. */
  readonly classes: readonly AssetClass[];
  /** Surfaces this adapter implements on the plan we target. */
  readonly capabilities: AdapterCapabilities;

  /** True when the adapter has everything it needs (e.g. an API key) to run. */
  isConfigured(): boolean;

  supports(asset: Asset): boolean;

  getQuote(asset: Asset): Promise<Quote>;
  getCandles(asset: Asset, req: CandleRequest): Promise<CandleSeries>;
  searchSymbols(query: string): Promise<Asset[]>;
  getIndexConstituents?(indexSymbol: string): Promise<Constituent[]>;
  getNews?(asset: Asset | null, from: number, to: number): Promise<NewsItem[]>;
  /** Optional per-call provenance override, e.g. an ETF-proxy note. */
  provenanceNote?(asset: Asset): string | undefined;
}
