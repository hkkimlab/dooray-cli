import { mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPath,
  hosts,
  loadConfig,
  removeProfile,
  resolveProfile,
  saveConfig,
  setProfileToken,
} from "../../src/core/config.js";
import { EXIT_AUTH, EXIT_NOT_FOUND, EXIT_USAGE, DoorayError } from "../../src/core/errors.js";
import { GOV_CONFIG, tempHome } from "../helpers.js";

describe("configPath", () => {
  it("honours XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/dooray/config.yaml");
  });
  it("falls back to ~/.config", () => {
    expect(configPath({ HOME: "/h" })).toBe("/h/.config/dooray/config.yaml");
  });
});

describe("hosts", () => {
  it("gov preset", () => {
    expect(hosts("gov")).toEqual({
      baseUrl: "https://api.gov-dooray.com",
      fileUrl: "https://file-api.gov-dooray.com",
    });
  });
  it("commercial preset", () => {
    expect(hosts("commercial")?.baseUrl).toBe("https://api.dooray.com");
  });
  it("empty env defaults to gov (differs from Go, which defaulted to commercial)", () => {
    expect(hosts("")?.baseUrl).toBe("https://api.gov-dooray.com");
  });
  it("unknown env", () => {
    expect(hosts("mars")).toBeUndefined();
  });
});

describe("load/save", () => {
  it("missing file is an empty config", async () => {
    const cfg = await loadConfig(join(tempHome(), "nope.yaml"));
    expect(cfg).toEqual({ profiles: {} });
  });

  it("reads the Go config format", async () => {
    const p = join(tempHome(), "config.yaml");
    writeFileSync(p, GOV_CONFIG);
    const cfg = await loadConfig(p);
    expect(cfg.default_profile).toBe("gov");
    expect(cfg.profiles.gov?.token).toBe("secret-token-123");
    expect(cfg.hooks?.alerts).toContain("hook.dooray.com");
  });

  it("rejects malformed yaml with a generic error", async () => {
    const p = join(tempHome(), "config.yaml");
    writeFileSync(p, "profiles: [unclosed");
    await expect(loadConfig(p)).rejects.toThrow(/parse config/);
  });

  it("rejects a non-mapping profiles section", async () => {
    const p = join(tempHome(), "config.yaml");
    writeFileSync(p, "profiles: 3\n");
    await expect(loadConfig(p)).rejects.toThrow(/profiles/);
  });

  it("saves with 0600 file inside a 0700 dir and round-trips unknown keys", async () => {
    const dir = join(tempHome(), "dooray");
    const p = join(dir, "config.yaml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, GOV_CONFIG + "extra_key: kept\n");
    const cfg = await loadConfig(p);
    await saveConfig(cfg, p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(p, "utf8")).toContain("extra_key: kept");
  });
});

describe("resolveProfile", () => {
  const cfg = {
    default_profile: "gov",
    profiles: {
      gov: { token: "t1", env: "gov" },
      relay: { token: "t2", env: "gov", base_url: "https://relay.example/dooray" },
      bare: { token: "t3" },
    },
  };

  it("uses the default profile and applies the preset", () => {
    const p = resolveProfile(cfg);
    expect(p).toMatchObject({ name: "gov", token: "t1", baseUrl: "https://api.gov-dooray.com" });
  });

  it("explicit base_url overrides the preset", () => {
    const p = resolveProfile(cfg, "relay");
    expect(p.baseUrl).toBe("https://relay.example/dooray");
    expect(p.fileUrl).toBe("https://file-api.gov-dooray.com");
  });

  it("profile without env resolves to gov", () => {
    expect(resolveProfile(cfg, "bare").baseUrl).toBe("https://api.gov-dooray.com");
  });

  it("--env override replaces both hosts", () => {
    const p = resolveProfile(cfg, "relay", "commercial");
    expect(p.baseUrl).toBe("https://api.dooray.com");
    expect(p.env).toBe("commercial");
  });

  it("unknown profile is an auth error", () => {
    const e = catchErr(() => resolveProfile(cfg, "nope"));
    expect(e.exit).toBe(EXIT_AUTH);
    expect(e.message).toContain("unknown profile: nope");
  });

  it("no profiles at all suggests auth login", () => {
    const e = catchErr(() => resolveProfile({ profiles: {} }));
    expect(e.exit).toBe(EXIT_AUTH);
    expect(e.message).toContain("dooray auth login");
  });

  it("unknown env override is a usage error", () => {
    expect(catchErr(() => resolveProfile(cfg, "gov", "mars")).exit).toBe(EXIT_USAGE);
  });
});

describe("profile edits are immutable", () => {
  it("setProfileToken sets default when missing and keeps other fields", () => {
    const before = { profiles: { gov: { token: "old", env: "gov", drive: { default_drive_id: "9" } } } };
    const after = setProfileToken(before, "gov", "gov", "new");
    expect(after.profiles.gov).toEqual({ token: "new", env: "gov", drive: { default_drive_id: "9" } });
    expect(after.default_profile).toBe("gov");
    expect(before.profiles.gov.token).toBe("old");
  });

  it("removeProfile reassigns default alphabetically", () => {
    const cfg = { default_profile: "b", profiles: { b: {}, c: {}, a: {} } };
    const after = removeProfile(cfg, "b");
    expect(Object.keys(after.profiles)).toEqual(["c", "a"]);
    expect(after.default_profile).toBe("a");
    expect(cfg.profiles).toHaveProperty("b");
  });

  it("removeProfile of last profile clears default", () => {
    expect(removeProfile({ default_profile: "a", profiles: { a: {} } }, "a").default_profile).toBe("");
  });

  it("removeProfile unknown is not-found", () => {
    expect(catchErr(() => removeProfile({ profiles: {} }, "x")).exit).toBe(EXIT_NOT_FOUND);
  });
});

function catchErr(fn: () => unknown): DoorayError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DoorayError) return e;
    throw e;
  }
  throw new Error("expected throw");
}
