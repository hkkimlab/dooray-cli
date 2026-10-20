import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSsoTarget } from "../../src/commands/auth.js";
import { DEFAULT_TOKEN_NAME, extractToken } from "../../src/sso/token.js";
import { GOV_CONFIG, runCli, tempHome } from "../helpers.js";

describe("resolveSsoTarget (Go parity)", () => {
  const cfg = { default_profile: "gov", profiles: { gov: { env: "gov" }, com: { env: "commercial" } } };
  it.each([
    [{}, undefined, undefined, ["gov", "gov"]],
    [cfg, undefined, undefined, ["gov", "gov"]],
    [cfg, "com", undefined, ["com", "commercial"]],
    [cfg, "new", undefined, ["new", "gov"]],
    [cfg, undefined, "commercial", ["gov", "commercial"]],
  ])("%o profile=%s env=%s", (c, profile, env, want) => {
    expect(resolveSsoTarget({ profiles: {}, ...c }, profile, env)).toEqual(want);
  });
  it("unknown env is a usage error", () => {
    expect(() => resolveSsoTarget(cfg, undefined, "mars")).toThrow(/unknown env/);
  });
});

describe("extractToken", () => {
  it.each([
    ["abc123", "abc123"],
    ["   abc123   ", "abc123"],
    ["\n\tabc123\n", "abc123"],
    ["", ""],
    ["  ab cd  ", "ab cd"],
  ])("%j", (raw, want) => expect(extractToken(raw)).toBe(want));
  it("default token name is plain dooray-cli", () => expect(DEFAULT_TOKEN_NAME).toBe("dooray-cli"));
});

describe("auth sso", () => {
  function home(): string {
    const h = tempHome();
    mkdirSync(join(h, ".config", "dooray"), { recursive: true });
    writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG);
    return h;
  }

  const cfgText = (h: string) => readFileSync(join(h, ".config", "dooray", "config.yaml"), "utf8");
  const withDomain = (h: string, env = "gov") => {
    writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG.replace("    env: gov\n", `    env: ${env}\n    domain: acme\n`));
    return h;
  };

  it("asks for the Dooray domain when the profile has none, then id/password, and saves the domain with the token", async () => {
    const seen: unknown[] = [];
    const h = home();
    const r = await runCli(["auth", "sso", "--token-name", "my-token"], {
      home: h,
      stdin: "acme\nmyid\npw123\n",
      sso: async (url, creds, tokenName, progress) => {
        seen.push(url, creds, tokenName);
        progress(50, "half");
        return "  NEW-TOKEN \n";
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toEqual(["https://acme.gov-dooray.com", { username: "myid", password: "pw123" }, "my-token"]);
    expect(cfgText(h)).toContain("token: NEW-TOKEN");
    expect(cfgText(h)).toContain("domain: acme");
    expect(r.err).toContain("[ 50%] half");
    expect(r.out + r.err).not.toContain("pw123");
  });

  it("uses the profile's domain without asking; commercial profiles go to <domain>.dooray.com", async () => {
    for (const [env, url] of [["gov", "https://acme.gov-dooray.com"], ["commercial", "https://acme.dooray.com"]]) {
      const seen: unknown[] = [];
      const r = await runCli(["auth", "sso"], { home: withDomain(home(), env), stdin: "myid\npw\n", sso: async (u, creds) => (seen.push(u, creds), "T") });
      expect(r.code).toBe(0);
      expect(seen).toEqual([url, { username: "myid", password: "pw" }]);
    }
  });

  it.each(["acme.gov-dooray.com", "https://acme.gov-dooray.com/", "ACME"])("the domain may be typed as %s", async (typed) => {
    const seen: unknown[] = [];
    const h = home();
    await runCli(["auth", "sso"], { home: h, stdin: `${typed}\nmyid\npw\n`, sso: async (u) => (seen.push(u), "T") });
    expect(seen).toEqual(["https://acme.gov-dooray.com"]);
    expect(cfgText(h)).toContain("domain: acme");
  });

  it("a malformed domain is a usage error and nothing is saved", async () => {
    for (const bad of ["", "acme.re.kr", "a b", "https://evil.example.com"]) {
      const h = home();
      const r = await runCli(["auth", "sso"], { home: h, stdin: `${bad}\nmyid\npw\n`, sso: async () => "T" });
      expect(r.code).toBe(2);
      expect(cfgText(h)).toBe(GOV_CONFIG);
    }
  });

  it("a failed login saves neither token nor domain", async () => {
    const h = home();
    const r = await runCli(["auth", "sso"], { home: h, stdin: "acme\nmyid\npw\n", sso: async () => "  " });
    expect(r.code).toBe(3);
    expect(cfgText(h)).toBe(GOV_CONFIG);
  });

  it("--id skips the id prompt; empty password and empty token are auth errors", async () => {
    const h = withDomain(home());
    expect((await runCli(["auth", "sso", "--id", "myid"], { home: h, stdin: "\n", sso: async () => "t" })).code).toBe(3);
    expect((await runCli(["auth", "sso", "--id", "myid"], { home: h, stdin: "pw\n", sso: async () => "  " })).code).toBe(3);
  });
});
