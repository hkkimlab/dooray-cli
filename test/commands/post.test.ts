import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetch, GOV_CONFIG, ok, runCli, tempHome, type Route } from "../helpers.js";

const P = "3000000000000000501";
const POST = "3000000000000000502";
const ME = "3000000000000000503";
const WF_REG = "3000000000000000504";
const WF_DONE = "3000000000000000505";
const TAG = "3000000000000000506";
const MS = "3000000000000000507";
const PP = `/project/v1/projects/${P}/posts`;

function home(): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG);
  return h;
}

const post = (extra = {}) => ({
  id: POST,
  subject: "회의록 정리",
  taskNumber: "개발팀/7",
  number: 7,
  project: { id: P, code: "개발팀" },
  body: { mimeType: "text/x-markdown", content: "hello world" },
  priority: "normal",
  dueDate: "2026-10-31T23:59:59+09:00",
  dueDateFlag: true,
  milestone: { id: MS, name: "1단계" },
  tags: [{ id: TAG }],
  users: {
    from: { type: "member", member: { organizationMemberId: ME, name: "나사용" } },
    to: [{ type: "member", member: { organizationMemberId: ME, name: "나사용" } }],
    cc: [],
  },
  workflow: { id: WF_REG, name: "등록" },
  workflowClass: "registered",
  ...extra,
});

const projects: Route = { path: "/project/v1/projects", body: ok([{ id: P, code: "개발팀" }], 1), repeat: true };
const meRoute: Route = { path: "/common/v1/members/me", body: ok({ id: ME, name: "나사용", defaultOrganization: { id: "9" } }), repeat: true };
const workflows: Route = {
  path: `/project/v1/projects/${P}/workflows`,
  body: ok([
    { id: WF_DONE, name: "완료", class: "closed", order: 400 },
    { id: WF_REG, name: "등록", class: "registered", order: 100 },
  ], 2),
};

