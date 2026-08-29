'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { searchLocal } from '@/lib/universe';
import { encodeSymbol, type Asset } from '@/lib/symbols';

/**
 * Cmd+K symbol jump.
 *
 * Matches against the bundled universe first, which is instant and costs no
 * rate budget, then folds in remote search results when the query looks like a
 * ticker the local tables do not carry.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<Asset[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const local = useMemo(() => searchLocal(query, 12), [query]);

  const results = useMemo(() => {
    const seen = new Set(local.map((a) => a.symbol));
    return [...local, ...remote.filter((a) => !seen.has(a.symbol))].slice(0, 16);
  }, [local, remote]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setRemote([]);
      setCursor(0);
      // The input mounts with the dialog; focus on the next frame.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Ask the server only when the local tables come up short.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2 || local.length >= 5) {
      setRemote([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as { results?: Asset[] };
        setRemote(body.results ?? []);
      } catch {
        /* aborted or offline: local results still stand */
      }
    }, 220);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, query, local.length]);

  if (!open) return null;

  const go = (asset: Asset) => {
    onClose();
    router.push(`/ticker/${encodeSymbol(asset.symbol)}`);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = results[cursor];
      if (chosen) go(chosen);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-xl panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Symbol search"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Symbol or name -- AAPL, BTC-USD, EUR/USD, ^GSPC"
          className="w-full border-b border-term-border bg-transparent px-3 py-2.5 text-term-bright outline-none placeholder:text-term-faint"
          spellCheck={false}
          autoComplete="off"
        />

        <ul className="max-h-80 overflow-y-auto">
          {results.length === 0 ? (
            <li className="px-3 py-3 text-term-dim">
              {query.trim() ? 'No match in the bundled universe.' : 'Type to search.'}
            </li>
          ) : (
            results.map((asset, index) => (
              <li key={asset.symbol}>
                <button
                  type="button"
                  onClick={() => go(asset)}
                  onMouseEnter={() => setCursor(index)}
                  className={clsx(
                    'flex w-full items-center gap-3 px-3 py-1.5 text-left',
                    index === cursor ? 'bg-term-accent/10 text-term-bright' : 'hover:bg-term-panel-2',
                  )}
                >
                  <span className="w-24 shrink-0 font-medium text-term-bright">{asset.symbol}</span>
                  <span className="flex-1 truncate text-term-dim">{asset.name}</span>
                  <span className="label shrink-0">{asset.assetClass}</span>
                </button>
              </li>
            ))
          )}
        </ul>

        <footer className="flex items-center gap-3 border-t border-term-border px-3 py-1 text-2xs text-term-faint">
          <span>ENTER open</span>
          <span>UP/DOWN navigate</span>
          <span>ESC close</span>
        </footer>
      </div>
    </div>
  );
}
