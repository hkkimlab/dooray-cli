// post comment … and post file … subcommands.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import * as api from "../api/post.js";
import type { PostFile, PostLog } from "../api/post.js";
import type { Ctx } from "../core/app.js";
import type { Client } from "../core/client.js";
import { memberNames } from "../core/resolve.js";
import { usageError } from "../core/errors.js";
import { saveResponse } from "../core/files.js";
import { cell, type Table } from "../core/output.js";
import { HTML, MARKDOWN, readText } from "../core/text.js";
import { instant, toKst } from "../core/time.js";
import { safeName } from "../drive/mirror.js";
import { collect, confirmed } from "./common.js";
import { target } from "./post.js";

const PROJECT_OPT = ["--project <project>", "project code or id (for bare post numbers)"] as const;
const PREVIEW = 80;

const author = (l: PostLog) => l.creator?.member?.name ?? l.creator?.emailUser?.emailAddress ?? cell(l.creator?.member?.organizationMemberId);

/** Log creators often carry only an id; fill in names so tables and --author work. */
async function withNames(client: Client, logs: PostLog[]): Promise<PostLog[]> {
  const missing = logs.flatMap((l) => (l.creator?.member && !l.creator.member.name ? [l.creator.member.organizationMemberId] : []));
  if (!missing.length) return logs;
  const names = await memberNames(client, missing);
  return logs.map((l) =>
    l.creator?.member && !l.creator.member.name
      ? { ...l, creator: { ...l.creator, member: { ...l.creator.member, name: names.get(l.creator.member.organizationMemberId) } } }
      : l,
  );
}

const logTable = (logs: PostLog[]): Table => ({
  columns: ["ID", "CREATED", "AUTHOR", "BODY"],
  rows: logs.map((l) => [l.id, cell(l.createdAt), author(l), (l.body?.content ?? "").replace(/\s+/g, " ").slice(0, PREVIEW)]),
});

const fileTable = (fs: PostFile[]): Table => ({
  columns: ["ID", "NAME", "SIZE", "MIME"],
  rows: fs.map((f) => [f.id, f.name, cell(f.size), cell(f.mimeType)]),
});

