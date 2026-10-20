import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fail, fakeFetch, GOV_CONFIG, ok, runCli, tempHome } from "../helpers.js";

const P = "3000000000000000801";
const PP = `/project/v1/projects/${P}`;
const ME = "3000000000000000802";

function home(): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG);
  return h;
}

describe("project basics", () => {
  it("list --search filters codes and keeps member=me", async () => {
    const f = fakeFetch([{ path: "/project/v1/projects", body: ok([{ id: P, code: "개발팀", scope: "private", state: "active" }, { id: "x", code: "EM팀" }], 2) }]);
    const r = await runCli(["project", "list", "--search", "개발"], { home: home(), fetch: f });
    expect(f.calls[0]!.url.searchParams.get("member")).toBe("me");
    expect(r.out).toContain("개발팀");
    expect(r.out).not.toContain("EM팀");
  });

  it("get by code", async () => {
    const f = fakeFetch([
      { path: "/project/v1/projects", body: ok([{ id: P, code: "개발팀" }], 1) },
      { path: PP, body: ok({ id: P, code: "개발팀", wiki: { id: "w" }, drive: { id: "d" } }) },
    ]);
    const r = await runCli(["project", "get", "개발팀"], { home: home(), fetch: f });
    expect(r.out).toMatch(new RegExp(`${P}\\s+개발팀`));
  });

  it("create / update / archive / activate", async () => {
    const f = fakeFetch([
      { method: "POST", path: "/project/v1/projects", body: ok({ id: P }) },
      { method: "PUT", path: PP, body: ok(null) },
      { method: "POST", path: `${PP}/set-archive`, body: ok(null) },
      { method: "POST", path: `${PP}/set-active`, body: ok(null) },
    ]);
    const h = home();
    await runCli(["project", "create", "--code", "새팀", "--description", "d"], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ code: "새팀", description: "d", scope: "private" });
    await runCli(["project", "update", P, "--description", "new"], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ description: "new" });
    expect((await runCli(["project", "archive", P], { home: h, fetch: f })).code).toBe(0);
    expect((await runCli(["project", "activate", P], { home: h, fetch: f })).code).toBe(0);
    expect((await runCli(["project", "update", P], { home: h })).code).toBe(2);
  });

  it("categories and is-creatable (both outcomes)", async () => {
    const f = fakeFetch([
      { path: "/project/v1/project-categories", body: ok([{ id: "c1", name: "연구" }]) },
      { method: "POST", path: "/project/v1/projects/is-creatable", body: ok(null) },
      { method: "POST", path: "/project/v1/projects/is-creatable", body: fail(-1, "already exists") },
    ]);
    const h = home();
    expect((await runCli(["project", "categories"], { home: h, fetch: f })).out).toContain("연구");
    expect(JSON.parse((await runCli(["project", "is-creatable", "a", "-o", "json"], { home: h, fetch: f })).out).creatable).toBe(true);
    const no = JSON.parse((await runCli(["project", "is-creatable", "b", "-o", "json"], { home: h, fetch: f })).out);
    expect(no).toEqual({ code: "b", creatable: false, reason: "already exists" });
    expect(f.calls[1]!.body).toEqual({ code: "a" });
  });
});

