import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { candles as candlesTable } from '@/lib/db/schema';
import type { CandleSeries, Resolution } from '@/lib/market/types';

/**
 * Durable candle storage.
 *
 * The disk cache expires; the backtest needs bars that stay put so a run is
 * reproducible and so replaying two years of history does not re-hit a free tier
 * that allows 25 requests a day.
 */

export function persistCandles(symbol: string, series: CandleSeries, source: string): number {
  if (series.bars.length === 0) return 0;

  return db.transaction((tx) => {
    let written = 0;
    for (const bar of series.bars) {
      const result = tx
        .insert(candlesTable)
        .values({
          symbol,
          resolution: series.resolution,
          t: bar.t,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          v: bar.v,
          source,
          hasRange: series.hasRange,
          fetchedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [candlesTable.symbol, candlesTable.resolution, candlesTable.t],
          set: { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, source, fetchedAt: Date.now() },
        })
        .run();
      written += result.changes;
    }
    return written;
  });
}

export function readPersistedCandles(symbol: string, resolution: Resolution): CandleSeries | null {
  const rows = db
    .select()
    .from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.resolution, resolution)))
    .orderBy(asc(candlesTable.t))
    .all();

  if (rows.length === 0) return null;

  return {
    bars: rows.map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v })),
    resolution,
    hasRange: rows[0]!.hasRange,
    hasVolume: rows.some((r) => r.v !== null),
  };
}
