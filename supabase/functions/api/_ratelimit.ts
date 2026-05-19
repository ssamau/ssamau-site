// In-memory sliding-window rate limiter.
//
// Why in-memory: Deno Deploy keeps function instances warm for ~15 min
// between requests, so a Map survives long enough to defeat real abuse
// (~bots aren't going to sleep 16 minutes between attempts). Across
// instance recycles or load-balancer fan-out, separate instances each
// keep their own counter — meaning a determined attacker could halve
// effective limits by hitting different POPs in parallel. We accept that
// trade-off for now; an Upstash Redis upgrade is a follow-up if real
// abuse appears in logs.
//
// Each call records a hit at `Date.now()` against the given key and
// returns whether the window is still under the cap.
//
// Map key format: `<bucket>:<identifier>` — bucket names below.
// Hits older than the window are pruned on every check so the Map
// can't grow unbounded.

const HITS = new Map<string, number[]>();

export type RateBucket = 'applications.submit' | 'auth.pin' | 'auth.reset';

export interface RateLimitOptions {
  /** Logical bucket name — segregates counters across endpoints. */
  bucket: RateBucket;
  /** Unique identifier (IP, NID, member_id, etc.). */
  identifier: string;
  /** Maximum hits allowed in the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

/**
 * Record an attempt and return whether the caller is still within limit.
 * The hit IS recorded even if the call exceeds the cap — that way a
 * burst doesn't "reset" itself by clearing pruned entries; the
 * attacker has to actually wait out the window.
 */
export function rateLimit(opts: RateLimitOptions): { ok: boolean; remaining: number; retryAfterMs: number } {
  const key = `${opts.bucket}:${opts.identifier}`;
  const now = Date.now();
  const cutoff = now - opts.windowMs;
  const hits = (HITS.get(key) ?? []).filter(t => t > cutoff);
  hits.push(now);
  HITS.set(key, hits);

  const inWindow = hits.length;
  const ok = inWindow <= opts.max;
  const retryAfterMs = ok ? 0 : Math.max(0, hits[0] + opts.windowMs - now);
  return { ok, remaining: Math.max(0, opts.max - inWindow), retryAfterMs };
}

/**
 * Convenience: extract a usable per-request IP from forwarded headers.
 * Behind Supabase + Cloudflare the first hop populates
 * `x-forwarded-for` with the real client IP. Fall back to a sentinel
 * when the header is missing so two unidentified requests don't
 * accidentally share a counter under "" (Map key collision).
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || 'unknown';
  return req.headers.get('cf-connecting-ip')
      ?? req.headers.get('x-real-ip')
      ?? 'unknown';
}
