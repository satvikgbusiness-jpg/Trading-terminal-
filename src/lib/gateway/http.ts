import 'server-only';
import { NextResponse } from 'next/server';
import { authenticate, hasScope, type AuthContext, type Scope } from './auth';

/**
 * Shared plumbing for the bot-facing routes.
 *
 * Responses are deliberately terse. An error tells the caller what to change
 * about its request and nothing about the terminal's internals -- no stack
 * traces, no SQL, no file paths, no configured limit values beyond the one it
 * actually hit.
 */

export type Guarded = { ok: true; auth: AuthContext } | { ok: false; response: NextResponse };

const STATUS_BY_REASON = {
  missing: 401,
  malformed: 401,
  unknown: 401,
  revoked: 403,
} as const;

/**
 * Authenticate, check the scope, and refuse when the gateway is locked.
 *
 * Read endpoints stay available while locked so an operator can still inspect
 * state through the same API; only order submission is blocked, and that check
 * lives in the service where the audit trail is written.
 */
export function guard(request: Request, scope: Scope): Guarded {
  const result = authenticate(request.headers.get('authorization'));
  if (!result.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: result.failure.message, code: result.failure.reason },
        { status: STATUS_BY_REASON[result.failure.reason], headers: noStore() },
      ),
    };
  }

  if (!hasScope(result.context, scope)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This token lacks the ${scope} scope`, code: 'insufficient_scope' },
        { status: 403, headers: noStore() },
      ),
    };
  }

  return { ok: true, auth: result.context };
}

export function noStore(): HeadersInit {
  return { 'cache-control': 'no-store' };
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: noStore() });
}

/** Parse a JSON body, refusing anything oversized or malformed. */
export async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > 16_384) {
    return { ok: false, response: json({ error: 'Request body too large', code: 'payload_too_large' }, 413) };
  }
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: json({ error: 'Body must be valid JSON', code: 'bad_json' }, 400) };
  }
}
