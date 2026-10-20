import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetch, GOV_CONFIG, ok, runCli, tempHome, type Route } from "../helpers.js";

const W = "3000000000000001001";
const PROJ = "3000000000000001002";
const HOME = "3000000000000001003";
const PAGE = "3000000000000001004";
const CHILD = "3000000000000001005";
const ME = "3000000000000001006";
const WP = `/wiki/v1/wikis/${W}/pages`;

function home(): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG);
  return h;
}

const wikis: Route = {
  path: "/wiki/v1/wikis",
  body: ok([{ id: W, name: "개발팀", type: "public", home: { pageId: HOME }, project: { id: PROJ } }, { id: "3000000000000001099", name: "@myid", home: { pageId: "x" }, project: { id: "y" } }], 2),
  repeat: true,
};

const page = (extra = {}) => ({
  id: PAGE,
  wikiId: W,
  parentPageId: HOME,
  subject: "회의록",
  version: 3,
  body: { mimeType: "text/x-markdown", content: "line one\nold text\n" },
  referrers: [{ type: "member", member: { organizationMemberId: ME } }],
  files: [{ id: "f1", attachFileId: "a1", name: "a.pdf", size: 3 }],
  images: [{ id: "i1", attachFileId: "a2", name: "p.png", size: 4 }],
  ...extra,
});

const pageById: Route = { path: `/wiki/v1/pages/${PAGE}`, body: ok(page()), repeat: true };

describe("wiki list/tree", () => {
  it("list with --search", async () => {
    const r = await runCli(["wiki", "list", "--search", "개발"], { home: home(), fetch: fakeFetch([wikis]) });
    expect(r.out).toMatch(new RegExp(`${W}\\s+개발팀\\s+public\\s+${PROJ}`));
    expect(r.out).not.toContain("@myid");
  });

  it("tree walks pages from home to --depth", async () => {
    const f = fakeFetch([
      wikis,
      { path: WP, body: ok([{ id: HOME, subject: "Home", root: true }], 1) },
      { path: new RegExp(`parentPageId=${HOME}`), body: ok([{ id: PAGE, subject: "회의록" }], 1) },
      { path: new RegExp(`parentPageId=${PAGE}`), body: ok([{ id: CHILD, subject: "2026" }], 1) },
    ]);
    const r = await runCli(["wiki", "tree", "개발팀", "--depth", "2"], { home: home(), fetch: f });
    expect(r.out).toBe(`Home  (${HOME})\n  회의록  (${PAGE})\n    2026  (${CHILD})\n`);
  });
});

describe("wiki page addressing", () => {
  it("page list defaults to children of home; wiki by project id", async () => {
    const f = fakeFetch([wikis, { path: new RegExp(`${WP}\\?parentPageId=${HOME}`), body: ok([{ id: PAGE, subject: "회의록" }], 1) }]);
    const r = await runCli(["wiki", "page", "list", "--wiki", PROJ], { home: home(), fetch: f });
    expect(r.out).toMatch(new RegExp(`${PAGE}\\s+회의록`));
  });

  it("get by id needs no --wiki; by /path resolves under home; by URL", async () => {
    const f = fakeFetch([
      pageById,
      wikis,
      { path: new RegExp(`parentPageId=${HOME}`), body: ok([{ id: PAGE, subject: "회의록" }], 1) },
      { path: `${WP}/${PAGE}`, body: ok(page()), repeat: true },
    ]);
    const h = home();
    expect((await runCli(["wiki", "page", "get", PAGE], { home: h, fetch: f })).out).toContain("old text");
    const p = await runCli(["wiki", "page", "get", "/회의록", "--wiki", "개발팀", "-o", "json"], { home: h, fetch: f });
    expect(JSON.parse(p.out).id).toBe(PAGE);
    const u = await runCli(["wiki", "page", "get", `https://acme.gov-dooray.com/wiki/${W}/${PAGE}`, "-o", "json"], { home: h, fetch: f });
    expect(JSON.parse(u.out).subject).toBe("회의록");
  });

  it("a path without --wiki is a usage error", async () => {
    expect((await runCli(["wiki", "page", "get", "/x"], { home: home() })).code).toBe(2);
  });
});

