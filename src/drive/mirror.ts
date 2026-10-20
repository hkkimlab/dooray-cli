// pull/push mirroring between a Dooray drive folder and a local directory: a plain mirror with no
// site-specific folder rules. Push (unlike Go) recurses into subfolders and really trashes remote
// orphans with --delete.
import { mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isFolder, type DriveFile, type DriveOps } from "../api/drive.js";
import { generic } from "../core/errors.js";

export type MirrorAction = "download" | "upload" | "update" | "delete";

export interface MirrorOpts {
  delete?: boolean;
  dryRun?: boolean;
  force?: boolean;
  /** Called for each transfer/deletion (also in dry-run) with a slash-separated relative path. */
  onAction?: (action: MirrorAction, path: string) => void;
}

export interface SyncResult {
  downloaded: number;
  uploaded: number;
  skipped: number;
  deleted: number;
}

/** An equal-size copy on the other side means "skip", unless forced or missing. */
export function shouldSkip(localSize: number, localExists: boolean, remoteSize: number, force: boolean): boolean {
  return !force && localExists && localSize === remoteSize;
}

/** Remote names become local path segments; refuse anything that could escape the target dir. */
export function safeName(name: string): string {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw generic(`unsafe file name from server: ${JSON.stringify(name)}`);
  }
  return name;
}

const sizeOf = async (p: string): Promise<number | undefined> => {
  const s = await stat(p).catch(() => undefined);
  return s?.isFile() ? s.size : undefined;
};
const isDir = async (p: string) => (await stat(p).catch(() => undefined))?.isDirectory() === true;
const rel = (root: string, p: string) => relative(root, p).split("\\").join("/");

interface Run {
  ops: DriveOps;
  opts: MirrorOpts;
  res: SyncResult;
  root: string;
}

const emptyResult = (): SyncResult => ({ downloaded: 0, uploaded: 0, skipped: 0, deleted: 0 });

// ---------- pull ----------

export async function pull(ops: DriveOps, remoteFolderId: string, localDir: string, opts: MirrorOpts): Promise<SyncResult> {
  const run: Run = { ops, opts, res: emptyResult(), root: localDir };
  if (!opts.dryRun) await mkdir(localDir, { recursive: true });
  const seen = new Set<string>();
  await pullFolder(run, remoteFolderId, localDir, seen);
  if (opts.delete) await deleteLocalOrphans(run, seen);
  return run.res;
}

async function pullFolder(run: Run, parentId: string, localDir: string, seen: Set<string>): Promise<void> {
  for (const item of await run.ops.list(parentId)) {
    if (isFolder(item)) {
      const target = join(localDir, safeName(item.name));
      seen.add(target);
      if (!run.opts.dryRun) await mkdir(target, { recursive: true });
      await pullFolder(run, item.id, target, seen);
    } else {
      await pullFile(run, item, localDir, seen);
    }
  }
}

async function pullFile(run: Run, item: DriveFile, localDir: string, seen: Set<string>): Promise<void> {
  const dest = join(localDir, safeName(item.name));
  seen.add(dest);
  const localSize = await sizeOf(dest);
  if (shouldSkip(localSize ?? 0, localSize !== undefined, item.size, run.opts.force === true)) {
    run.res.skipped++;
    return;
  }
  run.opts.onAction?.("download", rel(run.root, dest));
  if (!run.opts.dryRun) await run.ops.download(item.id, dest);
  run.res.downloaded++;
}

async function walk(dir: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    (e.isDirectory() ? dirs : files).push(join(e.parentPath, e.name));
  }
  return { files, dirs };
}

/** Removes local files not seen remotely, then now-empty unseen dirs (deepest first). Counts files only (as Go). */
async function deleteLocalOrphans(run: Run, seen: Set<string>): Promise<void> {
  if (!(await isDir(run.root))) return; // dry-run into a directory that does not exist yet
  const { files, dirs } = await walk(run.root);
  for (const f of files.filter((p) => !seen.has(p))) {
    run.opts.onAction?.("delete", rel(run.root, f));
    if (!run.opts.dryRun) await rm(f, { force: true });
    run.res.deleted++;
  }
  if (run.opts.dryRun) return;
  for (const d of dirs.filter((p) => !seen.has(p)).sort().reverse()) {
    await rmdir(d).catch(() => undefined); // only succeeds when empty
  }
}

// ---------- push ----------

export async function push(ops: DriveOps, localDir: string, remoteFolderId: string, opts: MirrorOpts): Promise<SyncResult> {
  const run: Run = { ops, opts, res: emptyResult(), root: localDir };
  await pushFolder(run, localDir, remoteFolderId);
  return run.res;
}

async function pushFolder(run: Run, localDir: string, remoteId: string | undefined): Promise<void> {
  // remoteId undefined: folder doesn't exist remotely yet (dry-run)
  const remote = (remoteId ? await run.ops.list(remoteId) : []).filter((f) => !f.name.startsWith("."));
  const byName = new Map(remote.map((f) => [f.name, f]));
  const entries = (await readdir(localDir, { withFileTypes: true })).filter((e) => !e.name.startsWith("."));
  for (const e of entries) {
    const path = join(localDir, e.name);
    const r = byName.get(e.name);
    byName.delete(e.name);
    if (e.isDirectory()) {
      if (r && !isFolder(r)) throw generic(`${rel(run.root, path)}: remote is a file, local is a folder`);
      let id = r?.id;
      if (!id && !run.opts.dryRun) id = (await run.ops.mkdir(remoteId!, e.name)).id;
      await pushFolder(run, path, id);
    } else if (e.isFile()) {
      if (r && isFolder(r)) throw generic(`${rel(run.root, path)}: remote is a folder, local is a file`);
      await pushFile(run, path, remoteId, r);
    }
  }
  if (run.opts.delete) {
    for (const orphan of byName.values()) {
      run.opts.onAction?.("delete", rel(run.root, join(localDir, orphan.name)));
      if (!run.opts.dryRun) await run.ops.trash(orphan.id);
      run.res.deleted++;
    }
  }
}

async function pushFile(run: Run, path: string, remoteId: string | undefined, r: DriveFile | undefined): Promise<void> {
  const size = (await sizeOf(path)) ?? 0;
  if (r && shouldSkip(size, true, r.size, run.opts.force === true)) {
    run.res.skipped++;
    return;
  }
  run.opts.onAction?.(r ? "update" : "upload", rel(run.root, path));
  if (!run.opts.dryRun) {
    if (r) await run.ops.update(r.id, path);
    else await run.ops.upload(remoteId!, path);
  }
  run.res.uploaded++;
}
