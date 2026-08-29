import { NextResponse } from 'next/server';
import { adapterStatus } from '@/lib/market/registry';
import { PROVIDER_LIMITS, configureProviders } from '@/lib/market/providers';
import { scheduler } from '@/lib/market/scheduler';
import { SP500_COVERAGE } from '@/lib/universe';
import { configuredFeeds } from '@/lib/market/adapters/rss';

export const dynamic = 'force-dynamic';

/** What is configured, what is not, and how much rate budget is left. */
export async function GET() {
  configureProviders();
  const adapters = adapterStatus().map((adapter) => ({
    ...adapter,
    rateLimit: PROVIDER_LIMITS[adapter.id] ?? null,
    usage: scheduler.stats(adapter.id),
  }));

  return NextResponse.json(
    {
      adapters,
      newsFeeds: configuredFeeds(),
      sp500: SP500_COVERAGE,
      unconfigured: adapters.filter((a) => !a.configured).map((a) => a.label),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
