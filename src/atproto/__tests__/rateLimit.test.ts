import { describe, it, expect } from "vitest";
import { RateLimiter, type RateLimitClock } from "../rateLimit";

/** Test clock with manually advanced time. */
class FakeClock implements RateLimitClock {
  private t = 0;
  private waiters: Array<{ at: number; resolve: () => void }> = [];

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ at: this.t + ms, resolve });
    });
  }

  /** Advance the clock by `ms`; resolves any sleepers whose deadline has passed. */
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.waiters.filter((w) => w.at <= this.t);
    this.waiters = this.waiters.filter((w) => w.at > this.t);
    for (const w of due) w.resolve();
    // Yield so resolved promises can continue.
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe("RateLimiter", () => {
  it("runs the first call immediately and spaces subsequent calls by interval", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);
    const completionTimes: number[] = [];

    const p1 = limiter.run(async () => completionTimes.push(clock.now()));
    const p2 = limiter.run(async () => completionTimes.push(clock.now()));
    const p3 = limiter.run(async () => completionTimes.push(clock.now()));

    // First call should resolve immediately at t=0.
    await Promise.resolve();
    await Promise.resolve();
    await p1;
    expect(completionTimes).toEqual([0]);

    // Second call needs to wait 50ms (initial interval).
    await clock.advance(50);
    await p2;
    expect(completionTimes).toEqual([0, 50]);

    await clock.advance(50);
    await p3;
    expect(completionTimes).toEqual([0, 50, 100]);
  });

  it("adapts interval to pace remaining budget across remaining window", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);

    // After a call, observe: 10 requests left over the next 5 seconds.
    // Ideal interval = 5000 / 10 = 500ms.
    limiter.observe({ remaining: 10, reset: 5 }); // reset = 5s unix → 5000ms

    const times: number[] = [];
    const p1 = limiter.run(async () => times.push(clock.now()));
    await Promise.resolve();
    await Promise.resolve();
    await p1;
    expect(times).toEqual([0]);

    const p2 = limiter.run(async () => times.push(clock.now()));
    await clock.advance(500);
    await p2;
    expect(times).toEqual([0, 500]);
  });

  it("waits until reset when remaining == 0", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);

    // 3 seconds until reset, no budget left.
    limiter.observe({ remaining: 0, reset: 3 });

    const times: number[] = [];
    const p1 = limiter.run(async () => times.push(clock.now()));

    await clock.advance(1000);
    expect(times).toEqual([]); // still waiting

    await clock.advance(2000);
    await p1;
    expect(times).toEqual([3000]);
  });

  it("backs off on 429 by Retry-After seconds", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);

    limiter.backoff("2"); // 2 seconds

    const times: number[] = [];
    const p1 = limiter.run(async () => times.push(clock.now()));
    await clock.advance(1000);
    expect(times).toEqual([]);
    await clock.advance(1000);
    await p1;
    expect(times).toEqual([2000]);
  });

  it("falls back to 5s when Retry-After is missing", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);

    limiter.backoff(null);

    const times: number[] = [];
    const p1 = limiter.run(async () => times.push(clock.now()));
    await clock.advance(4999);
    expect(times).toEqual([]);
    await clock.advance(1);
    await p1;
    expect(times).toEqual([5000]);
  });
});
