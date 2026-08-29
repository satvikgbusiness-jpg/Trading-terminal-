import clsx from 'clsx';
import type { ScoredNews } from '@/lib/news';
import type { AggregateResult } from '@/lib/analysis/sentiment';
import { timeAgo } from '@/lib/format';
import { Panel, SentimentChip, Unavailable } from './ui';

export type NewsStatus =
  | { kind: 'live'; source: string; fetchedAt: number; stale: boolean }
  | { kind: 'stored-only'; reason: string }
  | { kind: 'empty'; reason: string };

/**
 * The news stream.
 *
 * Every headline carries the sentiment chip the Outlook actually used, so the
 * number in the Outlook panel can be traced back to the stories behind it.
 */
export function NewsPane({
  items,
  status,
  sentiment,
  title = 'News',
}: {
  items: ScoredNews[];
  status: NewsStatus;
  sentiment: AggregateResult;
  title?: string;
}) {
  return (
    <Panel
      title={title}
      right={
        sentiment.counts.total > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className="text-term-faint">aggregate</span>
            <SentimentChip score={sentiment.score} label={sentiment.label} />
          </span>
        ) : null
      }
      className="min-h-0"
      bodyClassName="flex flex-col min-h-0"
    >
      {status.kind === 'stored-only' && (
        <p className="shrink-0 border-b border-term-border bg-term-warn/5 px-2 py-1 text-2xs text-term-warn">
          Live feed unavailable ({status.reason}). Showing stored headlines.
        </p>
      )}

      {items.length === 0 ? (
        <div className="p-2">
          <Unavailable
            reason={
              status.kind === 'empty' ? status.reason : 'No headlines in the scoring window.'
            }
            hint="News comes from the configured RSS feeds plus company news when an API key is set."
            compact
          />
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-term-border/50 overflow-y-auto">
          {items.map((item) => (
            <li key={item.id} className="px-2 py-1.5 hover:bg-term-panel-2">
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="block">
                <div className="flex items-start gap-2">
                  <SentimentChip score={item.sentimentScore} label={item.sentimentLabel} />
                  <span className="min-w-0 flex-1 text-term-text hover:text-term-bright">
                    {item.headline}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 pl-1 text-2xs text-term-faint">
                  <span className="truncate">{item.source}</span>
                  <span>·</span>
                  <span className="shrink-0">{timeAgo(item.publishedAt)}</span>
                  {item.symbol && (
                    <>
                      <span>·</span>
                      <span className="shrink-0 text-term-accent">{item.symbol}</span>
                    </>
                  )}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}

      {sentiment.counts.total > 0 && (
        <footer className="shrink-0 border-t border-term-border px-2 py-1 text-2xs text-term-faint">
          <span className="text-term-up">{sentiment.counts.positive} positive</span>
          {' · '}
          <span className="text-term-down">{sentiment.counts.negative} negative</span>
          {' · '}
          <span>{sentiment.counts.neutral} neutral</span>
          {' · '}
          <span title="Sum of recency weights: how many fresh headlines' worth of evidence this is.">
            {sentiment.effectiveCount.toFixed(1)} effective
          </span>
          {' · '}
          <span title="Lexicon scoring with a finance overlay, recency-decayed with a 24h half-life and shrunk toward neutral on thin evidence.">
            local lexicon model
          </span>
        </footer>
      )}
    </Panel>
  );
}

/** Sentiment is a bag-of-words read; say so where a user will act on it. */
export function SentimentMethodNote({ className }: { className?: string }) {
  return (
    <p className={clsx('text-2xs text-term-faint', className)}>
      Headlines are scored by a local lexicon (no model calls), weighted by recency with a 24-hour
      half-life and shrunk toward neutral when few stories exist. It is a bag-of-words method with no
      notion of sentence subject, so a headline about a rival can score against the symbol it is
      filed under.
    </p>
  );
}
