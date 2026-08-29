import 'server-only';
import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditLog, type AuditEntry } from '@/lib/db/schema';

/**
 * Append-only, hash-chained audit log.
 *
 * Every intent, decision and fill lands here. Each row's hash covers its own
 * content plus the previous row's hash, so altering or removing any entry
 * invalidates every hash after it and `verifyChain` names the first broken
 * link. UPDATE and DELETE are additionally blocked by SQL triggers installed in
 * scripts/migrate.ts, so no route handler can bypass this.
 */

export const GENESIS_HASH = 'GENESIS';

export type AuditAction =
  | 'token.issued'
  | 'token.revoked'
  | 'token.rejected'
  | 'intent.submitted'
  | 'intent.rejected'
  | 'intent.filled'
  | 'intent.queued_for_approval'
  | 'intent.approved'
  | 'intent.rejected_by_human'
  | 'intent.expired'
  | 'intent.cancelled'
  | 'intent.blocked_no_broker'
  | 'limit.breached'
  | 'gateway.locked'
  | 'gateway.unlocked'
  | 'gateway.kill_switch'
  | 'portfolio.read'
  | 'quote.read';

export interface AuditInput {
  actor: string;
  action: AuditAction;
  subjectType: string;
  subjectId?: string | null;
  payload?: unknown;
}

function hashRow(input: {
  ts: number;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  payload: string;
  prevHash: string;
}): string {
  // Length-prefixing each field stops two different rows from serialising to
  // the same string via separator characters inside a value.
  const canonical = [
    input.ts,
    input.actor,
    input.action,
    input.subjectType,
    input.subjectId ?? '',
    input.payload,
    input.prevHash,
  ]
    .map((part) => {
      const s = String(part);
      return `${s.length}:${s}`;
    })
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Append one entry. Reading the tail and inserting happen inside a single
 * SQLite transaction so two concurrent writers cannot chain off the same
 * predecessor and fork the log.
 */
export function appendAudit(input: AuditInput): AuditEntry {
  const payload = safeStringify(input.payload ?? {});
  const ts = Date.now();
  const subjectId = input.subjectId ?? null;

  return db.transaction((tx) => {
    const [previous] = tx.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1).all();
    const prevHash = previous?.hash ?? GENESIS_HASH;
    const hash = hashRow({
      ts,
      actor: input.actor,
      action: input.action,
      subjectType: input.subjectType,
      subjectId,
      payload,
      prevHash,
    });

    const [row] = tx
      .insert(auditLog)
      .values({
        ts,
        actor: input.actor,
        action: input.action,
        subjectType: input.subjectType,
        subjectId,
        payload,
        prevHash,
        hash,
      })
      .returning()
      .all();
    return row!;
  });
}

/**
 * Serialise a payload that may contain bot-supplied strings.
 *
 * Values are stored as JSON data and never evaluated or interpolated into a
 * query; the caps exist so a large or deeply nested payload cannot bloat the log.
 */
function safeStringify(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value, replacer);
  } catch {
    json = JSON.stringify({ error: 'payload could not be serialised' });
  }
  if (json === undefined) json = '{}';
  const MAX = 8_000;
  return json.length > MAX ? JSON.stringify({ truncated: json.slice(0, MAX) }) : json;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > 1_000) return `${value.slice(0, 1_000)}[truncated]`;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export interface ChainVerification {
  valid: boolean;
  entries: number;
  /** Id of the first entry whose hash does not match, when invalid. */
  brokenAt: number | null;
  reason: string | null;
}

/** Recompute every hash and confirm the chain is intact. */
export function verifyChain(): ChainVerification {
  const rows = db.select().from(auditLog).orderBy(auditLog.id).all();
  let prevHash = GENESIS_HASH;

  for (const row of rows) {
    if (row.prevHash !== prevHash) {
      return {
        valid: false,
        entries: rows.length,
        brokenAt: row.id,
        reason: `entry ${row.id} points at ${row.prevHash} but the previous entry hashes to ${prevHash}`,
      };
    }
    const expected = hashRow({
      ts: row.ts,
      actor: row.actor,
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      payload: row.payload,
      prevHash: row.prevHash,
    });
    if (expected !== row.hash) {
      return {
        valid: false,
        entries: rows.length,
        brokenAt: row.id,
        reason: `entry ${row.id} content does not match its recorded hash`,
      };
    }
    prevHash = row.hash;
  }
  return { valid: true, entries: rows.length, brokenAt: null, reason: null };
}

export interface AuditQuery {
  limit?: number;
  subjectType?: string;
  subjectId?: string;
}

export function readAudit(query: AuditQuery = {}): AuditEntry[] {
  const limit = Math.min(query.limit ?? 200, 1000);
  const base = db.select().from(auditLog);
  const filtered = query.subjectId
    ? base.where(eq(auditLog.subjectId, query.subjectId))
    : query.subjectType
      ? base.where(eq(auditLog.subjectType, query.subjectType))
      : base;
  return filtered.orderBy(desc(auditLog.id)).limit(limit).all();
}
