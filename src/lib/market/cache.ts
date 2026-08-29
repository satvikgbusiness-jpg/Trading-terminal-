import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Two-tier read-through cache: an in-process map in front of a JSON file store.
 *
 * The disk tier is what lets the terminal survive a provider outage honestly —
 * on a failed refresh we serve the last good payload and flag it `stale` rather
 * than inventing a number or showing a zero.
 */

export interface CacheEntry<T> {
  key: string;
  /** Unix ms when the payload was fetched from the origin. */
  storedAt: number;
  ttlMs: number;
  payload: T;
}

export interface CacheHit<T> {
  payload: T;
  storedAt: number;
  /** True when the entry is past its TTL. */
  expired: boolean;
}

export const CACHE_ROOT = process.env.GMT_CACHE_DIR ?? path.join(process.cwd(), '.cache');
/** Entries older than this are pruned from disk and never served, even as stale. */
export const MAX_AGE_MS = Number(process.env.GMT_CACHE_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000);

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 40);
}

function filePathFor(namespace: string, key: string): string {
  const safeNs = namespace.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(CACHE_ROOT, safeNs, `${hashKey(key)}.json`);
}

export class DiskCache {
  /** Exposed so the worker-only maintenance module can clear it after a prune. */
  memory = new Map<string, CacheEntry<unknown>>();
  private readonly maxMemoryEntries: number;

  constructor(maxMemoryEntries = 2000) {
    this.maxMemoryEntries = maxMemoryEntries;
  }

  async get<T>(namespace: string, key: string): Promise<CacheHit<T> | null> {
    const memKey = `${namespace}:${key}`;
    const now = Date.now();

    const inMemory = this.memory.get(memKey) as CacheEntry<T> | undefined;
    if (inMemory) {
      if (now - inMemory.storedAt > MAX_AGE_MS) {
        this.memory.delete(memKey);
      } else {
        return {
          payload: inMemory.payload,
          storedAt: inMemory.storedAt,
          expired: now - inMemory.storedAt > inMemory.ttlMs,
        };
      }
    }

    try {
      const raw = await fs.readFile(filePathFor(namespace, key), 'utf8');
      const entry = JSON.parse(raw) as CacheEntry<T>;
      if (typeof entry?.storedAt !== 'number') return null;
      if (now - entry.storedAt > MAX_AGE_MS) return null;
      this.remember(memKey, entry);
      return {
        payload: entry.payload,
        storedAt: entry.storedAt,
        expired: now - entry.storedAt > entry.ttlMs,
      };
    } catch {
      return null;
    }
  }

  async set<T>(namespace: string, key: string, payload: T, ttlMs: number): Promise<void> {
    const entry: CacheEntry<T> = { key, storedAt: Date.now(), ttlMs, payload };
    this.remember(`${namespace}:${key}`, entry);

    const file = filePathFor(namespace, key);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Write-then-rename so a crash mid-write cannot leave a truncated entry
      // that would later be parsed as a real value.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
      await fs.rename(tmp, file);
    } catch {
      // A read-only or full disk degrades us to memory-only caching, which is
      // not worth failing a request over.
    }
  }

  private remember(memKey: string, entry: CacheEntry<unknown>): void {
    if (this.memory.size >= this.maxMemoryEntries) {
      // Map preserves insertion order: drop the oldest key.
      const oldest = this.memory.keys().next();
      if (!oldest.done) this.memory.delete(oldest.value);
    }
    this.memory.delete(memKey);
    this.memory.set(memKey, entry);
  }

}

export const diskCache = new DiskCache();
