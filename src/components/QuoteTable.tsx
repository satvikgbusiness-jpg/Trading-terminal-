'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { encodeSymbol } from '@/lib/symbols';
import { changeColor, formatPercent, formatPrice, timeAgo } from '@/lib/format';
import { useQuoteStream } from './useQuoteStream';

export interface QuoteRow {
  symbol: string;
  name: string;
  assetClass: string;
}

/**
 * The dense quote grid used by the watchlist and movers panes.
 *
 * A symbol whose feed failed keeps its row and shows the reason inline. Dropping
 * the row would make an outage look like the symbol had simply gone away.
 */
export function QuoteTable({
  rows,
  onRemove,
  showClass = true,
  emptyMessage = 'Nothing here yet.',
}: {
  rows: QuoteRow[];
  onRemove?: (symbol: string) => void;
  showClass?: boolean;
  emptyMessage?: string;
}) {
  const { quotes, moved, connected, lastMessageAt } = useQuoteStream(rows.map((r) => r.symbol));

  if (rows.length === 0) {
    return <p className="px-2 py-3 text-term-dim">{emptyMessage}</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-term-panel">
            <tr className="border-b border-term-border text-left">
              <th className="label px-2 py-1 font-normal">Symbol</th>
              <th className="label px-2 py-1 text-right font-normal">Last</th>
              <th className="label px-2 py-1 text-right font-normal">Chg%</th>
              {showClass && <th className="label px-2 py-1 text-right font-normal">Class</th>}
              {onRemove && <th className="w-6" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const result = quotes[row.symbol];
              const direction = moved[row.symbol];

              return (
                <tr
                  key={row.symbol}
                  className={clsx(
                    'border-b border-term-border/50 hover:bg-term-panel-2',
                    direction === 'up' && 'flash-up',
                    direction === 'down' && 'flash-down',
                  )}
                >
                  <td className="px-2 py-1">
                    <Link
                      href={`/ticker/${encodeSymbol(row.symbol)}`}
                      className="block truncate text-term-bright hover:text-term-accent"
                      title={row.name}
                    >
                      {row.symbol}
                    </Link>
                  </td>

                  {result === undefined ? (
                    <td className="px-2 py-1 text-right text-term-faint" colSpan={showClass ? 2 : 1}>
                      loading
                    </td>
                  ) : result.ok ? (
                    <>
                      <td className="px-2 py-1 text-right tabular-nums text-term-bright">
                        {formatPrice(result.data.price)}
                        {result.provenance.stale && (
                          <span
                            className="ml-1 text-term-warn"
                            title={result.provenance.staleReason ?? 'cached value'}
                          >
                            *
                          </span>
                        )}
                      </td>
                      <td
                        className={clsx(
                          'px-2 py-1 text-right tabular-nums',
                          changeColor(result.data.changePercent),
                        )}
                      >
                        {formatPercent(result.data.changePercent)}
                      </td>
                    </>
                  ) : (
                    <td
                      className="truncate px-2 py-1 text-right text-term-warn"
                      colSpan={2}
                      title={result.message}
                    >
                      {result.code === 'no_api_key' ? 'no API key' : 'no data'}
                    </td>
                  )}

                  {showClass && (
                    <td className="px-2 py-1 text-right text-2xs text-term-dim">{row.assetClass}</td>
                  )}

                  {onRemove && (
                    <td className="px-1 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => onRemove(row.symbol)}
                        className="text-term-faint hover:text-term-down"
                        aria-label={`Remove ${row.symbol}`}
                        title={`Remove ${row.symbol}`}
                      >
                        x
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-term-border px-2 py-1 text-2xs text-term-dim">
        <span
          className={clsx('h-1.5 w-1.5 rounded-full', connected ? 'bg-term-up' : 'bg-term-warn')}
          aria-hidden
        />
        <span>{connected ? 'streaming' : 'reconnecting'}</span>
        {lastMessageAt && <span className="text-term-faint">· updated {timeAgo(lastMessageAt)}</span>}
        <span className="ml-auto text-term-faint">* = cached after a failed refresh</span>
      </div>
    </div>
  );
}
