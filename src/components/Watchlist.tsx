'use client';

import { useState, useTransition } from 'react';
import { Panel } from './ui';
import { QuoteTable, type QuoteRow } from './QuoteTable';

/**
 * The persisted watchlist. Adds and removes hit the API and re-render from the
 * server's response, so the list on screen is always the list in the database.
 */
export function Watchlist({ initial }: { initial: QuoteRow[] }) {
  const [rows, setRows] = useState<QuoteRow[]>(initial);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refresh = async (response: Response) => {
    const body = (await response.json()) as {
      items?: Array<{ symbol: string; assetClass: string }>;
      error?: string;
    };
    if (!response.ok) {
      setError(body.error ?? 'Request failed');
      return;
    }
    setError(null);
    setRows(
      (body.items ?? []).map((item) => ({
        symbol: item.symbol,
        name: item.symbol,
        assetClass: item.assetClass,
      })),
    );
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    const symbol = draft.trim().toUpperCase();
    if (!symbol) return;
    startTransition(async () => {
      const response = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      await refresh(response);
      if (response.ok) setDraft('');
    });
  };

  const remove = (symbol: string) => {
    startTransition(async () => {
      const response = await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
      });
      await refresh(response);
    });
  };

  return (
    <Panel
      title="Watchlist"
      right={<span>{rows.length}</span>}
      className="h-full"
      bodyClassName="flex flex-col min-h-0"
    >
      <form onSubmit={add} className="flex shrink-0 gap-1 border-b border-term-border p-1.5">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add symbol"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 border border-term-border bg-term-bg px-2 py-0.5 text-term-bright outline-none placeholder:text-term-faint focus:border-term-accent/60"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          className="border border-term-border-bright px-2 py-0.5 text-term-dim hover:border-term-accent/60 hover:text-term-bright disabled:opacity-40"
        >
          ADD
        </button>
      </form>

      {error && (
        <p className="shrink-0 border-b border-term-border bg-term-down/10 px-2 py-1 text-term-down">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1">
        <QuoteTable
          rows={rows}
          onRemove={remove}
          emptyMessage="Watchlist is empty. Run pnpm seed, or add a symbol above."
        />
      </div>
    </Panel>
  );
}
