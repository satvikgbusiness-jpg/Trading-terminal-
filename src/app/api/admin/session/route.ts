import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  adminSecret,
  clearedSessionCookie,
  requireAdmin,
  sessionCookie,
} from '@/lib/gateway/admin-auth';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ token: z.string().min(1).max(512) }).strict();

/** Whether this caller is already signed in, so the console can decide what to render. */
export async function GET(request: Request) {
  const check = requireAdmin(request);
  return NextResponse.json(
    {
      authenticated: check.ok,
      configured: adminSecret() !== null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Exchange the operator secret for a session cookie.
 *
 * The cookie is httpOnly and SameSite=Strict, so page JavaScript cannot read it
 * back out and another origin cannot ride it. It carries an HMAC rather than the
 * secret, so it cannot be replayed as an `x-admin-token` header.
 */
export async function POST(request: Request) {
  const secret = adminSecret();
  if (!secret) {
    return NextResponse.json(
      { error: 'GMT_ADMIN_TOKEN is not set on the server', code: 'admin_not_configured' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Expected { token }' }, { status: 400 });
  }

  // Deliberately the same response for a wrong token as for a malformed one,
  // and no hint about the expected length.
  const probe = new Request(request.url, { headers: { 'x-admin-token': parsed.data.token } });
  if (!requireAdmin(probe).ok) {
    return NextResponse.json(
      { error: 'Incorrect operator token', code: 'admin_unauthenticated' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { authenticated: true },
    { headers: { 'cache-control': 'no-store', 'set-cookie': sessionCookie(secret) } },
  );
}

/** Sign out. */
export async function DELETE() {
  return NextResponse.json(
    { authenticated: false },
    { headers: { 'cache-control': 'no-store', 'set-cookie': clearedSessionCookie() } },
  );
}
