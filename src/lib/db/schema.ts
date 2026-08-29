import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

/* ------------------------------------------------------------------ */
/* Watchlists                                                          */
/* ------------------------------------------------------------------ */

export const watchlists = sqliteTable('watchlists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull().default(now),
});

export const watchlistItems = sqliteTable(
  'watchlist_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    watchlistId: integer('watchlist_id')
      .notNull()
      .references(() => watchlists.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    assetClass: text('asset_class', { enum: ['equity', 'index', 'crypto', 'forex'] }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    addedAt: integer('added_at').notNull().default(now),
  },
  (t) => [uniqueIndex('watchlist_symbol_unique').on(t.watchlistId, t.symbol)],
);

/* ------------------------------------------------------------------ */
/* Cached market data                                                  */
/* ------------------------------------------------------------------ */

/** Persisted candles. The backtest reads these so it never re-hits a free tier. */
export const candles = sqliteTable(
  'candles',
  {
    symbol: text('symbol').notNull(),
    resolution: text('resolution').notNull(),
    /** Unix seconds, bar start. */
    t: integer('t').notNull(),
    o: real('o').notNull(),
    h: real('h').notNull(),
    l: real('l').notNull(),
    c: real('c').notNull(),
    v: real('v'),
    source: text('source').notNull(),
    /** False for reference-rate feeds where o/h/l are not a real trading range. */
    hasRange: integer('has_range', { mode: 'boolean' }).notNull().default(true),
    fetchedAt: integer('fetched_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('candle_pk').on(t.symbol, t.resolution, t.t),
    index('candle_symbol_res').on(t.symbol, t.resolution),
  ],
);

export const newsItems = sqliteTable(
  'news_items',
  {
    /** sha256 of the normalised URL. */
    id: text('id').primaryKey(),
    headline: text('headline').notNull(),
    url: text('url').notNull(),
    source: text('source').notNull(),
    summary: text('summary'),
    publishedAt: integer('published_at').notNull(),
    /** Canonical symbol this item was fetched for; null for general feeds. */
    symbol: text('symbol'),
    sentimentScore: real('sentiment_score').notNull(),
    sentimentLabel: text('sentiment_label', { enum: ['positive', 'negative', 'neutral'] }).notNull(),
    ingestedAt: integer('ingested_at').notNull().default(now),
  },
  (t) => [
    index('news_symbol_published').on(t.symbol, t.publishedAt),
    index('news_published').on(t.publishedAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Paper trading ledger                                                */
/* ------------------------------------------------------------------ */

export const paperAccounts = sqliteTable('paper_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  /** Uninvested cash, in account currency. */
  cash: real('cash').notNull(),
  startingCash: real('starting_cash').notNull(),
  currency: text('currency').notNull().default('USD'),
  createdAt: integer('created_at').notNull().default(now),
});

export const paperPositions = sqliteTable(
  'paper_positions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    /** Signed: negative is short. */
    quantity: real('quantity').notNull(),
    /** Weighted average entry price of the open quantity. */
    averagePrice: real('average_price').notNull(),
    realizedPnl: real('realized_pnl').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('position_account_symbol').on(t.accountId, t.symbol)],
);

export const paperFills = sqliteTable(
  'paper_fills',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    orderId: text('order_id').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    quantity: real('quantity').notNull(),
    /** The real market price the intent filled against. */
    price: real('price').notNull(),
    notional: real('notional').notNull(),
    /** Realised P&L booked by this fill, if it closed exposure. */
    realizedPnl: real('realized_pnl').notNull().default(0),
    /** Provenance of the price used, so a fill can always be explained. */
    priceSource: text('price_source').notNull(),
    priceAsOf: integer('price_as_of').notNull(),
    filledAt: integer('filled_at').notNull().default(now),
  },
  (t) => [index('fill_account_time').on(t.accountId, t.filledAt), index('fill_order').on(t.orderId)],
);

/* ------------------------------------------------------------------ */
/* Bot gateway                                                         */
/* ------------------------------------------------------------------ */

export const gatewayTokens = sqliteTable(
  'gateway_tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** sha256 of the secret. The secret itself is shown once at issue time. */
    tokenHash: text('token_hash').notNull(),
    /** JSON array of scope strings. */
    scopes: text('scopes').notNull(),
    accountId: integer('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull().default(now),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [index('token_hash_lookup').on(t.tokenHash)],
);

export const orderIntents = sqliteTable(
  'order_intents',
  {
    id: text('id').primaryKey(),
    tokenId: text('token_id').notNull(),
    accountId: integer('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    quantity: real('quantity').notNull(),
    orderType: text('order_type', { enum: ['market', 'limit'] }).notNull(),
    limitPrice: real('limit_price'),
    mode: text('mode', { enum: ['paper', 'live'] }).notNull().default('paper'),
    status: text('status', {
      enum: [
        'filled',
        'rejected',
        'pending_approval',
        'approved',
        'expired',
        'cancelled',
        'blocked_no_broker',
      ],
    }).notNull(),
    /** Machine-readable reason for a rejection or block. */
    statusReason: text('status_reason'),
    /** Caller-supplied idempotency key. */
    clientRef: text('client_ref'),
    createdAt: integer('created_at').notNull().default(now),
    /** Approval deadline for live intents. */
    expiresAt: integer('expires_at'),
    decidedAt: integer('decided_at'),
    decidedBy: text('decided_by'),
    filledPrice: real('filled_price'),
    filledAt: integer('filled_at'),
  },
  (t) => [
    index('intent_status').on(t.status),
    index('intent_account_created').on(t.accountId, t.createdAt),
    uniqueIndex('intent_client_ref').on(t.tokenId, t.clientRef),
  ],
);

/** Single-row table holding the gateway's lock state. */
export const gatewayState = sqliteTable('gateway_state', {
  id: integer('id').primaryKey(),
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
  lockReason: text('lock_reason'),
  lockedAt: integer('locked_at'),
  /** Who or what must clear the lock. Always a human in v1. */
  lockedBy: text('locked_by'),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * Append-only audit log, hash-chained.
 *
 * Each row's `hash` covers its own content plus the previous row's hash, so
 * removing or editing an entry breaks every hash after it. UPDATE and DELETE are
 * additionally blocked by SQL triggers (see scripts/migrate.ts).
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull().default(now),
    /** "bot:<tokenId>", "human", or "system". */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    /** JSON payload. Bot-supplied strings are stored as data, never evaluated. */
    payload: text('payload').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_ts').on(t.ts), index('audit_subject').on(t.subjectType, t.subjectId)],
);

/** Rolling per-day risk counters, used to enforce the daily-loss limit. */
export const riskCounters = sqliteTable(
  'risk_counters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => paperAccounts.id, { onDelete: 'cascade' }),
    /** UTC date, YYYY-MM-DD. */
    day: text('day').notNull(),
    realizedPnl: real('realized_pnl').notNull().default(0),
    orderCount: integer('order_count').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('risk_account_day').on(t.accountId, t.day)],
);

export type Watchlist = typeof watchlists.$inferSelect;
export type WatchlistItem = typeof watchlistItems.$inferSelect;
export type NewsRow = typeof newsItems.$inferSelect;
export type PaperAccount = typeof paperAccounts.$inferSelect;
export type PaperPosition = typeof paperPositions.$inferSelect;
export type PaperFill = typeof paperFills.$inferSelect;
export type GatewayToken = typeof gatewayTokens.$inferSelect;
export type OrderIntent = typeof orderIntents.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type CandleRow = typeof candles.$inferSelect;
