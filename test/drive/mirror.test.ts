import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pull, push, shouldSkip } from "../../src/drive/mirror.js";
import { tempHome } from "../helpers.js";
import { FakeDrive } from "./fake-drive.js";

function local(files: Record<string, string>): string {
  const dir = join(tempHome(), "local");
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("shouldSkip", () => {
  it.each([
    [{ localExists: false, localSize: 0, remoteSize: 0, force: false }, false],
    [{ localExists: true, localSize: 5, remoteSize: 5, force: false }, true],
    [{ localExists: true, localSize: 5, remoteSize: 6, force: false }, false],
    [{ localExists: true, localSize: 5, remoteSize: 5, force: true }, false],
  ])("%o → %s", (a, want) => {
    expect(shouldSkip(a.localSize, a.localExists, a.remoteSize, a.force)).toBe(want);
  });
});

describe("pull", () => {
  it("downloads new/changed files and skips equal-size ones", async () => {
    const d = new FakeDrive().file("f1", "same.txt", "abc").file("f2", "changed.txt", "abcd").file("f3", "new.txt", "x");
    const dir = local({ "same.txt": "xyz", "changed.txt": "a" });
    const res = await pull(d, "root", dir, {});
    expect(res).toEqual({ downloaded: 2, uploaded: 0, skipped: 1, deleted: 0 });
    expect(readFileSync(join(dir, "same.txt"), "utf8")).toBe("xyz");
    expect(readFileSync(join(dir, "changed.txt"), "utf8")).toBe("abcd");
  });

  it("dry-run downloads nothing but counts", async () => {
    const d = new FakeDrive().folder("a", "sub").file("f", "x.txt", "1", "a");
    const dir = local({});
    const actions: string[] = [];
    const res = await pull(d, "root", dir, { dryRun: true, onAction: (k, p) => actions.push(`${k} ${p}`) });
    expect(res.downloaded).toBe(1);
    expect(d.log).toEqual([]);
    expect(existsSync(join(dir, "sub"))).toBe(false);
    expect(actions).toEqual(["download sub/x.txt"]);
  });

  it("recurses into folders", async () => {
    const d = new FakeDrive().folder("a", "A").folder("b", "B", "a").file("f", "deep.txt", "1", "b");
    const dir = local({});
    await pull(d, "root", dir, {});
    expect(readFileSync(join(dir, "A", "B", "deep.txt"), "utf8")).toBe("1");
  });

  it("force re-downloads equal files", async () => {
    const d = new FakeDrive().file("f", "a.txt", "1");
    const res = await pull(d, "root", local({ "a.txt": "2" }), { force: true });
    expect(res.downloaded).toBe(1);
  });

  it("a copy in .cache/ does not count as downloaded (the cache rule was removed)", async () => {
    const d = new FakeDrive().file("f", "a.pdf", "PDF");
    const dir = local({ ".cache/a.pdf": "PDF" });
    expect((await pull(d, "root", dir, {})).downloaded).toBe(1);
    expect(readFileSync(join(dir, "a.pdf"), "utf8")).toBe("PDF");
  });

  it("folders mirror to the same name; no special local folders (99_아카이브 is just a folder)", async () => {
    const d = new FakeDrive().folder("a", "2023").file("f", "x.txt", "1", "a");
    const dir = local({ "99_아카이브/2023/old.txt": "o" });
    await pull(d, "root", dir, {});
    expect(readFileSync(join(dir, "2023", "x.txt"), "utf8")).toBe("1");
    expect(existsSync(join(dir, "99_아카이브", "2023", "x.txt"))).toBe(false);
  });

  it("delete removes local orphans (files and empty dirs) and keeps mirrored files", async () => {
    const d = new FakeDrive().file("f", "keep.txt", "1").folder("a", "2023").file("x", "x.txt", "1", "a");
    const dir = local({
      "keep.txt": "1",
      "orphan.txt": "o",
      "gone/deep.txt": "d",
      "2023/x.txt": "1",
    });
    const res = await pull(d, "root", dir, { delete: true });
    expect(existsSync(join(dir, "orphan.txt"))).toBe(false);
    expect(existsSync(join(dir, "gone"))).toBe(false);
    expect(existsSync(join(dir, "2023", "x.txt"))).toBe(true);
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
    expect(res.deleted).toBe(2);
  });

  it("delete + dry-run removes nothing", async () => {
    const d = new FakeDrive();
    const dir = local({ "orphan.txt": "o" });
    const res = await pull(d, "root", dir, { delete: true, dryRun: true });
    expect(res.deleted).toBe(1);
    expect(existsSync(join(dir, "orphan.txt"))).toBe(true);
  });
});

describe("push", () => {
  it("uploads missing files, skips equal sizes, updates changed content in place", async () => {
    const d = new FakeDrive().file("r1", "same.txt", "abc").file("r2", "changed.txt", "a");
    const dir = local({ "same.txt": "xyz", "changed.txt": "abcd", "new.txt": "n" });
    const res = await push(d, dir, "root", {});
    expect(res).toEqual({ downloaded: 0, uploaded: 2, skipped: 1, deleted: 0 });
    expect(d.log.sort()).toEqual(["update r2", "upload root/new.txt"]);
  });

  it("recurses into subfolders, creating missing remote folders", async () => {
    const d = new FakeDrive().folder("a", "A");
    const dir = local({ "A/x.txt": "1", "B/C/y.txt": "2" });
    await push(d, dir, "root", {});
    expect(d.log).toContain("upload a/x.txt");
    expect(d.log.some((l) => l.startsWith("mkdir root/B"))).toBe(true);
    expect(d.log.some((l) => /^mkdir \d+\/C$/.test(l))).toBe(true);
    expect(d.log.some((l) => /^upload \d+\/y.txt$/.test(l))).toBe(true);
  });

  it("skips dot-files and dot-folders (.DS_Store, .git)", async () => {
    const d = new FakeDrive();
    const dir = local({ ".DS_Store": "x", ".git/config": "p", "ok.txt": "1" });
    await push(d, dir, "root", {});
    expect(d.log).toEqual(["upload root/ok.txt"]);
  });

  it("dry-run changes nothing remotely", async () => {
    const d = new FakeDrive();
    const dir = local({ "a/b.txt": "1" });
    const res = await push(d, dir, "root", { dryRun: true });
    expect(res.uploaded).toBe(1);
    expect(d.log).toEqual([]);
  });

  it("delete trashes remote files and folders absent locally (recursively)", async () => {
    const d = new FakeDrive()
      .file("r1", "keep.txt", "1")
      .file("r2", "orphan.txt", "o")
      .folder("f1", "oldfolder")
      .folder("f2", "sub")
      .file("r3", "inner-orphan.txt", "i", "f2");
    const dir = local({ "keep.txt": "1", "sub/.keep": "" });
    const res = await push(d, dir, "root", { delete: true });
    expect(d.log.sort()).toEqual(["trash f1", "trash r2", "trash r3"]);
    expect(res.deleted).toBe(3);
  });

  it("delete + dry-run trashes nothing", async () => {
    const d = new FakeDrive().file("r", "orphan.txt", "o");
    const res = await push(d, local({}), "root", { delete: true, dryRun: true });
    expect(res.deleted).toBe(1);
    expect(d.log).toEqual([]);
  });

  it("a local file that is a remote folder (or vice versa) is an error", async () => {
    const d = new FakeDrive().folder("a", "x");
    await expect(push(d, local({ x: "file" }), "root", {})).rejects.toThrow(/x: remote is a folder/);
  });
});
