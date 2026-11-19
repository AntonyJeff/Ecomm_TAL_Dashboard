/**
 * A single cached value with stale-while-revalidate and in-flight de-duplication.
 *
 * - Fresh (age < ttlMs): returned immediately.
 * - Stale but within maxStaleMs: returned immediately, refreshed in the background.
 * - Missing, or older than maxStaleMs: the caller waits for a fresh load.
 * - Concurrent callers needing a load share one promise instead of each starting their own.
 */
export interface CachedLoader<T> {
  get(opts?: { force?: boolean }): Promise<T>;
  /** Current value if one has ever loaded, without triggering anything. */
  peek(): T | undefined;
  /** Bumps every time a new value is stored - lets derived caches know when to rebuild. */
  version(): number;
}

export function createCachedLoader<T>(
  name: string,
  load: () => Promise<T>,
  opts: { ttlMs: number; maxStaleMs?: number }
): CachedLoader<T> {
  const maxStaleMs = opts.maxStaleMs ?? Infinity;
  let value: T | undefined;
  let loadedAt = 0;
  let ver = 0;
  let inFlight: Promise<T> | null = null;

  function refresh(): Promise<T> {
    if (inFlight) return inFlight;
    inFlight = load()
      .then((v) => {
        value = v;
        loadedAt = Date.now();
        ver++;
        return v;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    async get({ force = false } = {}) {
      if (force || value === undefined) return refresh();
      const age = Date.now() - loadedAt;
      if (age < opts.ttlMs) return value;
      if (age < maxStaleMs) {
        refresh().catch((err) => console.error(`[cache] background refresh failed for ${name}:`, err));
        return value;
      }
      return refresh();
    },
    peek: () => value,
    version: () => ver,
  };
}
