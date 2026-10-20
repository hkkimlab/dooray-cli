import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetch, GOV_CONFIG, ok, runCli, tempHome } from "../helpers.js";

const CAL = "3000000000000000101";
const CAL2 = "3000000000000000102";
const EV = "3000000000000000201";
const MEMBER = "3000000000000000301";

function home(): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG);
  return h;
}

const CALS = ok(
  [
    { id: CAL, name: "업무", type: "private", me: { default: true, role: "owner" } },
    { id: CAL2, name: "팀", type: "project", me: { default: false, role: "view" } },
  ],
  2,
);

const event = (id: string, startedAt = "2026-10-20T10:00:00+09:00") => ({
  id,
  subject: "회의",
  startedAt,
  endedAt: "2026-10-20T11:00:00+09:00",
  calendar: { id: CAL, name: "업무" },
});

describe("calendar list/get", () => {
  it("lists calendars with type and default", async () => {
    const r = await runCli(["calendar", "list"], { home: home(), fetch: fakeFetch([{ path: "/calendar/v1/calendars", body: CALS }]) });
    expect(r.out).toMatch(/ID\s+NAME\s+TYPE\s+DEFAULT/);
    expect(r.out).toMatch(new RegExp(`${CAL}\\s+업무\\s+private\\s+\\*`));
  });

  it("get resolves a calendar by name", async () => {
    const f = fakeFetch([
      { path: "/calendar/v1/calendars", body: CALS },
      { path: `/calendar/v1/calendars/${CAL2}`, body: ok({ id: CAL2, name: "팀", type: "project" }) },
    ]);
    const r = await runCli(["calendar", "get", "팀", "-o", "json"], { home: home(), fetch: f });
    expect(JSON.parse(r.out).id).toBe(CAL2);
  });
});

describe("calendar create/delete/members", () => {
  it("create a private calendar", async () => {
    const f = fakeFetch([{ method: "POST", path: "/calendar/v1/calendars", body: ok({ id: CAL }) }]);
    await runCli(["calendar", "create", "개인업무", "--color", "ff0000"], { home: home(), fetch: f });
    expect(f.calls[0]!.body).toEqual({ name: "개인업무", type: "private", me: { color: "ff0000" } });
  });

  it("create a subscription calendar", async () => {
    const f = fakeFetch([{ method: "POST", path: "/calendar/v1/calendars", body: ok({ id: CAL }) }]);
    await runCli(["calendar", "create", "공휴일", "--subscription-url", "https://x/ics"], { home: home(), fetch: f });
    expect(f.calls[0]!.body).toEqual({ name: "공휴일", type: "subscription", calendarUrl: "https://x/ics" });
  });

  it("delete requires --yes", async () => {
    expect((await runCli(["calendar", "delete", CAL], { home: home() })).code).toBe(2);
    const f = fakeFetch([{ method: "DELETE", path: `/calendar/v1/calendars/${CAL}`, body: ok(null) }]);
    expect((await runCli(["calendar", "delete", CAL, "--yes"], { home: home(), fetch: f })).code).toBe(0);
  });

  it("members lists, and --member/--group replaces the whole list", async () => {
    const f = fakeFetch([
      {
        path: `/calendar/v1/calendars/${CAL}`,
        body: ok({ id: CAL, calendarMemberList: [{ type: "member", member: { organizationMemberId: MEMBER }, role: "view" }] }),
      },
      { path: "/common/v1/members/me", body: ok({ id: MEMBER }) },
      { method: "PUT", path: `/calendar/v1/calendars/${CAL}/members`, body: ok(null) },
    ]);
    const h = home();
    const l = await runCli(["calendar", "members", CAL], { home: h, fetch: f });
    expect(l.out).toMatch(new RegExp(`member\\s+${MEMBER}\\s+view`));
    const s = await runCli(["calendar", "members", CAL, "--member", "me=read_write", "--group", "team@example.com=view", "--yes"], { home: h, fetch: f });
    expect(s.code).toBe(0);
    expect(f.calls[2]!.body).toEqual({
      calendarMemberList: [
        { type: "member", member: { organizationMemberId: MEMBER }, role: "read_write" },
        { type: "distributionList", distributionList: { emailAddress: "team@example.com" }, role: "view" },
      ],
    });
  });

  it("members rejects a bad role", async () => {
    const r = await runCli(["calendar", "members", CAL, "--member", "me=boss", "--yes"], { home: home() });
    expect(r.code).toBe(2);
  });
});

