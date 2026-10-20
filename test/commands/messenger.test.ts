import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetch, GOV_CONFIG, logsPage, msgs, ok, runCli, tempHome, type Route } from "../helpers.js";

const CH = "3000000000000001101";
const DM = "3000000000000001102";
const ME = "3000000000000001103";
const OTHER = "3000000000000001104";
const LOG = "3000000000000001105";
const M = "/messenger/v1/channels";

function home(): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG);
  return h;
}

const channels: Route = {
  path: M,
  method: "GET",
  body: ok(
    [
      { id: CH, title: "개발방", type: "private", status: "normal", displayed: true, updatedAt: "2026-10-19T00:00:00+09:00" },
      { id: DM, title: null, type: "direct", status: "normal", displayed: true, updatedAt: "2026-10-18T00:00:00+09:00" },
      { id: "3000000000000001199", title: "보관방", type: "private", status: "archived", displayed: true, updatedAt: "2026-01-01T00:00:00+09:00" },
      { id: "3000000000000001198", title: "숨김", type: "direct", status: "normal", displayed: false, updatedAt: "2026-01-02T00:00:00+09:00" },
    ],
    4,
  ),
  repeat: true,
};

describe("messenger send", () => {
  it("--to by name sends a direct message", async () => {
    const f = fakeFetch([
      { path: "/common/v1/members", body: ok([{ id: OTHER, name: "홍길동" }], 1) },
      { method: "POST", path: `${M}/direct-send`, body: ok({ id: LOG }) },
    ]);
    const r = await runCli(["messenger", "send", "안녕하세요", "--to", "홍길동"], { home: home(), fetch: f });
    expect(r.code).toBe(0);
    expect(f.calls[1]!.body).toEqual({ text: "안녕하세요", organizationMemberId: OTHER });
  });

  it("--channel by title posts to logs; text from stdin", async () => {
    const f = fakeFetch([channels, { method: "POST", path: `${M}/${CH}/logs`, body: ok({ id: LOG, channelId: CH }) }]);
    const r = await runCli(["messenger", "send", "--channel", "개발", "--stdin"], { home: home(), fetch: f, stdin: "공지\n" });
    expect(r.code).toBe(0);
    expect(f.calls[1]!.body).toEqual({ text: "공지" });
  });

  it("--hook posts to the configured URL without the API token", async () => {
    const f = fakeFetch([{ method: "POST", path: "/services/1/2/abc", raw: "" }]);
    const r = await runCli(["messenger", "send", "배포 완료", "--hook", "alerts", "--bot-name", "CI"], { home: home(), fetch: f });
    expect(r.code).toBe(0);
    expect(f.calls[0]!.url.host).toBe("hook.dooray.com");
    expect(f.calls[0]!.body).toEqual({ botName: "CI", text: "배포 완료" });
    expect(f.calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("unknown hook name, missing target and empty text are usage errors", async () => {
    expect((await runCli(["messenger", "send", "x", "--hook", "nope"], { home: home() })).code).toBe(2);
    expect((await runCli(["messenger", "send", "x"], { home: home() })).code).toBe(2);
    expect((await runCli(["messenger", "send", "--to", "me"], { home: home() })).code).toBe(2);
  });

  it("a failing hook is an API error", async () => {
    const f = fakeFetch([{ method: "POST", path: "/services/1/2/abc", status: 400, raw: "bad" }]);
    const r = await runCli(["messenger", "send", "x", "--hook", "alerts"], { home: home(), fetch: f });
    expect([r.code, r.err.trim()]).toEqual([5, "error: hook send failed 400"]);
  });
});

describe("messenger channels", () => {
  it("list hides archived/hidden unless --all; filters by type and search", async () => {
    const f = fakeFetch([channels]);
    const h = home();
    const r = await runCli(["messenger", "channel", "list"], { home: h, fetch: f });
    expect(r.out).toContain("개발방");
    expect(r.out).not.toContain("보관방");
    expect(r.out).not.toContain("숨김");
    const all = await runCli(["messenger", "channel", "list", "--all", "--type", "private"], { home: h, fetch: f });
    expect(all.out).toContain("보관방");
    expect(all.out).not.toContain(DM);
    const s = await runCli(["messenger", "channel", "list", "--search", "개발"], { home: h, fetch: f });
    expect(s.out).toMatch(new RegExp(`${CH}\\s+개발방\\s+private`));
  });

  it("create uses idType=member-id and member ids", async () => {
    const f = fakeFetch([
      { path: "/common/v1/members/me", body: ok({ id: ME }) },
      { method: "POST", path: M, body: ok({ id: CH }) },
    ]);
    await runCli(["messenger", "channel", "create", "--title", "새 방", "--member", "me", "--member", OTHER], { home: home(), fetch: f });
    expect(f.calls[1]!.url.searchParams.get("idType")).toBe("member-id");
    expect(f.calls[1]!.body).toEqual({ type: "private", title: "새 방", memberIds: [ME, OTHER], capacity: "100" });
  });

  it("join/leave use the documented members/join|leave with memberIds (default: me)", async () => {
    const f = fakeFetch([
      channels,
      { path: "/common/v1/members/me", body: ok({ id: ME }), repeat: true },
      { method: "POST", path: `${M}/${CH}/members/join`, body: ok(null) },
      { method: "POST", path: `${M}/${CH}/members/leave`, body: ok(null) },
    ]);
    const h = home();
    await runCli(["messenger", "channel", "join", CH], { home: h, fetch: f });
    expect(f.calls.find((c) => c.url.pathname.endsWith("/join"))!.body).toEqual({ memberIds: [ME] });
    expect((await runCli(["messenger", "channel", "leave", CH], { home: h })).code).toBe(2);
    await runCli(["messenger", "channel", "leave", CH, "--yes"], { home: h, fetch: f });
    expect(f.calls.find((c) => c.url.pathname.endsWith("/leave"))!.body).toEqual({ memberIds: [ME] });
  });
});

describe("messenger logs/thread/reply/edit/delete", () => {
  it("logs prints oldest-first with sender names", async () => {
    const f = fakeFetch([
      channels,
      {
        path: `${M}/${CH}/logs`,
        body: ok([
          { id: "2", type: "NORMAL", sentAt: "2026-10-19T11:00:00+09:00", sender: { member: { organizationMemberId: OTHER } }, text: "두번째" },
          { id: "1", type: "NORMAL", sentAt: "2026-10-19T10:00:00+09:00", sender: { member: { organizationMemberId: ME } }, text: "첫번째" },
        ]),
      },
      { path: `/common/v1/members/${OTHER}`, body: ok({ id: OTHER, name: "홍길동" }) },
      { path: `/common/v1/members/${ME}`, body: ok({ id: ME, name: "나사용" }) },
    ]);
    const r = await runCli(["messenger", "logs", "개발방", "-n", "2"], { home: home(), fetch: f });
    expect(f.calls[1]!.url.searchParams.get("size")).toBe("2");
    expect(r.out).toMatch(/1\s+2026-10-19T10:00:00\+09:00\s+나사용\s+첫번째[\s\S]*2\s+2026-10-19T11:00:00\+09:00\s+홍길동\s+두번째/);
  });


  it("thread on a new message, and on an existing message (--log)", async () => {
    const f = fakeFetch([
      { method: "POST", path: `${M}/${CH}/threads/create-and-send`, body: ok({ id: "t1", channelId: "3000000000000001150" }) },
      { method: "POST", path: `${M}/${CH}/logs/${LOG}/threads/create-and-send`, body: ok({ id: "t2", channelId: "3000000000000001151" }) },
    ]);
    const h = home();
    const a = await runCli(["messenger", "thread", CH, "본문", "--thread-text", "글타래"], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ text: "본문", threadText: "글타래" });
    expect(a.out).toContain("3000000000000001150");
    await runCli(["messenger", "thread", CH, "답", "--log", LOG], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ text: "답" });
  });

  it("reply, edit and delete a message", async () => {
    const f = fakeFetch([
      { method: "POST", path: `${M}/${CH}/logs/${LOG}/reply`, body: ok({ id: "r1", channelId: CH }) },
      { method: "PUT", path: `${M}/${CH}/logs/${LOG}`, body: ok(null) },
      { method: "DELETE", path: `${M}/${CH}/logs/${LOG}`, body: ok(null) },
    ]);
    const h = home();
    await runCli(["messenger", "reply", CH, LOG, "답장"], { home: h, fetch: f });
    expect(f.calls[0]!.body).toEqual({ text: "답장" });
    await runCli(["messenger", "edit", CH, LOG, "수정"], { home: h, fetch: f });
    expect(f.calls[1]!.body).toEqual({ text: "수정" });
    expect((await runCli(["messenger", "delete", CH, LOG], { home: h })).code).toBe(2);
    expect((await runCli(["messenger", "delete", CH, LOG, "--yes"], { home: h, fetch: f })).code).toBe(0);
  });
});

describe("messenger logs paging, range and --count-only", () => {
  const LOGS = `${M}/${CH}/logs`;
  const json = async (args: string[], routes: Route[]) => {
    const f = fakeFetch(routes);
    const r = await runCli(["messenger", "logs", CH, "-o", "json", ...args], { home: home(), fetch: f });
    return { r, f, data: r.code === 0 ? JSON.parse(r.out) : undefined };
  };
  const seqOf = (ls: { seq: number }[]) => ls.map((l) => l.seq);
  const sizes = (f: ReturnType<typeof fakeFetch>) => f.calls.map((c) => [c.url.searchParams.get("size"), c.url.searchParams.get("logId")]);

  it("-n 20 (default) is still one request of size 20, oldest first", async () => {
    const { f, data } = await json([], [{ path: LOGS, body: logsPage(msgs(100, 81), true) }]);
    expect(sizes(f)).toEqual([["20", null]]);
    expect(seqOf(data)).toEqual(seqOf(msgs(100, 81)).reverse());
  });

  it("-n 1500 pages with logId; progress goes to stderr (hidden by --quiet), stdout stays clean", async () => {
    const routes = (): Route[] => [
      { path: LOGS, body: logsPage(msgs(2000, 1001), true) },
      { path: LOGS, body: logsPage(msgs(1000, 501), true) },
    ];
    const { r, f, data } = await json(["-n", "1500"], routes());
    expect(sizes(f)).toEqual([["1000", null], ["500", "L1001"]]);
    expect([data.length, data[0].seq, data.at(-1).seq]).toEqual([1500, 501, 2000]);
    expect(r.err).toMatch(/1500 messages, oldest 2026-09-30T23:21:00/);
    expect((await json(["-n", "1500", "--quiet"], routes())).r.err).toBe("");
  });

  it("--all walks back to the first message", async () => {
    const { f, data } = await json(["--all"], [
      { path: LOGS, body: logsPage(msgs(1030, 31), true) },
      { path: LOGS, body: logsPage(msgs(30, 1), false) },
    ]);
    expect(sizes(f)).toEqual([["1000", null], ["1000", "L31"]]);
    expect(data).toHaveLength(1030);
  });

  it("usage errors: -n with --all, bad -n, since after until, bad dates, -n with --count-only", async () => {
    const code = async (...a: string[]) => (await runCli(["messenger", "logs", CH, ...a], { home: home() })).code;
    expect(await code("-n", "5", "--all")).toBe(2);
    expect(await code("-n", "0")).toBe(2);
    expect(await code("-n", "1.5")).toBe(2);
    expect(await code("--since", "2026-10-02", "--until", "2026-10-01")).toBe(2);
    expect(await code("--since", "yesterday")).toBe(2);
    expect(await code("--count-only", "-n", "5")).toBe(2);
  });

  it("--since/--until include both ends; a date-only --until includes the whole day", async () => {
    // seq 1439 = 2026-10-01 23:59 KST, seq 1440 = 2026-10-02 00:00 KST
    const { f, data } = await json(["--since", "2026-10-01 23:58", "--until", "2026-10-01"], [
      { path: LOGS, body: logsPage(msgs(1445, 1430), true) },
    ]);
    expect(seqOf(data)).toEqual([1438, 1439]);
    expect(sizes(f)).toEqual([["1000", null]]);
  });

  it("--until alone drops newer messages and reads to the start; -n keeps the newest n in range", async () => {
    const until = ["--until", "2026-10-01T00:07:00+09:00"];
    expect(seqOf((await json(until, [{ path: LOGS, body: logsPage(msgs(10, 1), false) }])).data)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(seqOf((await json([...until, "-n", "2"], [{ path: LOGS, body: logsPage(msgs(10, 1), false) }])).data)).toEqual([6, 7]);
  });

  it("--count-only alone: one size=1 request, the latest seq as an upper bound", async () => {
    const { f, data } = await json(["--count-only"], [{ path: LOGS, body: logsPage(msgs(2054, 2054), true) }]);
    expect(sizes(f)).toEqual([["1", null]]);
    expect(data).toEqual({ channelId: CH, latestSeq: 2054, approximate: true });
    const t = await runCli(["messenger", "logs", CH, "--count-only"], { home: home(), fetch: fakeFetch([{ path: LOGS, body: logsPage(msgs(2054, 2054), true) }]) });
    expect(t.out).toMatch(/CHANNEL_ID\s+LATEST_SEQ\s+COUNT\n3000000000000001101\s+2054\s+<= 2054/);
  });

  it("--count-only --all fetches everything and counts by type", async () => {
    const { data } = await json(["--count-only", "--all"], [
      { path: LOGS, body: logsPage([...msgs(5, 4, "FILE"), ...msgs(3, 2)], true) },
      { path: LOGS, body: logsPage(msgs(1, 1, "SYSTEM"), false) },
    ]);
    expect(data).toEqual({
      channelId: CH,
      latestSeq: 5,
      count: 5,
      byType: { FILE: 2, NORMAL: 2, SYSTEM: 1 },
      oldest: msgs(1, 1)[0]!.sentAt,
      newest: msgs(5, 5)[0]!.sentAt,
    });
  });

  it("--count-only with a range counts only the range; csv has the same columns", async () => {
    const f = fakeFetch([{ path: LOGS, body: logsPage(msgs(10, 1), false) }]);
    const r = await runCli(["messenger", "logs", CH, "--count-only", "--until", "2026-10-01T00:07:00+09:00", "-o", "csv"], { home: home(), fetch: f });
    expect(r.out.split("\n")[0]).toBe("CHANNEL_ID,LATEST_SEQ,COUNT,OLDEST,NEWEST,BY_TYPE");
    expect(r.out.split("\n")[1]).toMatch(/^3000000000000001101,10,7,.*,NORMAL=7$/);
  });

  it("table and csv output carry a SEQ column", async () => {
    const f = fakeFetch([{ path: LOGS, body: logsPage(msgs(2, 1), false) }]);
    const r = await runCli(["messenger", "logs", CH, "-n", "2", "-o", "csv"], { home: home(), fetch: f });
    expect(r.out.split("\n").slice(0, 2)).toEqual(["ID,SEQ,SENT,SENDER,TEXT", `L1,1,${msgs(1, 1)[0]!.sentAt},NORMAL,`]);
  });
});
