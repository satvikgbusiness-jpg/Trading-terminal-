import { NextResponse } from 'next/server';
import { z } from 'zod';
import { issueToken, listTokens, revokeToken, SCOPES } from '@/lib/gateway/auth';
import { ensureAccount } from '@/lib/gateway/paper';
import { requireAdmin } from '@/lib/gateway/admin-auth';

export const dynamic = 'force-dynamic';

const issueSchema = z
  .object({
    name: z.string().min(1).max(64),
    scopes: z.array(z.enum(SCOPES)).min(1).optional(),
  })
  .strict();

export async function GET(request: Request) {
  const admin = requireAdmin(request);
  if (!admin.ok) return admin.response;

  return NextResponse.json(
    { tokens: listTokens(), scopes: SCOPES },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Issue a token. The secret is returned exactly once, here, and is never
 * recoverable afterwards -- only its hash is stored.
 */
export async function POST(request: Request) {
  const admin = requireAdmin(request);
  if (!admin.ok) return admin.response;

  const parsed = issueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Body must be { name: string, scopes?: string[] }' }, { status: 400 });
  }

  const account = ensureAccount();
  const issued = issueToken({
    name: parsed.data.name,
    accountId: account.id,
    scopes: parsed.data.scopes,
  });

  return NextResponse.json(
    {
      token: issued.token,
      id: issued.id,
      scopes: issued.scopes,
      warning: 'This secret is shown once. Store it now; it cannot be retrieved again.',
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
}

export async function DELETE(request: Request) {
  const admin = requireAdmin(request);
  if (!admin.ok) return admin.response;

  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const revoked = revokeToken(id, 'revoked from the operator console');
  return NextResponse.json({ revoked, tokens: listTokens() });
}
