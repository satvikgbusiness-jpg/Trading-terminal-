import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { db } from '@/lib/db';
import { orderIntents, type OrderIntent } from '@/lib/db/schema';
import { getQuote } from '@/lib/market/service';
import { appendAudit } from './audit';
import { revokeAllTokens, type AuthContext } from './auth';
import {
  checkPrePriceLimits, checkPricedLimits, loadLimits, lockGateway, readLockState, recordBreach,
  type Breach,
} from './limits';
import { currentEquity, executeFill, getPortfolio } from './paper';
import type { OrderIntentInput } from './schemas';

/**
 * ExecutionGateway.
 *
 * The isolation boundary between an untrusted trading agent and anything that
 * could move money. Every order intent runs the same pipeline:
 *
 *   authenticated -> gateway unlocked -> schema-validated -> priced from a real
 *   quote -> checked against server-side hard limits -> filled on paper, or
 *   queued for a human when flagged live.
 *
 * A live intent never executes on its own. v1 has no broker adapter at all, so
 * even an approved live intent terminates in `blocked_no_broker` -- the approval
 * queue is wired end to end and audited, but there is deliberately nothing
 * behind it to execute against.
 */

/** How long a live intent waits for a human before it lapses. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export type GatewayErrorCode =
  | 'gateway_locked'
  | 'no_market_data'
  | 'limit_breached'
  | 'limit_not_marketable'
  | 'not_found'
  | 'invalid_state';

export interface GatewayError {
  ok: false;
  code: GatewayErrorCode;
  message: string;
  /** Present when the failure was a hard-limit breach. */
  breach?: Breach;
}

export interface SubmitSuccess {
  ok: true;
  intent: PublicIntent;
}

export type SubmitResult = SubmitSuccess | GatewayError;

/** The intent shape returned to the bot. Never exposes internal ids or hashes. */
export interface PublicIntent {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  orderType: 'market' | 'limit';
  limitPrice: number | null;
  mode: 'paper' | 'live';
  status: OrderIntent['status'];
  statusReason: string | null;
  filledPrice: number | null;
  filledAt: number | null;
  createdAt: number;
  expiresAt: number | null;
  clientRef: string | null;
}

export function toPublicIntent(row: OrderIntent): PublicIntent {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    orderType: row.orderType,
    limitPrice: row.limitPrice,
    mode: row.mode,
    status: row.status,
    statusReason: row.statusReason,
    filledPrice: row.filledPrice,
    filledAt: row.filledAt,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    clientRef: row.clientRef,
  };
}

function newIntentId(): string {
  return `ord_${randomBytes(9).toString('base64url')}`;
}

/**
 * Submit an order intent.
 *
 * `input` has already been through the zod schema, so every field is a value of
 * the declared type. This function still treats it as data: nothing here is
 * interpolated into a query or evaluated.
 */
