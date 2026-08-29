'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { useMemo } from 'react';
import { INDEXES, encodeSymbol } from '@/lib/symbols';
import { SP500_COVERAGE } from '@/lib/universe';
import { changeColor, formatPercent, formatPrice } from '@/lib/format';
import { Panel, Unavailable } from './ui';
import { useQuoteStream } from './useQuoteStream';

/**
 * Index tiles.
 *
 * Where an index is only reachable through an ETF proxy, the tile says so on its
 * face -- SPY is a fund with its own price and tracking error, not the S&P 500.
 * Indices no configured feed can serve show an explicit gap rather than being
 * quietly omitted.
 */
export function IndexTiles() {
  const symbols = useMemo(() => INDEXES.map((i) => i.symbol), []);
  const { quotes } = useQuoteStream(symbols, 15_000);

  return (
    <Panel title="Indices" right={<span className="text-term-faint">6 tracked</span>}>
      <div className="grid grid-cols-2 gap-px bg-term-border md:grid-cols-3 xl:grid-cols-6">
        {INDEXES.map((index) => {
          const result = quotes[index.symbol];
          return (
            <Link
              key={index.symbol}
              href={`/ticker/${encodeSymbol(index.symbol)}`}
              className="flex flex-col gap-0.5 bg-term-panel p-2 hover:bg-term-panel-2"
            >
              <span className="label truncate" title={index.name}>
                {index.name}
              </span>

              {result === undefined ? (
                <span className="text-term-faint">loading</span>
              ) : result.ok ? (
                <>
                  <span className="text-sm tabular-nums text-term-bright">
                    {formatPrice(result.data.price)}
                  </span>
                  <span className={clsx('tabular-nums', changeColor(result.data.changePercent))}>
                    {formatPercent(result.data.changePercent)}
                  </span>
                  {result.provenance.note && (
                    <span className="truncate text-2xs text-term-warn" title={result.provenance.note}>
                      {result.provenance.note}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="text-term-warn">--</span>
                  <span className="truncate text-2xs text-term-dim" title={result.message}>
                    {result.code === 'no_api_key'
                      ? 'no API key configured'
                      : result.code === 'unsupported'
                        ? 'no configured feed serves this index'
                        : 'feed unavailable'}
                  </span>
                </>
              )}
            </Link>
          );
        })}
      </div>
    </Panel>
  );
}

/** The scrolling tape. Duplicated once so the loop is seamless. */
export function TickerTape({ symbols }: { symbols: string[] }) {
  const { quotes } = useQuoteStream(symbols, 10_000);
  const entries = symbols.map((symbol) => ({ symbol, result: quotes[symbol] }));

  return (
    <div className="overflow-hidden border-y border-term-border bg-term-panel py-1">
      <div className="animate-tape flex w-max gap-6 whitespace-nowrap px-3">
        {[0, 1].map((copy) => (
          <div key={copy} className="flex gap-6" aria-hidden={copy === 1}>
            {entries.map(({ symbol, result }) => (
              <Link
                key={`${copy}-${symbol}`}
                href={`/ticker/${encodeSymbol(symbol)}`}
                className="flex items-baseline gap-1.5 hover:text-term-accent"
              >
                <span className="text-term-bright">{symbol}</span>
                {result?.ok ? (
                  <>
                    <span className="tabular-nums">{formatPrice(result.data.price)}</span>
                    <span className={clsx('tabular-nums', changeColor(result.data.changePercent))}>
                      {formatPercent(result.data.changePercent)}
                    </span>
                  </>
                ) : (
                  <span className="text-term-faint">--</span>
                )}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface SectorCell {
  symbol: string;
  name: string;
  changePercent: number | null;
}

export interface SectorGroup {
  sector: string;
  /** Mean of the constituents that actually returned a quote. */
  averageChange: number | null;
  priced: number;
  total: number;
  cells: SectorCell[];
}

/**
 * S&P 500 sector heatmap.
 *
 * Cells with no quote are drawn grey rather than as a neutral zero, and the
 * sector average is computed only from names that actually priced -- with the
 * count shown, so a sector summarised from three of forty names cannot be
 * mistaken for a complete read.
 */
export function SectorHeatmap({ groups }: { groups: SectorGroup[] }) {
  if (groups.length === 0) {
    return (
      <Panel title="S&P 500 sectors">
        <Unavailable
          reason="No constituent quotes available."
          hint="Configure FINNHUB_API_KEY to price the bundled S&P 500 snapshot."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="S&P 500 sector heatmap"
      right={<span className="text-term-faint">{SP500_COVERAGE.label}</span>}
    >
      <div className="space-y-px bg-term-border">
        {groups.map((group) => (
          <div key={group.sector} className="bg-term-panel p-1.5">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-term-text">{group.sector}</span>
              <span className="flex items-center gap-2 text-2xs">
                <span className={clsx('tabular-nums', changeColor(group.averageChange))}>
                  {formatPercent(group.averageChange)}
                </span>
                <span className="text-term-faint">
                  {group.priced}/{group.total} priced
                </span>
              </span>
            </div>
            <div className="flex flex-wrap gap-px">
              {group.cells.map((cell) => (
                <Link
                  key={cell.symbol}
                  href={`/ticker/${encodeSymbol(cell.symbol)}`}
                  title={`${cell.name} ${formatPercent(cell.changePercent)}`}
                  className={clsx(
                    'min-w-[3.25rem] px-1 py-0.5 text-center text-2xs transition-opacity hover:opacity-80',
                    heatClass(cell.changePercent),
                  )}
                >
                  {cell.symbol}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Five buckets each way. Grey means "no quote", never "flat". */
function heatClass(change: number | null): string {
  if (change === null || !Number.isFinite(change)) {
    return 'bg-term-panel-2 text-term-faint';
  }
  if (change >= 3) return 'bg-term-up text-black';
  if (change >= 1.5) return 'bg-term-up/70 text-black';
  if (change >= 0.5) return 'bg-term-up/45 text-term-bright';
  if (change > 0) return 'bg-term-up/20 text-term-bright';
  if (change === 0) return 'bg-term-panel-2 text-term-dim';
  if (change > -0.5) return 'bg-term-down/20 text-term-bright';
  if (change > -1.5) return 'bg-term-down/45 text-term-bright';
  if (change > -3) return 'bg-term-down/70 text-black';
  return 'bg-term-down text-black';
}

export interface Mover {
  symbol: string;
  name: string;
  changePercent: number;
  price: number;
}

export function TopMovers({
  gainers,
  losers,
  priced,
  total,
}: {
  gainers: Mover[];
  losers: Mover[];
  priced: number;
  total: number;
}) {
  return (
    <Panel
      title="Top movers"
      right={<span className="text-term-faint">from {priced} of {total} priced</span>}
    >
      {priced === 0 ? (
        <Unavailable
          reason="No constituent quotes available to rank."
          hint="Movers are ranked from the bundled S&P 500 snapshot, which needs an equity data key."
          compact
        />
      ) : (
        <div className="grid grid-cols-2 gap-px bg-term-border">
          <MoverColumn title="Gainers" movers={gainers} />
          <MoverColumn title="Losers" movers={losers} />
        </div>
      )}
    </Panel>
  );
}

function MoverColumn({ title, movers }: { title: string; movers: Mover[] }) {
  return (
    <div className="bg-term-panel">
      <h3 className="label border-b border-term-border px-2 py-1">{title}</h3>
      {movers.length === 0 ? (
        <p className="px-2 py-2 text-term-faint">none</p>
      ) : (
        <ul>
          {movers.map((mover) => (
            <li key={mover.symbol} className="border-b border-term-border/50 last:border-0">
              <Link
                href={`/ticker/${encodeSymbol(mover.symbol)}`}
                className="flex items-baseline justify-between gap-2 px-2 py-1 hover:bg-term-panel-2"
              >
                <span className="truncate text-term-bright" title={mover.name}>
                  {mover.symbol}
                </span>
                <span className="shrink-0 tabular-nums text-term-dim">{formatPrice(mover.price)}</span>
                <span className={clsx('w-14 shrink-0 text-right tabular-nums', changeColor(mover.changePercent))}>
                  {formatPercent(mover.changePercent)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