describe("wiki page create/update/replace", () => {
  it("create defaults the parent to home, sets referrers and attached wiki files", async () => {
    const src = join(tempHome(), "att.pdf");
    writeFileSync(src, "pdf");
    const f = fakeFetch([
      wikis,
      { path: "/common/v1/members/me", body: ok({ id: ME }) },
      { method: "POST", path: `/wiki/v1/wikis/${W}/files`, body: ok({ id: "a9", attachFileId: "a9", name: "att.pdf" }) },
      { method: "POST", path: WP, body: ok({ id: PAGE, wikiId: W, parentPageId: HOME }) },
    ]);
    const r = await runCli(
      ["wiki", "page", "create", "--wiki", "개발팀", "--subject", "새 페이지", "--body", "내용", "--referrer", "me", "--file", src],
      { home: home(), fetch: f },
    );
    expect(r.code).toBe(0);
    const upload = f.calls[2]!.body as FormData;
    expect([...upload.keys()]).toEqual(["type", "file"]);
    expect(f.calls[3]!.body).toEqual({
      parentPageId: HOME,
      subject: "새 페이지",
      body: { mimeType: "text/x-markdown", content: "내용" },
      referrers: [{ type: "member", member: { organizationMemberId: ME } }],
      attachFileIds: ["a9"],
    });
  });

  it("update uses the title/content endpoints so referrers are never cleared", async () => {
    const f = fakeFetch([
      pageById,
      { method: "PUT", path: `${WP}/${PAGE}/title`, body: ok(null) },
      { method: "PUT", path: `${WP}/${PAGE}/content`, body: ok(null) },
    ]);
    const r = await runCli(["wiki", "page", "update", PAGE, "--subject", "새 제목", "--body", "새 본문"], { home: home(), fetch: f });
    expect(r.code).toBe(0);
    expect(f.calls[1]!.body).toEqual({ subject: "새 제목" });
    expect(f.calls[2]!.body).toEqual({ body: { mimeType: "text/x-markdown", content: "새 본문" } });
    expect(f.calls.some((c) => c.url.pathname === `${WP}/${PAGE}` && c.method === "PUT")).toBe(false);
  });

  it("update with nothing to change is a usage error", async () => {
    expect((await runCli(["wiki", "page", "update", PAGE], { home: home(), fetch: fakeFetch([pageById]) })).code).toBe(2);
  });

  it("replace edits only the matched text", async () => {
    const f = fakeFetch([pageById, { path: `${WP}/${PAGE}`, body: ok(page()), repeat: true }, { method: "PUT", path: `${WP}/${PAGE}/content`, body: ok(null) }]);
    const h = home();
    const d = await runCli(["wiki", "page", "replace", PAGE, "--old", "old text", "--new", "new text", "--dry-run"], { home: h, fetch: f });
    expect(d.out).toBe("-old text\n+new text\n");
    await runCli(["wiki", "page", "replace", PAGE, "--old", "old text", "--new", "new text"], { home: h, fetch: f });
    expect(f.calls.at(-1)!.body).toEqual({ body: { mimeType: "text/x-markdown", content: "line one\nnew text\n" } });
  });
});

describe("wiki page move/delete/referrers/links", () => {
  it("move under a parent, first position, without children", async () => {
    const f = fakeFetch([pageById, { method: "POST", path: `${WP}/${PAGE}/move`, body: ok(null) }]);
    await runCli(["wiki", "page", "move", PAGE, "--parent", CHILD, "--first", "--no-children"], { home: home(), fetch: f });
    expect(f.calls[1]!.body).toEqual({ targetParentPageId: CHILD, withChildren: false, beforePageId: "0" });
  });

  it("move needs --parent; --first and --before conflict", async () => {
    expect((await runCli(["wiki", "page", "move", PAGE], { home: home() })).code).toBe(2);
    expect((await runCli(["wiki", "page", "move", PAGE, "--parent", CHILD, "--first", "--before", CHILD], { home: home() })).code).toBe(2);
  });

  it("delete asks, then deletes", async () => {
    expect((await runCli(["wiki", "page", "delete", PAGE], { home: home() })).code).toBe(2);
    const f = fakeFetch([pageById, { method: "DELETE", path: `${WP}/${PAGE}`, body: ok(null) }]);
    expect((await runCli(["wiki", "page", "delete", PAGE, "--yes"], { home: home(), fetch: f })).code).toBe(0);
  });

  it("referrers show and replace", async () => {
    const f = fakeFetch([
      pageById,
      { path: `${WP}/${PAGE}`, body: ok(page()) },
      { path: "/common/v1/members/me", body: ok({ id: ME }) },
      { method: "PUT", path: `${WP}/${PAGE}/referrers`, body: ok(null) },
    ]);
    const h = home();
    expect((await runCli(["wiki", "page", "referrers", PAGE], { home: h, fetch: f })).out).toContain(ME);
    await runCli(["wiki", "page", "referrers", PAGE, "--set", "me", "--yes"], { home: h, fetch: f });
    expect(f.calls.at(-1)!.body).toEqual({ referrers: [{ type: "member", member: { organizationMemberId: ME } }] });
  });

  it("shared links list", async () => {
    const f = fakeFetch([pageById, { path: `${WP}/${PAGE}/shared-links`, body: ok([{ id: "l1", sharedLink: "https://s/1", scope: "member", includeDescendants: true }], 1) }]);
    expect((await runCli(["wiki", "page", "links", PAGE], { home: home(), fetch: f })).out).toMatch(/l1\s+member\s+yes\s+https:\/\/s\/1/);
  });
});

