/**
 * Portable per-isolate rate limiter.
 *
 * IMPORTANT: this repo's `wrangler.jsonc` declares no Cloudflare Rate
 * Limiting binding and no KV namespace, so this is NOT a global limit. Each
 * Cloudflare Workers isolate (roughly: each edge location/instance that
 * happens to handle a request) keeps its own independent counters in memory.
 * A caller hammering the endpoint from one place will very likely keep
 * landing on the same nearby isolate and get throttled, but a distributed
 * caller hitting multiple edge locations, or a request that lands on a
 * freshly spun-up isolate, can exceed the configured per-IP rate globally
 * even though each isolate individually enforces it. Do not treat this as a
 * global/authoritative limit — it is a best-effort local backstop. Swapping
 * in a Rate Limiting binding or a KV-backed counter would make the limit
 * global; that binding does not currently exist in this project.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  windowStart: number;
}

export class SlidingCounter {
  private readonly hits = new Map<string, Window>();

  /**
   * Fixed-window counter keyed by `key`. `limit` and `windowMs` are passed
   * per-call (rather than fixed at construction) so a single shared instance
   * can serve callers with different configured limits.
   */
  check(
    key: string,
    limit: number,
    windowMs: number,
    now: number = Date.now(),
  ): RateLimitResult {
    const entry = this.hits.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      this.prune(now, windowMs);
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
    }

    if (entry.count >= limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.windowStart + windowMs - now) / 1000),
      );
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    entry.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - entry.count),
      retryAfterSeconds: 0,
    };
  }

  /** Drop stale windows so the map doesn't grow without bound across many IPs. */
  private prune(now: number, windowMs: number): void {
    if (this.hits.size < 5000) return;
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= windowMs) {
        this.hits.delete(key);
      }
    }
  }
}