describe("calendar event list", () => {
  it("defaults to now..+7d, accepts calendar names and filters", async () => {
    const f = fakeFetch([
      { path: "/calendar/v1/calendars", body: CALS },
      { path: "/calendar/v1/calendars/*/events", body: ok([event(EV)], 1) },
    ]);
    const r = await runCli(["calendar", "event", "list", "--calendar", "업무", "--post-type", "toMe", "--category", "general"], {
      home: home(),
      fetch: f,
    });
    expect(r.out).toMatch(/ID\s+SUBJECT\s+START\s+END\s+CALENDAR/);
    const q = f.calls[1]!.url.searchParams;
    expect(q.get("calendars")).toBe(CAL);
    expect(q.get("postType")).toBe("toMe");
    expect(q.get("category")).toBe("general");
    const days = (Date.parse(q.get("timeMax")!) - Date.parse(q.get("timeMin")!)) / 86_400_000;
    expect(days).toBeCloseTo(7, 1);
  });

  it("a date-only --to is inclusive (next day 00:00 KST, exclusive)", async () => {
    const f = fakeFetch([{ path: "/calendar/v1/calendars/*/events", body: ok([], 0) }]);
    await runCli(["calendar", "event", "list", "--from", "2026-10-20", "--to", "2026-10-20"], { home: home(), fetch: f });
    const q = f.calls[0]!.url.searchParams;
    expect([q.get("timeMin"), q.get("timeMax")]).toEqual(["2026-10-20T00:00:00+09:00", "2026-10-21T00:00:00+09:00"]);
  });

  it("splits ranges longer than 50 days and de-duplicates", async () => {
    const f = fakeFetch([
      { path: "/calendar/v1/calendars/*/events", body: ok([event("a"), event("b")], 2) },
      { path: "/calendar/v1/calendars/*/events", body: ok([event("b"), event("c", "2026-12-01T10:00:00+09:00")], 2) },
    ]);
    const r = await runCli(["calendar", "event", "list", "--from", "2026-10-01", "--to", "2026-12-31", "-o", "json"], { home: home(), fetch: f });
    expect(f.calls).toHaveLength(2);
    expect(JSON.parse(r.out).map((e: { id: string }) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects --to before --from", async () => {
    const r = await runCli(["calendar", "event", "list", "--from", "2026-10-20", "--to", "2026-10-01"], { home: home() });
    expect(r.code).toBe(2);
  });
});

describe("calendar event get/create/update/delete", () => {
  it("get uses the real calendar id", async () => {
    const f = fakeFetch([{ path: `/calendar/v1/calendars/${CAL}/events/${EV}`, body: ok(event(EV)) }]);
    const r = await runCli(["calendar", "event", "get", EV, "--calendar", CAL], { home: home(), fetch: f });
    expect(r.code).toBe(0);
  });

  it("create defaults to the default calendar and always sends a body", async () => {
    const f = fakeFetch([
      { path: "/calendar/v1/calendars", body: CALS },
      { path: "/common/v1/members", body: ok([{ id: MEMBER, name: "홍길동" }], 1) },
      { method: "POST", path: `/calendar/v1/calendars/${CAL}/events`, body: ok({ id: EV }) },
    ]);
    const r = await runCli(
      [
        "calendar", "event", "create", "--subject", "회의", "--from", "2026-10-20 14:00", "--to", "2026-10-20 15:00",
        "--attendee", "홍길동", "--email-attendee", "ext@example.com", "--location", "4층", "--alarm", "10", "--private",
      ],
      { home: home(), fetch: f },
    );
    expect(r.code).toBe(0);
    expect(f.calls[2]!.body).toEqual({
      subject: "회의",
      body: { mimeType: "text/html", content: "" },
      startedAt: "2026-10-20T14:00:00+09:00",
      endedAt: "2026-10-20T15:00:00+09:00",
      wholeDayFlag: false,
      location: "4층",
      users: {
        to: [
          { type: "member", member: { organizationMemberId: MEMBER } },
          { type: "emailUser", emailUser: { emailAddress: "ext@example.com", name: "" } },
        ],
      },
      personalSettings: { alarms: [{ action: "mail", trigger: "TRIGGER:-PT10M" }], class: "private" },
    });
    expect(r.out).toContain(EV);
  });

  it("create a whole-day recurring event", async () => {
    const f = fakeFetch([{ method: "POST", path: `/calendar/v1/calendars/${CAL}/events`, body: ok({ id: EV }) }]);
    await runCli(
      ["calendar", "event", "create", "--calendar", CAL, "--subject", "휴가", "--from", "2026-10-20", "--to", "2026-10-21", "--whole-day",
        "--repeat", "weekly", "--interval", "2", "--until", "2026-12-31", "--byday", "MO"],
      { home: home(), fetch: f },
    );
    expect(f.calls[0]!.body).toMatchObject({
      startedAt: "2026-10-20+09:00",
      endedAt: "2026-10-21+09:00",
      wholeDayFlag: true,
      recurrenceRule: { frequency: "weekly", interval: 2, until: "2026-12-31T23:59:59+09:00", byday: "MO", timezoneName: "Asia/Seoul" },
    });
  });

  it("create requires subject, from, to", async () => {
    expect((await runCli(["calendar", "event", "create", "--calendar", CAL, "--subject", "x"], { home: home() })).code).toBe(2);
  });

  it("update sends only given fields", async () => {
    const f = fakeFetch([{ method: "PUT", path: `/calendar/v1/calendars/${CAL}/events/${EV}`, body: ok(null) }]);
    await runCli(["calendar", "event", "update", EV, "--calendar", CAL, "--subject", "변경"], { home: home(), fetch: f });
    expect(f.calls[0]!.body).toEqual({ subject: "변경" });
  });

  it("delete posts deleteType and asks first", async () => {
    expect((await runCli(["calendar", "event", "delete", EV, "--calendar", CAL], { home: home() })).code).toBe(2);
    const f = fakeFetch([{ method: "POST", path: `/calendar/v1/calendars/${CAL}/events/${EV}/delete`, body: ok(null) }]);
    await runCli(["calendar", "event", "delete", EV, "--calendar", CAL, "--delete-type", "whole", "--yes"], { home: home(), fetch: f });
    expect(f.calls[0]!.body).toEqual({ deleteType: "whole" });
  });

  it("rejects an unknown --delete-type", async () => {
    expect((await runCli(["calendar", "event", "delete", EV, "--calendar", CAL, "--delete-type", "all", "--yes"], { home: home() })).code).toBe(2);
  });
});

describe("calendar busy", () => {
  it("fetches busy hours for members", async () => {
    const f = fakeFetch([
      { path: "/common/v1/members/me", body: ok({ id: MEMBER }) },
      {
        method: "POST",
        path: "/calendar/v1/fetch-busy-hours",
        body: ok([{ member: { id: MEMBER, name: "홍길동" }, busyHours: [{ startedAt: "2026-10-20T10:00:00+09:00", endedAt: "2026-10-20T11:00:00+09:00" }] }]),
      },
    ]);
    const r = await runCli(["calendar", "busy", "me", "--from", "2026-10-20", "--to", "2026-10-21"], { home: home(), fetch: f });
    expect(f.calls[1]!.body).toEqual({
      organizationMemberIds: [MEMBER],
      beginDateTime: "2026-10-20T00:00:00+09:00",
      endDateTime: "2026-10-22T00:00:00+09:00",
    });
    expect(r.out).toMatch(/홍길동\s+2026-10-20T10:00:00\+09:00\s+2026-10-20T11:00:00\+09:00/);
  });
});
