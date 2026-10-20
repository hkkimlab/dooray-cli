import { describe, expect, it } from "vitest";
import { addDays, endOfDay, instant, kstDate, kstIso, splitRange, startOfDay, toKst, wholeDay } from "../../src/core/time.js";

describe("time", () => {
  it("startOfDay / endOfDay expand dates in KST and pass ISO through", () => {
    expect(startOfDay("2026-10-20")).toBe("2026-10-20T00:00:00+09:00");
    expect(endOfDay("2026-10-20")).toBe("2026-10-20T23:59:59+09:00");
    expect(endOfDay("2026-10-20T10:00:00Z")).toBe("2026-10-20T10:00:00Z");
    expect(() => startOfDay("tomorrow")).toThrow(/invalid date/);
  });

  it("toKst accepts dates, local date-times (with T or space) and offsets", () => {
    expect(toKst("2026-10-20")).toBe("2026-10-20T00:00:00+09:00");
    expect(toKst("2026-10-20 14:30")).toBe("2026-10-20T14:30:00+09:00");
    expect(toKst("2026-10-20T14:30:15")).toBe("2026-10-20T14:30:15+09:00");
    expect(toKst("2026-10-20T05:30:00Z")).toBe("2026-10-20T05:30:00Z");
    expect(() => toKst("2026-13-45")).toThrow(/invalid date/);
  });

  it("wholeDay formats as YYYY-MM-DD+09:00", () => {
    expect(wholeDay("2026-10-20")).toBe("2026-10-20+09:00");
    expect(wholeDay("2026-10-20T23:00:00+09:00")).toBe("2026-10-20+09:00");
    expect(wholeDay("2026-10-20T20:00:00Z")).toBe("2026-10-21+09:00");
  });

  it("kstIso / kstDate format an instant in KST", () => {
    const d = new Date("2026-10-19T20:00:00Z");
    expect(kstIso(d)).toBe("2026-10-20T05:00:00+09:00");
    expect(kstDate(d)).toBe("2026-10-20");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("instant understands whole-day values", () => {
    expect(instant("2026-10-20+09:00")).toBe(Date.parse("2026-10-20T00:00:00+09:00"));
    expect(instant("2026-10-20T01:00:00Z")).toBe(Date.parse("2026-10-20T01:00:00Z"));
    expect(instant(undefined)).toBe(0);
  });

  it("splitRange cuts a range into windows of at most n days", () => {
    const parts = splitRange("2026-01-01T00:00:00+09:00", "2026-03-15T00:00:00+09:00", 50);
    expect(parts).toEqual([
      ["2026-01-01T00:00:00+09:00", "2026-02-20T00:00:00+09:00"],
      ["2026-02-20T00:00:00+09:00", "2026-03-15T00:00:00+09:00"],
    ]);
    expect(splitRange("2026-01-01T00:00:00+09:00", "2026-01-02T00:00:00+09:00", 50)).toHaveLength(1);
  });
});
