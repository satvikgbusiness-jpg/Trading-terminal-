'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CommandPalette } from './CommandPalette';

const NAV = [
  { href: '/', label: 'MARKETS', key: 'F1' },
  { href: '/ticker/AAPL', label: 'TICKER', key: 'F2', match: '/ticker' },
  { href: '/bot', label: 'BOT', key: 'F3' },
  { href: '/demo', label: 'DEMO', key: 'F4' },
];

export function TerminalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [clock, setClock] = useState<string>('');

  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 flex items-center gap-4 border-b border-term-border bg-term-panel px-3 py-1.5">
        <Link href="/" className="shrink-0 font-bold tracking-widest text-term-accent">
          GMT<span className="text-term-dim">·</span>TERMINAL
        </Link>

        <nav className="flex items-center gap-0.5">
          {NAV.map((item) => {
            const active = item.match ? pathname.startsWith(item.match) : pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  'border px-2 py-0.5 text-2xs tracking-wider transition-colors',
                  active
                    ? 'border-term-accent/60 bg-term-accent/10 text-term-accent'
                    : 'border-transparent text-term-dim hover:border-term-border-bright hover:text-term-bright',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="ml-auto flex items-center gap-2 border border-term-border-bright bg-term-panel-2 px-2 py-0.5 text-2xs text-term-dim hover:border-term-accent/50 hover:text-term-bright"
        >
          <span>SEARCH SYMBOL</span>
          <kbd className="border border-term-border-bright px-1 text-term-faint">Cmd K</kbd>
        </button>

        <span className="hidden shrink-0 tabular-nums text-2xs text-term-dim sm:inline">
          {clock} UTC
        </span>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-term-border bg-term-panel px-3 py-1.5 text-2xs text-term-dim">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-term-warn">PAPER TRADING ONLY</span>
          <span className="text-term-faint">·</span>
          <span>Signals are descriptive, not predictive. Not investment advice.</span>
          <span className="text-term-faint">·</span>
          <span>
            Market data is delayed or reference-rate depending on source; every value on screen
            shows its own provenance.
          </span>
        </div>
      </footer>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
