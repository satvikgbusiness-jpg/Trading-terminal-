'use client';

import { useState, useTransition } from 'react';
import clsx from 'clsx';

export function AddToWatchlistButton({ symbol }: { symbol: string }) {
  const [state, setState] = useState<'idle' | 'added' | 'error'>('idle');
  const [pending, startTransition] = useTransition();

  const add = () =>
    startTransition(async () => {
      try {
        const response = await fetch('/api/watchlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbol }),
        });
        setState(response.ok ? 'added' : 'error');
      } catch {
        setState('error');
      }
    });

  return (
    <button
      type="button"
      onClick={add}
      disabled={pending || state === 'added'}
      className={clsx(
        'border px-1.5 py-0.5 text-2xs',
        state === 'added'
          ? 'border-term-up/50 text-term-up'
          : state === 'error'
            ? 'border-term-down/50 text-term-down'
            : 'border-term-border-bright text-term-dim hover:border-term-accent/60 hover:text-term-bright',
      )}
    >
      {state === 'added' ? 'ON WATCHLIST' : state === 'error' ? 'FAILED' : '+ WATCHLIST'}
    </button>
  );
}