export async function submitOrderIntent(
  auth: AuthContext,
  input: OrderIntentInput,
): Promise<SubmitResult> {
  // 1. A locked gateway refuses everything until a human clears it.
  const lock = readLockState();
  if (lock.locked) {
    return {
      ok: false,
      code: 'gateway_locked',
      message: `Gateway is locked: ${lock.reason ?? 'unknown reason'}. A human must reset it.`,
    };
  }

  // 2. Idempotency: the same clientRef never produces a second order.
  if (input.clientRef) {
    const [existing] = db
      .select()
      .from(orderIntents)
      .where(and(eq(orderIntents.tokenId, auth.tokenId), eq(orderIntents.clientRef, input.clientRef)))
      .limit(1)
      .all();
    if (existing) return { ok: true, intent: toPublicIntent(existing) };
  }

  const limits = loadLimits();

  // 3. Limits that need no price run first. The allowlist is a security control,
  //    so an untrusted caller must not be able to make the gateway fetch a quote
  //    for a symbol it is not permitted to trade.
  const preBreach = checkPrePriceLimits({ accountId: auth.accountId, symbol: input.symbol, limits });
  if (preBreach) return breachResult(auth, input, preBreach);

  // 4. Price the order from a real quote. No quote, no fill.
  const quote = await getQuote(input.symbol).catch(() => null);
  if (!quote || !quote.ok) {
    const reason = quote && !quote.ok ? quote.message : 'symbol could not be priced';
    const intent = recordIntent(auth, input, 'rejected', `no_market_data: ${reason}`);
    appendAudit({
      actor: auth.actor,
      action: 'intent.rejected',
      subjectType: 'intent',
      subjectId: intent.id,
      payload: { reason: 'no_market_data', detail: reason, request: input },
    });
    return {
      ok: false,
      code: 'no_market_data',
      message:
        `No current price for ${input.symbol}: ${reason}. ` +
        'Orders are never filled at an estimated or stale-substitute price.',
    };
  }

  const marketPrice = quote.data.price;

  // 5. Size limits, evaluated against the position this order would produce.
  const equity = await currentEquity(auth.accountId);
  const breach = checkPricedLimits({
    accountId: auth.accountId,
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
    price: input.orderType === 'limit' ? (input.limitPrice ?? marketPrice) : marketPrice,
    equity,
    limits,
  });

  if (breach) return breachResult(auth, input, breach);

  // 6. Live intents queue for a human. They never execute here.
  if (input.mode === 'live') {
    const expiresAt = Date.now() + APPROVAL_TTL_MS;
    const intent = recordIntent(auth, input, 'pending_approval', null, expiresAt);
    appendAudit({
      actor: auth.actor,
      action: 'intent.queued_for_approval',
      subjectType: 'intent',
      subjectId: intent.id,
      payload: {
        request: input,
        referencePrice: marketPrice,
        priceSource: quote.provenance.source,
        expiresAt,
      },
    });
    return { ok: true, intent: toPublicIntent(intent) };
  }

  // 7. Paper fill against the real quote.
  if (input.orderType === 'limit') {
    const limitPrice = input.limitPrice!;
    const marketable = input.side === 'buy' ? marketPrice <= limitPrice : marketPrice >= limitPrice;
    if (!marketable) {
      const reason =
        `limit ${limitPrice} is not marketable against ${marketPrice}. ` +
        'The paper engine fills immediately or not at all; it does not rest orders.';
      const intent = recordIntent(auth, input, 'rejected', `limit_not_marketable: ${reason}`);
      appendAudit({
        actor: auth.actor,
        action: 'intent.rejected',
        subjectType: 'intent',
        subjectId: intent.id,
        payload: { reason: 'limit_not_marketable', marketPrice, limitPrice },
      });
      return { ok: false, code: 'limit_not_marketable', message: reason };
    }
  }

  const intent = recordIntent(auth, input, 'filled', null);
  const fill = executeFill({
    accountId: auth.accountId,
    orderId: intent.id,
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
    price: marketPrice,
    priceSource: quote.provenance.source,
    priceAsOf: quote.data.timestamp,
  });

  const [updated] = db
    .update(orderIntents)
    .set({ filledPrice: marketPrice, filledAt: Date.now() })
    .where(eq(orderIntents.id, intent.id))
    .returning()
    .all();

  appendAudit({
    actor: auth.actor,
    action: 'intent.filled',
    subjectType: 'intent',
    subjectId: intent.id,
    payload: {
      request: input,
      price: marketPrice,
      priceSource: quote.provenance.source,
      priceStale: quote.provenance.stale,
      realizedPnl: fill.realizedPnl,
      cashAfter: fill.cashAfter,
    },
  });

  return { ok: true, intent: toPublicIntent(updated ?? intent) };
}

/**
 * Record a breach, lock the gateway, and answer the caller.
 *
 * A breach by an agent assumed to be self-modifying is treated as a signal, not
 * a routine rejection: the gateway locks until a human looks at it.
 */
