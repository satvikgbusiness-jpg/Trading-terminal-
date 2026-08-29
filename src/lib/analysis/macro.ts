import type { Asset } from '@/lib/symbols';

/**
 * Scheduled events that move markets.
 *
 * Shown as context beside the Outlook and deliberately *not* scored: knowing a
 * CPI print lands on Thursday tells you when the tape is likely to be
 * unpredictable, not which way it will go. Folding that into a directional
 * number would be inventing a view the data does not support.
 *
 * Two sources:
 *  - a static calendar of recurring policy and data events, generated from
 *    published schedules and clearly marked with when it was compiled;
 *  - per-symbol earnings dates from the news provider's earnings calendar,
 *    when a key is configured.
 */

export type MacroCategory = 'monetary-policy' | 'inflation' | 'employment' | 'growth' | 'earnings';

export interface MacroEvent {
  id: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  title: string;
  region: string;
  category: MacroCategory;
  /** Rough market impact, from the event type alone. Not a forecast. */
  importance: 'high' | 'medium' | 'low';
  /** Symbol this event is specific to, or null for market-wide events. */
  symbol: string | null;
  source: string;
}

/**
 * Recurring policy and data events.
 *
 * Dates are the published schedules as of the compile date below. Central banks
 * and statistical agencies do move dates, so this is labelled a static calendar
 * everywhere it is displayed, and any date in the past is filtered out rather
 * than shown as upcoming.
 */
export const MACRO_CALENDAR_COMPILED = '2026-08-29';

interface RecurringEvent {
  title: string;
  region: string;
  category: MacroCategory;
  importance: 'high' | 'medium' | 'low';
  /** Day of month the release typically lands on. */
  dayOfMonth: number;
  /** Months (1-12) this event occurs in. Empty means every month. */
  months?: number[];
}

const RECURRING: RecurringEvent[] = [
  // Central bank decisions. The FOMC meets eight times a year, the BoE and ECB
  // eight, the BoJ eight -- the months below follow their published cadence.
  { title: 'FOMC rate decision', region: 'US', category: 'monetary-policy', importance: 'high', dayOfMonth: 18, months: [1, 3, 5, 6, 7, 9, 11, 12] },
  { title: 'Bank of England rate decision', region: 'UK', category: 'monetary-policy', importance: 'high', dayOfMonth: 6, months: [2, 3, 5, 6, 8, 9, 11, 12] },
  { title: 'ECB rate decision', region: 'EU', category: 'monetary-policy', importance: 'high', dayOfMonth: 12, months: [1, 3, 4, 6, 7, 9, 10, 12] },
  { title: 'Bank of Japan policy decision', region: 'JP', category: 'monetary-policy', importance: 'medium', dayOfMonth: 19, months: [1, 3, 4, 6, 7, 9, 10, 12] },

  // Monthly data releases.
  { title: 'US CPI (inflation)', region: 'US', category: 'inflation', importance: 'high', dayOfMonth: 12 },
  { title: 'US PCE price index', region: 'US', category: 'inflation', importance: 'medium', dayOfMonth: 27 },
  { title: 'US non-farm payrolls', region: 'US', category: 'employment', importance: 'high', dayOfMonth: 5 },
  { title: 'US ISM manufacturing PMI', region: 'US', category: 'growth', importance: 'medium', dayOfMonth: 1 },
  { title: 'US retail sales', region: 'US', category: 'growth', importance: 'medium', dayOfMonth: 16 },
  { title: 'UK CPI (inflation)', region: 'UK', category: 'inflation', importance: 'medium', dayOfMonth: 17 },
  { title: 'Euro area flash CPI', region: 'EU', category: 'inflation', importance: 'medium', dayOfMonth: 30 },

  // Quarterly.
  { title: 'US GDP (advance estimate)', region: 'US', category: 'growth', importance: 'medium', dayOfMonth: 30, months: [1, 4, 7, 10] },
];

function isoDate(year: number, month: number, day: number): string {
  // Clamp to the month's real length so day 30 does not spill into March.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

/**
 * Expand the recurring calendar into concrete dates over the next `days`.
 *
 * These are the *typical* dates for each release, not confirmed ones. The UI
 * says so; the value is knowing that a rate decision falls in the next fortnight,
 * not planning to the hour.
 */
export function upcomingMacroEvents(days = 45, now = Date.now()): MacroEvent[] {
  const start = new Date(now);
  const end = new Date(now + days * 86_400_000);
  const events: MacroEvent[] = [];

  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor.getTime() <= end.getTime()) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;

    for (const recurring of RECURRING) {
      if (recurring.months && !recurring.months.includes(month)) continue;
      const date = isoDate(year, month, recurring.dayOfMonth);
      const ms = Date.parse(`${date}T00:00:00Z`);
      if (ms < now - 86_400_000 || ms > end.getTime()) continue;

      events.push({
        id: `${recurring.title}-${date}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        date,
        title: recurring.title,
        region: recurring.region,
        category: recurring.category,
        importance: recurring.importance,
        symbol: null,
        source: `static calendar (compiled ${MACRO_CALENDAR_COMPILED})`,
      });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/** Events relevant to a particular asset: market-wide plus its own earnings. */
export function relevantMacroEvents(
  asset: Asset,
  earnings: MacroEvent[] = [],
  days = 45,
  now = Date.now(),
): MacroEvent[] {
  const all = upcomingMacroEvents(days, now);

  const regionsFor: Record<string, string[]> = {
    equity: ['US'],
    index: ['US', 'UK', 'EU', 'JP'],
    crypto: ['US'],
    forex: ['US', 'UK', 'EU', 'JP'],
  };
  const regions = regionsFor[asset.assetClass] ?? ['US'];

  // For FX, only the two currencies in the pair matter.
  const filtered =
    asset.assetClass === 'forex'
      ? all.filter((e) => currencyRegions(asset.symbol).includes(e.region))
      : all.filter((e) => regions.includes(e.region));

  return [...earnings, ...filtered].sort((a, b) => a.date.localeCompare(b.date));
}

const CURRENCY_REGION: Record<string, string> = {
  USD: 'US', EUR: 'EU', GBP: 'UK', JPY: 'JP', CHF: 'CH', AUD: 'AU', CAD: 'CA', NZD: 'NZ',
};

function currencyRegions(pair: string): string[] {
  return pair
    .split('/')
    .map((code) => CURRENCY_REGION[code])
    .filter((r): r is string => Boolean(r));
}

/** Shape an earnings date from a provider into a MacroEvent. */
export function earningsEvent(symbol: string, date: string, source: string): MacroEvent {
  return {
    id: `earnings-${symbol}-${date}`.toLowerCase(),
    date,
    title: `${symbol} earnings`,
    region: 'US',
    category: 'earnings',
    importance: 'high',
    symbol,
    source,
  };
}
