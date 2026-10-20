import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generic } from "./errors.js";

type Env = Record<string, string | undefined>;

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Per-profile cache dir so different accounts never share entries. */
export function cacheDir(env: Env, profile: string): string {
  const base = env.XDG_CACHE_HOME || join(env.HOME ?? ".", ".cache");
  const safe = profile.replace(/[^\w.-]/g, "_");
  // "." / ".." would point the cache (and `cache clear`) at a parent directory.
  return join(base, "dooray", /^\.*$/.test(safe) ? `_${safe}` : safe);
}

const KEY_SEGMENT = /^[\w.-]+$/;

/** Small JSON file cache with per-call TTL. Entries are 0600. */
export class Cache {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const file = this.file(key);
    try {
      const entry = JSON.parse(await readFile(file, "utf8")) as { savedAt: number; data: T };
      if (this.now() - entry.savedAt <= ttlMs) return entry.data;
    } catch {
      // missing or corrupt entry: treat as a miss
    }
    const data = await load();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ savedAt: this.now(), data }), { mode: 0o600 });
    return data;
  }

  async drop(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private file(key: string): string {
    const parts = key.split("/");
    if (!parts.every((p) => KEY_SEGMENT.test(p) && p !== "..")) throw generic("invalid cache key: " + key);
    return join(this.dir, ...parts) + ".json";
  }
}
