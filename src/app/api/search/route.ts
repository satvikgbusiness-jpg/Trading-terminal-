import { NextResponse } from 'next/server';
import { searchSymbols } from '@/lib/market/service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (query.length < 1) return NextResponse.json({ results: [] });
  if (query.length > 64) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 });
  }

  try {
    const results = await searchSymbols(query);
    return NextResponse.json({ results }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(
      { results: [], error: err instanceof Error ? err.message : 'Search failed' },
      { status: 503 },
    );
  }
}