describe("wiki page comments", () => {
  const C = `${WP}/${PAGE}/comments`;
  it("list/get/add/update/delete", async () => {
    const f = fakeFetch([
      pageById,
      { path: C, body: ok([{ id: "c1", createdAt: "2026-10-01T00:00:00Z", creator: { member: { organizationMemberId: ME, name: "김" } }, body: { content: "좋아요" } }], 1) },
      { path: `${C}/c1`, body: ok({ id: "c1", body: { content: "좋아요" } }) },
      { method: "POST", path: C, body: ok({ id: "c2" }) },
      { method: "PUT", path: `${C}/c2`, body: ok(null) },
      { method: "DELETE", path: `${C}/c2`, body: ok(null) },
    ]);
    const h = home();
    expect((await runCli(["wiki", "page", "comment", "list", PAGE], { home: h, fetch: f })).out).toMatch(/c1\s+2026-10-01T00:00:00Z\s+김\s+좋아요/);
    expect((await runCli(["wiki", "page", "comment", "get", PAGE, "c1"], { home: h, fetch: f })).out).toContain("좋아요");
    await runCli(["wiki", "page", "comment", "add", PAGE, "--body", "새 댓글"], { home: h, fetch: f });
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ body: { content: "새 댓글" } });
    await runCli(["wiki", "page", "comment", "edit", PAGE, "c2", "--body", "수정"], { home: h, fetch: f });
    expect(f.calls.find((c) => c.method === "PUT")!.body).toEqual({ body: { content: "수정" } });
    expect((await runCli(["wiki", "page", "comment", "delete", PAGE, "c2", "--yes"], { home: h, fetch: f })).code).toBe(0);
  });
});

describe("wiki page files and wiki files", () => {
  it("list (files + images), upload with type first, download, delete", async () => {
    const out = join(tempHome(), "o");
    const src = join(tempHome(), "img.png");
    writeFileSync(src, "png");
    const F = `${WP}/${PAGE}/files`;
    const f = fakeFetch([
      pageById,
      { path: `${WP}/${PAGE}`, body: ok(page()), repeat: true },
      { method: "POST", path: F, body: ok({ id: "f2", attachFileId: "a3", name: "img.png", type: "inline_image" }) },
      { method: "GET", path: `${F}/f1`, status: 307, raw: "", headers: { location: "https://file-api.gov-dooray.com/dl/f1" } },
      { path: "/dl/f1", raw: "PDF" },
      { method: "DELETE", path: `${F}/f1`, body: ok(null) },
    ]);
    const h = home();
    const l = await runCli(["wiki", "page", "file", "list", PAGE], { home: h, fetch: f });
    expect(l.out).toMatch(/f1\s+a1\s+a.pdf\s+3\s+general/);
    expect(l.out).toMatch(/i1\s+a2\s+p.png\s+4\s+inline_image/);
    const u = await runCli(["wiki", "page", "file", "upload", PAGE, src, "--type", "inline_image"], { home: h, fetch: f });
    expect(u.out).toContain("![img.png](/wikis/");
    const form = f.calls.find((c) => c.method === "POST")!.body as FormData;
    expect([...form.keys()]).toEqual(["type", "file"]);
    expect(form.get("type")).toBe("inline_image");
    await runCli(["wiki", "page", "file", "download-all", PAGE, "-O", out], { home: h, fetch: fakeFetch([
      pageById,
      { path: `${WP}/${PAGE}`, body: ok(page({ images: [] })) },
      { path: `${F}/f1`, raw: "PDF" },
    ]) });
    expect(readFileSync(join(out, "a.pdf"), "utf8")).toBe("PDF");
    expect((await runCli(["wiki", "page", "file", "delete", PAGE, "f1", "--yes"], { home: h, fetch: f })).code).toBe(0);
  });

  it("wiki-level upload and attach-file download", async () => {
    const src = join(tempHome(), "w.txt");
    writeFileSync(src, "w");
    const out = join(tempHome(), "w-out.txt");
    const f = fakeFetch([
      wikis,
      { method: "POST", path: `/wiki/v1/wikis/${W}/files`, body: ok({ id: "a7", attachFileId: "a7", name: "w.txt" }) },
      { path: `/wiki/v1/wikis/${W}/attachFiles/a7`, raw: "W" },
    ]);
    const h = home();
    expect((await runCli(["wiki", "file", "upload", "개발팀", src], { home: h, fetch: f })).out).toContain("a7");
    await runCli(["wiki", "file", "download", "개발팀", "a7", "-O", out], { home: h, fetch: f });
    expect(readFileSync(out, "utf8")).toBe("W");
  });
});
