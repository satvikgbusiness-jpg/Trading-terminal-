import { FeedError } from './types';
import { scheduler } from './scheduler';

const DEFAULT_TIMEOUT_MS = Number(process.env.GMT_HTTP_TIMEOUT_MS ?? 12_000);

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Shared across concurrent identical requests. */
  dedupeKey?: string;
  /** Expected content: json (default) or text (RSS/CSV). */
  as?: 'json' | 'text';
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Rate-limited HTTP GET.
 *
 * All non-2xx responses become `FeedError`s — callers can never mistake an error
 * body for data. A 429 parks the whole provider bucket so sibling requests back
 * off too instead of each discovering the limit separately.
 */
export async function fetchFromProvider<T>(
  provider: string,
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, dedupeKey, as = 'json' } = opts;

  return scheduler.run(
    provider,
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: as === 'json' ? 'application/json' : 'text/xml, text/plain, */*', ...headers },
          cache: 'no-store',
        });
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        throw new FeedError(
          'network_error',
          aborted ? `Request to ${provider} timed out after ${timeoutMs}ms` : `Network error calling ${provider}: ${(err as Error).message}`,
          provider,
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')) ?? 60_000;
        scheduler.park(provider, Date.now() + retryAfterMs);
        throw new FeedError('rate_limited', `${provider} rate limit hit`, provider, retryAfterMs);
      }
      if (response.status === 404) {
        throw new FeedError('not_found', `${provider} returned 404 for ${redact(url)}`, provider);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new FeedError(
          'upstream_error',
          `${provider} returned ${response.status}: ${body.slice(0, 200)}`,
          provider,
        );
      }

      if (as === 'text') return (await response.text()) as unknown as T;

      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new FeedError(
          'bad_response',
          `${provider} returned non-JSON body: ${text.slice(0, 200)}`,
          provider,
        );
      }
    },
    dedupeKey,
  );
}

/** Strip query strings so API keys never reach logs or error messages. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
