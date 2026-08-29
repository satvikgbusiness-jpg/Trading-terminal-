import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CACHE_ROOT, MAX_AGE_MS, diskCache } from './cache';

/**
 * Cache pruning, kept out of the module the web app imports.
 *
 * Walking the cache directory is dynamic filesystem access, which makes the
 * bundler trace the whole project into the server output. Only the worker needs
 * it, so it lives here and the web bundle never sees it.
 */
export async function pruneCache(): Promise<number> {
  let removed = 0;
  const now = Date.now();

  let namespaces: string[];
  try {
    namespaces = await fs.readdir(CACHE_ROOT);
  } catch {
    return 0;
  }

  for (const namespace of namespaces) {
    const dir = path.join(CACHE_ROOT, namespace);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          await fs.unlink(full);
          removed += 1;
        }
      } catch {
        /* raced with another prune */
      }
    }
  }

  // Drop the in-process tier too, so a pruned entry cannot be served from memory.
  diskCache.memory.clear();
  return removed;
}
