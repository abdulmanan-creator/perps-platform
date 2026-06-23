/**
 * Small in-process TTL cache. Backs three production concerns:
 *
 *   - replay protection on /exchange Phase B (seen-signature set)
 *   - idempotency on /agent/exchange (key → in-flight/settled response)
 *   - read caching (/markets metadata, Privy user lookups)
 *
 * In-memory by design: the API runs as a single Render instance, so a
 * per-process cache is authoritative. If we ever scale horizontally,
 * replay/idempotency state must move to a shared store (Redis) — the
 * call sites are the only places that need to change.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { ttlMs: number; maxEntries?: number }) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    // Refresh insertion order so eviction below approximates LRU-by-write.
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) {
      this.evict();
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Insert the key if absent (or expired). Returns true when this call
   * inserted it — i.e. first sighting — false when the key was already
   * live. The atomic check-and-set for replay detection.
   */
  addIfAbsent(key: string, value: V): boolean {
    if (this.get(key) !== undefined) return false;
    this.set(key, value);
    return true;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  /** Drop expired entries; if still at capacity, drop the oldest insertions. */
  private evict(): void {
    const now = Date.now();
    for (const [k, e] of this.store) {
      if (now >= e.expiresAt) this.store.delete(k);
    }
    // Map iterates in insertion order — delete from the front until we fit.
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }
}

/**
 * Cache the *promise* of an async producer. Concurrent callers for the same
 * key share one in-flight request (coalescing); rejected promises are
 * evicted immediately so a transient failure doesn't poison the cache for
 * the full TTL.
 */
export function cachedAsync<T>(
  cache: TtlCache<Promise<T>>,
  key: string,
  producer: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = producer().catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, p);
  return p;
}