describe("milestones / workflows / tags", () => {
  it("milestone create converts dates; update/delete", async () => {
    const f = fakeFetch([
      { method: "POST", path: `${PP}/milestones`, body: ok({ id: "m1" }) },
      { method: "PUT", path: `${PP}/milestones/m1`, body: ok(null) },
      { method: "DELETE", path: `${PP}/milestones/m1`, body: ok(null) },
      { path: `${PP}/milestones`, body: ok([{ id: "m1", name: "1단계", status: "open" }], 1) },
    ]);
    const h = home();
    await runCli(["project", "milestone", "create", "--project", P, "--name", "1단계", "--started-at", "2026-10-01", "--ended-at", "2026-12-31"], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ name: "1단계", startedAt: "2026-10-01+09:00", endedAt: "2026-12-31+09:00" });
    await runCli(["project", "milestone", "update", "m1", "--project", P, "--status", "closed"], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ status: "closed" });
    expect((await runCli(["project", "milestone", "delete", "m1", "--project", P, "--yes"], { home: h, fetch: f })).code).toBe(0);
    expect((await runCli(["project", "milestone", "list", "--project", P], { home: h, fetch: f })).out).toMatch(/m1\s+1단계\s+open/);
  });

  it("workflow create/update/delete by name", async () => {
    const wfs = { path: `${PP}/workflows`, body: ok([{ id: "w1", name: "등록", class: "registered", order: 100 }, { id: "w2", name: "완료", class: "closed", order: 400 }], 2), repeat: true };
    const f = fakeFetch([
      { method: "POST", path: `${PP}/workflows`, body: ok(null) },
      wfs,
      { method: "PUT", path: `${PP}/workflows/w1`, body: ok(null) },
      { method: "POST", path: `${PP}/workflows/w1/delete`, body: ok(null) },
    ]);
    const h = home();
    await runCli(["project", "workflow", "create", "--project", P, "--name", "검토", "--class", "working", "--order", "250"], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ name: "검토", class: "working", order: 250 });
    await runCli(["project", "workflow", "update", "등록", "--project", P, "--name", "할 일"], { home: h, fetch: f });
    expect(f.calls.find((c) => c.method === "PUT")!.body).toEqual({ name: "할 일", class: "registered", order: 100 });
    await runCli(["project", "workflow", "delete", "등록", "--project", P, "--move-to", "closed", "--yes"], { home: h, fetch: f });
    expect(f.calls.at(-1)!.body).toEqual({ toBeWorkflowId: "w2" });
    expect((await runCli(["project", "workflow", "create", "--project", P, "--name", "x", "--class", "nope"], { home: h, fetch: f })).code).toBe(2);
  });

  it("tag list/create/group", async () => {
    const tags = { path: `${PP}/tags`, body: ok([{ id: "t1", name: "긴급", color: "ff0000", tagGroup: { id: "g1", name: "중요도" } }], 1), repeat: true };
    const f = fakeFetch([
      tags,
      { method: "POST", path: `${PP}/tags`, body: ok({ id: "t2" }) },
      { method: "PUT", path: `${PP}/tag-groups/g1`, body: ok(null) },
    ]);
    const h = home();
    expect((await runCli(["project", "tag", "list", "--project", P], { home: h, fetch: f })).out).toMatch(/t1\s+긴급\s+ff0000\s+중요도/);
    await runCli(["project", "tag", "create", "--project", P, "--name", "중요도:보통", "--color", "00ff00"], { home: h, fetch: f });
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ name: "중요도:보통", color: "00ff00" });
    await runCli(["project", "tag", "group", "중요도", "--project", P, "--mandatory", "--no-select-one"], { home: h, fetch: f });
    expect(f.calls.find((c) => c.method === "PUT")!.body).toEqual({ mandatory: true, selectOne: false });
    expect((await runCli(["project", "tag", "group", "없음", "--project", P, "--mandatory"], { home: h, fetch: f })).code).toBe(2);
  });
});

describe("members / groups", () => {
  it("member add/remove by name; list", async () => {
    const f = fakeFetch([
      { path: "/common/v1/members", body: ok([{ id: ME, name: "홍길동" }], 1), repeat: true },
      { method: "POST", path: `${PP}/members`, body: ok({}) },
      { method: "DELETE", path: `${PP}/members/${ME}`, body: ok(null) },
      { path: `${PP}/members`, body: ok([{ organizationMemberId: ME, role: "admin" }], 1) },
    ]);
    const h = home();
    await runCli(["project", "member", "add", "홍길동", "--project", P, "--role", "admin"], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ organizationMemberId: ME, role: "admin" });
    expect((await runCli(["project", "member", "remove", "홍길동", "--project", P, "--yes"], { home: h, fetch: f })).code).toBe(0);
    expect((await runCli(["project", "member", "list", "--project", P], { home: h, fetch: f })).out).toMatch(new RegExp(`${ME}\\s+admin`));
    expect((await runCli(["project", "member", "add", "x", "--project", P, "--role", "owner"], { home: h })).code).toBe(2);
  });

  it("member-group list flattens nested arrays; get shows members", async () => {
    const f = fakeFetch([
      { path: `${PP}/member-groups`, body: ok([[{ id: "3000000000000000901", code: "분석팀" }]], 1), repeat: true },
      { path: `${PP}/member-groups/3000000000000000901`, body: ok({ id: "3000000000000000901", code: "분석팀", members: [{ organizationMember: { id: ME, name: "홍길동" } }] }) },
    ]);
    const h = home();
    expect((await runCli(["project", "member-group", "list", "--project", P], { home: h, fetch: f })).out).toContain("분석팀");
    expect((await runCli(["project", "member-group", "get", "분석팀", "--project", P], { home: h, fetch: f })).out).toMatch(/분석팀\s+\d+\s+홍길동/);
  });
});

