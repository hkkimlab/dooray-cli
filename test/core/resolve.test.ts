import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Cache } from "../../src/core/cache.js";
import { Client } from "../../src/core/client.js";
import { DoorayError } from "../../src/core/errors.js";
import { isId, matchByName, parseDoorayUrl, resolveMember, resolveProject } from "../../src/core/resolve.js";
import { fakeFetch, ok, tempHome, type Route } from "../helpers.js";

const items = [
  { id: "1", name: "회의록" },
  { id: "2", name: "회의록-2025" },
  { id: "3", name: "Design" },
];
const opts = { kind: "project", name: (i: (typeof items)[number]) => i.name, id: (i: (typeof items)[number]) => i.id };

function thrown(fn: () => unknown): DoorayError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DoorayError) return e;
    throw e;
  }
  throw new Error("expected throw");
}

describe("isId", () => {
  it("15+ digits", () => {
    expect(isId("3036830023878922413")).toBe(true);
    expect(isId("12345")).toBe(false);
    expect(isId("abc")).toBe(false);
  });
});

describe("matchByName", () => {
  it("exact match wins over partial", () => {
    expect(matchByName(items, "회의록", opts).id).toBe("1");
  });
  it("case-insensitive unique partial match", () => {
    expect(matchByName(items, "desi", opts).id).toBe("3");
  });
  it("ambiguous partial lists candidates and is a usage error", () => {
    const e = thrown(() => matchByName(items, "회의", opts));
    expect(e.exit).toBe(2);
    expect(e.message).toContain("2 projects match '회의'");
    expect(e.message).toContain("- 회의록 (1)");
    expect(e.message).toContain("- 회의록-2025 (2)");
  });
  it("no match is not-found with samples", () => {
    const e = thrown(() => matchByName(items, "zzz", opts));
    expect(e.exit).toBe(4);
    expect(e.message).toContain("no project matches 'zzz'");
    expect(e.message).toContain("Design");
  });
});

describe("parseDoorayUrl", () => {
  it.each([
    ["https://acme.gov-dooray.com/task/to/3000000000000000001", { kind: "post", postId: "3000000000000000001" }],
    [
      "https://nhn.dooray.com/task/3000000000000000002/3000000000000000001?x=1",
      { kind: "post", projectId: "3000000000000000002", postId: "3000000000000000001" },
    ],
    ["https://a.dooray.co.kr/project/tasks/3000000000000000001#c", { kind: "post", postId: "3000000000000000001" }],
    [
      "https://acme.gov-dooray.com/project/3000000000000000002/3000000000000000001",
      { kind: "post", projectId: "3000000000000000002", postId: "3000000000000000001" },
    ],
    [
      "https://acme.gov-dooray.com/wiki/3000000000000000003/3000000000000000004",
      { kind: "wiki", wikiId: "3000000000000000003", pageId: "3000000000000000004" },
    ],
    [
      "https://acme.gov-dooray.com/mail/systems/inbox/3000000000000000005",
      { kind: "mail", mailbox: "inbox", mailId: "3000000000000000005" },
    ],
    ["https://x.dooray.com/mail/folders/1/3000000000000000005", { kind: "mail", mailbox: null, mailId: "3000000000000000005" }],
  ])("%s", (url, expected) => {
    expect(parseDoorayUrl(url)).toEqual(expected);
  });

  it("rejects non-dooray hosts and junk", () => {
    expect(parseDoorayUrl("https://evil.com/task/to/3000000000000000001")).toBeNull();
    expect(parseDoorayUrl("https://dooray.com.evil.com/task/to/3000000000000000001")).toBeNull();
    expect(parseDoorayUrl("not a url")).toBeNull();
  });
});

function ctx(routes: Route[]) {
  const f = fakeFetch(routes);
  const client = new Client({ token: "t", baseUrl: "https://api", fileUrl: "https://file", fetch: f, sleep: async () => {} });
  return { client, cache: new Cache(join(tempHome(), "c")), f };
}

const PROJECTS = [
  { id: "3000000000000000010", code: "aadc-team", wiki: { id: "w1" }, drive: { id: "d1" } },
  { id: "3000000000000000011", code: "aadc-lab" },
];

describe("resolveProject", () => {
  it("passes ids through without a request", async () => {
    const { client, cache, f } = ctx([]);
    expect((await resolveProject(client, cache, "3000000000000000099")).id).toBe("3000000000000000099");
    expect(f.calls).toHaveLength(0);
  });

  it("matches by code from my projects, cached", async () => {
    const { client, cache, f } = ctx([{ path: "/project/v1/projects", body: ok(PROJECTS, 2) }]);
    expect(await resolveProject(client, cache, "aadc-team")).toMatchObject({ id: "3000000000000000010", wikiId: "w1", driveId: "d1" });
    expect((await resolveProject(client, cache, "aadc-lab")).id).toBe("3000000000000000011");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url.searchParams.get("member")).toBe("me");
  });

  it("falls back to the private project list", async () => {
    const { client, cache, f } = ctx([
      { path: /^\/project\/v1\/projects\?(?!.*type=private)/, body: ok(PROJECTS, 2) },
      { path: /type=private/, body: ok([{ id: "3000000000000000012", code: "secret" }], 1) },
    ]);
    expect((await resolveProject(client, cache, "secret")).id).toBe("3000000000000000012");
    expect(f.calls).toHaveLength(2);
  });

  it("ambiguous code stops with candidates", async () => {
    const { client, cache } = ctx([{ path: "/project/v1/projects", body: ok(PROJECTS, 2) }]);
    await expect(resolveProject(client, cache, "aadc")).rejects.toThrow(/2 projects match/);
  });
});

describe("resolveMember", () => {
  it("ids pass through", async () => {
    const { client } = ctx([]);
    expect(await resolveMember(client, "3000000000000000020")).toBe("3000000000000000020");
  });
  it("'me' resolves via members/me", async () => {
    const { client } = ctx([{ path: "/common/v1/members/me", body: ok({ id: "3000000000000000021" }) }]);
    expect(await resolveMember(client, "me")).toBe("3000000000000000021");
  });
  it("email searches externalEmailAddresses", async () => {
    const { client, f } = ctx([
      { path: "/common/v1/members", body: ok([{ id: "3000000000000000022", name: "김", externalEmailAddress: "k@example.com" }], 1) },
    ]);
    expect(await resolveMember(client, "k@example.com")).toBe("3000000000000000022");
    expect(f.calls[0]!.url.searchParams.get("externalEmailAddresses")).toBe("k@example.com");
  });
  it("name searches by name and stops on ambiguity", async () => {
    const { client } = ctx([
      {
        path: "/common/v1/members",
        body: ok(
          [
            { id: "3000000000000000023", name: "김철수", userCode: "a" },
            { id: "3000000000000000024", name: "김철수", userCode: "b" },
          ],
          2,
        ),
      },
    ]);
    await expect(resolveMember(client, "김철수")).rejects.toThrow(/2 members match '김철수'/);
  });
  it("unique exact name", async () => {
    const { client, f } = ctx([
      { path: "/common/v1/members", body: ok([{ id: "3000000000000000025", name: "홍길동" }, { id: "3000000000000000026", name: "홍길동2" }], 2) },
    ]);
    expect(await resolveMember(client, "홍길동")).toBe("3000000000000000025");
    expect(f.calls[0]!.url.searchParams.get("name")).toBe("홍길동");
  });
});
