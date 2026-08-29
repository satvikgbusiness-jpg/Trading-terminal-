import clsx from 'clsx';
import type { Outlook } from '@/lib/analysis/outlook';
import type { MacroEvent } from '@/lib/analysis/macro';
import { MACRO_CALENDAR_COMPILED } from '@/lib/analysis/macro';
import { Bias, OutlookDisclaimer, Panel, Unavailable, VolatilityBadge } from './ui';

/**
 * The Outlook panel.
 *
 * Renders the bias, the strength, and every reason behind it. The framing line
 * is not optional and not collapsible: a number like "BULLISH 62" is only
 * honest next to a statement of what it is and is not.
 */
export function OutlookPanel({ outlook, gap }: { outlook: Outlook | null; gap: string | null }) {
  if (!outlook) {
    return (
      <Panel title="Outlook">
        <div className="space-y-2 p-2">
          <Unavailable
            reason={gap ?? 'No price history available.'}
            hint="The Outlook needs daily bars. Configure an equity data key, or pick a symbol whose feed is available."
            compact
          />
          <OutlookDisclaimer />
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Outlook"
      right={<span className="text-term-faint">{outlook.barsUsed} bars</span>}
    >
      <div className="space-y-2 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base">
            <Bias bias={outlook.bias} strength={outlook.strength} />
          </span>
          <VolatilityBadge level={outlook.volatility.level} />
          <span className="ml-auto text-2xs text-term-faint">score {outlook.score.toFixed(1)}</span>
        </div>

        {/* A strength bar reads faster than a number for "how far from neutral". */}
        <div className="h-1 w-full bg-term-panel-2">
          <div
            className={clsx(
              'h-full',
              outlook.bias === 'bullish'
                ? 'bg-term-up'
                : outlook.bias === 'bearish'
                  ? 'bg-term-down'
                  : 'bg-term-dim',
            )}
            style={{ width: `${Math.min(100, outlook.strength)}%` }}
          />
        </div>

        <ul className="space-y-0.5">
          {outlook.reasons.map((reason, index) => (
            <li key={index} className="flex gap-1.5 text-term-text">
              <span className="shrink-0 text-term-faint">-</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>

        <ComponentBreakdown outlook={outlook} />

        {outlook.gaps.length > 0 && (
          <details className="border border-term-border bg-term-panel-2/40">
            <summary className="cursor-pointer px-2 py-1 text-2xs text-term-warn">
              {outlook.gaps.length} input{outlook.gaps.length === 1 ? '' : 's'} unavailable
            </summary>
            <ul className="space-y-0.5 px-2 pb-2 text-2xs text-term-dim">
              {outlook.gaps.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </details>
        )}

        <OutlookDisclaimer className="border-t border-term-border pt-1.5" />
      </div>
    </Panel>
  );
}

/** How each input contributed, so the headline number can be taken apart. */
function ComponentBreakdown({ outlook }: { outlook: Outlook }) {
  const available = outlook.components.filter((c) => c.available);
  const totalWeight = available.reduce((sum, c) => sum + c.weight, 0);

  return (
    <details className="border border-term-border bg-term-panel-2/40">
      <summary className="cursor-pointer px-2 py-1 text-2xs text-term-dim">
        How this was computed ({available.length} of {outlook.components.length} inputs, weight{' '}
        {totalWeight.toFixed(1)})
      </summary>
      <table className="w-full px-2 pb-2 text-2xs">
        <thead>
          <tr className="text-left text-term-faint">
            <th className="px-2 py-0.5 font-normal">Input</th>
            <th className="px-2 py-0.5 text-right font-normal">Reading</th>
            <th className="px-2 py-0.5 text-right font-normal">Weight</th>
            <th className="px-2 py-0.5 text-right font-normal">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {outlook.components.map((component) => (
            <tr key={component.id} className="border-t border-term-border/50">
              <td className="px-2 py-0.5 text-term-text">{component.label}</td>
              <td
                className={clsx(
                  'px-2 py-0.5 text-right tabular-nums',
                  !component.available
                    ? 'text-term-faint'
                    : component.contribution > 0
                      ? 'text-term-up'
                      : component.contribution < 0
                        ? 'text-term-down'
                        : 'text-term-dim',
                )}
              >
                {component.available ? component.contribution.toFixed(2) : 'n/a'}
              </td>
              <td className="px-2 py-0.5 text-right tabular-nums text-term-dim">
                {component.weight.toFixed(1)}
              </td>
              <td className="px-2 py-0.5 text-right tabular-nums text-term-dim">
                {component.available ? component.weighted.toFixed(2) : '--'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 pb-2 text-2xs text-term-faint">
        Score is the weighted mean over available inputs only, scaled to -100..100. Unavailable
        inputs are excluded from the denominator rather than counted as zero. Volatility is reported
        but never scored.
      </p>
    </details>
  );
}

/**
 * Scheduled events, shown as context and deliberately not scored.
 *
 * Knowing a CPI print lands on Thursday tells you when the tape is likely to be
 * unpredictable, not which way it will go.
 */
export function MacroStrip({ events }: { events: MacroEvent[] }) {
  if (events.length === 0) {
    return (
      <Panel title="External factors">
        <p className="p-2 text-term-dim">No scheduled events in the next six weeks.</p>
      </Panel>
    );
  }

  return (
    <Panel
      title="External factors"
      right={<span className="text-term-faint">context only, not scored</span>}
    >
      <ul className="divide-y divide-term-border/50">
        {events.slice(0, 12).map((event) => (
          <li key={event.id} className="flex items-baseline gap-2 px-2 py-1">
            <span className="w-20 shrink-0 tabular-nums text-term-dim">{event.date}</span>
            <span
              className={clsx(
                'w-1 shrink-0 self-stretch',
                event.importance === 'high'
                  ? 'bg-term-warn'
                  : event.importance === 'medium'
                    ? 'bg-term-warn/40'
                    : 'bg-term-border-bright',
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-term-text">{event.title}</span>
            <span className="shrink-0 text-2xs text-term-faint">{event.region}</span>
          </li>
        ))}
      </ul>
      <p className="border-t border-term-border px-2 py-1 text-2xs text-term-faint">
        Typical release dates from a static calendar compiled {MACRO_CALENDAR_COMPILED}. Central
        banks and statistical agencies do move dates -- confirm against the official schedule before
        relying on any of these.
      </p>
    </Panel>
  );
}
