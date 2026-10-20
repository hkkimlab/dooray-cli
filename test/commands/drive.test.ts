import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOLDER_MIME } from "../../src/api/drive.js";
import { fakeFetch, GOV_CONFIG, ok, runCli, tempHome, type Route } from "../helpers.js";

const D = "3000000000000000001";
const ROOT = "3000000000000000002";
const DIR = "3000000000000000003";
const FILE = "3000000000000000004";
const FILES = `/drive/v1/drives/${D}/files`;

function home(extra = ""): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG.replace("    env: gov\n", `    env: gov\n${extra}`));
  return h;
}

const withDrive = () => home(`    drive:\n      default_drive_id: "${D}"\n`);

const folder = (id: string, name: string, extra = {}) => ({ id, name, mimeType: FOLDER_MIME, size: 0, type: "folder", ...extra });
const file = (id: string, name: string, size = 3) => ({ id, name, mimeType: "text/plain", size, type: "file" });

const rootRoute: Route = { path: new RegExp(`^${FILES}\\?type=folder&subTypes=root`), body: ok([folder(ROOT, "root", { subType: "root" })], 1) };

describe("drive drives", () => {
  it("lists private and project drives", async () => {
    const f = fakeFetch([{ path: "/drive/v1/drives", body: ok([{ id: D, name: null, type: "private", project: { id: "9" } }], 1) }]);
    const r = await runCli(["drive", "drives", "--type", "private"], { home: home(), fetch: f });
    expect(r.out).toMatch(/ID\s+NAME\s+TYPE\s+PROJECT_ID/);
    expect(r.out).toContain("내 드라이브");
    expect(f.calls[0]!.url.searchParams.get("type")).toBe("private");
  });
});

describe("drive list", () => {
  it("uses the profile default drive and the root folder", async () => {
    const f = fakeFetch([rootRoute, { path: new RegExp(`parentId=${ROOT}`), body: ok([folder(DIR, "2025"), file(FILE, "a.txt", 12)], 2) }]);
    const r = await runCli(["drive", "list"], { home: withDrive(), fetch: f });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ID\s+NAME\s+TYPE\s+SIZE/);
    expect(r.out).toMatch(new RegExp(`${DIR}\\s+2025\\s+folder`));
    expect(r.out).toMatch(new RegExp(`${FILE}\\s+a.txt\\s+file\\s+12`));
  });

  it("falls back to the private drive and accepts a /path", async () => {
    const f = fakeFetch([
      { path: "/drive/v1/drives", body: ok([{ id: D, name: null, type: "private" }], 1) },
      rootRoute,
      { path: new RegExp(`parentId=${ROOT}`), body: ok([folder(DIR, "2025")], 1) },
      { path: new RegExp(`parentId=${DIR}`), body: ok([file(FILE, "x.pdf")], 1) },
    ]);
    const r = await runCli(["drive", "list", "/2025", "-o", "json"], { home: home(), fetch: f });
    expect(JSON.parse(r.out)[0].name).toBe("x.pdf");
  });

  it("--drive by name", async () => {
    const f = fakeFetch([
      { path: /type=private/, body: ok([{ id: "3000000000000000009", name: null, type: "private" }], 1) },
      { path: /type=project/, body: ok([{ id: D, name: "개발팀", type: "project" }], 1) },
      { path: new RegExp(`${FILES}\\?parentId=${DIR}`), body: ok([], 0) },
    ]);
    const r = await runCli(["drive", "list", DIR, "--drive", "개발"], { home: home(), fetch: f });
    expect(r.code).toBe(0);
  });

  it("a missing path segment is not-found with candidates", async () => {
    const f = fakeFetch([rootRoute, { path: new RegExp(`parentId=${ROOT}`), body: ok([folder(DIR, "2025")], 1) }]);
    const r = await runCli(["drive", "list", "/2024"], { home: withDrive(), fetch: f });
    expect(r.code).toBe(4);
    expect(r.err).toContain("no '2024' in /; entries: 2025/");
  });

  it("a relative name is a usage error", async () => {
    const r = await runCli(["drive", "list", "2025"], { home: withDrive(), fetch: fakeFetch([]) });
    expect(r.code).toBe(2);
  });
});

