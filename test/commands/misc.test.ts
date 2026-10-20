import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetch, GOV_CONFIG, ok, runCli, tempHome } from "../helpers.js";

function home(): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG);
  return h;
}

const withCursor = (result: unknown[], cursor: string) => ({ ...ok(result), cursor });

describe("stream", () => {
  const mail = { type: "mail", mail: { id: "m1", sentAt: "2026-10-19T12:31:53+09:00", subject: "RE: 사용료", users: { from: { type: "emailUser", emailUser: { name: "권경환" } } } } };
  const post = { type: "post", post: { id: "p1", createdAt: "2026-10-19T10:00:00+09:00", subject: "업무", users: { from: { type: "member", member: { name: "이관호" } } } } };

  it("lists the newest activity with a readable summary", async () => {
    const f = fakeFetch([{ path: "/common/v1/streams", body: withCursor([mail, post], "c1") }]);
    const r = await runCli(["stream", "list", "--size", "2", "--unread"], { home: home(), fetch: f });
    expect(f.calls[0]!.url.searchParams.get("size")).toBe("2");
    expect(f.calls[0]!.url.searchParams.get("read")).toBe("false");
    expect(r.out).toMatch(/TYPE\s+TIME\s+FROM\s+TITLE/);
    expect(r.out).toMatch(/mail\s+2026-10-19T12:31:53\+09:00\s+권경환\s+RE: 사용료/);
    expect(r.out).toMatch(/post\s+2026-10-19T10:00:00\+09:00\s+이관호\s+업무/);
    expect(r.err).toContain("next: --before c1");
  });

  it("--all follows the cursor until an empty page", async () => {
    const f = fakeFetch([
      { path: "/common/v1/streams", body: withCursor([mail], "c1") },
      { path: "/common/v1/streams", body: withCursor([post], "c2") },
      { path: "/common/v1/streams", body: withCursor([], "c3") },
    ]);
    const r = await runCli(["stream", "list", "--all", "-o", "json"], { home: home(), fetch: f });
    expect(JSON.parse(r.out)).toHaveLength(2);
    expect(f.calls[1]!.url.searchParams.get("before")).toBe("c1");
    expect(f.calls[2]!.url.searchParams.get("before")).toBe("c2");
  });

  it("rejects a size over 200", async () => {
    expect((await runCli(["stream", "list", "--size", "500"], { home: home() })).code).toBe(2);
  });
});

describe("contact", () => {
  const c = {
    id: "3000000000000001201",
    name: "홍길동",
    company: "활빈당",
    department: "돌격",
    emails: [{ emailAddress: "hong@x.com", default: true }],
    phones: [{ numberWithCountryCode: "+82-10-1234-5678", default: true }],
  };
  it("list / get / search", async () => {
    const f = fakeFetch([
      { path: "/contacts/v1/contacts", body: ok([c], 1) },
      { path: `/contacts/v1/contacts/${c.id}`, body: ok(c) },
      { method: "POST", path: "/contacts/v1/contacts/search", body: ok([{ id: c.id, name: "홍길동", company: "활빈당", emailAddress: "hong@x.com" }], 1) },
    ]);
    const h = home();
    const l = await runCli(["contact", "list"], { home: h, fetch: f });
    expect(l.out).toMatch(/ID\s+NAME\s+COMPANY\s+DEPARTMENT\s+EMAIL\s+PHONE/);
    expect(l.out).toMatch(/홍길동\s+활빈당\s+돌격\s+hong@x.com\s+\+82-10-1234-5678/);
    expect(JSON.parse((await runCli(["contact", "get", c.id, "-o", "json"], { home: h, fetch: f })).out).name).toBe("홍길동");
    const s = await runCli(["contact", "search", "홍길", "활빈"], { home: h, fetch: f });
    expect(f.calls[2]!.body).toEqual({ all: ["홍길", "활빈"] });
    expect(s.out).toContain("hong@x.com");
  });
});

describe("incoming-hook", () => {
  it("create for projects, get, delete", async () => {
    const P = "3000000000000001301";
    const f = fakeFetch([
      { method: "POST", path: "/common/v1/incoming-hooks", body: ok({ id: "h1", url: "https://hook.dooray.com/services/1/2/x" }) },
      { path: "/common/v1/incoming-hooks/h1", body: ok({ id: "h1", name: "CI", serviceType: "incoming", projects: [{ id: P }], url: "https://hook.dooray.com/services/1/2/x" }) },
      { method: "DELETE", path: "/common/v1/incoming-hooks/h1", body: ok(null) },
    ]);
    const h = home();
    const c = await runCli(["incoming-hook", "create", "--name", "CI", "--project", P], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ name: "CI", serviceType: "incoming", projectIds: [P] });
    expect(c.out).toContain("https://hook.dooray.com/services/1/2/x");
    expect((await runCli(["incoming-hook", "get", "h1"], { home: h, fetch: f })).out).toMatch(/h1\s+CI\s+incoming/);
    expect((await runCli(["incoming-hook", "delete", "h1"], { home: h })).code).toBe(2);
    expect((await runCli(["incoming-hook", "delete", "h1", "--yes"], { home: h, fetch: f })).code).toBe(0);
  });

  it("rejects an unknown service type", async () => {
    expect((await runCli(["incoming-hook", "create", "--name", "x", "--service", "slack", "--project", "1"], { home: home() })).code).toBe(2);
  });
});
