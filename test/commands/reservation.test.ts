import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetch, fail, GOV_CONFIG, ok, runCli, tempHome } from "../helpers.js";

const CATEGORY = "3000000000000000401";
const RES = "3000000000000000402";
const RV = "3000000000000000403";

function home(): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG);
  return h;
}

const CATS = ok([{ id: CATEGORY, type: "meetingRoom", name: "연구동 회의실" }], 1);
const reservation = { id: RV, resource: { id: RES, name: "L7234" }, subject: "회의", startedAt: "2026-10-20T10:00:00+09:00", endedAt: "2026-10-20T11:00:00+09:00" };

describe("reservation resources", () => {
  it("resource list prints categories (Go behaviour)", async () => {
    const r = await runCli(["reservation", "resource", "list"], { home: home(), fetch: fakeFetch([{ path: "/reservation/v1/resource-categories", body: CATS }]) });
    expect(r.out).toMatch(new RegExp(`${CATEGORY}\\s+meetingRoom\\s+연구동 회의실`));
  });

  it("resource reservable takes a category name", async () => {
    const f = fakeFetch([
      { path: "/reservation/v1/resource-categories", body: CATS },
      { path: "/reservation/v1/reservable-resources", body: ok([{ id: RES, name: "L7234", use: true }], 1) },
    ]);
    const r = await runCli(["reservation", "resource", "reservable", "--category", "연구동"], { home: home(), fetch: f });
    expect(f.calls[1]!.url.searchParams.get("resourceCategoryId")).toBe(CATEGORY);
    expect(r.out).toMatch(new RegExp(`${RES}\\s+L7234\\s+yes`));
  });

  it("resource all surfaces the manager-permission error", async () => {
    const f = fakeFetch([{ path: "/reservation/v1/resources", body: { header: { resultMessage: "You do not have the resource reservation manager permission." } } }]);
    const r = await runCli(["reservation", "resource", "all"], { home: home(), fetch: f });
    expect(r.code).toBe(5);
    expect(r.err).toContain("manager permission");
  });

  it("resource get shows one resource", async () => {
    const f = fakeFetch([{ path: `/reservation/v1/resources/${RES}`, body: ok({ id: RES, name: "L7234", use: true, description: "7층" }) }]);
    const r = await runCli(["reservation", "resource", "get", RES, "-o", "json"], { home: home(), fetch: f });
    expect(JSON.parse(r.out).description).toBe("7층");
  });
});

describe("reservation list/get", () => {
  it("lists with time range and resource filter", async () => {
    const f = fakeFetch([{ path: "/reservation/v1/resource-reservations", body: ok([reservation], 1) }]);
    const r = await runCli(["reservation", "list", "--resource", RES, "--from", "2026-10-20", "--to", "2026-10-21"], { home: home(), fetch: f });
    const q = f.calls[0]!.url.searchParams;
    expect(q.get("resourceIds")).toBe(RES);
    expect(q.get("timeMin")).toBe("2026-10-20T00:00:00+09:00");
    expect(q.get("timeMax")).toBe("2026-10-22T00:00:00+09:00");
    expect(r.out).toMatch(/ID\s+RESOURCE\s+SUBJECT\s+START\s+END/);
  });

  it("get by id (recurring occurrence ids pass through)", async () => {
    const id = `${RV}-20261020T010000Z`;
    const f = fakeFetch([{ path: `/reservation/v1/resource-reservations/${id}`, body: ok(reservation) }]);
    expect((await runCli(["reservation", "get", id], { home: home(), fetch: f })).code).toBe(0);
  });
});

describe("reservation create/update/cancel", () => {
  it("create sends the documented body (no users)", async () => {
    const f = fakeFetch([{ method: "POST", path: "/reservation/v1/resource-reservations", body: ok({ id: RV, masterResourceReservationId: RV }) }]);
    const r = await runCli(
      ["reservation", "create", "--resource", RES, "--subject", "회의", "--from", "2026-10-20 10:00", "--to", "2026-10-20 11:00", "--class", "private", "--alarm", "10"],
      { home: home(), fetch: f },
    );
    expect(r.code).toBe(0);
    expect(f.calls[0]!.body).toEqual({
      resourceId: RES,
      subject: "회의",
      startedAt: "2026-10-20T10:00:00+09:00",
      endedAt: "2026-10-20T11:00:00+09:00",
      wholeDayFlag: false,
      class: "private",
      alarms: [{ action: "mail", trigger: "TRIGGER:-PT10M" }],
    });
  });

  it("create surfaces API errors", async () => {
    const f = fakeFetch([{ method: "POST", path: "/reservation/v1/resource-reservations", body: fail(-1, "already reserved") }]);
    const r = await runCli(["reservation", "create", "--resource", RES, "--subject", "x", "--from", "2026-10-20 10:00", "--to", "2026-10-20 11:00"], { home: home(), fetch: f });
    expect([r.code, r.err.trim()]).toEqual([5, "error: already reserved"]);
  });

  it("update sends updateType and given fields", async () => {
    const f = fakeFetch([{ method: "PUT", path: `/reservation/v1/resource-reservations/${RV}`, body: ok(null) }]);
    await runCli(["reservation", "update", RV, "--subject", "변경", "--update-type", "this"], { home: home(), fetch: f });
    expect(f.calls[0]!.body).toEqual({ subject: "변경", updateType: "this" });
  });

  it("update with a recurrence change requires updateType whole", async () => {
    const r = await runCli(["reservation", "update", RV, "--repeat", "weekly", "--update-type", "this"], { home: home() });
    expect(r.code).toBe(2);
  });

  it("cancel asks first; DELETE carries deleteType (empty for single)", async () => {
    expect((await runCli(["reservation", "cancel", RV], { home: home() })).code).toBe(2);
    const f = fakeFetch([{ method: "DELETE", path: `/reservation/v1/resource-reservations/${RV}`, body: ok(null) }]);
    await runCli(["reservation", "cancel", RV, "--yes"], { home: home(), fetch: f });
    expect(f.calls[0]!.body).toEqual({ deleteType: "" });
  });
});
