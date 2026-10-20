import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { applyReplace, findOccurrences, readReplaceInputs, readText } from "../../src/core/text.js";
import { dateFilter } from "../../src/core/time.js";
import { tempHome } from "../helpers.js";

const io = (stdin = "") => ({ stdin: Readable.from([stdin]) });

describe("readText", () => {
  it("inline text as-is, file/stdin lose BOM and one trailing newline", async () => {
    const f = join(tempHome(), "b.md");
    writeFileSync(f, "﻿hello\n\n");
    expect(await readText(io(), "body", "x\n", undefined)).toBe("x\n");
    expect(await readText(io(), "body", undefined, f)).toBe("hello\n");
    expect(await readText(io("piped\n"), "body", "-", undefined)).toBe("piped");
    expect(await readText(io(), "body", undefined, undefined)).toBeUndefined();
  });
  it("rejects both forms and missing files", async () => {
    await expect(readText(io(), "body", "a", "b")).rejects.toThrow(/either --body or --body-file/);
    await expect(readText(io(), "body", undefined, "/nope/x")).rejects.toMatchObject({ exit: 2 });
  });
});

describe("applyReplace", () => {
  it("replaces exactly one match and previews the changed line", () => {
    const r = applyReplace("a\nhello world\nz", "world", "there", false);
    expect(r.content).toBe("a\nhello there\nz");
    expect(r.replaced).toBe(1);
    expect(r.preview).toBe("-hello world\n+hello there");
  });
  it("several matches need --all; overlaps count but are replaced once", () => {
    expect(() => applyReplace("x x", "x", "y", false)).toThrow(/2 places/);
    expect(applyReplace("x x", "x", "y", true).content).toBe("y y");
    expect(findOccurrences("aaa", "aa")).toEqual([0, 1]);
    expect(applyReplace("aaa", "aa", "b", true).content).toBe("ba");
  });
  it("keeps $& and $1 literal", () => {
    expect(applyReplace("cost", "cost", "$& $1", false).content).toBe("$& $1");
  });
  it("not found mentions CRLF/NFC hints", () => {
    expect(() => applyReplace("a\r\nb", "a\nb", "c", false)).toThrow(/CRLF/);
    expect(() => applyReplace("한글".normalize("NFD"), "한글", "x", false)).toThrow(/normalization/);
    expect(() => applyReplace("abc", "", "x", false)).toThrow(/empty/);
    expect(() => applyReplace("abc", "a", "a", false)).toThrow(/same/);
  });
  it("empty new deletes", () => {
    expect(applyReplace("keep DROP keep", " DROP", "", false).content).toBe("keep keep");
  });
});

describe("readReplaceInputs", () => {
  it("needs both sides and only one stdin", async () => {
    await expect(readReplaceInputs(io(), { old: "a" })).rejects.toThrow(/--new/);
    await expect(readReplaceInputs(io(), { old: "-", new: "-" })).rejects.toThrow(/only one/);
    expect(await readReplaceInputs(io("x\n"), { old: "-", new: "" })).toEqual({ oldText: "x", newText: "" });
    await expect(readReplaceInputs(io(""), { old: "a", new: "-" })).rejects.toThrow(/empty/);
  });
});

describe("dateFilter", () => {
  it.each([
    ["today", "today"],
    ["prev-7d", "prev-7d"],
    ["next-3d", "next-3d"],
    ["2026-10-01~2026-10-31", "2026-10-01T00:00:00+09:00~2026-10-31T23:59:59+09:00"],
    ["2026-10-01~", "2026-10-01T00:00:00+09:00~2999-12-31T23:59:59Z"],
    ["~2026-10-31", "1970-01-01T00:00:00Z~2026-10-31T23:59:59+09:00"],
    ["2026-10-20", "2026-10-20T00:00:00+09:00~2026-10-20T23:59:59+09:00"],
  ])("%s", (input, want) => {
    expect(dateFilter("--created", input)).toBe(want);
  });
  it("rejects junk and inverted ranges", () => {
    expect(() => dateFilter("--created", "prev-0d")).toThrow(/--created/);
    expect(() => dateFilter("--created", "~")).toThrow();
    expect(() => dateFilter("--created", "2026-10-31~2026-10-01")).toThrow(/before/);
  });
});