export function registerPostComments(post: Command, ctx: Ctx): void {
  const cmd = post.command("comment").description("post comments");

  cmd
    .command("list <post>")
    .description("list comments (oldest first)")
    .option(...PROJECT_OPT)
    .option("--desc", "newest first")
    .option("--since <time>", "only comments created at/after this time")
    .option("--author <name>", "only comments whose author name contains this")
    .action(async (ref: string, o: { project?: string; desc?: boolean; since?: string; author?: string }) => {
      const since = o.since === undefined ? undefined : Date.parse(toKst(o.since));
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const logs = (await withNames(app.client, await api.listLogs(app.client, projectId, postId, o.desc ? "-createdAt" : "createdAt", since || o.author ? 0 : app.limit)))
        .filter((l) => since === undefined || instant(l.createdAt) >= since)
        .filter((l) => !o.author || author(l).includes(o.author));
      const shown = app.limit > 0 ? logs.slice(0, app.limit) : logs;
      app.printer.emit(shown, logTable(shown));
    });

  cmd
    .command("latest <post>")
    .description("the newest comments")
    .option(...PROJECT_OPT)
    .option("-n, --count <n>", "how many", "1")
    .action(async (ref: string, o: { project?: string; count: string }) => {
      const n = Number(o.count);
      if (!Number.isInteger(n) || n < 1) throw usageError("--count must be a positive integer");
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const logs = await withNames(app.client, await api.listLogs(app.client, projectId, postId, "-createdAt", n));
      if (app.printer.format === "table" && n === 1 && logs[0]) {
        app.printer.emit(logs, logTable(logs));
        app.io.out(`\n${logs[0].body?.content ?? ""}\n`);
        return;
      }
      app.printer.emit(logs, logTable(logs));
    });

  cmd
    .command("get <post> <commentId>")
    .description("show a comment")
    .option(...PROJECT_OPT)
    .action(async (ref: string, logId: string, o: { project?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const [l] = await withNames(app.client, [await api.getLog(app.client, projectId, postId, logId)]);
      app.printer.emit(l, logTable([l!]));
      if (app.printer.format === "table") app.io.out(`\n${l!.body?.content ?? ""}\n`);
    });

  cmd
    .command("add <post>")
    .description("add a comment (optionally attaching files)")
    .option(...PROJECT_OPT)
    .option("--body <text>", 'comment text ("-" = stdin)')
    .option("--body-file <path>", "comment text from a file")
    .option("--html", "body is HTML (default: markdown)")
    .option("--file <path>", "attach a local file (uploaded to the post, repeatable)", collect)
    .action(async (ref: string, o: { project?: string; body?: string; bodyFile?: string; html?: boolean; file?: string[] }) => {
      const text = await readText(ctx.io, "body", o.body, o.bodyFile);
      if (!text && !o.file?.length) throw usageError("comment add needs --body/--body-file (or --file)");
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const ids = [];
      for (const f of o.file ?? []) ids.push((await api.uploadFile(app.client, projectId, postId, f)).id);
      const { id } = await api.createLog(app.client, projectId, postId, { mimeType: o.html ? HTML : MARKDOWN, content: text ?? "" }, ids);
      app.printer.emit({ id, attachFileIds: ids }, { columns: ["ID", "FILES"], rows: [[id, ids.join(", ")]] });
    });

  cmd
    .command("update <post> <commentId>")
    .alias("edit")
    .description("replace a comment's text (comments sent as email cannot be edited)")
    .option(...PROJECT_OPT)
    .option("--body <text>", 'new text ("-" = stdin)')
    .option("--body-file <path>", "new text from a file")
    .option("--html", "body is HTML (default: keep the current format)")
    .action(async (ref: string, logId: string, o: { project?: string; body?: string; bodyFile?: string; html?: boolean }) => {
      const text = await readText(ctx.io, "body", o.body, o.bodyFile);
      if (text === undefined) throw usageError("comment update needs --body or --body-file");
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const mimeType = o.html ? HTML : ((await api.getLog(app.client, projectId, postId, logId)).body?.mimeType ?? MARKDOWN);
      await api.updateLog(app.client, projectId, postId, logId, { mimeType, content: text });
      app.printer.info(`updated comment ${logId}`);
    });

  cmd
    .command("delete <post> <commentId>")
    .description("delete a comment")
    .option(...PROJECT_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, logId: string, o: { project?: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete comment ${logId}?`, o.yes))) return;
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      await api.deleteLog(app.client, projectId, postId, logId);
      app.printer.info(`deleted comment ${logId}`);
    });
}

export function registerPostFiles(post: Command, ctx: Ctx): void {
  const cmd = post.command("file").description("post attachments");

  cmd
    .command("list <post>")
    .option(...PROJECT_OPT)
    .action(async (ref: string, o: { project?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const fs = await api.listFiles(app.client, projectId, postId);
      app.printer.emit(fs, fileTable(fs));
    });

  cmd
    .command("upload <post> <localPath>")
    .option(...PROJECT_OPT)
    .action(async (ref: string, localPath: string, o: { project?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const { id } = await api.uploadFile(app.client, projectId, postId, localPath);
      app.printer.emit({ id }, { columns: ["ID"], rows: [[id]] });
    });

  cmd
    .command("download <post> <fileId>")
    .option(...PROJECT_OPT)
    .option("-O, --output <path>", "destination (default: the attachment name in the current directory)")
    .action(async (ref: string, fileId: string, o: { project?: string; output?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const dest = o.output ?? safeName((await api.getFileMeta(app.client, projectId, postId, fileId)).name);
      await saveResponse(await api.downloadFile(app.client, projectId, postId, fileId), dest);
      app.printer.emit({ fileId, path: dest }, { columns: ["FILE_ID", "PATH"], rows: [[fileId, dest]] });
    });

  cmd
    .command("download-all <post>")
    .option(...PROJECT_OPT)
    .option("-O, --output <dir>", "destination directory", ".")
    .action(async (ref: string, o: { project?: string; output: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      await mkdir(o.output, { recursive: true });
      const saved = [];
      for (const f of await api.listFiles(app.client, projectId, postId)) {
        const dest = join(o.output, safeName(f.name));
        await saveResponse(await api.downloadFile(app.client, projectId, postId, f.id), dest);
        saved.push({ fileId: f.id, path: dest });
      }
      app.printer.emit(saved, { columns: ["FILE_ID", "PATH"], rows: saved.map((s) => [s.fileId, s.path]) });
    });

  cmd
    .command("delete <post> <fileId>")
    .option(...PROJECT_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, fileId: string, o: { project?: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete attachment ${fileId}?`, o.yes))) return;
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      await api.deleteFile(app.client, projectId, postId, fileId);
      app.printer.info(`deleted attachment ${fileId}`);
    });
}
