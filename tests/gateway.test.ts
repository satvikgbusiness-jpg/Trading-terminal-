import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, destroyTestDatabase } from './helpers/db';
import type { Result } from '@/lib/market/types';
import type { Quote } from '@/lib/market/types';

/**
 * Gateway integration tests.
 *
 * These run against a real SQLite database with the real schema and the real
 * append-only triggers. The only thing stubbed is the market data layer, so
 * fills can be driven from known prices.
 */

const dbFile = createTestDatabase('gateway');
process.env.DATABASE_URL = dbFile;
process.env.GMT_INSTRUMENT_ALLOWLIST = 'AAPL,MSFT,BTC-USD';
process.env.GMT_MAX_ORDER_NOTIONAL = '10000';
process.env.GMT_MAX_POSITION_NOTIONAL = '25000';
process.env.GMT_MAX_POSITION_PERCENT_EQUITY = '50';
process.env.GMT_MAX_DAILY_LOSS = '2500';
process.env.GMT_MAX_ORDERS_PER_MINUTE = '10';
process.env.GMT_MAX_ORDERS_PER_DAY = '200';

/** Prices the stubbed feed will return, keyed by symbol. Null means "no data". */
const feed: Record<string, number | null> = { AAPL: 100, MSFT: 200, 'BTC-USD': 50_000 };

vi.mock('@/lib/market/service', () => ({
  getQuote: async (symbol: string): Promise<Result<Quote>> => {
    const price = feed[symbol];
    if (price === null || price === undefined) {
      return { ok: false, code: 'upstream_error', message: `no feed for ${symbol}`, source: 'test' };
    }
    return {
      ok: true,
      data: {
        symbol,
        price,
        previousClose: price,
        change: 0,
        changePercent: 0,
        dayOpen: price,
        dayHigh: price,
        dayLow: price,
        timestamp: Date.now(),
      },
      provenance: { source: 'TestFeed', fetchedAt: Date.now(), delayMinutes: 0, stale: false },
    };
  },
  getQuotes: async () => ({}),
  getCandles: async () => ({ ok: false, code: 'unsupported', message: 'stub', source: 'test' }),
  getNews: async () => ({ ok: false, code: 'unsupported', message: 'stub', source: 'test' }),
}));

type Mod = {
  db: typeof import('@/lib/db').db;
  schema: typeof import('@/lib/db/schema');
  auth: typeof import('@/lib/gateway/auth');
  audit: typeof import('@/lib/gateway/audit');
  limits: typeof import('@/lib/gateway/limits');
  paper: typeof import('@/lib/gateway/paper');
  service: typeof import('@/lib/gateway/service');
};

let m: Mod;
let accountId: number;

beforeAll(async () => {
  const [dbMod, schema, auth, audit, limits, paper, service] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('@/lib/gateway/auth'),
    import('@/lib/gateway/audit'),
    import('@/lib/gateway/limits'),
    import('@/lib/gateway/paper'),
    import('@/lib/gateway/service'),
  ]);
  m = { db: dbMod.db, schema, auth, audit, limits, paper, service };
  accountId = m.paper.ensureAccount('test-account', 100_000).id;
});

afterAll(() => destroyTestDatabase(dbFile));

beforeEach(() => {
  // Reset everything except the append-only audit log, which by design cannot
  // be cleared -- the chain simply keeps growing across tests.
  m.db.delete(m.schema.orderIntents).run();
  m.db.delete(m.schema.paperFills).run();
  m.db.delete(m.schema.paperPositions).run();
  m.db.update(m.schema.paperAccounts).set({ cash: 100_000 }).run();
  m.limits.unlockGateway('test-reset');
  feed.AAPL = 100;
  feed.MSFT = 200;
  feed['BTC-USD'] = 50_000;
});

function botContext(scopes?: import('@/lib/gateway/auth').Scope[]) {
  const issued = m.auth.issueToken({ name: `bot-${Math.random()}`, accountId, scopes });
  const result = m.auth.authenticate(`Bearer ${issued.token}`);
  if (!result.ok) throw new Error('token should authenticate');
  return { issued, ctx: result.context };
}

const order = (over: Partial<import('@/lib/gateway/schemas').OrderIntentInput> = {}) => ({
  symbol: 'AAPL',
  side: 'buy' as const,
  quantity: 10,
  orderType: 'market' as const,
  mode: 'paper' as const,
  ...over,
});

/* ------------------------------------------------------------------ */

