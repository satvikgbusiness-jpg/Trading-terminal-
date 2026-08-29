import 'server-only';
import { and, asc, eq, max } from 'drizzle-orm';
import { db } from '@/lib/db';
import { watchlistItems, watchlists, type WatchlistItem } from '@/lib/db/schema';
import { resolveAsset } from '@/lib/symbols';

export const DEFAULT_WATCHLIST = 'default';

/** The seeded demo watchlist: one name from each asset class the terminal covers. */
export const SEED_SYMBOLS = [
  '^GSPC', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'JPM', 'XOM',
  'BTC-USD', 'ETH-USD', 'SOL-USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY',
];

export function ensureWatchlist(name = DEFAULT_WATCHLIST): number {
  const [existing] = db.select().from(watchlists).where(eq(watchlists.name, name)).limit(1).all();
  if (existing) return existing.id;
  const [created] = db.insert(watchlists).values({ name }).returning().all();
  return created!.id;
}

export function readWatchlist(name = DEFAULT_WATCHLIST): WatchlistItem[] {
  const id = ensureWatchlist(name);
  return db
    .select()
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, id))
    .orderBy(asc(watchlistItems.sortOrder), asc(watchlistItems.id))
    .all();
}

export function addToWatchlist(symbol: string, name = DEFAULT_WATCHLIST): WatchlistItem {
  // Throws for anything the terminal cannot model, so a bad symbol never lands
  // in the list and breaks every later render.
  const asset = resolveAsset(symbol);
  const watchlistId = ensureWatchlist(name);

  const [{ value: highest } = { value: null }] = db
    .select({ value: max(watchlistItems.sortOrder) })
    .from(watchlistItems)
    .where(eq(watchlistItems.watchlistId, watchlistId))
    .all();

  const [row] = db
    .insert(watchlistItems)
    .values({
      watchlistId,
      symbol: asset.symbol,
      assetClass: asset.assetClass,
      sortOrder: (highest ?? 0) + 1,
    })
    .onConflictDoNothing()
    .returning()
    .all();

  if (row) return row;

  const [existing] = db
    .select()
    .from(watchlistItems)
    .where(and(eq(watchlistItems.watchlistId, watchlistId), eq(watchlistItems.symbol, asset.symbol)))
    .limit(1)
    .all();
  return existing!;
}

export function removeFromWatchlist(symbol: string, name = DEFAULT_WATCHLIST): boolean {
  const watchlistId = ensureWatchlist(name);
  const result = db
    .delete(watchlistItems)
    .where(
      and(
        eq(watchlistItems.watchlistId, watchlistId),
        eq(watchlistItems.symbol, symbol.trim().toUpperCase()),
      ),
    )
    .run();
  return result.changes > 0;
}

/** Populate an empty watchlist with the demo set. Never overwrites user edits. */
export function seedWatchlist(name = DEFAULT_WATCHLIST): number {
  const existing = readWatchlist(name);
  if (existing.length > 0) return 0;
  for (const symbol of SEED_SYMBOLS) addToWatchlist(symbol, name);
  return SEED_SYMBOLS.length;
}
