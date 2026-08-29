import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_COOKIE,
  clearedSessionCookie,
  requireAdmin,
  sessionCookie,
  sessionValue,
} from '@/lib/gateway/admin-auth';

/**
 * The operator gate on `/api/admin`.
 *
 * These routes decide live-order approvals, issue and revoke bot tokens, clear a
 * locked gateway and read the audit log. They used to take no credential at all,
 * so the bot they exist to contain could reach every one of them: lock the
 * gateway on a limit breach and immediately clear it, approve its own live
 * intents -- which the audit log then recorded as `actor: "human"` -- and mint
 * itself replacement tokens after the kill switch revoked the old ones.
 */

const SECRET = 'test-operator-secret-0123456789';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/admin/unlock', { headers });
}

afterEach(() => {
  delete process.env.GMT_ADMIN_TOKEN;
});

describe('requireAdmin', () => {
  it('refuses everything when no secret is configured', () => {
    delete process.env.GMT_ADMIN_TOKEN;
    const result = requireAdmin(req({ 'x-admin-token': 'anything' }));

    // Closed by default: an operator control that serves anyone when
    // unconfigured is not a control.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  it('refuses a request with no credential', () => {
    process.env.GMT_ADMIN_TOKEN = SECRET;
    const result = requireAdmin(req());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it('refuses a gateway bearer token', () => {
    // The exact escalation this closes: a bot presenting its own valid token.
    process.env.GMT_ADMIN_TOKEN = SECRET;
    const result = requireAdmin(req({ authorization: 'Bearer gmt_abc_def' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it('refuses a wrong secret, and one that is a prefix of the right one', () => {
    process.env.GMT_ADMIN_TOKEN = SECRET;
    expect(requireAdmin(req({ 'x-admin-token': 'wrong' })).ok).toBe(false);
    expect(requireAdmin(req({ 'x-admin-token': SECRET.slice(0, -1) })).ok).toBe(false);
    expect(requireAdmin(req({ 'x-admin-token': `${SECRET}x` })).ok).toBe(false);
  });

  it('accepts the secret as a header', () => {
    process.env.GMT_ADMIN_TOKEN = SECRET;
    expect(requireAdmin(req({ 'x-admin-token': SECRET })).ok).toBe(true);
  });

  it('accepts the session cookie', () => {
    process.env.GMT_ADMIN_TOKEN = SECRET;
    const cookie = `${ADMIN_COOKIE}=${sessionValue(SECRET)}`;
    expect(requireAdmin(req({ cookie })).ok).toBe(true);
  });

  it('reads its cookie out of a jar that holds others', () => {
    process.env.GMT_ADMIN_TOKEN = SECRET;
    const cookie = `theme=dark; ${ADMIN_COOKIE}=${sessionValue(SECRET)}; other=1`;
    expect(requireAdmin(req({ cookie })).ok).toBe(true);
  });

  it('does not accept the cookie value replayed as the header', () => {
    // The cookie carries an HMAC, not the secret, so capturing it does not hand
    // over a credential that works everywhere the secret does.
    process.env.GMT_ADMIN_TOKEN = SECRET;
    const value = sessionValue(SECRET);
    expect(value).not.toBe(SECRET);
    expect(requireAdmin(req({ 'x-admin-token': value })).ok).toBe(false);
  });

  it('stops honouring a session issued under a rotated secret', () => {
    process.env.GMT_ADMIN_TOKEN = SECRET;
    const cookie = `${ADMIN_COOKIE}=${sessionValue(SECRET)}`;
    process.env.GMT_ADMIN_TOKEN = 'a-different-operator-secret-000';
    expect(requireAdmin(req({ cookie })).ok).toBe(false);
  });
});

describe('session cookie attributes', () => {
  it('is httpOnly, same-site and scoped to the whole app', () => {
    const cookie = sessionCookie(SECRET);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain(SECRET);
  });

  it('clears by expiring immediately', () => {
    expect(clearedSessionCookie()).toContain('Max-Age=0');
  });
});