function breachResult(auth: AuthContext, input: OrderIntentInput, breach: Breach): GatewayError {
  const intent = recordIntent(auth, input, 'rejected', `${breach.code}: ${breach.message}`);
  recordBreach(breach, auth.actor, { intentId: intent.id, request: input });
  return {
    ok: false,
    code: 'limit_breached',
    message: `${breach.message}. The gateway is now locked and requires a human reset.`,
    breach,
  };
}

function recordIntent(
  auth: AuthContext,
  input: OrderIntentInput,
  status: OrderIntent['status'],
  statusReason: string | null,
  expiresAt?: number,
): OrderIntent {
  const [row] = db
    .insert(orderIntents)
    .values({
      id: newIntentId(),
      tokenId: auth.tokenId,
      accountId: auth.accountId,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      orderType: input.orderType,
      limitPrice: input.limitPrice ?? null,
      mode: input.mode,
      status,
      statusReason,
      clientRef: input.clientRef ?? null,
      createdAt: Date.now(),
      expiresAt: expiresAt ?? null,
    })
    .returning()
    .all();

  if (status === 'rejected' || status === 'filled') {
    appendAudit({
      actor: auth.actor,
      action: 'intent.submitted',
      subjectType: 'intent',
      subjectId: row!.id,
      payload: { request: input, initialStatus: status },
    });
  }
  return row!;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function getIntent(id: string, accountId?: number): OrderIntent | null {
  const [row] = db.select().from(orderIntents).where(eq(orderIntents.id, id)).limit(1).all();
  if (!row) return null;
  // A token may only read intents belonging to its own account.
  if (accountId !== undefined && row.accountId !== accountId) return null;
  return expireIfLapsed(row);
}

/**
 * Approvals lapse on the clock, not on a sweeper run. Every read re-checks the
 * deadline so an expired intent can never be approved because the background
 * job happened not to have run yet.
 */
function expireIfLapsed(row: OrderIntent): OrderIntent {
  if (row.status !== 'pending_approval' || row.expiresAt === null || row.expiresAt > Date.now()) {
    return row;
  }
  const [updated] = db
    .update(orderIntents)
    .set({ status: 'expired', statusReason: 'approval window elapsed', decidedAt: Date.now() })
    .where(and(eq(orderIntents.id, row.id), eq(orderIntents.status, 'pending_approval')))
    .returning()
    .all();

  if (updated) {
    appendAudit({
      actor: 'system',
      action: 'intent.expired',
      subjectType: 'intent',
      subjectId: row.id,
      payload: { expiresAt: row.expiresAt },
    });
  }
  return updated ?? row;
}

export function listIntents(accountId: number, limit = 100): OrderIntent[] {
  return db
    .select()
    .from(orderIntents)
    .where(eq(orderIntents.accountId, accountId))
    .orderBy(desc(orderIntents.createdAt))
    .limit(limit)
    .all()
    .map(expireIfLapsed);
}

/** The human-facing approval queue. */
export function pendingApprovals(): OrderIntent[] {
  return db
    .select()
    .from(orderIntents)
    .where(eq(orderIntents.status, 'pending_approval'))
    .orderBy(desc(orderIntents.createdAt))
    .all()
    .map(expireIfLapsed)
    .filter((row) => row.status === 'pending_approval');
}

/** Mark every lapsed approval expired. Called by the worker. */
export function expireStaleApprovals(): number {
  const stale = db
    .select()
    .from(orderIntents)
    .where(and(eq(orderIntents.status, 'pending_approval'), lte(orderIntents.expiresAt, Date.now())))
    .all();

  for (const row of stale) expireIfLapsed(row);
  return stale.length;
}

/* ------------------------------------------------------------------ */
/* Human decisions                                                     */
/* ------------------------------------------------------------------ */

export type DecisionResult = { ok: true; intent: PublicIntent } | GatewayError;

/**
 * Approve a queued live intent.
 *
 * Approval is recorded and audited, and then the intent stops: v1 has no
 * broker adapter, so there is nothing to route it to. The terminal says so
 * explicitly rather than pretending an order went somewhere.
 */
export function approveIntent(id: string, actor: string, note?: string): DecisionResult {
  const row = getIntent(id);
  if (!row) return { ok: false, code: 'not_found', message: `No intent ${id}` };

  if (row.status !== 'pending_approval') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `Intent ${id} is ${row.status}, not awaiting approval`,
    };
  }

  const nowMs = Date.now();
  appendAudit({
    actor,
    action: 'intent.approved',
    subjectType: 'intent',
    subjectId: id,
    payload: { note: note ?? null, symbol: row.symbol, side: row.side, quantity: row.quantity },
  });

  const [updated] = db
    .update(orderIntents)
    .set({
      status: 'blocked_no_broker',
      statusReason:
        'Approved by a human, but this build has no live execution path. ' +
        'No broker adapter is configured and none ships in v1.',
      decidedAt: nowMs,
      decidedBy: actor,
    })
    .where(eq(orderIntents.id, id))
    .returning()
    .all();

  appendAudit({
    actor: 'system',
    action: 'intent.blocked_no_broker',
    subjectType: 'intent',
    subjectId: id,
    payload: { reason: 'v1 has no real-money execution path' },
  });

  return { ok: true, intent: toPublicIntent(updated!) };
}

