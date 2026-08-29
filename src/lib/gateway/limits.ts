import 'server-only';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '@/lib/db';
import { gatewayState, orderIntents, paperFills, paperPositions } from '@/lib/db/schema';
import { tryResolveAsset } from '@/lib/symbols';
import { appendAudit } from './audit';

/**
 * Hard limits, enforced here and nowhere else.
 *
 * The bot is untrusted and self-modifying, so any limit it could enforce on
 * itself is not a limit. These checks run inside the gateway, on the server,
 * after the request has been authenticated and validated, and they read state
 * from the database rather than from anything the caller sent.
 *
 * A breach locks the gateway. That is deliberately strict: for an agent assumed
 * to be capable of rewriting its own code, an attempt to exceed a position cap
 * or trade an instrument outside the allowlist is a signal that something is
 * wrong, not a routine rejection to retry past. Clearing the lock requires a
 * human on the /bot screen.
 */

export interface RiskLimits {
  /** Largest absolute notional a single order may carry. */
  maxOrderNotional: number;
  /** Largest absolute notional any one position may reach. */
  maxPositionNotional: number;
  /** Largest share of account equity any one position may reach, as a percent. */
  maxPositionPercentEquity: number;
  /** Realised loss for the UTC day at which the gateway stops accepting orders. */
  maxDailyLoss: number;
  maxOrdersPerMinute: number;
  maxOrdersPerDay: number;
  /**
   * Symbols the bot may trade. Empty means "nothing" rather than "everything" --
   * an allowlist that defaults to open is not an allowlist.
   */
  instrumentAllowlist: string[];
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}

export const DEFAULT_ALLOWLIST = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM', 'SPY',
  'BTC-USD', 'ETH-USD', 'SOL-USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY',
];

export function loadLimits(): RiskLimits {
  const rawAllowlist = process.env.GMT_INSTRUMENT_ALLOWLIST;
  const instrumentAllowlist = (
    rawAllowlist === undefined || rawAllowlist.trim() === ''
      ? DEFAULT_ALLOWLIST
      : rawAllowlist.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  ).filter((symbol) => tryResolveAsset(symbol) !== null);

  return {
    maxOrderNotional: num('GMT_MAX_ORDER_NOTIONAL', 10_000),
    maxPositionNotional: num('GMT_MAX_POSITION_NOTIONAL', 25_000),
    maxPositionPercentEquity: num('GMT_MAX_POSITION_PERCENT_EQUITY', 20),
    maxDailyLoss: num('GMT_MAX_DAILY_LOSS', 2_500),
    maxOrdersPerMinute: num('GMT_MAX_ORDERS_PER_MINUTE', 10),
    maxOrdersPerDay: num('GMT_MAX_ORDERS_PER_DAY', 200),
    instrumentAllowlist,
  };
}

/* ------------------------------------------------------------------ */
/* Lock state                                                          */
/* ------------------------------------------------------------------ */

export interface LockState {
  locked: boolean;
  reason: string | null;
  lockedAt: number | null;
  lockedBy: string | null;
}

export function readLockState(): LockState {
  const [row] = db.select().from(gatewayState).where(eq(gatewayState.id, 1)).limit(1).all();
  if (!row) return { locked: false, reason: null, lockedAt: null, lockedBy: null };
  return {
    locked: row.locked,
    reason: row.lockReason,
    lockedAt: row.lockedAt,
    lockedBy: row.lockedBy,
  };
}

export function lockGateway(reason: string, actor: string): void {
  const nowMs = Date.now();
  db.insert(gatewayState)
    .values({ id: 1, locked: true, lockReason: reason, lockedAt: nowMs, lockedBy: actor, updatedAt: nowMs })
    .onConflictDoUpdate({
      target: gatewayState.id,
      set: { locked: true, lockReason: reason, lockedAt: nowMs, lockedBy: actor, updatedAt: nowMs },
    })
    .run();

  appendAudit({
    actor,
    action: 'gateway.locked',
    subjectType: 'gateway',
    subjectId: 'state',
    payload: { reason },
  });
}

/**
 * Clear the lock. Only ever called from the human-facing admin route -- there is
 * no gateway endpoint a bot could reach that unlocks itself.
 */