describe("drive get/download/upload", () => {
  it("get prints meta", async () => {
    const f = fakeFetch([{ path: `${FILES}/${FILE}`, body: ok({ ...file(FILE, "a.txt"), parentFile: { id: DIR, path: "/2025" } }) }]);
    const r = await runCli(["drive", "get", FILE, "-o", "json"], { home: withDrive(), fetch: f });
    expect(JSON.parse(r.out).parentFile.path).toBe("/2025");
    expect(f.calls[0]!.url.searchParams.get("media")).toBe("meta");
  });

  it("download follows the 307 and writes the file", async () => {
    const out = join(tempHome(), "a.txt");
    const f = fakeFetch([
      { path: `${FILES}/${FILE}`, status: 307, raw: "", headers: { location: `https://file-api.gov-dooray.com/dl/${FILE}` } },
      { path: `/dl/${FILE}`, raw: "hello" },
    ]);
    const r = await runCli(["drive", "download", FILE, "-O", out], { home: withDrive(), fetch: f });
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("hello");
    expect(existsSync(out + ".tmp")).toBe(false);
  });

  it("download without -O names the file from meta, refusing unsafe names", async () => {
    const f = fakeFetch([{ path: `${FILES}/${FILE}`, body: ok(file(FILE, "../evil")) }]);
    const r = await runCli(["drive", "download", FILE], { home: withDrive(), fetch: f });
    expect(r.code).toBe(1);
    expect(r.err).toContain("unsafe file name");
  });

  it("upload posts multipart with parentId to the root by default", async () => {
    const local = join(tempHome(), "up.txt");
    writeFileSync(local, "data");
    const f = fakeFetch([
      rootRoute,
      { method: "POST", path: FILES, status: 307, raw: "", headers: { location: `https://file-api.gov-dooray.com/uploads${FILES}?parentId=${ROOT}` } },
      { method: "POST", path: `/uploads${FILES}`, body: ok(file(FILE, "up.txt", 4)) },
    ]);
    const r = await runCli(["drive", "upload", local], { home: withDrive(), fetch: f });
    expect(r.code).toBe(0);
    expect(f.calls[1]!.url.searchParams.get("parentId")).toBe(ROOT);
    const form = f.calls[2]!.body as FormData;
    expect((form.get("file") as File).name).toBe("up.txt");
  });

  it("update uploads a new version with PUT media=raw", async () => {
    const local = join(tempHome(), "v2.txt");
    writeFileSync(local, "v2");
    const f = fakeFetch([{ method: "PUT", path: `${FILES}/${FILE}`, body: ok({ id: FILE, version: 2 }) }]);
    const r = await runCli(["drive", "update", FILE, local, "-o", "json"], { home: withDrive(), fetch: f });
    expect(JSON.parse(r.out)).toEqual({ id: FILE, version: 2 });
    expect(f.calls[0]!.url.searchParams.get("media")).toBe("raw");
  });
});

describe("drive mkdir/rename/mv/cp/rm", () => {
  it("mkdir uses create-folder under --parent", async () => {
    const f = fakeFetch([{ method: "POST", path: `${FILES}/${DIR}/create-folder`, body: ok({ id: "3000000000000000010" }) }]);
    const r = await runCli(["drive", "mkdir", "new", "--parent", DIR, "-o", "json"], { home: withDrive(), fetch: f });
    expect(JSON.parse(r.out)).toEqual({ id: "3000000000000000010", name: "new" });
    expect(f.calls[0]!.body).toEqual({ name: "new" });
  });

  it("rename PUTs media=meta {name}", async () => {
    const f = fakeFetch([{ method: "PUT", path: `${FILES}/${FILE}`, body: ok(null) }]);
    expect((await runCli(["drive", "rename", FILE, "b.txt"], { home: withDrive(), fetch: f })).code).toBe(0);
    expect(f.calls[0]!.body).toEqual({ name: "b.txt" });
    expect(f.calls[0]!.url.searchParams.get("media")).toBe("meta");
  });

  it("mv moves to a folder", async () => {
    const f = fakeFetch([{ method: "POST", path: `${FILES}/${FILE}/move`, body: ok(null) }]);
    await runCli(["drive", "mv", FILE, DIR], { home: withDrive(), fetch: f });
    expect(f.calls[0]!.body).toEqual({ destinationFileId: DIR });
  });

  it("cp copies within the drive (or --to-drive)", async () => {
    const f = fakeFetch([{ method: "POST", path: `${FILES}/${FILE}/copy`, body: ok(null) }]);
    await runCli(["drive", "cp", FILE, DIR, "--to-drive", "3000000000000000099"], { home: withDrive(), fetch: f });
    expect(f.calls[0]!.body).toEqual({ destinationDriveId: "3000000000000000099", destinationFileId: DIR });
  });

  it("rm moves to trash after confirmation; non-tty without --yes refuses", async () => {
    const refused = await runCli(["drive", "rm", FILE], { home: withDrive(), fetch: fakeFetch([]) });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--yes");
    const f = fakeFetch([{ method: "POST", path: `${FILES}/${FILE}/move`, body: ok(null) }]);
    expect((await runCli(["drive", "rm", FILE, "--yes"], { home: withDrive(), fetch: f })).code).toBe(0);
    expect(f.calls[0]!.body).toEqual({ destinationFileId: "trash" });
  });

  it("rm on a tty asks and can be declined", async () => {
    const r = await runCli(["drive", "rm", FILE], { home: withDrive(), fetch: fakeFetch([]), tty: true, stdin: "n\n" });
    expect(r.code).toBe(0);
    expect(r.err).toContain("cancelled");
  });

  it("rm --permanent deletes (only works from trash)", async () => {
    const f = fakeFetch([{ method: "DELETE", path: `${FILES}/${FILE}`, body: ok(null) }]);
    expect((await runCli(["drive", "rm", FILE, "--permanent", "--yes"], { home: withDrive(), fetch: f })).code).toBe(0);
  });
});

