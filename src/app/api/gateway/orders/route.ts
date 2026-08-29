import { guard, json, readJson } from '@/lib/gateway/http';
import { formatIssues, orderIntentSchema } from '@/lib/gateway/schemas';
import { listIntents, submitOrderIntent } from '@/lib/gateway/service';

export const dynamic = 'force-dynamic';

/** submitOrderIntent. */
export async function POST(request: Request) {
  const guarded = guard(request, 'order:submit');
  if (!guarded.ok) return guarded.response;

  const body = await readJson(request);
  if (!body.ok) return body.response;

  // Strict schema: unknown keys are rejected rather than silently ignored, so a
  // bot cannot smuggle a field past a future version of this handler.
  const parsed = orderIntentSchema.safeParse(body.value);
  if (!parsed.success) {
    return json({ error: 'Invalid order intent', issues: formatIssues(parsed.error) }, 400);
  }

  const result = await submitOrderIntent(guarded.auth, parsed.data);
  if (!result.ok) {
    const status =
      result.code === 'gateway_locked' || result.code === 'limit_breached'
        ? 423
        : result.code === 'no_market_data'
          ? 503
          : 422;
    return json({ error: result.message, code: result.code, breach: result.breach ?? null }, status);
  }

  return json({ intent: result.intent }, 201);
}

/** The token's own recent intents. */
export async function GET(request: Request) {
  const guarded = guard(request, 'order:read');
  if (!guarded.ok) return guarded.response;

  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
  const intents = listIntents(
    guarded.auth.accountId,
    Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
  );
  return json({ intents });
}
