import 'server-only';
import { resolveAsset, type Asset } from '@/lib/symbols';
import { getCandles, getQuote } from '@/lib/market/service';
import type { CandleSeries, Provenance, Quote, Result } from '@/lib/market/types';
import { refreshAndReadNews, type ScoredNews } from '@/lib/news';
import { aggregateSentiment, type AggregateResult } from './sentiment';
import { computeOutlook, type Outlook } from './outlook';
import { relevantMacroEvents, type MacroEvent } from './macro';

/**
 * Assembles everything a ticker screen needs in one pass, so the page renders a
 * single coherent snapshot rather than a mosaic of independently-timed fetches.
 *
 * Each part carries its own status. A missing news feed does not blank the
 * chart, and a missing chart does not blank the quote -- every gap is reported
 * where it happened.
 */

/** Daily history to request. 400 bars covers SMA(200) with room to spare. */
export const DEFAULT_LOOKBACK_DAYS = 400;

export interface SymbolSnapshot {
  asset: Asset;
  quote: Result<Quote>;
  candles: Result<CandleSeries>;
  news: ScoredNews[];
  newsStatus:
    | { kind: 'live'; source: string; fetchedAt: number; stale: boolean }
    | { kind: 'stored-only'; reason: string }
    | { kind: 'empty'; reason: string };
  sentiment: AggregateResult;
  /** Null when there are not enough bars to compute anything. */
  outlook: Outlook | null;
  /** Why there is no outlook, when there is none. */
  outlookGap: string | null;
  macro: MacroEvent[];
  /** Provenance lines for the footer, deduplicated. */
  provenance: Provenance[];
}

export async function getSymbolSnapshot(
  symbol: string,
  options: { lookbackDays?: number; newsDays?: number } = {},
): Promise<SymbolSnapshot> {
  const asset = resolveAsset(symbol);
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const newsDays = options.newsDays ?? 7;

  const [quote, candles, news] = await Promise.all([
    getQuote(asset.symbol).catch(
      (err): Result<Quote> => ({
        ok: false,
        code: 'upstream_error',
        message: err instanceof Error ? err.message : String(err),
        source: 'none',
      }),
    ),
    getCandles(asset.symbol, { resolution: 'D', lookbackDays }).catch(
      (err): Result<CandleSeries> => ({
        ok: false,
        code: 'upstream_error',
        message: err instanceof Error ? err.message : String(err),
        source: 'none',
      }),
    ),
    refreshAndReadNews({ symbol: asset.symbol, days: newsDays, limit: 40 }),
  ]);

  const sentiment = aggregateSentiment(
    news.items.map((n) => ({ score: n.sentimentScore, publishedAt: n.publishedAt })),
  );

  let outlook: Outlook | null = null;
  let outlookGap: string | null = null;

  if (candles.ok && candles.data.bars.length > 0) {
    outlook = computeOutlook({ symbol: asset.symbol, series: candles.data, news: sentiment });
  } else {
    outlookGap = candles.ok
      ? 'The candle feed returned no bars for this symbol.'
      : `No price history: ${candles.message}`;
  }

  const provenance: Provenance[] = [];
  if (quote.ok) provenance.push(quote.provenance);
  if (candles.ok) provenance.push(candles.provenance);

  return {
    asset,
    quote,
    candles,
    news: news.items,
    newsStatus: news.status,
    sentiment,
    outlook,
    outlookGap,
    macro: relevantMacroEvents(asset),
    provenance: dedupeProvenance(provenance),
  };
}

function dedupeProvenance(entries: Provenance[]): Provenance[] {
  const seen = new Set<string>();
  const out: Provenance[] = [];
  for (const entry of entries) {
    const key = `${entry.source}|${entry.note ?? ''}|${entry.stale}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * A compact Outlook for list rows (watchlist, movers) where a full snapshot
 * would be far too many requests. Uses cached candles and stored news only --
 * it never triggers a fresh fetch, so rendering a 20-row watchlist costs at
 * most one provider call per symbol from the shared cache.
 */
export async function getListOutlook(symbol: string): Promise<Outlook | null> {
  const asset = resolveAsset(symbol);
  const candles = await getCandles(asset.symbol, {
    resolution: 'D',
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
  }).catch(() => null);

  if (!candles || !candles.ok || candles.data.bars.length === 0) return null;

  const { readStoredNews } = await import('@/lib/news');
  const stored = readStoredNews({ symbol: asset.symbol, days: 7, limit: 40 });
  const sentiment = aggregateSentiment(
    stored.map((n) => ({ score: n.sentimentScore, publishedAt: n.publishedAt })),
  );

  return computeOutlook({ symbol: asset.symbol, series: candles.data, news: sentiment });
}