describe("drive link", () => {
  it("create/list/get/update/delete", async () => {
    const L = `${FILES}/${FILE}/shared-links`;
    const f = fakeFetch([
      { method: "POST", path: L, body: ok({ id: "1" }) },
      { method: "GET", path: L, body: ok([{ id: "1", scope: "member", sharedLink: "https://x/s/1", expiredAt: "2026-12-31T00:00:00+09:00" }], 1) },
      { method: "GET", path: `${L}/1`, body: ok({ id: "1", scope: "member" }) },
      { method: "PUT", path: `${L}/1`, body: ok(null) },
      { method: "DELETE", path: `${L}/1`, body: ok(null) },
    ]);
    const h = withDrive();
    const c = await runCli(["drive", "link", "create", FILE, "--scope", "member", "--expires", "2026-12-31"], { home: h, fetch: f });
    expect(c.code).toBe(0);
    expect(f.calls[0]!.body).toEqual({ scope: "member", expiredAt: "2026-12-31T23:59:59+09:00" });
    const l = await runCli(["drive", "link", "list", FILE], { home: h, fetch: f });
    expect(l.out).toContain("https://x/s/1");
    await runCli(["drive", "link", "get", FILE, "1"], { home: h, fetch: f });
    await runCli(["drive", "link", "update", FILE, "1", "--scope", "memberAndGuest"], { home: h, fetch: f });
    expect(f.calls[3]!.body).toEqual({ scope: "memberAndGuest" });
    expect((await runCli(["drive", "link", "delete", FILE, "1", "--yes"], { home: h, fetch: f })).code).toBe(0);
  });

  it("rejects an unknown scope", async () => {
    const r = await runCli(["drive", "link", "create", FILE, "--scope", "world", "--expires", "2026-12-31"], { home: withDrive() });
    expect(r.code).toBe(2);
  });
});

describe("drive changes", () => {
  it("passes revision/size", async () => {
    const f = fakeFetch([{ path: `/drive/v2/drives/${D}/changes`, body: ok([{ revision: "5", changeType: "updated", file: { id: FILE, name: "a", type: "file", path: "/a" } }]) }]);
    const r = await runCli(["drive", "changes", "--since", "4", "--size", "50"], { home: withDrive(), fetch: f });
    expect(r.out).toMatch(/5\s+updated\s+file\s+\/a\/a/);
    expect(f.calls[0]!.url.search).toBe("?latestRevision=4&size=50");
  });
});

