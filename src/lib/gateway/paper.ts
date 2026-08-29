import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { paperAccounts, paperFills, paperPositions, type PaperAccount, type PaperFill } from '@/lib/db/schema';
import { getQuote } from '@/lib/market/service';
import { applyFill, valuePortfolio, type PortfolioValuation, type Position } from './accounting';

/**
 * The paper engine.
 *
 * Order intents fill against real quotes into a simulated ledger. There is no
 * broker connection anywhere in this file, and no code path that reaches one.
 *
 * The one rule that matters: a fill needs a real price. When the market data
 * layer cannot supply a quote, the order is rejected with `no_market_data`
 * rather than filled at a stale, interpolated, or last-known price. A paper
 * ledger whose fills are invented teaches a bot the wrong thing.
 */

export const DEFAULT_ACCOUNT_NAME = 'paper-default';

export function getAccount(accountId: number): PaperAccount | null {
  const [row] = db.select().from(paperAccounts).where(eq(paperAccounts.id, accountId)).limit(1).all();
  return row ?? null;
}

export function getDefaultAccount(): PaperAccount | null {
  const [row] = db
    .select()
    .from(paperAccounts)
    .where(eq(paperAccounts.name, DEFAULT_ACCOUNT_NAME))
    .limit(1)
    .all();
  return row ?? null;
}

export function ensureAccount(name = DEFAULT_ACCOUNT_NAME, startingCash = 100_000): PaperAccount {
  const [existing] = db.select().from(paperAccounts).where(eq(paperAccounts.name, name)).limit(1).all();
  if (existing) return existing;

  const [created] = db
    .insert(paperAccounts)
    .values({ name, cash: startingCash, startingCash, currency: 'USD' })
    .returning()
    .all();
  return created!;
}

export interface PositionRow {
  symbol: string;
  position: Position;
  updatedAt: number;
}

export function getPositions(accountId: number): PositionRow[] {
  return db
    .select()
    .from(paperPositions)
    .where(eq(paperPositions.accountId, accountId))
    .all()
    .map((row) => ({
      symbol: row.symbol,
      position: {
        quantity: row.quantity,
        averagePrice: row.averagePrice,
        realizedPnl: row.realizedPnl,
      },
      updatedAt: row.updatedAt,
    }));
}

export function getFills(accountId: number, limit = 100): PaperFill[] {
  return db
    .select()
    .from(paperFills)
    .where(eq(paperFills.accountId, accountId))
    .orderBy(desc(paperFills.filledAt))
    .limit(limit)
    .all();
}

export interface PricedPosition extends PositionRow {
  price: number | null;
  priceSource: string | null;
  priceStale: boolean;
  marketValue: number | null;
  unrealizedPnl: number | null;
}

export interface Portfolio {
  account: { id: number; name: string; currency: string; startingCash: number };
  valuation: PortfolioValuation;
  positions: PricedPosition[];
  /** Positions whose quote could not be fetched, and why. */
  pricingGaps: Array<{ symbol: string; reason: string }>;
  asOf: number;
}

