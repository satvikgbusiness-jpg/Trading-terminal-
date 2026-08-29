import { getQuotes } from '@/lib/market/service';
import { tryResolveAsset } from '@/lib/symbols';

export const dynamic = 'force-dynamic';

/**
 * Server-sent quote stream.
 *
 * The client subscribes with `?symbols=AAPL,BTC-USD`. The server polls the same
 * cached, rate-limited market service the pages use, so opening ten tabs costs
 * the provider nothing extra -- the cache and the single-flight scheduler
 * collapse them into one upstream request per TTL.
 *
 * Every message carries provenance, so a stale value stays visibly stale as it
 * streams.
 */

const MIN_INTERVAL_MS = 3_000;
const DEFAULT_INTERVAL_MS = 8_000;
const MAX_SYMBOLS = 30;
/** Streams are closed after this long so a forgotten tab cannot poll forever. */
const MAX_STREAM_MS = 30 * 60_000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbols = (url.searchParams.get('symbols') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && tryResolveAsset(s) !== null)
    .slice(0, MAX_SYMBOLS);

  const requested = Number(url.searchParams.get('intervalMs') ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(requested)
    ? Math.min(Math.max(requested, MIN_INTERVAL_MS), 60_000)
    : DEFAULT_INTERVAL_MS;

  if (symbols.length === 0) {
    return new Response('event: error\ndata: {"error":"no recognised symbols"}\n\n', {
      status: 400,
      headers: sseHeaders(),
    });
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const startedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The client went away between the check and the write.
          closed = true;
        }
      };

      send('open', { symbols, intervalMs });

      const poll = async () => {
        if (closed) return;
        if (Date.now() - startedAt > MAX_STREAM_MS) {
          send('closing', { reason: 'stream lifetime reached; reconnect to continue' });
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        try {
          const quotes = await getQuotes(symbols);
          send('quotes', { quotes, at: Date.now() });
        } catch (err) {
          send('error', { error: err instanceof Error ? err.message : 'quote poll failed' });
        }

        if (!closed) timer = setTimeout(poll, intervalMs);
      };

      await poll();

      request.signal.addEventListener('abort', () => {
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and friends buffer SSE by default, which stalls the stream.
    'x-accel-buffering': 'no',
  };
}
