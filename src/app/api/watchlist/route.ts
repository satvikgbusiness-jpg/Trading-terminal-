import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addToWatchlist, readWatchlist, removeFromWatchlist } from '@/lib/watchlist';
import { tryResolveAsset } from '@/lib/symbols';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ symbol: z.string().min(1).max(32) }).strict();

export async function GET() {
  return NextResponse.json(
    { items: readWatchlist() },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Body must be { symbol: string }' }, { status: 400 });
  }
  if (tryResolveAsset(parsed.data.symbol) === null) {
    return NextResponse.json(
      { error: `Unrecognised symbol: ${parsed.data.symbol}` },
      { status: 400 },
    );
  }
  const item = addToWatchlist(parsed.data.symbol);
  return NextResponse.json({ item, items: readWatchlist() });
}

export async function DELETE(request: Request) {
  const symbol = new URL(request.url).searchParams.get('symbol') ?? '';
  if (!symbol) return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
  const removed = removeFromWatchlist(symbol);
  return NextResponse.json({ removed, items: readWatchlist() });
}
