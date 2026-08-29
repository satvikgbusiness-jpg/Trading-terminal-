import { NextResponse } from 'next/server';
import { getQuotes } from '@/lib/market/service';
import { tryResolveAsset } from '@/lib/symbols';

export const dynamic = 'force-dynamic';

/** Batch quotes. `?symbols=AAPL,BTC-USD,EUR/USD` */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('symbols') ?? '';
  const symbols = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

  const unknown = symbols.filter((s) => tryResolveAsset(s) === null);
  const valid = symbols.filter((s) => tryResolveAsset(s) !== null);

  if (valid.length === 0) {
    return NextResponse.json(
      { quotes: {}, unknown, error: symbols.length ? 'No recognised symbols' : 'No symbols given' },
      { status: symbols.length ? 400 : 200 },
    );
  }

  const quotes = await getQuotes(valid);
  return NextResponse.json({ quotes, unknown }, { headers: { 'cache-control': 'no-store' } });
}
