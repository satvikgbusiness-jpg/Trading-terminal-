import { NextResponse } from 'next/server';
import { approvalDecisionSchema, formatIssues, orderIdSchema } from '@/lib/gateway/schemas';
import { approveIntent, rejectIntent } from '@/lib/gateway/service';

export const dynamic = 'force-dynamic';

/**
 * Record a human decision on a queued live intent.
 *
 * There is deliberately no auto-approve setting and no bulk-approve endpoint:
 * every live intent is decided one at a time by a person.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const idCheck = orderIdSchema.safeParse(id);
  if (!idCheck.success) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  }

  const parsed = approvalDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Body must be { decision: "approve" | "reject", note?: string }', issues: formatIssues(parsed.error) },
      { status: 400 },
    );
  }

  const actor = 'human';
  const result =
    parsed.data.decision === 'approve'
      ? approveIntent(idCheck.data, actor, parsed.data.note)
      : rejectIntent(idCheck.data, actor, parsed.data.note);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: result.code === 'not_found' ? 404 : 409 },
    );
  }

  return NextResponse.json({ intent: result.intent }, { headers: { 'cache-control': 'no-store' } });
}
