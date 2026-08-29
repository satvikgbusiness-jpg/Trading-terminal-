import { XMLParser } from 'fast-xml-parser';
import { fetchFromProvider } from '../http';
import { env } from '../providers';
import { newsId } from './finnhub';
import { FeedError, type NewsItem } from '../types';

/**
 * Default feeds. Overridden wholesale by NEWS_RSS_FEEDS.
 *
 * These are the publishers' own public syndication endpoints — we read the feed
 * a publisher offers for reading, and link out to the article rather than
 * reproducing it. Nothing here scrapes a paywalled page.
 */
export const DEFAULT_FEEDS: Array<{ url: string; label: string }> = [
  // Checked live. Two entries used to be dead and neither said so loudly:
  // feeds.reuters.com no longer resolves at all (Reuters retired its public
  // RSS), and feeds.a.dj.com still answers 200 with a frozen copy of January
  // 2025, which is the worse failure of the two -- a feed that returns stale
  // items looks healthy. The news window drops anything older than seven days,
  // so the stale copy never reached the pane, but it never contributed either.
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', label: 'CNBC Markets' },
  { url: 'https://www.ft.com/rss/home', label: 'Financial Times' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', label: 'CoinDesk' },
  { url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', label: 'WSJ Markets' },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

interface RssItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  pubDate?: unknown;
  published?: unknown;
  updated?: unknown;
  summary?: unknown;
  content?: unknown;
  'dc:date'?: unknown;
}

/** RSS/Atom values arrive as strings, numbers, or `{ '#text': ... }` objects. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['#text'] === 'string') return record['#text'].trim() || null;
    if (typeof record['@_href'] === 'string') return record['@_href'].trim() || null;
  }
  return null;
}

function linkOf(item: RssItem): string | null {
  const direct = text(item.link);
  if (direct) return direct;
  // Atom feeds carry an array of <link rel="..."> elements.
  const links = item.link;
  if (Array.isArray(links)) {
    const alternate =
      links.find((l) => (l as Record<string, unknown>)?.['@_rel'] === 'alternate') ?? links[0];
    return text(alternate);
  }
  return null;
}

function dateOf(item: RssItem): number {
  for (const candidate of [item.pubDate, item.published, item.updated, item['dc:date']]) {
    const raw = text(candidate);
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

/** Strip markup and entity noise from a feed summary. */
function plain(value: unknown, max = 400): string | null {
  const raw = text(value);
  if (!raw) return null;
  const stripped = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped ? stripped.slice(0, max) : null;
}

export interface FeedResult {
  label: string;
  url: string;
  items: NewsItem[];
  error?: string;
}

/** Fetch and parse one feed. Never throws; failures are reported per feed. */
export async function fetchFeed(url: string, label: string): Promise<FeedResult> {
  try {
    const xml = await fetchFromProvider<string>('rss', url, {
      as: 'text',
      dedupeKey: `rss:${url}`,
      headers: { 'user-agent': 'GMT-Terminal/0.1 (+https://localhost) feed reader' },
    });

    const doc = parser.parse(xml) as Record<string, any>;
    const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'] ?? doc?.feed;
    if (!channel) {
      throw new FeedError('bad_response', `${label} did not return RSS or Atom`, label);
    }

    const rawItems = channel.item ?? channel.entry ?? doc?.['rdf:RDF']?.item ?? [];
    const list: RssItem[] = Array.isArray(rawItems) ? rawItems : [rawItems];
    // Attribute to the configured label, not the feed's own <title>. Publishers
    // title their feeds for their own site: the FT's home feed calls itself
    // "International homepage", which is not a source a reader can place.
    const feedName = label;

    const items: NewsItem[] = [];
    for (const item of list) {
      const headline = plain(item.title, 300);
      const link = linkOf(item);
      if (!headline || !link) continue;
      items.push({
        id: newsId(link),
        headline,
        url: link,
        source: feedName,
        summary: plain(item.description ?? item.summary ?? item.content),
        publishedAt: dateOf(item),
        symbol: null,
      });
    }
    return { label, url, items };
  } catch (err) {
    return {
      label,
      url,
      items: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function configuredFeeds(): Array<{ url: string; label: string }> {
  const custom = env.rssFeeds();
  if (custom.length === 0) return DEFAULT_FEEDS;
  return custom.map((url) => {
    let label = url;
    try {
      label = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* keep the raw string */
    }
    return { url, label };
  });
}

/** Fetch every configured feed, deduped by normalised URL. */
export async function fetchAllFeeds(): Promise<{ items: NewsItem[]; results: FeedResult[] }> {
  const feeds = configuredFeeds();
  const results = await Promise.all(feeds.map((f) => fetchFeed(f.url, f.label)));
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const result of results) {
    for (const item of result.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  items.sort((a, b) => b.publishedAt - a.publishedAt);
  return { items, results };
}
