import { guard, json } from '@/lib/gateway/http';
import { getPortfolio } from '@/lib/gateway/paper';
import { appendAudit } from '@/lib/gateway/audit';
import { readLockState } from '@/lib/gateway/limits';

export const dynamic = 'force-dynamic';

/** getPortfolio -- the bot's own paper book, never anyone else's. */
export async function GET(request: Request) {
  const guarded = guard(request, 'portfolio:read');
  if (!guarded.ok) return guarded.response;

  const portfolio = await getPortfolio(guarded.auth.accountId);
  if (!portfolio) return json({ error: 'No paper account for this token' }, 404);

  appendAudit({
    actor: guarded.auth.actor,
    action: 'portfolio.read',
    subjectType: 'account',
    subjectId: String(guarded.auth.accountId),
    payload: { positions: portfolio.positions.length },
  });

  return json({
    account: portfolio.account,
    valuation: portfolio.valuation,
    positions: portfolio.positions.map((p) => ({
      symbol: p.symbol,
      quantity: p.position.quantity,
      averagePrice: p.position.averagePrice,
      realizedPnl: p.position.realizedPnl,
      price: p.price,
      priceSource: p.priceSource,
      priceStale: p.priceStale,
      marketValue: p.marketValue,
      unrealizedPnl: p.unrealizedPnl,
    })),
    // Named explicitly so a bot cannot mistake an unpriced position for a flat one.
    pricingGaps: portfolio.pricingGaps,
    gatewayLocked: readLockState().locked,
    asOf: portfolio.asOf,
  });
}
