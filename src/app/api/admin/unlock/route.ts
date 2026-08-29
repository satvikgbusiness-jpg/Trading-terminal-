import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readLockState, unlockGateway } from '@/lib/gateway/limits';
import { requireAdmin } from '@/lib/gateway/admin-auth';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ note: z.string().max(500).optional() }).strict();

export async function GET(request: Request) {
  const admin = requireAdmin(request);
  if (!admin.ok) return admin.response;

  return NextResponse.json(readLockState(), { headers: { 'cache-control': 'no-store' } });
}

/**
 * Clear a lock.
 *
 * Requires the operator secret, which a bot bearer token is not. Before that
 * check existed the route took no credential at all, so the bot could clear a
 * lock its own limit breach had just set -- the containment story read the
 * right way in the README and did not hold at the socket.
 */
export async function POST(request: Request) {
  const admin = requireAdmin(request);
  if (!admin.ok) return admin.response;

  const parsed = bodySchema.safeParse((await request.json().catch(() => ({}))) ?? {});
  unlockGateway('human', parsed.success ? parsed.data.note : undefined);
  return NextResponse.json(
    { lock: readLockState() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
