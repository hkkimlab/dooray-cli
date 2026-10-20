// Token bucket matching Dooray's rate limiter, calibrated from response headers.
// Ported from jon890/dooray-cli src/api/rate-limiter.ts (MIT, see THIRD_PARTY_NOTICES.md).
//   x-ratelimit-burst-capacity: 20   bucket size
//   x-ratelimit-replenish-rate: 5    tokens per second
//   x-ratelimit-remaining: 19        tokens left now

export interface RateLimitSnapshot {
  remaining?: number;
  burstCapacity?: number;
  replenishRate?: number;
}

export interface TokenBucket {
  acquire(): Promise<void>;
  sync(snapshot: RateLimitSnapshot): void;
  drain(): void;
  readonly available: number;
}

export interface TokenBucketOptions {
  capacity?: number;
  replenishRate?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BURST_CAPACITY = 20;
const DEFAULT_REPLENISH_RATE = 5;
const MIN_WAIT_MS = 10;

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  const read = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw == null) return undefined;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : undefined;
  };
  return {
    remaining: read("x-ratelimit-remaining"),
    burstCapacity: read("x-ratelimit-burst-capacity"),
    replenishRate: read("x-ratelimit-replenish-rate"),
  };
}

export function createTokenBucket(opts: TokenBucketOptions = {}): TokenBucket {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const positiveOr = (v: number | undefined, fallback: number) => (v != null && v > 0 ? v : fallback);

  let capacity = positiveOr(opts.capacity, DEFAULT_BURST_CAPACITY);
  let rate = positiveOr(opts.replenishRate, DEFAULT_REPLENISH_RATE);
  let tokens = capacity;
  let updatedAt = now();
  // Serialises acquirers so concurrent callers can't spend the same token.
  let queue: Promise<void> = Promise.resolve();

  const projected = (at: number) => Math.min(capacity, tokens + (Math.max(0, at - updatedAt) / 1000) * rate);
  const refill = () => {
    const at = now();
    if (at <= updatedAt) return;
    tokens = projected(at);
    updatedAt = at;
  };
  const take = async () => {
    for (;;) {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.max(((1 - tokens) / rate) * 1000, MIN_WAIT_MS));
    }
  };

  return {
    acquire() {
      const next = queue.then(take);
      queue = next.catch(() => undefined);
      return next;
    },
    sync(s) {
      if (s.burstCapacity != null && s.burstCapacity > 0) capacity = s.burstCapacity;
      if (s.replenishRate != null && s.replenishRate > 0) rate = s.replenishRate;
      if (s.remaining != null) {
        // The server is authoritative; only ever lower our estimate.
        refill();
        tokens = Math.min(tokens, s.remaining, capacity);
        updatedAt = now();
      }
    },
    drain() {
      tokens = 0;
      updatedAt = now();
    },
    get available() {
      return projected(now());
    },
  };
}