describe("post references", () => {
  it("project/number resolves via postNumber", async () => {
    const f = fakeFetch([projects, { path: PP, body: ok([post()], 1) }, { path: `${PP}/${POST}`, body: ok(post()) }]);
    const r = await runCli(["post", "get", "개발팀/7", "-o", "json"], { home: home(), fetch: f });
    expect(r.code).toBe(0);
    expect(f.calls[1]!.url.searchParams.get("postNumber")).toBe("7");
    expect(JSON.parse(r.out).id).toBe(POST);
  });

  it("a task URL resolves the project through /project/v1/posts/{id}", async () => {
    const f = fakeFetch([{ path: `/project/v1/posts/${POST}`, body: ok(post()) }, { path: `${PP}/${POST}`, body: ok(post()) }]);
    const r = await runCli(["task", "get", `https://acme.gov-dooray.com/task/to/${POST}`], { home: home(), fetch: f });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/NUMBER\s+개발팀\/7/);
    expect(r.out).toContain("hello world");
  });

  it("a bare number needs --project", async () => {
    const r = await runCli(["post", "get", "7"], { home: home(), fetch: fakeFetch([]) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--project");
  });

  it("a wiki URL is rejected", async () => {
    const r = await runCli(["post", "get", "https://x.dooray.com/wiki/3000000000000000001/3000000000000000002"], { home: home() });
    expect(r.code).toBe(2);
  });
});

describe("post list/search", () => {
  it("maps filters to the API query", async () => {
    const f = fakeFetch([
      projects,
      meRoute,
      { path: `/project/v1/projects/${P}/tags`, body: ok([{ id: TAG, name: "긴급", tagGroup: { id: "g", name: "중요도" } }], 1) },
      { path: PP, body: ok([post()], 1) },
    ]);
    const r = await runCli(
      ["post", "list", "개발팀", "--to", "me", "--tag", "중요도:긴급", "--status", "registered,working", "--created", "2026-10-01~", "--order", "-postUpdatedAt"],
      { home: home(), fetch: f },
    );
    expect(r.code).toBe(0);
    const q = f.calls.at(-1)!.url.searchParams;
    expect(q.get("toMemberIds")).toBe(ME);
    expect(q.get("tagIds")).toBe(TAG);
    expect(q.get("postWorkflowClasses")).toBe("registered,working");
    expect(q.get("createdAt")).toBe("2026-10-01T00:00:00+09:00~2999-12-31T23:59:59Z");
    expect(q.get("order")).toBe("-postUpdatedAt");
    expect(r.out).toMatch(/ID\s+NUMBER\s+SUBJECT\s+WORKFLOW\s+PRIORITY\s+ASSIGNEES/);
    expect(r.out).toMatch(/개발팀\/7\s+회의록 정리\s+등록\s+normal\s+나사용/);
  });

  it("--unassigned, --milestone and default order", async () => {
    const f = fakeFetch([
      { path: `/project/v1/projects/${P}/milestones`, body: ok([{ id: MS, name: "1단계" }], 1) },
      { path: PP, body: ok([], 0) },
    ]);
    await runCli(["post", "list", "--project", P, "--unassigned", "--milestone", "1단계"], { home: home(), fetch: f });
    const q = f.calls.at(-1)!.url.searchParams;
    expect(q.get("toMemberSize")).toBe("0");
    expect(q.get("milestoneIds")).toBe(MS);
    expect(q.get("order")).toBe("-createdAt");
  });

  it("rejects a bad --status and a missing project", async () => {
    expect((await runCli(["post", "list", P, "--status", "done"], { home: home(), fetch: fakeFetch([]) })).code).toBe(2);
    expect((await runCli(["post", "list"], { home: home() })).code).toBe(2);
  });

  it("search <project> <keyword> uses subjects", async () => {
    const f = fakeFetch([{ path: PP, body: ok([post()], 1) }]);
    await runCli(["post", "search", P, "회의"], { home: home(), fetch: f });
    expect(f.calls[0]!.url.searchParams.get("subjects")).toBe("회의");
  });
});

describe("post create", () => {
  it("builds users/body/tags and sets the workflow afterwards", async () => {
    const f = fakeFetch([
      meRoute,
      { path: `/project/v1/projects/${P}/tags`, body: ok([{ id: TAG, name: "긴급" }], 1) },
      { method: "POST", path: PP, body: ok({ id: POST }) },
      workflows,
      { method: "POST", path: `${PP}/${POST}/set-workflow`, body: ok(null) },
    ]);
    const r = await runCli(
      ["post", "create", P, "--subject", "새 업무", "--body", "내용", "--to", "me", "--tag", "긴급", "--priority", "high", "--due", "2026-10-31", "--workflow", "closed"],
      { home: home(), fetch: f },
    );
    expect(r.code).toBe(0);
    expect(f.calls[2]!.body).toEqual({
      subject: "새 업무",
      body: { mimeType: "text/x-markdown", content: "내용" },
      users: { to: [{ type: "member", member: { organizationMemberId: ME } }], cc: [] },
      dueDate: "2026-10-31T23:59:59+09:00",
      dueDateFlag: true,
      tagIds: [TAG],
      priority: "high",
    });
    expect(f.calls[4]!.body).toEqual({ workflowId: WF_DONE });
  });

  it("--dry-run prints the body with mentions and task links, sends nothing", async () => {
    const f = fakeFetch([
      meRoute,
      { path: `/common/v1/members/${ME}`, body: ok({ id: ME, name: "나사용" }) },
      { path: `/project/v1/posts/${POST}`, body: ok(post()) },
      { path: `${PP}/${POST}`, body: ok(post()) },
    ]);
    const r = await runCli(["post", "create", P, "--title", "t", "--body", "본문", "--mention", "me", "--link-task", POST, "--dry-run"], { home: home(), fetch: f });
    const body = JSON.parse(r.out);
    expect(body.body.content).toBe(`[@나사용](dooray://9/members/${ME} "me")\n\n본문\n\n[개발팀/7 회의록 정리](dooray://9/tasks/${POST})`);
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("mentions are refused for HTML bodies", async () => {
    const r = await runCli(["post", "create", P, "--subject", "t", "--html", "--mention", "me"], { home: home(), fetch: fakeFetch([]) });
    expect(r.code).toBe(2);
  });

  it("--template fills subject/body; --draft creates a draft", async () => {
    const f = fakeFetch([
      { path: `/project/v1/projects/${P}/templates`, body: ok([{ id: "3000000000000000599", templateName: "회의록" }], 1) },
      { path: `/project/v1/projects/${P}/templates/3000000000000000599`, body: ok({ id: "3000000000000000599", subject: "[회의록] 2026", body: { mimeType: "text/html", content: "<p>x</p>" }, priority: "low" }) },
      { method: "POST", path: "/project/v1/post-drafts", body: ok({ id: "d1", url: "/task/write/draft/d1" }) },
    ]);
    const r = await runCli(["post", "create", P, "--template", "회의록", "--draft"], { home: home(), fetch: f });
    expect(f.calls[1]!.url.searchParams.get("interpolation")).toBe("true");
    expect(f.calls[2]!.body).toMatchObject({ projectId: P, subject: "[회의록] 2026", body: { mimeType: "text/html", content: "<p>x</p>" }, priority: "low" });
    expect(r.out).toContain("/task/write/draft/d1");
  });

  it("needs a subject", async () => {
    expect((await runCli(["post", "create", P], { home: home(), fetch: fakeFetch([]) })).code).toBe(2);
  });
});

describe("post update/replace", () => {
  it("update keeps unspecified fields (full PUT) and only sends tags when changed", async () => {
    const f = fakeFetch([{ path: `${PP}/${POST}`, body: ok(post()) }, { method: "PUT", path: `${PP}/${POST}`, body: ok(null) }]);
    const r = await runCli(["post", "update", POST, "--project", P, "--subject", "바뀐 제목"], { home: home(), fetch: f });
    expect(r.code).toBe(0);
    expect(f.calls[1]!.body).toEqual({
      subject: "바뀐 제목",
      body: { mimeType: "text/x-markdown", content: "hello world" },
      priority: "normal",
      dueDate: "2026-10-31T23:59:59+09:00",
      dueDateFlag: true,
      milestoneId: MS,
      users: { to: [{ type: "member", member: { organizationMemberId: ME, name: "나사용" } }], cc: [] },
    });
  });

  it("update --html without a new body is refused (it would relabel markdown as HTML)", async () => {
    const r = await runCli(["post", "update", POST, "--project", P, "--html"], { home: home(), fetch: fakeFetch([{ path: `${PP}/${POST}`, body: ok(post()) }]) });
    expect(r.code).toBe(2);
  });

  it("update --to replaces assignees and --parent sets the parent", async () => {
    const PARENT = "3000000000000000600";
    const f = fakeFetch([
      { path: `${PP}/${POST}`, body: ok(post()) },
      { method: "PUT", path: `${PP}/${POST}`, body: ok(null) },
      { method: "POST", path: `${PP}/${POST}/set-parent-post`, body: ok({}) },
    ]);
    await runCli(["post", "update", POST, "--project", P, "--to", "3000000000000000777", "--parent", PARENT], { home: home(), fetch: f });
    expect((f.calls[1]!.body as { users: unknown }).users).toEqual({
      to: [{ type: "member", member: { organizationMemberId: "3000000000000000777" } }],
      cc: [],
    });
    expect(f.calls[2]!.body).toEqual({ parentPostId: PARENT });
  });

  it("replace --dry-run previews; replace sends the edited body keeping the rest", async () => {
    const f = fakeFetch([
      { path: `${PP}/${POST}`, body: ok(post()), repeat: true },
      { method: "PUT", path: `${PP}/${POST}`, body: ok(null) },
    ]);
    const d = await runCli(["post", "replace", POST, "--project", P, "--old", "world", "--new", "there", "--dry-run"], { home: home(), fetch: f });
    expect(d.out).toBe("-hello world\n+hello there\n");
    const r = await runCli(["post", "replace", POST, "--project", P, "--old", "world", "--new", "there", "-o", "json"], { home: home(), fetch: f });
    expect(JSON.parse(r.out)).toEqual({ postId: POST, replaced: 1 });
    const put = f.calls.find((c) => c.method === "PUT")!.body as { body: unknown; subject: string };
    expect(put.body).toEqual({ mimeType: "text/x-markdown", content: "hello there" });
    expect(put.subject).toBe("회의록 정리");
  });

  it("replace without a match fails before writing", async () => {
    const f = fakeFetch([{ path: `${PP}/${POST}`, body: ok(post()) }]);
    const r = await runCli(["post", "replace", POST, "--project", P, "--old", "nope", "--new", "x"], { home: home(), fetch: f });
    expect(r.code).toBe(2);
  });
});

describe("post workflow transitions", () => {
  it("done → set-done; reopen → first registered workflow", async () => {
    const f = fakeFetch([
      { method: "POST", path: `${PP}/${POST}/set-done`, body: ok(null) },
      workflows,
      { method: "POST", path: `${PP}/${POST}/set-workflow`, body: ok(null) },
    ]);
    const h = home();
    expect((await runCli(["post", "done", POST, "--project", P], { home: h, fetch: f })).code).toBe(0);
    await runCli(["post", "reopen", POST, "--project", P], { home: h, fetch: f });
    expect(f.calls[2]!.body).toEqual({ workflowId: WF_REG });
  });

  it("workflow --member changes one assignee via to/{member}", async () => {
    const f = fakeFetch([workflows, { method: "PUT", path: `${PP}/${POST}/to/me`, body: ok(null) }]);
    const r = await runCli(["post", "workflow", POST, "완료", "--project", P, "--member", "me"], { home: home(), fetch: f });
    expect(r.code).toBe(0);
    expect(f.calls[1]!.body).toEqual({ workflowId: WF_DONE });
  });

  it("move and parent", async () => {
    const OTHER = "3000000000000000700";
    const f = fakeFetch([
      { method: "POST", path: `${PP}/${POST}/move`, body: ok({}) },
      { method: "POST", path: `${PP}/${POST}/set-parent-post`, body: ok({}) },
    ]);
    const h = home();
    await runCli(["post", "move", POST, "--project", P, "--to-project", OTHER, "--no-sub-posts"], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ targetProjectId: OTHER, includeSubPosts: false });
    await runCli(["post", "parent", POST, OTHER, "--project", P], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ parentPostId: OTHER });
  });
});

describe("post comments", () => {
  const L = `${PP}/${POST}/logs`;
  const log = (id: string, createdAt: string, name = "나사용") => ({
    id,
    createdAt,
    creator: { type: "member", member: { organizationMemberId: ME, name } },
    body: { mimeType: "text/x-markdown", content: `comment ${id}` },
  });

  it("list filters by --since and --author", async () => {
    const f = fakeFetch([{ path: L, body: ok([log("1", "2026-10-01T00:00:00Z"), log("2", "2026-10-10T00:00:00Z", "홍길동")], 2) }]);
    const r = await runCli(["post", "comment", "list", POST, "--project", P, "--since", "2026-10-05", "-o", "json"], { home: home(), fetch: f });
    expect(JSON.parse(r.out).map((l: { id: string }) => l.id)).toEqual(["2"]);
    expect(f.calls[0]!.url.searchParams.get("order")).toBe("createdAt");
  });

  it("fills in author names that the API leaves out", async () => {
    const bare = { id: "5", createdAt: "2026-10-10T00:00:00Z", creator: { type: "member", member: { organizationMemberId: "3000000000000000999" } }, body: { content: "x" } };
    const f = fakeFetch([
      { path: L, body: ok([bare], 1) },
      { path: "/common/v1/members/3000000000000000999", body: ok({ id: "3000000000000000999", name: "이몽룡" }) },
    ]);
    const r = await runCli(["post", "comment", "list", POST, "--project", P, "--author", "몽룡"], { home: home(), fetch: f });
    expect(r.out).toMatch(/5\s+2026-10-10T00:00:00Z\s+이몽룡/);
  });

  it("latest prints the newest body", async () => {
    const f = fakeFetch([{ path: L, body: ok([log("9", "2026-10-10T00:00:00Z")], 5) }]);
    const r = await runCli(["post", "comment", "latest", POST, "--project", P], { home: home(), fetch: f });
    expect(f.calls[0]!.url.searchParams.get("order")).toBe("-createdAt");
    expect(r.out).toContain("comment 9");
  });

  it("add uploads files then attaches their ids", async () => {
    const file = join(tempHome(), "a.txt");
    writeFileSync(file, "x");
    const f = fakeFetch([
      { method: "POST", path: `${PP}/${POST}/files`, body: ok({ id: "f1" }) },
      { method: "POST", path: L, body: ok({ id: "c1" }) },
    ]);
    const r = await runCli(["post", "comment", "add", POST, "--project", P, "--body", "첨부", "--file", file], { home: home(), fetch: f });
    expect(r.code).toBe(0);
    expect(f.calls[1]!.body).toEqual({ body: { content: "첨부", mimeType: "text/x-markdown" }, attachFileIds: ["f1"] });
  });

  it("add without body fails; update keeps the mime type; delete asks", async () => {
    expect((await runCli(["post", "comment", "add", POST, "--project", P], { home: home() })).code).toBe(2);
    const f = fakeFetch([
      { path: `${L}/c1`, body: ok({ id: "c1", body: { mimeType: "text/html", content: "<p>a</p>" } }) },
      { method: "PUT", path: `${L}/c1`, body: ok(null) },
      { method: "DELETE", path: `${L}/c1`, body: ok(null) },
    ]);
    const h = home();
    await runCli(["post", "comment", "edit", POST, "c1", "--project", P, "--body", "<p>b</p>"], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ body: { mimeType: "text/html", content: "<p>b</p>" } });
    expect((await runCli(["post", "comment", "delete", POST, "c1", "--project", P], { home: h })).code).toBe(2);
    expect((await runCli(["post", "comment", "delete", POST, "c1", "--project", P, "--yes"], { home: h, fetch: f })).code).toBe(0);
  });

  it("get shows one comment", async () => {
    const f = fakeFetch([{ path: `${L}/c1`, body: ok(log("c1", "2026-10-10T00:00:00Z")) }]);
    expect((await runCli(["post", "comment", "get", POST, "c1", "--project", P], { home: home(), fetch: f })).out).toContain("comment c1");
  });
});

