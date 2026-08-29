import { NextResponse } from 'next/server';
import { z } from 'zod';
import { killSwitch } from '@/lib/gateway/service';
import { requireAdmin } from '@/lib/gateway/admin-auth';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ reason: z.string().min(1).max(500).optional() }).strict();

/** Kill switch: revoke every token, cancel open intents, lock the gateway. */
export async function POST(request: Request) {
  const admin = requireAdmin(request);
  if (!admin.ok) return admin.response;

  const parsed = bodySchema.safeParse((await request.json().catch(() => ({}))) ?? {});
  const reason = parsed.success ? (parsed.data.reason ?? 'kill switch engaged') : 'kill switch engaged';

  const result = killSwitch('human', reason);
  return NextResponse.json(
    { ...result, reason },
    { headers: { 'cache-control': 'no-store' } },
  );
}