describe("drive pull/push", () => {
  it("pull mirrors a remote folder and prints a summary", async () => {
    const dir = join(tempHome(), "mirror");
    const f = fakeFetch([
      { path: new RegExp(`parentId=${DIR}`), body: ok([file(FILE, "a.txt", 2)], 1) },
      { path: `${FILES}/${FILE}`, raw: "hi" },
    ]);
    const r = await runCli(["drive", "pull", DIR, dir], { home: withDrive(), fetch: f });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi");
    expect(r.out).toMatch(/DOWNLOADED\s+UPLOADED\s+SKIPPED\s+DELETED\n1\s+0\s+0\s+0/);
    expect(r.err).toContain("download a.txt");
  });

  it("pull ignores leftover Go-era archive_match/cache_lookup settings", async () => {
    const h = home(`    drive:\n      default_drive_id: "${D}"\n      archive_match: true\n      cache_lookup: true\n`);
    const dir = join(tempHome(), "mirror");
    mkdirSync(join(dir, "99_아카이브", "2023"), { recursive: true });
    mkdirSync(join(dir, ".cache"), { recursive: true });
    writeFileSync(join(dir, ".cache", "a.txt"), "hi");
    const f = fakeFetch([
      { path: new RegExp(`parentId=${DIR}`), body: ok([file(FILE, "a.txt", 2), { id: "3000000000000000050", name: "2023", mimeType: FOLDER_MIME, size: 0, type: "folder" }], 2) },
      { path: `${FILES}/${FILE}`, raw: "hi" },
      { path: new RegExp("parentId=3000000000000000050"), body: ok([], 0) },
    ]);
    const r = await runCli(["drive", "pull", DIR, dir, "-o", "json"], { home: h, fetch: f });
    expect(JSON.parse(r.out)).toEqual({ downloaded: 1, uploaded: 0, skipped: 0, deleted: 0 });
    expect(existsSync(join(dir, "2023"))).toBe(true);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi");
  });

  it("pull --delete asks first (non-tty needs --yes); --dry-run into a missing dir works", async () => {
    const refused = await runCli(["drive", "pull", DIR, join(tempHome(), "m"), "--delete"], { home: withDrive(), fetch: fakeFetch([]) });
    expect(refused.code).toBe(2);
    const f = fakeFetch([{ path: new RegExp(`parentId=${DIR}`), body: ok([file(FILE, "a.txt", 2)], 1) }]);
    const r = await runCli(["drive", "pull", DIR, join(tempHome(), "missing"), "--delete", "--dry-run"], { home: withDrive(), fetch: f });
    expect(r.code).toBe(0);
    expect(r.err).toContain("[dry-run] download a.txt");
  });

  it("pull refuses remote names that would escape the local dir", async () => {
    const f = fakeFetch([{ path: new RegExp(`parentId=${DIR}`), body: ok([file(FILE, "../x", 2)], 1) }]);
    const r = await runCli(["drive", "pull", DIR, join(tempHome(), "m")], { home: withDrive(), fetch: f });
    expect(r.code).toBe(1);
    expect(r.err).toContain("unsafe file name");
  });

  it("push --delete needs --yes; --dry-run does not", async () => {
    const dir = join(tempHome(), "src");
    mkdirSync(dir);
    const refused = await runCli(["drive", "push", dir, DIR, "--delete"], { home: withDrive(), fetch: fakeFetch([]) });
    expect(refused.code).toBe(2);
    const f = fakeFetch([{ path: new RegExp(`parentId=${DIR}`), body: ok([file(FILE, "old.txt")], 1) }]);
    const r = await runCli(["drive", "push", dir, DIR, "--delete", "--dry-run"], { home: withDrive(), fetch: f });
    expect(r.code).toBe(0);
    expect(r.err).toContain("[dry-run] delete old.txt");
  });

  it("push uploads and trashes orphans with --yes", async () => {
    const dir = join(tempHome(), "src");
    mkdirSync(dir);
    writeFileSync(join(dir, "new.txt"), "n");
    const f = fakeFetch([
      { path: new RegExp(`parentId=${DIR}`), body: ok([file(FILE, "old.txt")], 1) },
      { method: "POST", path: FILES, body: ok(file("3000000000000000011", "new.txt", 1)) },
      { method: "POST", path: `${FILES}/${FILE}/move`, body: ok(null) },
    ]);
    const r = await runCli(["drive", "push", dir, DIR, "--delete", "--yes", "-o", "json"], { home: withDrive(), fetch: f });
    expect(JSON.parse(r.out)).toEqual({ downloaded: 0, uploaded: 1, skipped: 0, deleted: 1 });
    expect(f.calls[2]!.body).toEqual({ destinationFileId: "trash" });
  });
});
