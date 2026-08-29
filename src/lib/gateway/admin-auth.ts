import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * Operator authentication for the `/api/admin` surface.
 *
 * These routes are the human half of the containment model: they unlock a
 * locked gateway, decide live-order approvals, issue and revoke bot tokens, and
 * read the audit log. Until this module existed they were reachable by anyone
 * who could open a socket to the server -- which includes the very bot they are
 * meant to contain. A bot could lock the gateway on a limit breach and clear the
 * lock itself, approve its own live intents (recorded in the audit log as
 * `actor: "human"`, so the log positively misreported who decided), and mint
 * itself replacement tokens after the kill switch revoked the old ones.
 *
 * The check is a shared operator secret, `GMT_ADMIN_TOKEN`, presented either as
 * an `x-admin-token` header (for curl and scripts) or as the session cookie the
 * console exchanges it for. A bot holding a bearer token has neither.
 *
 * With no secret configured the routes refuse rather than open. An operator
 * control that defaults to unauthenticated is not a control -- the same reason
 * the instrument allowlist defaults to empty rather than to everything.
 */

export const ADMIN_COOKIE = 'gmt_admin_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export function adminSecret(): string | null {
  return process.env.GMT_ADMIN_TOKEN?.trim() || null;
}

/** Constant-time compare that does not leak length through an early return. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Cookie value for a signed-in operator.
 *
 * An HMAC of a fixed label under the secret, so a stolen cookie does not hand
 * over the secret itself -- it cannot be replayed as an `x-admin-token` header
 * and it stops working the moment the secret is rotated.
 */
export function sessionValue(secret: string): string {
  return createHmac('sha256', secret).update('gmt-admin-session-v1').digest('hex');
}

export type AdminCheck = { ok: true } | { ok: false; response: NextResponse };

function deny(message: string, code: string, status: number): AdminCheck {
  return {
    ok: false,
    response: NextResponse.json({ error: message, code }, { status, headers: { 'cache-control': 'no-store' } }),
  };
}

/** Guard every `/api/admin` handler with this before doing anything else. */
export function requireAdmin(request: Request): AdminCheck {
  const secret = adminSecret();
  if (!secret) {
    return deny(
      'Admin routes are disabled because GMT_ADMIN_TOKEN is not set. Set it in .env.local and restart.',
      'admin_not_configured',
      503,
    );
  }

  const header = request.headers.get('x-admin-token');
  if (header && sameSecret(header, secret)) return { ok: true };

  const cookie = readCookie(request.headers.get('cookie'), ADMIN_COOKIE);
  if (cookie && sameSecret(cookie, sessionValue(secret))) return { ok: true };

  return deny('Operator authentication required', 'admin_unauthenticated', 401);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionCookie(secret: string): string {
  return (
    `${ADMIN_COOKIE}=${sessionValue(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`
  );
}

export function clearedSessionCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
