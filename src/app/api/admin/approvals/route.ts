import { NextResponse } from 'next/server';
import { pendingApprovals, toPublicIntent } from '@/lib/gateway/service';
import { requireAdmin } from '@/lib/gateway/admin-auth';

export const dynamic = 'force-dynamic';

/** The human approval queue. Expired intents are filtered out on read. */
export async function GET(request: Request) {
  const admin = requireAdmin(request);
  if (!admin.ok) return admin.response;

  const intents = pendingApprovals().map(toPublicIntent);
  return NextResponse.json(
    { intents, now: Date.now() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
