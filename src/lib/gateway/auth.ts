import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { gatewayTokens, type GatewayToken } from '@/lib/db/schema';
import { appendAudit } from './audit';

/**
 * Scoped bearer tokens for the bot process.
 *
 * The scope set is deliberately tiny and additive: there is no scope that reads
 * configuration or secrets, no scope that moves funds, and no withdrawal or
 * transfer endpoint anywhere in the gateway for a scope to reach. A compromised
 * bot token can read its own paper portfolio, read quotes, and queue order
 * intents that a human still has to approve before anything labelled live
 * happens. That is the whole blast radius.
 */

export const SCOPES = ['portfolio:read', 'quote:read', 'order:submit', 'order:read'] as const;
export type Scope = (typeof SCOPES)[number];

/** What a freshly issued token is allowed to do. */
export const DEFAULT_SCOPES: Scope[] = ['portfolio:read', 'quote:read', 'order:submit', 'order:read'];

const TOKEN_PREFIX = 'gmt';
/** gmt_<16 hex id>_<base64url secret>. The secret may itself contain "-" and "_". */
const TOKEN_RE = /^gmt_([0-9a-f]{16})_([A-Za-z0-9_-]{16,})$/;

export interface IssuedToken {
  id: string;
  /** The full secret. Shown once at issue time and never stored in the clear. */
  token: string;
  name: string;
  scopes: Scope[];
  accountId: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function issueToken(options: { name: string; accountId: number; scopes?: Scope[] }): IssuedToken {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}_${id}_${secret}`;
  const scopes = options.scopes ?? DEFAULT_SCOPES;

  db.insert(gatewayTokens)
    .values({
      id,
      name: options.name,
      tokenHash: sha256(secret),
      scopes: JSON.stringify(scopes),
      accountId: options.accountId,
    })
    .run();

  appendAudit({
    actor: 'human',
    action: 'token.issued',
    subjectType: 'token',
    subjectId: id,
    // The secret is never written to the audit log.
    payload: { name: options.name, scopes, accountId: options.accountId },
  });

  return { id, token, name: options.name, scopes, accountId: options.accountId };
}

export interface AuthContext {
  tokenId: string;
  name: string;
  scopes: Scope[];
  accountId: number;
  /** "bot:<tokenId>", used as the audit actor. */
  actor: string;
}

export type AuthFailure =
  | { reason: 'missing'; message: string }
  | { reason: 'malformed'; message: string }
  | { reason: 'unknown'; message: string }
  | { reason: 'revoked'; message: string };

export type AuthResult = { ok: true; context: AuthContext } | { ok: false; failure: AuthFailure };

/**
 * Verify an Authorization header.
 *
 * The stored hash is compared with timingSafeEqual, and an unknown token id is
 * still compared against a dummy hash so that a wrong id and a wrong secret take
 * the same time to reject.
 */
export function authenticate(header: string | null): AuthResult {
  if (!header) {
    return { ok: false, failure: { reason: 'missing', message: 'Authorization header required' } };
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'Expected an Authorization: Bearer header' },
    };
  }

  // The secret is base64url, whose alphabet includes "_", so the token cannot be
  // split on every underscore -- only the two that delimit the prefix and id.
  const parsed = match[1]!.trim().match(TOKEN_RE);
  if (!parsed) {
    return {
      ok: false,
      failure: { reason: 'malformed', message: 'Token format is gmt_<id>_<secret>' },
    };
  }
  const [, id, secret] = parsed as unknown as [string, string, string];

  const [row] = db.select().from(gatewayTokens).where(eq(gatewayTokens.id, id)).limit(1).all();

  const presented = sha256(secret);
  // Compare even when the id is unknown, so timing does not distinguish the cases.
  const expected = row?.tokenHash ?? sha256('absent-token-placeholder');
  const matches = safeEqual(presented, expected);

  if (!row || !matches) {
    appendAudit({
      actor: `bot:${id}`,
      action: 'token.rejected',
      subjectType: 'token',
      subjectId: id,
      payload: { reason: row ? 'secret mismatch' : 'unknown token id' },
    });
    return { ok: false, failure: { reason: 'unknown', message: 'Invalid token' } };
  }

  if (row.revokedAt !== null) {
    return {
      ok: false,
      failure: {
        reason: 'revoked',
        message: row.revokedReason ? `Token was revoked: ${row.revokedReason}` : 'Token was revoked',
      },
    };
  }

  db.update(gatewayTokens).set({ lastUsedAt: Date.now() }).where(eq(gatewayTokens.id, id)).run();

  return {
    ok: true,
    context: {
      tokenId: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes),
      accountId: row.accountId,
      actor: `bot:${row.id}`,
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseScopes(raw: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s as string));
  } catch {
    return [];
  }
}

export function hasScope(context: AuthContext, scope: Scope): boolean {
  return context.scopes.includes(scope);
}

export function revokeToken(id: string, reason: string, actor = 'human'): boolean {
  const result = db
    .update(gatewayTokens)
    .set({ revokedAt: Date.now(), revokedReason: reason })
    .where(and(eq(gatewayTokens.id, id), isNull(gatewayTokens.revokedAt)))
    .run();

  if (result.changes > 0) {
    appendAudit({
      actor,
      action: 'token.revoked',
      subjectType: 'token',
      subjectId: id,
      payload: { reason },
    });
    return true;
  }
  return false;
}

/** Revoke every active token. The kill switch's first act. */
export function revokeAllTokens(reason: string, actor = 'human'): string[] {
  const active = db.select().from(gatewayTokens).where(isNull(gatewayTokens.revokedAt)).all();
  for (const token of active) revokeToken(token.id, reason, actor);
  return active.map((t) => t.id);
}

/** Token metadata for the UI. Never includes the secret or its hash. */
export function listTokens(): Array<Omit<GatewayToken, 'tokenHash' | 'scopes'> & { scopes: Scope[] }> {
  return db
    .select()
    .from(gatewayTokens)
    .all()
    .map(({ tokenHash: _tokenHash, ...rest }) => ({ ...rest, scopes: parseScopes(rest.scopes) }));
}
