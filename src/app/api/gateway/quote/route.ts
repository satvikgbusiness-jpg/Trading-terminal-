import { guard, json } from '@/lib/gateway/http';
import { getQuote } from '@/lib/market/service';
import { quoteQuerySchema, formatIssues } from '@/lib/gateway/schemas';
import { loadLimits } from '@/lib/gateway/limits';

export const dynamic = 'force-dynamic';

/**
 * getQuote for the bot.
 *
 * Restricted to the instrument allowlist: the gateway will not act as a general
 * market data proxy for an untrusted process, and the allowlist is a security
 * boundary rather than only a trading rule.
 */
export async function GET(request: Request) {
  const guarded = guard(request, 'quote:read');
  if (!guarded.ok) return guarded.response;

  const parsed = quoteQuerySchema.safeParse({
    symbol: new URL(request.url).searchParams.get('symbol') ?? '',
  });
  if (!parsed.success) {
    return json({ error: 'Invalid query', issues: formatIssues(parsed.error) }, 400);
  }

  const limits = loadLimits();
  if (!limits.instrumentAllowlist.includes(parsed.data.symbol)) {
    return json(
      {
        error: `${parsed.data.symbol} is not on the instrument allowlist`,
        code: 'instrument_not_allowed',
      },
      403,
    );
  }

  const result = await getQuote(parsed.data.symbol);
  if (!result.ok) {
    return json({ error: result.message, code: result.code, source: result.source }, 503);
  }

  return json({
    symbol: result.data.symbol,
    price: result.data.price,
    change: result.data.change,
    changePercent: result.data.changePercent,
    timestamp: result.data.timestamp,
    // Provenance travels with the price so a bot can refuse to act on stale data.
    provenance: result.provenance,
  });
}
