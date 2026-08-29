import { NextResponse } from 'next/server';
import { readAudit, verifyChain } from '@/lib/gateway/audit';
import { requireAdmin } from '@/lib/gateway/admin-auth';

export const dynamic = 'force-dynamic';

/** The append-only log, plus a live verification of its hash chain. */
export async function GET(request: Request) {
  const admin = requireAdmin(request);
  if (!admin.ok) return admin.response;

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const subjectId = url.searchParams.get('subjectId') ?? undefined;
  const subjectType = url.searchParams.get('subjectType') ?? undefined;

  const entries = readAudit({
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 100,
    subjectId,
    subjectType,
  });

  return NextResponse.json(
    { entries, verification: verifyChain() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
