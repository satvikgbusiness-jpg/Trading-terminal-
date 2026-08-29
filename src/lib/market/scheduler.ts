/**
 * Central request scheduler.
 *
 * Every outbound call to a data provider goes through here so that free-tier
 * rate limits are respected process-wide rather than per-call-site. Provides:
 *
 *   - a token bucket per provider (requests per window)
 *   - a minimum gap between consecutive requests to the same provider
 *   - a concurrency cap per provider
 *   - single-flight: concurrent callers asking for the same key share one request
 *   - honouring 429 / Retry-After by parking the whole bucket
 */

export interface RateLimit {
  /** Requests allowed per `windowMs`. */
  requests: number;
  windowMs: number;
  /** Minimum milliseconds between two consecutive requests. */
  minIntervalMs?: number;
  /** Maximum in-flight requests. */
  concurrency?: number;
}

interface Bucket {
  limit: Required<RateLimit>;
  /** Timestamps (ms) of requests started inside the current window. */
  hits: number[];
  lastStartedAt: number;
  inFlight: number;
  /** When in the future, the bucket is parked (e.g. after a 429). */
  parkedUntil: number;
  /** Callers blocked on a concurrency slot. */
  waiters: Array<() => void>;
}

export type Clock = () => number;

const DEFAULTS = { minIntervalMs: 0, concurrency: 4 };

export class RequestScheduler {
  private buckets = new Map<string, Bucket>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly now: Clock = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  configure(provider: string, limit: RateLimit): void {
    const merged = { ...DEFAULTS, ...limit };
    const existing = this.buckets.get(provider);
    if (existing) {
      existing.limit = merged;
      return;
    }
    this.buckets.set(provider, {
      limit: merged,
      hits: [],
      lastStartedAt: 0,
      inFlight: 0,
      parkedUntil: 0,
      waiters: [],
    });
  }

  /** Park a provider until `until` (ms epoch) — used when we see a 429. */
  park(provider: string, until: number): void {
    const bucket = this.bucketFor(provider);
    bucket.parkedUntil = Math.max(bucket.parkedUntil, until);
  }

  /** Milliseconds until this provider could start a request, 0 when ready now. */
  waitTime(provider: string): number {
    return this.computeDelay(this.bucketFor(provider));
  }

  /** Introspection for the UI's rate-limit panel. */
  stats(provider: string): { inFlight: number; used: number; limit: number; parkedForMs: number } {
    const bucket = this.bucketFor(provider);
    this.prune(bucket);
    return {
      inFlight: bucket.inFlight,
      used: bucket.hits.length,
      limit: bucket.limit.requests,
      parkedForMs: Math.max(0, bucket.parkedUntil - this.now()),
    };
  }

  /**
   * Run `fn` subject to `provider`'s limits.
   *
   * When `dedupeKey` is given, concurrent callers with the same key share a
   * single execution — this collapses the fan-out from e.g. twelve watchlist
   * rows all asking for the same index quote in one tick.
   */
  async run<T>(provider: string, fn: () => Promise<T>, dedupeKey?: string): Promise<T> {
    if (!dedupeKey) return this.execute(provider, fn);

    const existing = this.inflight.get(dedupeKey) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = this.execute(provider, fn).finally(() => {
      this.inflight.delete(dedupeKey);
    });
    // Swallow rejections on the shared handle so a failing request cannot raise
    // an unhandled rejection for callers that never awaited it.
    promise.catch(() => {});
    this.inflight.set(dedupeKey, promise);
    return promise;
  }

  private async execute<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const bucket = this.bucketFor(provider);
    await this.acquire(bucket);
    try {
      return await fn();
    } finally {
      bucket.inFlight -= 1;
      this.release(bucket);
    }
  }

  private bucketFor(provider: string): Bucket {
    let bucket = this.buckets.get(provider);
    if (!bucket) {
      // Unconfigured providers get a conservative default rather than free rein.
      this.configure(provider, { requests: 30, windowMs: 60_000, minIntervalMs: 200 });
      bucket = this.buckets.get(provider)!;
    }
    return bucket;
  }

  private prune(bucket: Bucket): void {
    const cutoff = this.now() - bucket.limit.windowMs;
    while (bucket.hits.length > 0 && bucket.hits[0]! <= cutoff) bucket.hits.shift();
  }

  /** Milliseconds the caller must wait before the rate window permits a start. */
  private computeDelay(bucket: Bucket): number {
    this.prune(bucket);
    const now = this.now();
    let wait = 0;

    if (bucket.parkedUntil > now) wait = Math.max(wait, bucket.parkedUntil - now);

    if (bucket.hits.length >= bucket.limit.requests) {
      const oldest = bucket.hits[0]!;
      wait = Math.max(wait, oldest + bucket.limit.windowMs - now);
    }

    const gap = bucket.lastStartedAt + bucket.limit.minIntervalMs - now;
    if (gap > 0) wait = Math.max(wait, gap);

    return wait;
  }

  /**
   * Block until the bucket permits a start, then *reserve* the slot before
   * yielding. Reservation and the checks that authorise it happen in the same
   * synchronous block, so two callers woken in the same tick cannot both pass.
   */
  private async acquire(bucket: Bucket): Promise<void> {
    for (;;) {
      const delay = this.computeDelay(bucket);
      if (delay > 0) {
        await this.sleep(delay);
        continue;
      }
      if (bucket.inFlight >= bucket.limit.concurrency) {
        await new Promise<void>((resolve) => bucket.waiters.push(resolve));
        continue;
      }
      // Authorised: take the slot and stamp the window in one go.
      bucket.inFlight += 1;
      bucket.lastStartedAt = this.now();
      bucket.hits.push(bucket.lastStartedAt);
      return;
    }
  }

  /** Wake every waiter; each re-checks and re-queues if it still cannot start. */
  private release(bucket: Bucket): void {
    const waiters = bucket.waiters.splice(0);
    for (const wake of waiters) wake();
  }
}

/** Process-wide scheduler. */
export const scheduler = new RequestScheduler();
