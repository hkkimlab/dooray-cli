import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Cache, cacheDir } from "../../src/core/cache.js";
import { tempHome } from "../helpers.js";

describe("cacheDir", () => {
  it("is per profile under XDG_CACHE_HOME", () => {
    expect(cacheDir({ XDG_CACHE_HOME: "/c", HOME: "/h" }, "gov")).toBe("/c/dooray/gov");
    expect(cacheDir({ HOME: "/h" }, "gov")).toBe("/h/.cache/dooray/gov");
  });
  it("sanitises odd profile names", () => {
    expect(cacheDir({ HOME: "/h" }, "../evil")).toBe("/h/.cache/dooray/.._evil");
    expect(cacheDir({ HOME: "/h" }, "..")).toBe("/h/.cache/dooray/_..");
    expect(cacheDir({ HOME: "/h" }, ".")).toBe("/h/.cache/dooray/_.");
  });
});

describe("Cache", () => {
  it("loads once within ttl, reloads after expiry, files are 0600", async () => {
    let t = 0;
    const dir = join(tempHome(), "c");
    const cache = new Cache(dir, () => t);
    let loads = 0;
    const load = async () => ({ n: ++loads });
    expect(await cache.get("tags/123", 1000, load)).toEqual({ n: 1 });
    expect(await cache.get("tags/123", 1000, load)).toEqual({ n: 1 });
    t = 1001;
    expect(await cache.get("tags/123", 1000, load)).toEqual({ n: 2 });
    const file = join(dir, "tags", "123.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("drop and clear remove entries", async () => {
    const dir = join(tempHome(), "c");
    const cache = new Cache(dir);
    await cache.get("a", 1e9, async () => 1);
    await cache.drop("a");
    expect(existsSync(join(dir, "a.json"))).toBe(false);
    await cache.get("b", 1e9, async () => 1);
    await cache.clear();
    expect(existsSync(dir)).toBe(false);
  });

  it("rejects keys that escape the cache dir", async () => {
    const cache = new Cache(join(tempHome(), "c"));
    await expect(cache.get("../x", 1, async () => 1)).rejects.toThrow(/invalid cache key/);
  });

  it("treats a corrupt entry as a miss", async () => {
    const dir = join(tempHome(), "c");
    const cache = new Cache(dir);
    await cache.get("k", 1e9, async () => 1);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "k.json"), "{oops");
    expect(await cache.get("k", 1e9, async () => 2)).toBe(2);
  });
});
