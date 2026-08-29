import { NextResponse } from 'next/server';
import { getCandles } from '@/lib/market/service';
import { tryResolveAsset } from '@/lib/symbols';
import type { Resolution } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

const RESOLUTIONS: Resolution[] = ['1', '5', '15', '60', 'D', 'W'];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get('symbol') ?? '';
  const resolution = (url.searchParams.get('resolution') ?? 'D') as Resolution;
  const lookbackDays = Number(url.searchParams.get('lookbackDays') ?? 400);

  if (tryResolveAsset(symbol) === null) {
    return NextResponse.json({ error: `Unrecognised symbol: ${symbol}` }, { status: 400 });
  }
  if (!RESOLUTIONS.includes(resolution)) {
    return NextResponse.json(
      { error: `resolution must be one of ${RESOLUTIONS.join(', ')}` },
      { status: 400 },
    );
  }
  if (!Number.isFinite(lookbackDays) || lookbackDays < 1 || lookbackDays > 4000) {
    return NextResponse.json({ error: 'lookbackDays must be between 1 and 4000' }, { status: 400 });
  }

  const result = await getCandles(symbol, { resolution, lookbackDays });
  return NextResponse.json(result, {
    status: result.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
