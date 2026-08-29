import { NextResponse } from 'next/server';
import { pendingApprovals, toPublicIntent } from '@/lib/gateway/service';

export const dynamic = 'force-dynamic';

/** The human approval queue. Expired intents are filtered out on read. */
export async function GET() {
  const intents = pendingApprovals().map(toPublicIntent);
  return NextResponse.json(
    { intents, now: Date.now() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
