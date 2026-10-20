import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fail, fakeFetch, GOV_CONFIG, ok, runCli, tempHome } from "../helpers.js";

function homeWith(config = GOV_CONFIG): string {
  const home = tempHome();
  const dir = join(home, ".config", "dooray");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.yaml"), config, { mode: 0o600 });
  return home;
}

const cfgFile = (home: string) => join(home, ".config", "dooray", "config.yaml");
const ME = { id: "3000000000000000001", name: "홍길동", userCode: "hong", externalEmailAddress: "hong@example.com" };

describe("root", () => {
  it("--version prints the package version", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--help exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: dooray");
  });

  it("unknown command and unknown option exit 2", async () => {
    expect((await runCli(["nope"])).code).toBe(2);
    expect((await runCli(["auth", "list", "--bogus"])).code).toBe(2);
  });

  it("invalid --format exits 2", async () => {
    const r = await runCli(["-o", "xml", "auth", "list"], { home: homeWith() });
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid format: xml");
  });

  it("global options work after the subcommand", async () => {
    const r = await runCli(["auth", "list", "-o", "json"], { home: homeWith() });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([{ name: "gov", env: "gov", default: "*" }]);
  });
});

describe("auth", () => {
  it("list prints a table marking the default", async () => {
    const r = await runCli(["auth", "list"], { home: homeWith() });
    expect(r.out).toMatch(/NAME\s+ENV/);
    expect(r.out).toMatch(/\*\s+gov\s+gov/);
  });

  it("status validates the token via members/me and never prints it", async () => {
    const f = fakeFetch([{ path: "/common/v1/members/me", body: ok(ME) }]);
    const r = await runCli(["auth", "status", "-o", "json"], { home: homeWith(), fetch: f });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ profile: "gov", env: "gov", baseUrl: "https://api.gov-dooray.com", name: "홍길동", ok: "true" });
    expect(r.out + r.err).not.toContain("secret-token-123");
    expect(f.calls[0]!.url.host).toBe("api.gov-dooray.com");
  });

  it("status with a bad token exits 3", async () => {
    const f = fakeFetch([{ path: "/common/v1/members/me", status: 401, body: fail(401, "Unauthorized") }]);
    const r = await runCli(["auth", "status"], { home: homeWith(), fetch: f });
    expect(r.code).toBe(3);
  });

  it("status for an unknown profile exits 3", async () => {
    const r = await runCli(["auth", "status", "--profile", "nope"], { home: homeWith() });
    expect(r.code).toBe(3);
    expect(r.err).toContain("unknown profile: nope");
  });

  it("DOORAY_PROFILE selects the profile", async () => {
    const r = await runCli(["auth", "status"], { home: homeWith(), env: { DOORAY_PROFILE: "x" } });
    expect(r.err).toContain("unknown profile: x");
  });

  it("login reads a piped token, defaults to gov, writes 0600", async () => {
    const home = tempHome();
    const r = await runCli(["auth", "login"], { home, stdin: "tok-abc\n" });
    expect(r.code).toBe(0);
    const text = readFileSync(cfgFile(home), "utf8");
    expect(text).toContain("default_profile: gov");
    expect(text).toContain("token: tok-abc");
    expect(statSync(cfgFile(home)).mode & 0o777).toBe(0o600);
    expect(r.err).toContain('saved profile "gov" (gov)');
    expect(r.err).not.toContain("tok-abc");
  });

  it("login --env commercial --profile c keeps the existing default", async () => {
    const home = homeWith();
    await runCli(["auth", "login", "--env", "commercial", "--profile", "c"], { home, stdin: "t2" });
    const text = readFileSync(cfgFile(home), "utf8");
    expect(text).toContain("default_profile: gov");
    expect(text).toMatch(/c:\n\s+token: t2\n\s+env: commercial/);
  });

  it("login with an empty token exits 3", async () => {
    expect((await runCli(["auth", "login"], { stdin: "\n" })).code).toBe(3);
  });

  it("remove deletes the profile", async () => {
    const home = homeWith();
    const r = await runCli(["auth", "remove", "gov"], { home });
    expect(r.code).toBe(0);
    expect(readFileSync(cfgFile(home), "utf8")).not.toContain("secret-token-123");
    expect((await runCli(["auth", "remove", "gov"], { home })).code).toBe(4);
  });
});

describe("config", () => {
  it("get masks secrets", async () => {
    const r = await runCli(["config", "get", "-o", "json"], { home: homeWith() });
    const v = JSON.parse(r.out);
    expect(v.token).toBe("secr****-123");
    expect(v.env).toBe("gov");
  });

  it("set writes nested keys, coerces numbers, reads '-' from stdin", async () => {
    const home = homeWith();
    expect((await runCli(["config", "set", "mail.imap_port", "993"], { home })).code).toBe(0);
    expect((await runCli(["config", "set", "mail.password", "-"], { home, stdin: "pw\n" })).code).toBe(0);
    const text = readFileSync(cfgFile(home), "utf8");
    expect(text).toMatch(/imap_port: 993/);
    expect(text).toMatch(/password: pw/);
    const g = await runCli(["config", "get", "mail.password"], { home });
    expect(g.out.trim()).toBe("****");
  });

  it("set hooks.<name> writes a top-level hook", async () => {
    const home = homeWith();
    await runCli(["config", "set", "hooks.deploy", "https://hook.dooray.com/services/9"], { home });
    expect(readFileSync(cfgFile(home), "utf8")).toMatch(/deploy: https:\/\/hook.dooray.com\/services\/9/);
  });

  it("unknown key is a usage error", async () => {
    expect((await runCli(["config", "set", "nope", "1"], { home: homeWith() })).code).toBe(2);
    expect((await runCli(["config", "set", "mail.imap_port", "abc"], { home: homeWith() })).code).toBe(2);
    expect((await runCli(["config", "set", "drive.archive_match", "true"], { home: homeWith() })).code).toBe(2);
  });
});

describe("cache clear", () => {
  it("removes the profile cache dir", async () => {
    const home = homeWith();
    const dir = join(home, ".cache", "dooray", "gov");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.json"), "{}");
    const r = await runCli(["cache", "clear"], { home });
    expect(r.code).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("doctor", () => {
  it("reports all checks ok", async () => {
    const f = fakeFetch([{ path: "/common/v1/members/me", body: ok(ME), headers: { "x-ratelimit-remaining": "19" } }]);
    const r = await runCli(["doctor", "-o", "json"], { home: homeWith(), fetch: f });
    expect(r.code).toBe(0);
    const checks = JSON.parse(r.out) as { check: string; ok: boolean }[];
    expect(checks.map((c) => c.check)).toEqual(["config", "permissions", "profile", "api"]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("flags loose permissions and api failures, exits 1", async () => {
    const home = homeWith();
    chmodSync(cfgFile(home), 0o644);
    const f = fakeFetch([{ path: "/common/v1/members/me", status: 401, body: fail(401, "bad token") }]);
    const r = await runCli(["doctor"], { home, fetch: f });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/permissions\s+FAIL\s+0644/);
    expect(r.out).toMatch(/api\s+FAIL\s+bad token/);
  });

  it("without a config it fails early but still prints", async () => {
    const r = await runCli(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/config\s+FAIL/);
  });
});