describe('token auth', () => {
  it('accepts a freshly issued token and never stores the secret', () => {
    const { issued } = botContext();
    const row = m.db.select().from(m.schema.gatewayTokens).all().find((t) => t.id === issued.id)!;
    expect(row.tokenHash).not.toContain(issued.token);
    expect(JSON.stringify(m.auth.listTokens())).not.toContain(issued.token);
  });

  it('rejects a missing, malformed, or unknown token', () => {
    expect(m.auth.authenticate(null)).toMatchObject({ ok: false, failure: { reason: 'missing' } });
    expect(m.auth.authenticate('Bearer nonsense')).toMatchObject({ ok: false, failure: { reason: 'malformed' } });
    // Wrong shape entirely.
    expect(m.auth.authenticate('Bearer gmt_deadbeef_short')).toMatchObject({
      ok: false,
      failure: { reason: 'malformed' },
    });
    // Well-formed, but no such token.
    expect(
      m.auth.authenticate('Bearer gmt_00112233445566aa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    ).toMatchObject({ ok: false, failure: { reason: 'unknown' } });
  });

  it('rejects a valid id with the wrong secret', () => {
    const { issued } = botContext();
    const result = m.auth.authenticate(`Bearer gmt_${issued.id}_notTheSecret`);
    expect(result.ok).toBe(false);
  });

  it('rejects a revoked token', () => {
    const { issued } = botContext();
    m.auth.revokeToken(issued.id, 'test');
    expect(m.auth.authenticate(`Bearer ${issued.token}`)).toMatchObject({
      ok: false,
      failure: { reason: 'revoked' },
    });
  });

  it('has no scope that reaches secrets or funds', () => {
    for (const scope of m.auth.SCOPES) {
      expect(scope).toMatch(/^(portfolio|quote|order):(read|submit)$/);
    }
    expect(m.auth.SCOPES).not.toContain('secrets:read');
    expect(m.auth.SCOPES.some((s) => /withdraw|transfer|secret|admin/i.test(s))).toBe(false);
  });

  it('issues narrower tokens when asked', () => {
    const { ctx } = botContext(['quote:read']);
    expect(m.auth.hasScope(ctx, 'quote:read')).toBe(true);
    expect(m.auth.hasScope(ctx, 'order:submit')).toBe(false);
  });
});

describe('paper fills', () => {
  it('fills a market order against the real quote and updates the ledger', async () => {
    const { ctx } = botContext();
    const result = await m.service.submitOrderIntent(ctx, order());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.intent.status).toBe('filled');
    expect(result.intent.filledPrice).toBe(100);

    const portfolio = await m.paper.getPortfolio(accountId);
    expect(portfolio!.valuation.cash).toBe(99_000);
    expect(portfolio!.positions.find((p) => p.symbol === 'AAPL')!.position).toMatchObject({
      quantity: 10,
      averagePrice: 100,
    });
  });

  it('books P&L on a round trip', async () => {
    const { ctx } = botContext();
    await m.service.submitOrderIntent(ctx, order({ quantity: 10 }));
    feed.AAPL = 130;
    await m.service.submitOrderIntent(ctx, order({ side: 'sell', quantity: 10 }));

    const portfolio = await m.paper.getPortfolio(accountId);
    expect(portfolio!.valuation.cash).toBe(100_300);
    expect(portfolio!.valuation.realizedPnl).toBeCloseTo(300, 6);
  });

  it('refuses to fill when there is no price, rather than inventing one', async () => {
    const { ctx } = botContext();
    feed.AAPL = null;
    const result = await m.service.submitOrderIntent(ctx, order());
    expect(result).toMatchObject({ ok: false, code: 'no_market_data' });
    if (result.ok) return;
    expect(result.message).toMatch(/never filled at an estimated/i);

    // Nothing moved.
    const portfolio = await m.paper.getPortfolio(accountId);
    expect(portfolio!.valuation.cash).toBe(100_000);
    expect(m.paper.getFills(accountId)).toHaveLength(0);
  });

  it('fills a marketable limit order and rejects an unmarketable one', async () => {
    const { ctx } = botContext();
    const good = await m.service.submitOrderIntent(
      ctx,
      order({ orderType: 'limit', limitPrice: 105 }),
    );
    expect(good.ok && good.intent.status).toBe('filled');

    const bad = await m.service.submitOrderIntent(
      ctx,
      order({ orderType: 'limit', limitPrice: 95, clientRef: 'unmarketable-1' }),
    );
    expect(bad).toMatchObject({ ok: false, code: 'limit_not_marketable' });
  });

  it('treats clientRef as an idempotency key', async () => {
    const { ctx } = botContext();
    const first = await m.service.submitOrderIntent(ctx, order({ clientRef: 'abc-123' }));
    const second = await m.service.submitOrderIntent(ctx, order({ clientRef: 'abc-123' }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.intent.id).toBe(first.intent.id);
    expect(m.paper.getFills(accountId)).toHaveLength(1);
  });
});

describe('hard limits', () => {
  it('blocks an instrument off the allowlist and locks the gateway', async () => {
    const { ctx } = botContext();
    // TSLA is a real symbol with no stub price. The allowlist must reject it
    // before the gateway ever tries to fetch a quote for it.
    const result = await m.service.submitOrderIntent(ctx, order({ symbol: 'TSLA' }));
    expect(result).toMatchObject({ ok: false, code: 'limit_breached' });
    if (result.ok) return;
    expect(result.breach!.code).toBe('instrument_not_allowed');
    expect(m.limits.readLockState().locked).toBe(true);
  });

  it('blocks an order over the per-order notional cap', async () => {
    const { ctx } = botContext();
    // 200 x 100 = 20,000, over the 10,000 cap.
    const result = await m.service.submitOrderIntent(ctx, order({ quantity: 200 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.breach!.code).toBe('order_notional_exceeded');
  });

  it('blocks a sequence of small orders that would walk past the position cap', async () => {
    const { ctx } = botContext();
    // Cap is 25,000. Each order is 9,000 of AAPL; the third would reach 27,000.
    for (let i = 0; i < 2; i += 1) {
      const ok = await m.service.submitOrderIntent(ctx, order({ quantity: 90, clientRef: `walk-${i}` }));
      expect(ok.ok).toBe(true);
    }
    const blocked = await m.service.submitOrderIntent(ctx, order({ quantity: 90, clientRef: 'walk-2' }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.breach!.code).toBe('position_notional_exceeded');
  });

  it('always allows reducing an oversized position', async () => {
    const { ctx } = botContext();
    await m.service.submitOrderIntent(ctx, order({ quantity: 90, clientRef: 'r1' }));
    m.limits.unlockGateway('test');
    // Selling reduces exposure and must pass even as caps tighten around it.
    process.env.GMT_MAX_POSITION_NOTIONAL = '1';
    const reduce = await m.service.submitOrderIntent(
      ctx,
      order({ side: 'sell', quantity: 50, clientRef: 'r2' }),
    );
    process.env.GMT_MAX_POSITION_NOTIONAL = '25000';
    expect(reduce.ok).toBe(true);
  });

  it('stops accepting orders once the daily loss limit is reached', async () => {
    const { ctx } = botContext();
    await m.service.submitOrderIntent(ctx, order({ quantity: 100, clientRef: 'loss-open' }));
    feed.AAPL = 70; // a 3,000 loss on 100 shares, past the 2,500 limit
    await m.service.submitOrderIntent(ctx, order({ side: 'sell', quantity: 100, clientRef: 'loss-close' }));

    m.limits.unlockGateway('test');
    feed.AAPL = 100;
    const blocked = await m.service.submitOrderIntent(ctx, order({ clientRef: 'after-loss' }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.breach!.code).toBe('daily_loss_exceeded');
  });

  it('enforces the order rate limit against submissions, not fills', async () => {
    const { ctx } = botContext();
    // Rejected orders still count, so a bot cannot spin on doomed requests.
    feed.MSFT = null;
    for (let i = 0; i < 10; i += 1) {
      await m.service.submitOrderIntent(ctx, order({ symbol: 'MSFT', clientRef: `rate-${i}` }));
    }
    feed.MSFT = 200;
    const blocked = await m.service.submitOrderIntent(ctx, order({ clientRef: 'rate-final' }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.breach!.code).toBe('order_rate_exceeded');
  });

  it('refuses everything while locked, until a human unlocks', async () => {
    const { ctx } = botContext();
    m.limits.lockGateway('test lock', 'human');

    const blocked = await m.service.submitOrderIntent(ctx, order());
    expect(blocked).toMatchObject({ ok: false, code: 'gateway_locked' });

    m.limits.unlockGateway('human');
    const allowed = await m.service.submitOrderIntent(ctx, order({ clientRef: 'after-unlock' }));
    expect(allowed.ok).toBe(true);
  });

  it('exposes no bot-reachable way to unlock itself', async () => {
    const gatewayApi = Object.keys(m.service);
    expect(gatewayApi).not.toContain('unlockGateway');
    // unlockGateway lives in the limits module, which no gateway route exports.
    expect(typeof m.limits.unlockGateway).toBe('function');
  });
});

describe('live intents and the approval queue', () => {
  it('queues a live intent instead of filling it', async () => {
    const { ctx } = botContext();
    const result = await m.service.submitOrderIntent(ctx, order({ mode: 'live' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.intent.status).toBe('pending_approval');
    expect(result.intent.filledPrice).toBeNull();
    expect(m.paper.getFills(accountId)).toHaveLength(0);
    expect(m.service.pendingApprovals()).toHaveLength(1);
  });

  it('sets a ten-minute approval deadline', async () => {
    const { ctx } = botContext();
    const before = Date.now();
    const result = await m.service.submitOrderIntent(ctx, order({ mode: 'live' }));
    if (!result.ok) throw new Error('expected queue');
    const ttl = result.intent.expiresAt! - before;
    expect(ttl).toBeGreaterThan(9.5 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 1_000);
    expect(m.service.APPROVAL_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('expires a lapsed approval on read, not only when a sweeper runs', async () => {
    const { ctx } = botContext();
    const result = await m.service.submitOrderIntent(ctx, order({ mode: 'live' }));
    if (!result.ok) throw new Error('expected queue');

    // Backdate the deadline directly, as the passage of time would.
    m.db.update(m.schema.orderIntents).set({ expiresAt: Date.now() - 1 }).run();

    const read = m.service.getIntent(result.intent.id);
    expect(read!.status).toBe('expired');
    expect(m.service.pendingApprovals()).toHaveLength(0);

    const decision = m.service.approveIntent(result.intent.id, 'human');
    expect(decision).toMatchObject({ ok: false, code: 'invalid_state' });
  });

  it('never auto-approves: an approved live intent still has nowhere to execute', async () => {
    const { ctx } = botContext();
    const result = await m.service.submitOrderIntent(ctx, order({ mode: 'live' }));
    if (!result.ok) throw new Error('expected queue');

    const decision = m.service.approveIntent(result.intent.id, 'human', 'looks fine');
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.intent.status).toBe('blocked_no_broker');
    expect(decision.intent.statusReason).toMatch(/no live execution path/i);
    // Approval must not have produced a paper fill either.
    expect(m.paper.getFills(accountId)).toHaveLength(0);
  });

  it('records a human rejection with the decider and note', async () => {
    const { ctx } = botContext();
    const result = await m.service.submitOrderIntent(ctx, order({ mode: 'live' }));
    if (!result.ok) throw new Error('expected queue');

    const decision = m.service.rejectIntent(result.intent.id, 'human', 'too large');
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.intent.status).toBe('rejected');
    expect(decision.intent.statusReason).toContain('too large');
  });
});

describe('kill switch', () => {
  it('revokes tokens, cancels open intents, and locks the gateway', async () => {
    const { issued, ctx } = botContext();
    const queued = await m.service.submitOrderIntent(ctx, order({ mode: 'live' }));
    if (!queued.ok) throw new Error('expected queue');

    const result = m.service.killSwitch('human', 'unexpected behaviour');

    expect(result.revokedTokens).toContain(issued.id);
    expect(result.cancelledIntents).toContain(queued.intent.id);
    expect(m.limits.readLockState().locked).toBe(true);
    expect(m.auth.authenticate(`Bearer ${issued.token}`)).toMatchObject({ ok: false });
    expect(m.service.getIntent(queued.intent.id)!.status).toBe('cancelled');
  });
});

describe('audit log', () => {
  it('records the full lifecycle of an intent', async () => {
    const { ctx } = botContext();
    const result = await m.service.submitOrderIntent(ctx, order());
    if (!result.ok) throw new Error('expected fill');

    const entries = m.audit.readAudit({ subjectId: result.intent.id });
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('intent.submitted');
    expect(actions).toContain('intent.filled');
  });

  it('keeps the hash chain valid as entries accumulate', async () => {
    const { ctx } = botContext();
    await m.service.submitOrderIntent(ctx, order({ clientRef: 'chain-1' }));
    await m.service.submitOrderIntent(ctx, order({ side: 'sell', quantity: 5, clientRef: 'chain-2' }));
    const verification = m.audit.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.entries).toBeGreaterThan(2);
  });

  it('cannot be edited or deleted, even by direct SQL', () => {
    m.audit.appendAudit({ actor: 'system', action: 'quote.read', subjectType: 'test', subjectId: 'x' });
    expect(() => m.db.$client.exec("UPDATE audit_log SET action = 'tampered'")).toThrow(/append-only/);
    expect(() => m.db.$client.exec('DELETE FROM audit_log')).toThrow(/append-only/);
  });

  it('detects tampering if a row is somehow altered', () => {
    m.audit.appendAudit({ actor: 'system', action: 'quote.read', subjectType: 'test', subjectId: 'y' });
    const before = m.audit.verifyChain();
    expect(before.valid).toBe(true);

    // Drop the triggers to simulate an attacker with direct database access.
    m.db.$client.exec('DROP TRIGGER audit_log_no_update');
    m.db.$client.exec("UPDATE audit_log SET payload = '{\"tampered\":true}' WHERE id = (SELECT MIN(id) FROM audit_log)");

    const after = m.audit.verifyChain();
    expect(after.valid).toBe(false);
    expect(after.brokenAt).not.toBeNull();

    m.db.$client.exec(`
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not permitted'); END;
    `);
  });

  it('never writes a token secret into the log', () => {
    const { issued } = botContext();
    const dump = JSON.stringify(m.audit.readAudit({ limit: 1000 }));
    expect(dump).not.toContain(issued.token);
  });
});
