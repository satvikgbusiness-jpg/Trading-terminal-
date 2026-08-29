import { NextResponse } from 'next/server';
import { refreshAndReadNews } from '@/lib/news';
import { tryResolveAsset } from '@/lib/symbols';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get('symbol')?.trim() || undefined;
  const days = Number(url.searchParams.get('days') ?? 7);
  const limit = Number(url.searchParams.get('limit') ?? 40);

  if (symbol && tryResolveAsset(symbol) === null) {
    return NextResponse.json({ error: `Unrecognised symbol: ${symbol}` }, { status: 400 });
  }

  const result = await refreshAndReadNews({
    symbol,
    days: Number.isFinite(days) ? Math.min(Math.max(days, 1), 30) : 7,
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 40,
  });

  return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
}
