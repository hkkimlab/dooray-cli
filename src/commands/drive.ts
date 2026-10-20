import type { Command } from "commander";
import * as drive from "../api/drive.js";
import { isFolder, type DriveFile } from "../api/drive.js";
import type { App, Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { cell, type Table } from "../core/output.js";
import { pull, push, safeName, type MirrorAction, type MirrorOpts, type SyncResult } from "../drive/mirror.js";
import { endOfDay } from "../core/time.js";
import { confirmed } from "./common.js";

const LINK_SCOPES = ["member", "memberAndGuest", "memberAndGuestAndExternal"];

const fileTable = (files: DriveFile[]): Table => ({
  columns: ["ID", "NAME", "TYPE", "SIZE"],
  rows: files.map((f) => [f.id, f.name, isFolder(f) ? "folder" : "file", isFolder(f) ? "" : cell(f.size)]),
});

const DRIVE_OPT = ["--drive <drive>", "drive id or name (default: profile default_drive_id, else your private drive)"] as const;

/** Resolves --drive and returns the app plus the drive id. */
async function withDrive(ctx: Ctx, opts: { drive?: string }): Promise<{ app: App; driveId: string }> {
  const app = await ctx.app();
  const driveId = await drive.resolveDrive(app.client, opts.drive, app.profile.drive.default_drive_id);
  return { app, driveId };
}

/** A file/folder reference (id or /path); undefined means the root folder. */
const ref = (app: App, driveId: string, r: string | undefined) =>
  r === undefined ? drive.rootFolder(app.client, driveId) : drive.resolveRef(app.client, driveId, r);

function emitSync(app: App, res: SyncResult): void {
  app.printer.emit(res, {
    columns: ["DOWNLOADED", "UPLOADED", "SKIPPED", "DELETED"],
    rows: [[res.downloaded, res.uploaded, res.skipped, res.deleted].map(String)],
  });
}

function mirrorOpts(app: App, o: { delete?: boolean; dryRun?: boolean; force?: boolean }): MirrorOpts {
  return {
    delete: o.delete,
    dryRun: o.dryRun,
    force: o.force,
    onAction: (action: MirrorAction, path: string) => app.printer.info(`${o.dryRun ? "[dry-run] " : ""}${action} ${path}`),
  };
}

export function registerDrive(program: Command, ctx: Ctx): void {
  const cmd = program.command("drive").description("Dooray drive: files, folders, shared links, pull/push mirroring");

  cmd
    .command("drives")
    .description("list drives (private and project)")
    .option("--type <type>", "private|project")
    .option("--scope <scope>", "for project drives: private|public")
    .action(async (o: { type?: string; scope?: string }) => {
      const app = await ctx.app();
      const drives = await drive.listDrives(app.client, { type: o.type, scope: o.scope });
      app.printer.emit(drives, {
        columns: ["ID", "NAME", "TYPE", "PROJECT_ID"],
        rows: drives.map((d) => [d.id, d.name ?? "내 드라이브", d.type, cell(d.project?.id)]),
      });
    });

  cmd
    .command("list [folder]")
    .description("list a folder (id or /path; default: root)")
    .option(...DRIVE_OPT)
    .action(async (folder: string | undefined, o: { drive?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const parent = await ref(app, driveId, folder);
      const files = await drive.listFiles(app.client, driveId, parent.id, app.limit);
      app.printer.emit(files, fileTable(files));
    });

  cmd
    .command("get <file>")
    .description("show file metadata")
    .option(...DRIVE_OPT)
    .action(async (file: string, o: { drive?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const meta = await drive.getFile(app.client, driveId, (await ref(app, driveId, file)).id);
      app.printer.emit(meta, fileTable([meta]));
    });

  cmd
    .command("download <file>")
    .description("download a file (default name: the remote name, in the current directory)")
    .option(...DRIVE_OPT)
    .option("-O, --output <path>", "local destination path")
    .action(async (file: string, o: { drive?: string; output?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const id = (await ref(app, driveId, file)).id;
      const dest = o.output ?? safeName((await drive.getFile(app.client, driveId, id)).name);
      await drive.downloadFile(app.client, driveId, id, dest);
      app.printer.emit({ fileId: id, path: dest }, { columns: ["FILE_ID", "PATH"], rows: [[id, dest]] });
    });

  cmd
    .command("upload <localPath>")
    .description("upload a local file")
    .option(...DRIVE_OPT)
    .option("--parent <folder>", "destination folder id or /path (default: root)")
    .action(async (localPath: string, o: { drive?: string; parent?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const parent = await ref(app, driveId, o.parent);
      const f = await drive.uploadFile(app.client, driveId, parent.id, localPath);
      app.printer.emit(f, fileTable([f]));
    });

  cmd
    .command("update <file> <localPath>")
    .description("upload a new version of an existing file")
    .option(...DRIVE_OPT)
    .action(async (file: string, localPath: string, o: { drive?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const r = await drive.updateFile(app.client, driveId, (await ref(app, driveId, file)).id, localPath);
      app.printer.emit(r, { columns: ["ID", "VERSION"], rows: [[r.id, cell(r.version)]] });
    });

  cmd
    .command("mkdir <name>")
    .description("create a folder")
    .option(...DRIVE_OPT)
    .option("--parent <folder>", "parent folder id or /path (default: root)")
    .action(async (name: string, o: { drive?: string; parent?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const parent = await ref(app, driveId, o.parent);
      const { id } = await drive.createFolder(app.client, driveId, parent.id, name);
      app.printer.emit({ id, name }, { columns: ["ID", "NAME"], rows: [[id, name]] });
    });

  cmd
    .command("rename <file> <newName>")
    .description("rename a file or folder")
    .option(...DRIVE_OPT)
    .action(async (file: string, newName: string, o: { drive?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const id = (await ref(app, driveId, file)).id;
      await drive.renameFile(app.client, driveId, id, newName);
      app.printer.emit({ id, name: newName }, { columns: ["ID", "NAME"], rows: [[id, newName]] });
    });

  cmd
    .command("mv <file> <destFolder>")
    .description("move a file or folder into another folder")
    .option(...DRIVE_OPT)
    .action(async (file: string, dest: string, o: { drive?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const [src, dst] = [(await ref(app, driveId, file)).id, (await ref(app, driveId, dest)).id];
      await drive.moveFile(app.client, driveId, src, dst);
      app.printer.emit({ id: src, destination: dst }, { columns: ["ID", "DESTINATION"], rows: [[src, dst]] });
    });

  cmd
    .command("cp <file> <destFolder>")
    .description("copy a file into a folder (destFolder is an id when --to-drive is another drive)")
    .option(...DRIVE_OPT)
    .option("--to-drive <drive>", "destination drive id or name (default: same drive)")
    .action(async (file: string, dest: string, o: { drive?: string; toDrive?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      const destDrive = o.toDrive ? await drive.resolveDrive(app.client, o.toDrive, undefined) : driveId;
      const src = (await ref(app, driveId, file)).id;
      const dst = (await ref(app, destDrive, dest)).id;
      await drive.copyFile(app.client, driveId, src, destDrive, dst);
      app.printer.emit({ id: src, destinationDriveId: destDrive, destination: dst }, { columns: ["ID", "DESTINATION"], rows: [[src, dst]] });
    });

  cmd
    .command("rm <file>")
    .description("move a file or folder to the trash (--permanent deletes a file already in the trash)")
    .option(...DRIVE_OPT)
    .option("--permanent", "delete permanently (file must be in the trash)")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (file: string, o: { drive?: string; permanent?: boolean; yes?: boolean }) => {
      if (!(await confirmed(ctx, `${o.permanent ? "permanently delete" : "move to trash"}: ${file}?`, o.yes))) return;
      const { app, driveId } = await withDrive(ctx, o);
      const id = (await ref(app, driveId, file)).id;
      if (o.permanent) await drive.deleteFile(app.client, driveId, id);
      else await drive.moveFile(app.client, driveId, id, "trash");
      app.printer.info(`${o.permanent ? "deleted" : "trashed"} ${id}`);
    });

  registerLinks(cmd, ctx);

  cmd
    .command("changes")
    .description("list changes in the drive since a revision (v2 changes API)")
    .option(...DRIVE_OPT)
    .option("--since <revision>", "latest revision already seen (default 0)")
    .option("--file-id <id>", "continue after this file within --since")
    .option("--size <n>", "max entries (server default 20, max 200)")
    .action(async (o: { drive?: string; since?: string; fileId?: string; size?: string }) => {
      const { app, driveId } = await withDrive(ctx, o);
      type Change = { revision: string; changeType: string; file?: { id?: string; type?: string; name?: string; path?: string } };
      const changes = (await drive.listChanges(app.client, driveId, {
        latestRevision: o.since,
        fileId: o.fileId,
        size: o.size === undefined ? undefined : Number(o.size),
      })) as Change[];
      app.printer.emit(changes, {
        columns: ["REVISION", "CHANGE", "TYPE", "PATH", "FILE_ID"],
        rows: changes.map((c) => [c.revision, c.changeType, cell(c.file?.type), cell(c.file?.name ? `${(c.file.path ?? "").replace(/\/$/, "")}/${c.file.name}` : c.file?.path), cell(c.file?.id)]),
      });
    });

  cmd
    .command("pull <remoteFolder> <localDir>")
    .description("mirror a remote folder (id or /path) into a local directory")
    .option(...DRIVE_OPT)
    .option("--delete", "remove local files that are absent remotely")
    .option("--dry-run", "report planned actions without transferring")
    .option("--force", "re-download even when sizes match")
    .option("-y, --yes", "do not ask before --delete")
    .action(async (remote: string, localDir: string, o: { drive?: string; delete?: boolean; dryRun?: boolean; force?: boolean; yes?: boolean }) => {
      if (o.delete && !o.dryRun) {
        const q = `pull --delete removes files under ${localDir} that are not on the drive. Continue?`;
        if (!(await confirmed(ctx, q, o.yes))) return;
      }
      const { app, driveId } = await withDrive(ctx, o);
      const folder = await ref(app, driveId, remote);
      emitSync(app, await pull(drive.driveOps(app.client, driveId), folder.id, localDir, mirrorOpts(app, o)));
    });

  cmd
    .command("push <localDir> <remoteFolder>")
    .description("mirror a local directory (recursively, dot-files skipped) into a remote folder")
    .option(...DRIVE_OPT)
    .option("--delete", "move remote files/folders absent locally to the trash")
    .option("--dry-run", "report planned actions without transferring")
    .option("--force", "re-upload even when sizes match")
    .option("-y, --yes", "do not ask before --delete")
    .action(async (localDir: string, remote: string, o: { drive?: string; delete?: boolean; dryRun?: boolean; force?: boolean; yes?: boolean }) => {
      if (o.delete && !o.dryRun) {
        const q = `push --delete moves remote files missing from ${localDir} to the trash. Continue?`;
        if (!(await confirmed(ctx, q, o.yes))) return;
      }
      const { app, driveId } = await withDrive(ctx, o);
      const folder = await ref(app, driveId, remote);
      emitSync(app, await push(drive.driveOps(app.client, driveId), localDir, folder.id, mirrorOpts(app, o)));
    });
}

function registerLinks(cmd: Command, ctx: Ctx): void {
  const link = cmd.command("link").description("shared links of a file");
  const scope = (s: string | undefined) => {
    if (s !== undefined && !LINK_SCOPES.includes(s)) throw usageError(`--scope must be one of ${LINK_SCOPES.join("|")}`);
    return s;
  };
  const target = async (o: { drive?: string }, file: string) => {
    const { app, driveId } = await withDrive(ctx, o);
    return { app, driveId, fileId: (await ref(app, driveId, file)).id };
  };

  link
    .command("list <file>")
    .option(...DRIVE_OPT)
    .option("--expired", "show expired links instead of valid ones")
    .action(async (file: string, o: { drive?: string; expired?: boolean }) => {
      const { app, driveId, fileId } = await target(o, file);
      const links = await drive.listLinks(app.client, driveId, fileId, !o.expired);
      app.printer.emit(links, {
        columns: ["ID", "SCOPE", "EXPIRED_AT", "URL"],
        rows: links.map((l) => [l.id, cell(l.scope), cell(l.expiredAt), cell(l.sharedLink)]),
      });
    });

  link
    .command("get <file> <linkId>")
    .option(...DRIVE_OPT)
    .action(async (file: string, linkId: string, o: { drive?: string }) => {
      const { app, driveId, fileId } = await target(o, file);
      const l = await drive.getLink(app.client, driveId, fileId, linkId);
      app.printer.emit(l, { columns: ["ID", "SCOPE", "EXPIRED_AT", "URL"], rows: [[l.id, cell(l.scope), cell(l.expiredAt), cell(l.sharedLink)]] });
    });

  link
    .command("create <file>")
    .option(...DRIVE_OPT)
    .requiredOption("--scope <scope>", LINK_SCOPES.join("|"))
    .requiredOption("--expires <date>", "expiry: YYYY-MM-DD (end of that day, KST) or ISO-8601")
    .action(async (file: string, o: { drive?: string; scope: string; expires: string }) => {
      const s = scope(o.scope)!;
      const { app, driveId, fileId } = await target(o, file);
      const { id } = await drive.createLink(app.client, driveId, fileId, s, endOfDay(o.expires));
      app.printer.emit({ id }, { columns: ["ID"], rows: [[id]] });
    });

  link
    .command("update <file> <linkId>")
    .option(...DRIVE_OPT)
    .option("--scope <scope>", LINK_SCOPES.join("|"))
    .option("--expires <date>", "expiry: YYYY-MM-DD or ISO-8601")
    .action(async (file: string, linkId: string, o: { drive?: string; scope?: string; expires?: string }) => {
      const body = { scope: scope(o.scope), expiredAt: o.expires === undefined ? undefined : endOfDay(o.expires) };
      const { app, driveId, fileId } = await target(o, file);
      await drive.updateLink(app.client, driveId, fileId, linkId, body);
      app.printer.info(`updated link ${linkId}`);
    });

  link
    .command("delete <file> <linkId>")
    .option(...DRIVE_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (file: string, linkId: string, o: { drive?: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete shared link ${linkId}?`, o.yes))) return;
      const { app, driveId, fileId } = await target(o, file);
      await drive.deleteLink(app.client, driveId, fileId, linkId);
      app.printer.info(`deleted link ${linkId}`);
    });
}
