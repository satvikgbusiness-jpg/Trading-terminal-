import 'server-only';
import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { newsItems, type NewsRow } from '@/lib/db/schema';
import { getNews } from '@/lib/market/service';
import type { NewsItem, Result } from '@/lib/market/types';
import { scoreHeadline } from '@/lib/analysis/sentiment';

/**
 * News ingestion and retrieval.
 *
 * Headlines are scored once at ingest and stored with their score, so the
 * Outlook engine and the news pane always agree and re-rendering a page does not
 * re-run the lexicon over hundreds of items. Deduplication is by the normalised
 * URL hash the adapters produce, so the same story arriving from Finnhub and
 * from an RSS feed is stored once.
 */

export interface ScoredNews {
  id: string;
  headline: string;
  url: string;
  source: string;
  summary: string | null;
  publishedAt: number;
  symbol: string | null;
  sentimentScore: number;
  sentimentLabel: 'positive' | 'negative' | 'neutral';
}

function toScored(row: NewsRow): ScoredNews {
  return {
    id: row.id,
    headline: row.headline,
    url: row.url,
    source: row.source,
    summary: row.summary,
    publishedAt: row.publishedAt,
    symbol: row.symbol,
    sentimentScore: row.sentimentScore,
    sentimentLabel: row.sentimentLabel,
  };
}

/** Score and persist items, ignoring any already stored. Returns the new count. */
export function ingestNews(items: NewsItem[]): number {
  if (items.length === 0) return 0;

  return db.transaction((tx) => {
    let count = 0;
    for (const item of items) {
      const sentiment = scoreHeadline(item.headline, item.summary);
      const result = tx
        .insert(newsItems)
        .values({
          id: item.id,
          headline: item.headline,
          url: item.url,
          source: item.source,
          summary: item.summary,
          publishedAt: item.publishedAt,
          symbol: item.symbol,
          sentimentScore: sentiment.score,
          sentimentLabel: sentiment.label,
        })
        // A story can arrive from several feeds. Keep the first copy, but let a
        // later one attach a symbol if the first was from a general feed.
        .onConflictDoUpdate({
          target: newsItems.id,
          set: { symbol: sql`COALESCE(${newsItems.symbol}, excluded.symbol)` },
        })
        .run();
      if (result.changes > 0) count += 1;
    }
    return count;
  });
}

export interface StoredNewsQuery {
  symbol?: string;
  days?: number;
  limit?: number;
  /** Include general (unattributed) headlines alongside symbol-tagged ones. */
  includeGeneral?: boolean;
}

export function readStoredNews(query: StoredNewsQuery = {}): ScoredNews[] {
  const { symbol, days = 7, limit = 60, includeGeneral = true } = query;
  const since = Date.now() - days * 86_400_000;

  const where = symbol
    ? and(
        gte(newsItems.publishedAt, since),
        includeGeneral
          ? or(eq(newsItems.symbol, symbol), isNull(newsItems.symbol))
          : eq(newsItems.symbol, symbol),
      )
    : gte(newsItems.publishedAt, since);

  return db
    .select()
    .from(newsItems)
    .where(where)
    .orderBy(desc(newsItems.publishedAt))
    .limit(limit)
    .all()
    .map(toScored);
}

export interface NewsFetchResult {
  items: ScoredNews[];
  /** Where the items came from, or why there are none. */
  status:
    | { kind: 'live'; source: string; fetchedAt: number; stale: boolean }
    | { kind: 'stored-only'; reason: string }
    | { kind: 'empty'; reason: string };
}

/**
 * Fetch, store and return news for a symbol.
 *
 * On a feed failure this falls back to what is already stored and says so,
 * rather than presenting an empty pane as "no news".
 */
export async function refreshAndReadNews(query: StoredNewsQuery = {}): Promise<NewsFetchResult> {
  const { symbol, days = 7, limit = 60 } = query;

  let fetched: Result<NewsItem[]>;
  try {
    fetched = await getNews({ symbol, days, limit });
  } catch (err) {
    fetched = {
      ok: false,
      code: 'upstream_error',
      message: err instanceof Error ? err.message : String(err),
      source: 'none',
    };
  }

  if (fetched.ok) {
    ingestNews(fetched.data);
    const items = readStoredNews(query);
    return {
      items,
      status: {
        kind: 'live',
        source: fetched.provenance.source,
        fetchedAt: fetched.provenance.fetchedAt,
        stale: fetched.provenance.stale,
      },
    };
  }

  const stored = readStoredNews(query);
  if (stored.length > 0) {
    return { items: stored, status: { kind: 'stored-only', reason: fetched.message } };
  }
  return { items: [], status: { kind: 'empty', reason: fetched.message } };
}

/** Drop items older than `days`, so the table does not grow without bound. */
export function pruneNews(days = 60): number {
  const cutoff = Date.now() - days * 86_400_000;
  return db.delete(newsItems).where(sql`${newsItems.publishedAt} < ${cutoff}`).run().changes;
}
