import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readLockState, unlockGateway } from '@/lib/gateway/limits';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ note: z.string().max(500).optional() }).strict();

export async function GET() {
  return NextResponse.json(readLockState(), { headers: { 'cache-control': 'no-store' } });
}

/**
 * Clear a lock. Reachable only from the operator UI -- there is no bearer-token
 * route that unlocks the gateway, so a bot cannot reset a limit it just tripped.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse((await request.json().catch(() => ({}))) ?? {});
  unlockGateway('human', parsed.success ? parsed.data.note : undefined);
  return NextResponse.json(
    { lock: readLockState() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
