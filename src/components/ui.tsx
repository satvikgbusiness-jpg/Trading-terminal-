import clsx from 'clsx';
import type { Provenance } from '@/lib/market/types';
import { timeAgo } from '@/lib/format';

/** A bordered panel with a small uppercase title bar. */
export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx('panel flex min-h-0 flex-col', className)}>
      {(title || right) && (
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-term-border px-2 py-1">
          <h2 className="label truncate">{title}</h2>
          {right ? <div className="shrink-0 text-2xs text-term-dim">{right}</div> : null}
        </header>
      )}
      <div className={clsx('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * Explains why a value is missing.
 *
 * Used everywhere a feed could not answer. The terminal shows the reason rather
 * than a zero, a dash with no explanation, or a plausible-looking placeholder.
 */
export function Unavailable({
  reason,
  hint,
  compact,
}: {
  reason: string;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-1 border border-dashed border-term-border-bright bg-term-panel-2/40 text-term-dim',
        compact ? 'px-2 py-1.5' : 'px-3 py-4',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-term-warn">NO DATA</span>
        <span className="truncate">{reason}</span>
      </div>
      {hint ? <p className="text-2xs text-term-faint">{hint}</p> : null}
    </div>
  );
}

/** Marks a value that came from cache after a failed refresh. */
export function StaleBadge({ provenance }: { provenance: Provenance }) {
  if (!provenance.stale) return null;
  return (
    <span
      title={provenance.staleReason ?? 'The last refresh failed; showing the previous value.'}
      className="border border-term-warn/50 bg-term-warn/10 px-1 text-2xs text-term-warn"
    >
      STALE
    </span>
  );
}

/**
 * The provenance footer: source, age and delay for every value on screen.
 *
 * Reads like "AAPL - delayed 15m - Finnhub - 12s ago". This is the terminal's
 * central honesty affordance: you can always tell where a number came from.
 */
export function ProvenanceLine({
  label,
  provenance,
  className,
}: {
  label?: string;
  provenance: Provenance;
  className?: string;
}) {
  const delay =
    provenance.delayMinutes === 0
      ? 'real-time'
      : provenance.delayMinutes >= 1440
        ? `daily fixing`
        : `delayed ${provenance.delayMinutes}m`;

  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-1.5 text-2xs', className)}>
      {label ? <span className="text-term-text">{label}</span> : null}
      <span className="text-term-faint">·</span>
      <span className="text-term-dim">{delay}</span>
      <span className="text-term-faint">·</span>
      <span className="text-term-accent">{provenance.source}</span>
      <span className="text-term-faint">·</span>
      <span className="text-term-dim">{timeAgo(provenance.fetchedAt)}</span>
      {provenance.note ? (
        <>
          <span className="text-term-faint">·</span>
          <span className="text-term-warn" title={provenance.note}>
            {provenance.note}
          </span>
        </>
      ) : null}
      <StaleBadge provenance={provenance} />
    </span>
  );
}

export function Bias({ bias, strength }: { bias: 'bullish' | 'bearish' | 'neutral'; strength: number }) {
  const arrow = bias === 'bullish' ? '▲' : bias === 'bearish' ? '▼' : '▬';
  const color =
    bias === 'bullish' ? 'text-term-up' : bias === 'bearish' ? 'text-term-down' : 'text-term-dim';
  return (
    <span className={clsx('font-medium', color)}>
      {arrow} {bias.toUpperCase()} {strength}
    </span>
  );
}

export function VolatilityBadge({ level }: { level: 'low' | 'medium' | 'high' | 'unknown' }) {
  const style = {
    low: 'border-term-up/40 bg-term-up/10 text-term-up',
    medium: 'border-term-warn/40 bg-term-warn/10 text-term-warn',
    high: 'border-term-down/40 bg-term-down/10 text-term-down',
    unknown: 'border-term-border-bright bg-term-panel-2 text-term-dim',
  }[level];
  return <span className={clsx('border px-1 text-2xs', style)}>{level.toUpperCase()} VOL</span>;
}

export function SentimentChip({ score, label }: { score: number; label: string }) {
  const style =
    label === 'positive'
      ? 'border-term-up/40 bg-term-up/10 text-term-up'
      : label === 'negative'
        ? 'border-term-down/40 bg-term-down/10 text-term-down'
        : 'border-term-border-bright bg-term-panel-2 text-term-dim';
  const sign = score >= 0 ? '+' : '';
  return (
    <span className={clsx('shrink-0 border px-1 text-2xs tabular-nums', style)} title={`sentiment ${score.toFixed(3)}`}>
      {sign}
      {score.toFixed(2)}
    </span>
  );
}

/** The line that must appear on every Outlook surface. */
export function OutlookDisclaimer({ className }: { className?: string }) {
  return (
    <p className={clsx('text-2xs text-term-dim', className)}>
      Signals are descriptive, not predictive. Not investment advice.
    </p>
  );
}