describe("post files", () => {
  const F = `${PP}/${POST}/files`;
  it("list, download-all and delete", async () => {
    const out = join(tempHome(), "dl");
    const f = fakeFetch([
      { path: F, body: ok([{ id: "f1", name: "a.txt", size: 1 }], 1), repeat: true },
      { path: `${F}/f1`, status: 307, raw: "", headers: { location: "https://file-api.gov-dooray.com/downloads/f1" } },
      { path: "/downloads/f1", raw: "A" },
      { method: "DELETE", path: `${F}/f1`, body: ok(null) },
    ]);
    const h = home();
    expect((await runCli(["post", "file", "list", POST, "--project", P], { home: h, fetch: f })).out).toMatch(/f1\s+a.txt\s+1/);
    await runCli(["post", "file", "download-all", POST, "--project", P, "-O", out], { home: h, fetch: f });
    expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("A");
    expect((await runCli(["post", "file", "delete", POST, "f1", "--project", P, "--yes"], { home: h, fetch: f })).code).toBe(0);
  });

  it("upload and single download by meta name", async () => {
    const src = join(tempHome(), "up.txt");
    writeFileSync(src, "U");
    const f = fakeFetch([
      { method: "POST", path: F, body: ok({ id: "f2" }) },
      { path: `${F}/f2`, body: ok({ id: "f2", name: "../bad" }) },
    ]);
    const h = home();
    expect((await runCli(["post", "file", "upload", POST, src, "--project", P], { home: h, fetch: f })).out).toContain("f2");
    expect((await runCli(["post", "file", "download", POST, "f2", "--project", P], { home: h, fetch: f })).err).toContain("unsafe file name");
  });
});
