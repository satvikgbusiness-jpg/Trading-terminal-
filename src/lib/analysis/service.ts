import 'server-only';
import { resolveAsset, type Asset } from '@/lib/symbols';
import { getCandles, getQuote } from '@/lib/market/service';
import type { CandleSeries, Provenance, Quote, Result } from '@/lib/market/types';
import { refreshAndReadNews, type ScoredNews } from '@/lib/news';
import { aggregateSentiment, type AggregateResult } from './sentiment';
import { computeOutlook, type Outlook } from './outlook';
import { earningsEvent, relevantMacroEvents, type MacroEvent } from './macro';
import { finnhub } from '@/lib/market/registry';

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

  const earnings = await fetchEarnings(asset);

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
    macro: relevantMacroEvents(asset, earnings),
    provenance: dedupeProvenance(provenance),
  };
}

/**
 * Upcoming earnings dates, when a provider can supply them.
 *
 * Earnings only exist for equities, and the endpoint is on a paid plan for some
 * accounts, so a failure here degrades to an empty list -- the rest of the
 * external-factors strip still renders.
 */
async function fetchEarnings(asset: Asset): Promise<MacroEvent[]> {
  if (asset.assetClass !== 'equity') return [];
  if (!finnhub.isConfigured()) return [];

  const now = Date.now();
  try {
    const dates = await finnhub.getEarningsCalendar(asset, now, now + 90 * 86_400_000);
    return dates.map((date) => earningsEvent(asset.symbol, date, finnhub.label));
  } catch {
    return [];
  }
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