export function rejectIntent(id: string, actor: string, note?: string): DecisionResult {
  const row = getIntent(id);
  if (!row) return { ok: false, code: 'not_found', message: `No intent ${id}` };
  if (row.status !== 'pending_approval') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `Intent ${id} is ${row.status}, not awaiting approval`,
    };
  }

  const [updated] = db
    .update(orderIntents)
    .set({
      status: 'rejected',
      statusReason: note ? `rejected by ${actor}: ${note}` : `rejected by ${actor}`,
      decidedAt: Date.now(),
      decidedBy: actor,
    })
    .where(eq(orderIntents.id, id))
    .returning()
    .all();

  appendAudit({
    actor,
    action: 'intent.rejected_by_human',
    subjectType: 'intent',
    subjectId: id,
    payload: { note: note ?? null },
  });

  return { ok: true, intent: toPublicIntent(updated!) };
}

/* ------------------------------------------------------------------ */
/* Kill switch                                                         */
/* ------------------------------------------------------------------ */

export interface KillSwitchResult {
  revokedTokens: string[];
  cancelledIntents: string[];
  lockedAt: number;
}

/**
 * One action, three effects: revoke every token so the bot cannot authenticate,
 * cancel every intent still in flight, and lock the gateway so nothing resumes
 * until a human clears it.
 */
export function killSwitch(actor: string, reason = 'kill switch engaged'): KillSwitchResult {
  const revokedTokens = revokeAllTokens(reason, actor);

  const openIntents = db
    .select()
    .from(orderIntents)
    .where(inArray(orderIntents.status, ['pending_approval', 'approved']))
    .all();

  const cancelledIntents: string[] = [];
  for (const intent of openIntents) {
    db.update(orderIntents)
      .set({ status: 'cancelled', statusReason: reason, decidedAt: Date.now(), decidedBy: actor })
      .where(eq(orderIntents.id, intent.id))
      .run();
    appendAudit({
      actor,
      action: 'intent.cancelled',
      subjectType: 'intent',
      subjectId: intent.id,
      payload: { reason },
    });
    cancelledIntents.push(intent.id);
  }

  lockGateway(reason, actor);

  appendAudit({
    actor,
    action: 'gateway.kill_switch',
    subjectType: 'gateway',
    subjectId: 'state',
    payload: { reason, revokedTokens, cancelledIntents },
  });

  return { revokedTokens, cancelledIntents, lockedAt: Date.now() };
}

export { getPortfolio };
