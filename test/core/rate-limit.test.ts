import { describe, expect, it } from "vitest";
import { createTokenBucket, parseRateLimitHeaders } from "../../src/core/rate-limit.js";

function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: (ms: number) => (t += ms),
  };
}

describe("token bucket", () => {
  it("allows a burst up to capacity without waiting", async () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 3, replenishRate: 1, now: c.now, sleep: c.sleep });
    await Promise.all([b.acquire(), b.acquire(), b.acquire()]);
    expect(c.slept).toEqual([]);
  });

  it("waits for refill when empty", async () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 1, replenishRate: 2, now: c.now, sleep: c.sleep });
    await b.acquire();
    await b.acquire();
    expect(c.slept).toEqual([500]);
  });

  it("concurrent callers queue instead of double-spending", async () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 1, replenishRate: 1, now: c.now, sleep: c.sleep });
    await Promise.all([b.acquire(), b.acquire(), b.acquire()]);
    expect(c.slept).toEqual([1000, 1000]);
  });

  it("sync only lowers tokens to the server value and adopts capacity/rate", () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 20, replenishRate: 5, now: c.now, sleep: c.sleep });
    b.sync({ remaining: 2, burstCapacity: 10, replenishRate: 4 });
    expect(b.available).toBe(2);
    b.sync({ remaining: 50 });
    expect(b.available).toBe(2);
    c.advance(1000);
    expect(b.available).toBe(6);
  });

  it("drain empties the bucket", () => {
    const c = clock();
    const b = createTokenBucket({ now: c.now, sleep: c.sleep });
    b.drain();
    expect(b.available).toBe(0);
  });

  it("ignores non-positive capacity/rate", () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 0, replenishRate: -1, now: c.now, sleep: c.sleep });
    expect(b.available).toBe(20);
  });
});

describe("parseRateLimitHeaders", () => {
  it("reads numeric headers and drops junk", () => {
    const h = new Headers({
      "x-ratelimit-remaining": "19",
      "x-ratelimit-burst-capacity": "abc",
      "x-ratelimit-replenish-rate": "5",
    });
    expect(parseRateLimitHeaders(h)).toEqual({ remaining: 19, burstCapacity: undefined, replenishRate: 5 });
  });
});
