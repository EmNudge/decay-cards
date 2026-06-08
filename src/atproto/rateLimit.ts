/**
 * Adaptive rate limiter for PDS requests.
 *
 * Single global serializer: requests run one at a time, spaced by `interval`
 * milliseconds. The interval starts at 50ms (≈20 req/sec) and adapts based on
 * `RateLimit-Remaining` / `RateLimit-Reset` response headers. On 429, we back
 * off per `Retry-After`.
 *
 * The clock and sleep are injectable for deterministic tests.
 */

export interface RateLimitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: RateLimitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const INITIAL_INTERVAL_MS = 50; // 20 req/sec
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 10_000;

export interface RateHeaders {
  /** "RateLimit-Remaining" header value. */
  remaining?: string | number | null;
  /** "RateLimit-Reset" header value (Unix seconds). */
  reset?: string | number | null;
  /** "Retry-After" header value (seconds, or HTTP date). */
  retryAfter?: string | number | null;
}

export class RateLimiter {
  private interval = INITIAL_INTERVAL_MS;
  private nextAvailableAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private clock: RateLimitClock;

  constructor(clock: RateLimitClock = realClock) {
    this.clock = clock;
  }

  /**
   * Run `fn` with rate limiting. Waits its turn in the queue, then waits
   * until the next slot is open, then runs `fn`.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the queue so callers serialize. We don't propagate errors
    // through the chain — each request handles its own outcome.
    const myTurn = this.queue.then(() => this.waitForSlot());
    this.queue = myTurn.catch(() => {});
    await myTurn;
    return fn();
  }

  private async waitForSlot(): Promise<void> {
    const now = this.clock.now();
    const wait = this.nextAvailableAt - now;
    if (wait > 0) await this.clock.sleep(wait);
    this.nextAvailableAt = this.clock.now() + this.interval;
  }

  /**
   * Observe rate-limit response headers and adjust pacing. Call after every
   * request (successful or not) to keep the limiter calibrated.
   */
  observe(headers: RateHeaders): void {
    const remainingRaw = headers.remaining;
    const resetRaw = headers.reset;
    if (remainingRaw == null || resetRaw == null) return;

    const remaining = Number(remainingRaw);
    const reset = Number(resetRaw);
    if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return;

    // `reset` is a unix epoch seconds timestamp per AT Proto convention.
    const msUntilReset = reset * 1000 - this.clock.now();
    if (msUntilReset <= 0) {
      this.interval = INITIAL_INTERVAL_MS;
      return;
    }

    if (remaining <= 0) {
      // No budget left in this window: hold off until reset.
      this.nextAvailableAt = this.clock.now() + msUntilReset;
      return;
    }

    // Pace the remaining budget evenly across the remaining window.
    const idealInterval = msUntilReset / remaining;
    this.interval = clamp(idealInterval, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  }

  /**
   * Apply a 429 back-off. `retryAfter` is the `Retry-After` header value
   * (seconds, or an HTTP date). Falls back to 5s if unparseable.
   */
  backoff(retryAfter: string | number | null | undefined): void {
    const waitMs = parseRetryAfter(retryAfter, this.clock.now()) ?? 5000;
    this.nextAvailableAt = this.clock.now() + waitMs;
  }

  /** Clear all queued waiters and reset pacing. Tests only. */
  reset(): void {
    this.interval = INITIAL_INTERVAL_MS;
    this.nextAvailableAt = 0;
    this.queue = Promise.resolve();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function parseRetryAfter(value: string | number | null | undefined, nowMs: number): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Math.max(0, value * 1000);
  const asNum = Number(value);
  if (Number.isFinite(asNum)) return Math.max(0, asNum * 1000);
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - nowMs);
  return null;
}

/** Global limiter for write/list traffic. */
export const globalLimiter = new RateLimiter();