describe("templates / hooks / email", () => {
  it("template create from --body-json @file and from flags; delete", async () => {
    const json = join(tempHome(), "t.json");
    writeFileSync(json, JSON.stringify({ templateName: "주간", subject: "주간 보고" }));
    const f = fakeFetch([
      { method: "POST", path: `${PP}/templates`, body: ok({ id: "3000000000000000950" }), repeat: true },
      { method: "DELETE", path: `${PP}/templates/3000000000000000950`, body: ok(null) },
    ]);
    const h = home();
    await runCli(["project", "template", "create", "--project", P, "--body-json", `@${json}`], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ templateName: "주간", subject: "주간 보고" });
    await runCli(["project", "template", "create", "--project", P, "--name", "n", "--body", "b"], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ templateName: "n", body: { mimeType: "text/x-markdown", content: "b" } });
    expect((await runCli(["project", "template", "create", "--project", P, "--body-json", "{bad"], { home: h })).code).toBe(2);
    expect((await runCli(["project", "template", "delete", "3000000000000000950", "--project", P, "--yes"], { home: h, fetch: f })).code).toBe(0);
  });

  it("template get uses interpolation by default; list", async () => {
    const f = fakeFetch([
      { path: `${PP}/templates/3000000000000000950`, body: ok({ id: "3000000000000000950", templateName: "주간", subject: "2026 보고" }) },
      { path: `${PP}/templates`, body: ok([{ id: "3000000000000000950", templateName: "주간" }], 1) },
    ]);
    const h = home();
    await runCli(["project", "template", "get", "3000000000000000950", "--project", P], { home: h, fetch: f });
    expect(f.calls[0]!.url.searchParams.get("interpolation")).toBe("true");
    expect((await runCli(["project", "template", "list", "--project", P], { home: h, fetch: f })).out).toContain("주간");
  });

  it("hook, wiki-hook and email", async () => {
    const f = fakeFetch([
      { method: "POST", path: `${PP}/hooks`, body: ok({ id: "h1" }) },
      { method: "POST", path: `${PP}/wiki-hooks`, body: ok({ id: "h2" }) },
      { method: "POST", path: `${PP}/email-addresses`, body: ok({ id: "e1" }) },
      { path: `${PP}/email-addresses/e1`, body: ok({ id: "e1", emailAddress: "team@acme.gov-dooray.com", name: "팀" }) },
    ]);
    const h = home();
    await runCli(["project", "hook", "create", "--project", P, "--url", "https://x/h", "--event", "postCreated", "--include-body"], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ url: "https://x/h", type: "task", sendEvents: ["postCreated"], option: { body: { include: true, embedInlineImage: false } } });
    await runCli(["project", "wiki-hook", "create", "--project", P, "--url", "https://x/w", "--event", "pageCreated"], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ url: "https://x/w", eventTypes: ["pageCreated"], messageType: "dooray", enabled: true });
    await runCli(["project", "email", "create", "--project", P, "--email", "team@acme.gov-dooray.com"], { home: h, fetch: f });
    expect((await runCli(["project", "email", "get", "e1", "--project", P], { home: h, fetch: f })).out).toContain("team@acme.gov-dooray.com");
    expect((await runCli(["project", "hook", "create", "--project", P, "--url", "u"], { home: h })).code).toBe(2);
  });
});

describe("member", () => {
  it("list needs a filter; get resolves me", async () => {
    expect((await runCli(["member", "list"], { home: home() })).code).toBe(2);
    const f = fakeFetch([
      { path: "/common/v1/members", body: ok([{ id: ME, name: "홍길동", userCode: "hong" }], 1) },
      { path: "/common/v1/members/me", body: ok({ id: ME }) },
      { path: `/common/v1/members/${ME}`, body: ok({ id: ME, name: "홍길동", userCode: "hong", externalEmailAddress: "h@example.com" }) },
    ]);
    const h = home();
    const l = await runCli(["member", "list", "--search", "홍"], { home: h, fetch: f });
    expect(l.out).toMatch(/ID\s+CODE\s+NAME\s+EMAIL/);
    expect(f.calls[0]!.url.searchParams.get("name")).toBe("홍");
    expect((await runCli(["member", "get", "me"], { home: h, fetch: f })).out).toContain("h@example.com");
  });
});
