import Link from 'next/link';
import { getQuotes } from '@/lib/market/service';
import { sectorsWithConstituents, SP500, SP500_COVERAGE } from '@/lib/universe';
import { adapterStatus } from '@/lib/market/registry';
import { readWatchlist } from '@/lib/watchlist';
import { CRYPTO_BASES, FOREX_MAJORS, INDEXES } from '@/lib/symbols';
import {
  IndexTiles, SectorHeatmap, TickerTape, TopMovers,
  type Mover, type SectorGroup,
} from '@/components/MarketOverview';
import { Watchlist } from '@/components/Watchlist';
import { Panel } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * How many S&P constituents to price for the heatmap.
 *
 * The bundled snapshot has ~450 names and a free equity tier allows ~60 requests
 * a minute, so pricing all of them on every page load would exhaust the budget
 * in seconds. This takes the largest slice the cache can hold comfortably and
 * reports the coverage on screen rather than implying the heatmap is complete.
 */
const HEATMAP_SAMPLE = Number(process.env.GMT_HEATMAP_SYMBOLS ?? 60);

export default async function MarketsPage() {
  const watchlistItems = readWatchlist();

  // One shared quote fetch feeds the heatmap and the movers list.
  const sectors = sectorsWithConstituents();
  const sampled = sampleAcrossSectors(sectors, HEATMAP_SAMPLE);
  const quotes = await getQuotes(sampled.map((c) => c.symbol));

  const groups: SectorGroup[] = sectors.map((group) => {
    const cells = group.constituents
      .filter((c) => quotes[c.symbol] !== undefined)
      .map((c) => {
        const result = quotes[c.symbol];
        return {
          symbol: c.symbol,
          name: c.name,
          changePercent: result?.ok ? result.data.changePercent : null,
        };
      });

    const priced = cells.filter((c) => c.changePercent !== null);
    return {
      sector: group.sector,
      averageChange:
        priced.length === 0
          ? null
          : priced.reduce((sum, c) => sum + (c.changePercent ?? 0), 0) / priced.length,
      priced: priced.length,
      total: group.constituents.length,
      cells,
    };
  });

  const ranked: Mover[] = [];
  for (const [symbol, result] of Object.entries(quotes)) {
    if (!result.ok || result.data.changePercent === null) continue;
    ranked.push({
      symbol,
      name: SP500.constituents.find((c) => c.symbol === symbol)?.name ?? symbol,
      changePercent: result.data.changePercent,
      price: result.data.price,
    });
  }
  ranked.sort((a, b) => b.changePercent - a.changePercent);

  const tapeSymbols = [
    ...INDEXES.map((i) => i.symbol),
    ...['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA'],
    ...Object.keys(CRYPTO_BASES).slice(0, 5).map((base) => `${base}-USD`),
    ...FOREX_MAJORS.slice(0, 4).map((f) => f.symbol),
  ];

  const adapters = adapterStatus();
  const missing = adapters.filter((a) => a.requiresKey && !a.configured);

  return (
    <div className="flex flex-col">
      <TickerTape symbols={tapeSymbols} />

      {missing.length > 0 && (
        <div className="border-b border-term-warn/30 bg-term-warn/5 px-3 py-1.5 text-2xs text-term-warn">
          <span className="font-medium">SETUP</span>{' '}
          <span className="text-term-text">
            {missing.map((m) => m.label).join(', ')} {missing.length === 1 ? 'has' : 'have'} no API
            key, so equity and index data is unavailable. Crypto (CoinGecko) and FX (ECB) work
            without keys. See <code className="text-term-accent">.env.example</code>. Empty panels
            below are missing data, not flat markets.
          </span>
        </div>
      )}

      <div className="grid gap-2 p-2 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-2">
          <IndexTiles />

          <div className="grid gap-2 lg:grid-cols-[1fr_360px]">
            <SectorHeatmap groups={groups.filter((g) => g.cells.length > 0)} />
            <div className="flex flex-col gap-2">
              <TopMovers
                gainers={ranked.slice(0, 8)}
                losers={ranked.slice(-8).reverse()}
                priced={ranked.length}
                total={sampled.length}
              />
              <CoverageNote sampled={sampled.length} />
            </div>
          </div>
        </div>

        <div className="min-w-0 xl:h-[calc(100vh-9rem)] xl:sticky xl:top-12">
          <Watchlist
            initial={watchlistItems.map((item) => ({
              symbol: item.symbol,
              name: item.symbol,
              assetClass: item.assetClass,
            }))}
          />
        </div>
      </div>
    </div>
  );
}

function CoverageNote({ sampled }: { sampled: number }) {
  return (
    <Panel title="Coverage">
      <div className="space-y-1.5 p-2 text-2xs text-term-dim">
        <p>
          The heatmap and movers are computed from{' '}
          <span className="text-term-text">{sampled}</span> constituents sampled across all 11
          sectors, drawn from a bundled snapshot of {SP500_COVERAGE.listed} of roughly{' '}
          {SP500_COVERAGE.nominal} S&P 500 members ({SP500_COVERAGE.snapshotDate}).
        </p>
        <p>
          Pricing every name on each load would exhaust a free-tier rate limit, so this is a
          sample, not the index. It is not index-weighted and should not be read as index
          performance.
        </p>
        <p>
          <Link href="/demo" className="text-term-accent hover:underline">
            DEMO tab
          </Link>{' '}
          carries synthetic data and feeds nothing here.
        </p>
      </div>
    </Panel>
  );
}

/**
 * Take a proportional slice of each sector so the heatmap has representation
 * everywhere rather than 60 technology names and nothing else.
 */
function sampleAcrossSectors(
  sectors: ReturnType<typeof sectorsWithConstituents>,
  budget: number,
): Array<{ symbol: string; name: string; sector: string }> {
  const total = sectors.reduce((sum, s) => sum + s.constituents.length, 0);
  if (total === 0) return [];

  const picked: Array<{ symbol: string; name: string; sector: string }> = [];
  for (const group of sectors) {
    const share = Math.max(2, Math.round((group.constituents.length / total) * budget));
    picked.push(...group.constituents.slice(0, share));
  }
  return picked.slice(0, budget);
}
