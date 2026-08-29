'use client';

import { useEffect, useRef, useState } from 'react';
import type { Quote, Result } from '@/lib/market/types';

export type QuoteMap = Record<string, Result<Quote>>;

export interface StreamState {
  quotes: QuoteMap;
  /** Symbols that changed on the last tick, and which way, for the flash. */
  moved: Record<string, 'up' | 'down'>;
  connected: boolean;
  lastMessageAt: number | null;
  error: string | null;
}

/**
 * Subscribe to the server-sent quote stream.
 *
 * The server does the polling against the shared, rate-limited cache, so this
 * hook is a thin consumer. `moved` marks which rows changed on the last tick so
 * the table can flash them without diffing in every row component.
 */
export function useQuoteStream(symbols: string[], intervalMs = 8000): StreamState {
  const [state, setState] = useState<StreamState>({
    quotes: {},
    moved: {},
    connected: false,
    lastMessageAt: null,
    error: null,
  });

  const previous = useRef<Record<string, number>>({});
  // Join into a stable key so a new array identity with the same contents does
  // not tear down and rebuild the EventSource on every render.
  const key = symbols.slice().sort().join(',');

  useEffect(() => {
    if (!key) return;

    const source = new EventSource(`/api/stream?symbols=${encodeURIComponent(key)}&intervalMs=${intervalMs}`);

    source.addEventListener('open', () => {
      setState((s) => ({ ...s, connected: true, error: null }));
    });

    source.addEventListener('quotes', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { quotes: QuoteMap; at: number };
        const moved: Record<string, 'up' | 'down'> = {};

        for (const [symbol, result] of Object.entries(payload.quotes)) {
          if (!result.ok) continue;
          const before = previous.current[symbol];
          if (before !== undefined && before !== result.data.price) {
            moved[symbol] = result.data.price > before ? 'up' : 'down';
          }
          previous.current[symbol] = result.data.price;
        }

        setState({
          quotes: payload.quotes,
          moved,
          connected: true,
          lastMessageAt: payload.at,
          error: null,
        });
      } catch {
        /* a malformed frame is not worth tearing the stream down for */
      }
    });

    source.addEventListener('error', () => {
      // EventSource reconnects on its own; surface the gap without hiding data.
      setState((s) => ({ ...s, connected: false, error: 'Stream interrupted; reconnecting.' }));
    });

    source.addEventListener('closing', () => {
      source.close();
      setState((s) => ({ ...s, connected: false, error: 'Stream closed. Reload to resume.' }));
    });

    return () => source.close();
  }, [key, intervalMs]);

  return state;
}
