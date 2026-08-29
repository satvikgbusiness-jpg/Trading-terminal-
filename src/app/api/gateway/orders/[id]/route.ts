import { guard, json } from '@/lib/gateway/http';
import { orderIdSchema } from '@/lib/gateway/schemas';
import { getIntent, toPublicIntent } from '@/lib/gateway/service';

export const dynamic = 'force-dynamic';

/** getOrderStatus. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guarded = guard(request, 'order:read');
  if (!guarded.ok) return guarded.response;

  const { id } = await context.params;
  const parsed = orderIdSchema.safeParse(id);
  if (!parsed.success) return json({ error: 'Invalid order id' }, 400);

  // Scoped to the token's own account: one bot cannot read another's orders.
  const intent = getIntent(parsed.data, guarded.auth.accountId);
  if (!intent) return json({ error: 'No such order', code: 'not_found' }, 404);

  return json({ intent: toPublicIntent(intent) });
}