export function unlockGateway(actor: string, note?: string): void {
  const nowMs = Date.now();
  db.insert(gatewayState)
    .values({ id: 1, locked: false, lockReason: null, lockedAt: null, lockedBy: null, updatedAt: nowMs })
    .onConflictDoUpdate({
      target: gatewayState.id,
      set: { locked: false, lockReason: null, lockedAt: null, lockedBy: null, updatedAt: nowMs },
    })
    .run();

  appendAudit({
    actor,
    action: 'gateway.unlocked',
    subjectType: 'gateway',
    subjectId: 'state',
    payload: { note: note ?? null },
  });
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

export type BreachCode =
  | 'instrument_not_allowed'
  | 'order_notional_exceeded'
  | 'position_notional_exceeded'
  | 'position_concentration_exceeded'
  | 'daily_loss_exceeded'
  | 'order_rate_exceeded'
  | 'daily_order_count_exceeded';

export interface Breach {
  code: BreachCode;
  message: string;
  /** The configured ceiling and what the request would have made it. */
  limit: number;
  actual: number;
}

export interface PrePriceContext {
  accountId: number;
  symbol: string;
  limits: RiskLimits;
  now?: number;
}

export interface CheckContext extends PrePriceContext {
  side: 'buy' | 'sell';
  quantity: number;
  /** Price used to value the order. Always a real quote, never an estimate. */
  price: number;
  /** Total account equity: cash plus the market value of open positions. */
  equity: number;
}

/** UTC day key, matching risk_counters.day. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Limits that can be evaluated without a price.
 *
 * These run *before* the gateway fetches a quote. The instrument allowlist is a
 * security control, so an untrusted caller must not be able to make the gateway
 * issue an outbound request for a symbol it is not permitted to trade -- that
 * would leak the allowlist through timing and burn the shared rate budget on
 * arbitrary symbols. The rate and daily-loss caps run here too, so a bot cannot
 * spin on requests that are certain to fail later in the pipeline.
 */
export function checkPrePriceLimits(ctx: PrePriceContext): Breach | null {
  const now = ctx.now ?? Date.now();

  if (!ctx.limits.instrumentAllowlist.includes(ctx.symbol)) {
    return {
      code: 'instrument_not_allowed',
      message:
        `${ctx.symbol} is not on the instrument allowlist ` +
        `(${ctx.limits.instrumentAllowlist.length} symbols permitted)`,
      limit: ctx.limits.instrumentAllowlist.length,
      actual: 0,
    };
  }

  const startOfDay = Date.parse(`${dayKey(now)}T00:00:00Z`);

  const todaysFills = db
    .select()
    .from(paperFills)
    .where(and(eq(paperFills.accountId, ctx.accountId), gte(paperFills.filledAt, startOfDay)))
    .all();

  const realizedToday = todaysFills.reduce((sum, f) => sum + f.realizedPnl, 0);
  if (realizedToday <= -ctx.limits.maxDailyLoss) {
    return {
      code: 'daily_loss_exceeded',
      message:
        `Realised loss today is ${Math.abs(realizedToday).toFixed(2)}, ` +
        `at or past the ${ctx.limits.maxDailyLoss} daily loss limit`,
      limit: ctx.limits.maxDailyLoss,
      actual: Math.abs(realizedToday),
    };
  }

  // Order rate is counted from submitted intents, not fills, so a bot cannot
  // evade it by sending orders that are certain to be rejected downstream.
  const recentIntents = db
    .select()
    .from(orderIntents)
    .where(and(eq(orderIntents.accountId, ctx.accountId), gte(orderIntents.createdAt, now - 60_000)))
    .all();

  if (recentIntents.length >= ctx.limits.maxOrdersPerMinute) {
    return {
      code: 'order_rate_exceeded',
      message: `${recentIntents.length} orders in the last minute, at the limit of ${ctx.limits.maxOrdersPerMinute}`,
      limit: ctx.limits.maxOrdersPerMinute,
      actual: recentIntents.length,
    };
  }

  const todaysIntents = db
    .select()
    .from(orderIntents)
    .where(and(eq(orderIntents.accountId, ctx.accountId), gte(orderIntents.createdAt, startOfDay)))
    .all();

  if (todaysIntents.length >= ctx.limits.maxOrdersPerDay) {
    return {
      code: 'daily_order_count_exceeded',
      message: `${todaysIntents.length} orders today, at the daily limit of ${ctx.limits.maxOrdersPerDay}`,
      limit: ctx.limits.maxOrdersPerDay,
      actual: todaysIntents.length,
    };
  }

  return null;
}

/**
 * Limits that need a price: order size, position size and concentration.
 *
 * Position caps apply to the position the order would *produce*, not the one
 * that exists now, so a sequence of individually-legal orders cannot walk past
 * the cap.
 */
export function checkPricedLimits(ctx: CheckContext): Breach | null {
  const notional = Math.abs(ctx.quantity * ctx.price);

  if (notional > ctx.limits.maxOrderNotional) {
    return {
      code: 'order_notional_exceeded',
      message: `Order notional ${notional.toFixed(2)} exceeds the per-order cap of ${ctx.limits.maxOrderNotional}`,
      limit: ctx.limits.maxOrderNotional,
      actual: notional,
    };
  }

  const [position] = db
    .select()
    .from(paperPositions)
    .where(and(eq(paperPositions.accountId, ctx.accountId), eq(paperPositions.symbol, ctx.symbol)))
    .limit(1)
    .all();

  const currentQty = position?.quantity ?? 0;
  const delta = ctx.side === 'buy' ? ctx.quantity : -ctx.quantity;
  const projectedQty = currentQty + delta;
  const projectedNotional = Math.abs(projectedQty * ctx.price);

  // Reducing exposure is always allowed, even from a position already over a cap
  // -- otherwise a limit change could trap the account in a position it cannot exit.
  const reducesExposure = Math.abs(projectedQty) < Math.abs(currentQty);
  if (reducesExposure) return null;

  if (projectedNotional > ctx.limits.maxPositionNotional) {
    return {
      code: 'position_notional_exceeded',
      message:
        `Order would take the ${ctx.symbol} position to ${projectedNotional.toFixed(2)}, ` +
        `over the ${ctx.limits.maxPositionNotional} per-position cap`,
      limit: ctx.limits.maxPositionNotional,
      actual: projectedNotional,
    };
  }

  if (ctx.equity > 0) {
    const concentration = (projectedNotional / ctx.equity) * 100;
    if (concentration > ctx.limits.maxPositionPercentEquity) {
      return {
        code: 'position_concentration_exceeded',
        message:
          `Order would take ${ctx.symbol} to ${concentration.toFixed(1)}% of equity, ` +
          `over the ${ctx.limits.maxPositionPercentEquity}% concentration cap`,
        limit: ctx.limits.maxPositionPercentEquity,
        actual: concentration,
      };
    }
  }

  return null;
}

/** Record a breach and lock the gateway. */
export function recordBreach(breach: Breach, actor: string, context: Record<string, unknown>): void {
  appendAudit({
    actor,
    action: 'limit.breached',
    subjectType: 'gateway',
    subjectId: 'limits',
    payload: { ...breach, ...context },
  });
  lockGateway(`${breach.code}: ${breach.message}`, actor);
}
