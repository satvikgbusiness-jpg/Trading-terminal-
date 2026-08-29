import { NextResponse } from 'next/server';
import { getSymbolSnapshot } from '@/lib/analysis/service';
import { tryResolveAsset } from '@/lib/symbols';

export const dynamic = 'force-dynamic';

/**
 * The full Outlook for a symbol, including the reasons behind it.
 *
 * The disclaimer travels with the payload rather than being a UI-only string, so
 * any consumer of this endpoint carries the framing too.
 */
export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get('symbol')?.trim() ?? '';
  if (tryResolveAsset(symbol) === null) {
    return NextResponse.json({ error: `Unrecognised symbol: ${symbol}` }, { status: 400 });
  }

  const snapshot = await getSymbolSnapshot(symbol);
  return NextResponse.json(
    {
      symbol: snapshot.asset.symbol,
      outlook: snapshot.outlook,
      outlookGap: snapshot.outlookGap,
      sentiment: snapshot.sentiment,
      macro: snapshot.macro,
      provenance: snapshot.provenance,
      disclaimer: 'Signals are descriptive, not predictive. Not investment advice.',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
