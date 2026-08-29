import { notFound } from 'next/navigation';
import clsx from 'clsx';
import { decodeSymbol, tryResolveAsset } from '@/lib/symbols';
import { getSymbolSnapshot } from '@/lib/analysis/service';
import { equityName, equitySector } from '@/lib/universe';
import { atr, closes, realizedVolatility } from '@/lib/analysis/indicators';
import { changeColor, formatCompact, formatPercent, formatPrice } from '@/lib/format';
import { Panel, ProvenanceLine, Unavailable } from '@/components/ui';
import { PriceChart } from '@/components/PriceChart';
import { MacroStrip, OutlookPanel } from '@/components/OutlookPanel';
import { NewsPane, SentimentMethodNote } from '@/components/NewsPane';
import { AddToWatchlistButton } from '@/components/AddToWatchlistButton';

export const dynamic = 'force-dynamic';

export default async function TickerPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: raw } = await params;
  const symbol = decodeSymbol(raw);
  if (tryResolveAsset(symbol) === null) notFound();

  const snapshot = await getSymbolSnapshot(symbol);
  const { asset, quote, candles, outlook, outlookGap, news, newsStatus, sentiment, macro } = snapshot;

  const displayName = equityName(asset.symbol) ?? asset.name;
  const sector = equitySector(asset.symbol);

  return (
    <div className="flex flex-col gap-2 p-2">
      {/* ---------- Quote header ---------- */}
      <Panel>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2 p-2">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="text-lg font-bold text-term-bright">{asset.symbol}</h1>
              <span className="label">{asset.assetClass}</span>
              {sector && <span className="label">{sector}</span>}
              <AddToWatchlistButton symbol={asset.symbol} />
            </div>
            <p className="truncate text-term-dim">{displayName}</p>
          </div>

          {quote.ok ? (
            <>
              <Stat label="Last" value={formatPrice(quote.data.price)} large />
              <Stat
                label="Change"
                value={formatPercent(quote.data.changePercent)}
                className={changeColor(quote.data.changePercent)}
              />
              <Stat
                label="Day range"
                value={
                  quote.data.dayLow !== null && quote.data.dayHigh !== null
                    ? `${formatPrice(quote.data.dayLow)} - ${formatPrice(quote.data.dayHigh)}`
                    : 'not reported'
                }
              />
              <RangeStats candles={candles.ok ? candles.data : null} />
            </>
          ) : (
            <div className="min-w-0 flex-1">
              <Unavailable
                reason={quote.message}
                hint={
                  quote.code === 'no_api_key'
                    ? 'Add the relevant key to .env.local and restart. See .env.example.'
                    : undefined
                }
                compact
              />
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-term-border px-2 py-1">
          {snapshot.provenance.length === 0 ? (
            <span className="text-2xs text-term-warn">No source could be reached for this symbol.</span>
          ) : (
            snapshot.provenance.map((provenance, index) => (
              <ProvenanceLine key={index} label={asset.symbol} provenance={provenance} />
            ))
          )}
        </footer>
      </Panel>

      <div className="grid gap-2 xl:grid-cols-[1fr_380px]">
        <div className="flex min-w-0 flex-col gap-2">
          <Panel title="Chart" right={<span className="text-term-faint">daily</span>}>
            {candles.ok && candles.data.bars.length > 0 ? (
              <PriceChart series={candles.data} symbol={asset.symbol} />
            ) : (
              <div className="p-2">
                <Unavailable
                  reason={candles.ok ? 'The feed returned no bars.' : candles.message}
                  hint={
                    candles.ok
                      ? undefined
                      : candles.code === 'no_api_key'
                        ? 'Equity and index candles come from Alpha Vantage. Set ALPHAVANTAGE_API_KEY.'
                        : candles.code === 'unsupported'
                          ? 'This feed cannot serve bars at the requested resolution and window.'
                          : undefined
                  }
                />
              </div>
            )}
          </Panel>

          <MacroStrip events={macro} />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <OutlookPanel outlook={outlook} gap={outlookGap} />

          <div className="min-h-0 xl:max-h-[36rem]">
            <NewsPane
              items={news}
              status={newsStatus}
              sentiment={sentiment}
              title={`News · ${asset.symbol}`}
            />
          </div>

          <SentimentMethodNote className="px-1" />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  className,
  large,
}: {
  label: string;
  value: string;
  className?: string;
  large?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={clsx('tabular-nums text-term-bright', large && 'text-lg', className)}>
        {value}
      </div>
    </div>
  );
}

/**
 * 52-week range and volatility, computed from the bars actually returned.
 *
 * The window label states how many bars were used, because a "52-week range"
 * built from 30 bars would be a different statistic wearing the same name.
 */
function RangeStats({ candles }: { candles: import('@/lib/market/types').CandleSeries | null }) {
  if (!candles || candles.bars.length === 0) return null;

  const window = candles.bars.slice(-252);
  const high = Math.max(...window.map((b) => b.h));
  const low = Math.min(...window.map((b) => b.l));
  const prices = closes(candles.bars);
  const spot = prices[prices.length - 1] ?? null;

  const atrSeries = atr(candles.bars, 14);
  const latestAtr = [...atrSeries].reverse().find((v) => v !== null) ?? null;
  const realized = realizedVolatility(prices.slice(-60));

  const label = window.length >= 252 ? '52-week range' : `${window.length}-bar range`;

  return (
    <>
      <Stat label={label} value={`${formatPrice(low)} - ${formatPrice(high)}`} />
      {candles.hasRange && latestAtr !== null && spot ? (
        <Stat
          label="ATR(14)"
          value={`${formatPrice(latestAtr)} (${((latestAtr / spot) * 100).toFixed(2)}%)`}
        />
      ) : realized !== null ? (
        <Stat label="Volatility (ann.)" value={`${(realized * 100).toFixed(1)}% c2c`} />
      ) : null}
      {candles.hasVolume && (
        <Stat
          label="Volume"
          value={formatCompact(candles.bars[candles.bars.length - 1]?.v ?? null)}
        />
      )}
    </>
  );
}