/** Value the whole book at current market prices. */
export async function getPortfolio(accountId: number): Promise<Portfolio | null> {
  const account = getAccount(accountId);
  if (!account) return null;

  const rows = getPositions(accountId);
  const open = rows.filter((r) => r.position.quantity !== 0);

  const quotes = await Promise.all(
    open.map(async (row) => {
      try {
        const result = await getQuote(row.symbol);
        return { symbol: row.symbol, result };
      } catch (err) {
        return {
          symbol: row.symbol,
          result: {
            ok: false as const,
            code: 'upstream_error' as const,
            message: err instanceof Error ? err.message : String(err),
            source: 'none',
          },
        };
      }
    }),
  );

  const prices: Record<string, number | null> = {};
  const priceMeta: Record<string, { source: string; stale: boolean }> = {};
  const pricingGaps: Array<{ symbol: string; reason: string }> = [];

  for (const { symbol, result } of quotes) {
    if (result.ok) {
      prices[symbol] = result.data.price;
      priceMeta[symbol] = { source: result.provenance.source, stale: result.provenance.stale };
    } else {
      prices[symbol] = null;
      pricingGaps.push({ symbol, reason: result.message });
    }
  }

  const valuation = valuePortfolio(account.cash, account.startingCash, rows, prices);

  const positions: PricedPosition[] = rows.map((row) => {
    const price = prices[row.symbol] ?? null;
    const meta = priceMeta[row.symbol];
    return {
      ...row,
      price,
      priceSource: meta?.source ?? null,
      priceStale: meta?.stale ?? false,
      marketValue: price === null ? null : row.position.quantity * price,
      unrealizedPnl:
        price === null || row.position.quantity === 0
          ? row.position.quantity === 0
            ? 0
            : null
          : (price - row.position.averagePrice) * row.position.quantity,
    };
  });

  return {
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
      startingCash: account.startingCash,
    },
    valuation,
    positions,
    pricingGaps,
    asOf: Date.now(),
  };
}

export interface ExecuteFillInput {
  accountId: number;
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  priceSource: string;
  priceAsOf: number;
}

export interface ExecuteFillResult {
  fillId: number;
  realizedPnl: number;
  cashAfter: number;
  position: Position;
}

/**
 * Book a fill.
 *
 * Position update, cash movement and the fill record go in one transaction, so
 * a crash between them cannot leave the ledger describing a position the cash
 * balance does not agree with.
 */
export function executeFill(input: ExecuteFillInput): ExecuteFillResult {
  return db.transaction((tx) => {
    const [account] = tx.select().from(paperAccounts).where(eq(paperAccounts.id, input.accountId)).limit(1).all();
    if (!account) throw new Error(`Paper account ${input.accountId} does not exist`);

    const [existing] = tx
      .select()
      .from(paperPositions)
      .where(and(eq(paperPositions.accountId, input.accountId), eq(paperPositions.symbol, input.symbol)))
      .limit(1)
      .all();

    const before: Position = existing
      ? { quantity: existing.quantity, averagePrice: existing.averagePrice, realizedPnl: existing.realizedPnl }
      : { quantity: 0, averagePrice: 0, realizedPnl: 0 };

    const outcome = applyFill(before, {
      side: input.side,
      quantity: input.quantity,
      price: input.price,
    });

    const nowMs = Date.now();

    if (existing) {
      tx.update(paperPositions)
        .set({
          quantity: outcome.position.quantity,
          averagePrice: outcome.position.averagePrice,
          realizedPnl: outcome.position.realizedPnl,
          updatedAt: nowMs,
        })
        .where(eq(paperPositions.id, existing.id))
        .run();
    } else {
      tx.insert(paperPositions)
        .values({
          accountId: input.accountId,
          symbol: input.symbol,
          quantity: outcome.position.quantity,
          averagePrice: outcome.position.averagePrice,
          realizedPnl: outcome.position.realizedPnl,
          updatedAt: nowMs,
        })
        .run();
    }

    const cashAfter = account.cash + outcome.cashDelta;
    tx.update(paperAccounts).set({ cash: cashAfter }).where(eq(paperAccounts.id, input.accountId)).run();

    const [fill] = tx
      .insert(paperFills)
      .values({
        accountId: input.accountId,
        orderId: input.orderId,
        symbol: input.symbol,
        side: input.side,
        quantity: input.quantity,
        price: input.price,
        notional: input.quantity * input.price,
        realizedPnl: outcome.realizedPnl,
        priceSource: input.priceSource,
        priceAsOf: input.priceAsOf,
        filledAt: nowMs,
      })
      .returning()
      .all();

    return {
      fillId: fill!.id,
      realizedPnl: outcome.realizedPnl,
      cashAfter,
      position: outcome.position,
    };
  });
}

/** Equity used by the concentration limit. Unpriced names are excluded. */
export async function currentEquity(accountId: number): Promise<number> {
  const portfolio = await getPortfolio(accountId);
  return portfolio?.valuation.equity ?? 0;
}
