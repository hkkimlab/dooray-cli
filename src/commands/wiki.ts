import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import * as wk from "../api/wiki.js";
import type { WikiComment, WikiFile, WikiPage } from "../api/wiki.js";
import type { App, Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { saveResponse } from "../core/files.js";
import { cell, type Table } from "../core/output.js";
import { resolveMember } from "../core/resolve.js";
import { applyReplace, editInEditor, readReplaceInputs, readText } from "../core/text.js";
import { safeName } from "../drive/mirror.js";
import { collect, confirmed, oneOf } from "./common.js";

const WIKI_OPT = ["--wiki <wiki>", "wiki id, project id or wiki name (needed for /paths)"] as const;
const FILE_TYPES = ["general", "inline_image"];
const DEFAULT_TREE_DEPTH = 3;

const pageTable = (ps: WikiPage[]): Table => ({
  columns: ["ID", "SUBJECT", "UPDATED"],
  rows: ps.map((p) => [p.id, p.subject, cell(p.updatedAt)]),
});

const commentTable = (cs: WikiComment[]): Table => ({
  columns: ["ID", "CREATED", "AUTHOR", "BODY"],
  rows: cs.map((c) => [c.id, cell(c.createdAt), cell(c.creator?.member?.name ?? c.creator?.member?.organizationMemberId), (c.body?.content ?? "").replace(/\s+/g, " ").slice(0, 80)]),
});

const pageFiles = (p: WikiPage) => [
  ...(p.files ?? []).map((f) => ({ ...f, type: f.type ?? "general" })),
  ...(p.images ?? []).map((f) => ({ ...f, type: f.type ?? "inline_image" })),
];

const fileTable = (fs: WikiFile[]): Table => ({
  columns: ["ID", "ATTACH_ID", "NAME", "SIZE", "TYPE"],
  rows: fs.map((f) => [f.id, cell(f.attachFileId), f.name, cell(f.size), cell(f.type)]),
});

async function target(ctx: Ctx, ref: string, wiki?: string): Promise<{ app: App } & wk.PageRef> {
  const app = await ctx.app();
  return { app, ...(await wk.resolvePage(app.client, app.cache, ref, wiki)) };
}

async function members(app: App, who: string[]): Promise<string[]> {
  const ids = [];
  for (const w of who) ids.push(await resolveMember(app.client, w));
  return ids;
}

export function registerWiki(program: Command, ctx: Ctx): void {
  const cmd = program.command("wiki").description("wikis and wiki pages");

  cmd
    .command("list")
    .description("wikis you can access")
    .option("--search <text>", "name contains (case-insensitive)")
    .action(async (o: { search?: string }) => {
      const app = await ctx.app();
      const all = await wk.listWikis(app.client, o.search ? 0 : app.limit);
      const ws = o.search ? all.filter((w) => w.name.toLowerCase().includes(o.search!.toLowerCase())) : all;
      app.printer.emit(ws, { columns: ["ID", "NAME", "TYPE", "PROJECT_ID"], rows: ws.map((w) => [w.id, w.name, cell(w.type), cell(w.project?.id)]) });
    });

  cmd
    .command("tree <wiki>")
    .description("page tree from the home page")
    .option("--depth <n>", "levels below home", String(DEFAULT_TREE_DEPTH))
    .action(async (ref: string, o: { depth: string }) => {
      const depth = Number(o.depth);
      if (!Number.isInteger(depth) || depth < 0) throw usageError("--depth must be a non-negative integer");
      const app = await ctx.app();
      const wiki = await wk.resolveWiki(app.client, app.cache, ref);
      const homeId = await wk.homePage(app.client, wiki);
      const top = await wk.listPages(app.client, wiki.id);
      const homeSubject = top.find((p) => p.id === homeId)?.subject ?? "Home";
      type Node = { id: string; subject: string; children: Node[] };
      const walk = async (id: string, subject: string, level: number): Promise<Node> => ({
        id,
        subject,
        children: level >= depth ? [] : await Promise.all((await wk.listPages(app.client, wiki.id, id)).map((c) => walk(c.id, c.subject, level + 1))),
      });
      const tree = await walk(homeId, homeSubject, 0);
      if (app.printer.format === "json") return app.printer.emit(tree, { columns: [], rows: [] });
      const lines: string[] = [];
      const print = (n: Node, indent: number): void => {
        lines.push(`${"  ".repeat(indent)}${n.subject}  (${n.id})`);
        n.children.forEach((c) => print(c, indent + 1));
      };
      print(tree, 0);
      app.io.out(lines.join("\n") + "\n");
    });

  const file = cmd.command("file").description("wiki-level files (not attached to a page)");
  file
    .command("upload <wiki> <localPath>")
    .description("upload; the attach id can be used with page create --attach")
    .action(async (ref: string, localPath: string) => {
      const app = await ctx.app();
      const wiki = await wk.resolveWiki(app.client, app.cache, ref);
      const f = await wk.uploadWikiFile(app.client, wiki.id, localPath);
      app.printer.emit(f, fileTable([f]));
    });
  file
    .command("download <wiki> <attachFileId>")
    .option("-O, --output <path>", "destination (default: the attach id)")
    .action(async (ref: string, attachId: string, o: { output?: string }) => {
      const app = await ctx.app();
      const wiki = await wk.resolveWiki(app.client, app.cache, ref);
      const dest = o.output ?? attachId;
      await saveResponse(await wk.downloadAttachFile(app.client, wiki.id, attachId), dest);
      app.printer.emit({ attachFileId: attachId, path: dest }, { columns: ["ATTACH_ID", "PATH"], rows: [[attachId, dest]] });
    });

  registerPages(cmd, ctx);
}

function registerPages(wiki: Command, ctx: Ctx): void {
  const cmd = wiki.command("page").description("wiki pages: a page is a URL, an id, or a /path with --wiki");

  cmd
    .command("list")
    .description("child pages (default: children of the home page)")
    .requiredOption(...WIKI_OPT)
    .option("--parent <page>", "parent page (id or /path)")
    .action(async (o: { wiki: string; parent?: string }) => {
      const app = await ctx.app();
      const wiki = await wk.resolveWiki(app.client, app.cache, o.wiki);
      const parent = o.parent ? (await wk.resolvePage(app.client, app.cache, o.parent, undefined, wiki.id)).pageId : await wk.homePage(app.client, wiki);
      const ps = await wk.listPages(app.client, wiki.id, parent);
      app.printer.emit(ps, pageTable(ps));
    });

  cmd
    .command("get <page>")
    .option(...WIKI_OPT)
    .action(async (ref: string, o: { wiki?: string }) => {
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      const p = await wk.getPage(app.client, wikiId, pageId);
      if (app.printer.format !== "table") return app.printer.emit(p, pageTable([p]));
      app.printer.emit(p, pageTable([p]));
      app.io.out(`\n${p.body?.content ?? ""}\n`);
    });

  cmd
    .command("create")
    .requiredOption(...WIKI_OPT)
    .option("--subject <text>", "page title")
    .option("--title <text>", "same as --subject")
    .option("--body <markdown>", 'body ("-" = stdin)')
    .option("--body-file <path>", "body from a file")
    .option("--parent <page>", "parent page (default: home)")
    .option("--referrer <who>", "referrer member (repeatable)", collect)
    .option("--file <path>", "attach a local file (repeatable)", collect)
    .option("--attach <attachFileId>", "attach an already uploaded wiki file (repeatable)", collect)
    .action(async (o: { wiki: string; subject?: string; title?: string; body?: string; bodyFile?: string; parent?: string; referrer?: string[]; file?: string[]; attach?: string[] }) => {
      const subject = o.subject ?? o.title;
      if (!subject) throw usageError("page create needs --subject");
      const content = (await readText(ctx.io, "body", o.body, o.bodyFile)) ?? "";
      const app = await ctx.app();
      const wiki = await wk.resolveWiki(app.client, app.cache, o.wiki);
      const parentPageId = o.parent ? (await wk.resolvePage(app.client, app.cache, o.parent, undefined, wiki.id)).pageId : await wk.homePage(app.client, wiki);
      const referrers = o.referrer ? (await members(app, o.referrer)).map((organizationMemberId) => ({ type: "member", member: { organizationMemberId } })) : undefined;
      const attachFileIds = [...(o.attach ?? [])];
      for (const f of o.file ?? []) {
        const up = await wk.uploadWikiFile(app.client, wiki.id, f);
        attachFileIds.push(up.attachFileId ?? up.id);
      }
      const body = {
        parentPageId,
        subject,
        body: { mimeType: "text/x-markdown", content },
        ...(referrers && { referrers }),
        ...(attachFileIds.length && { attachFileIds }),
      };
      const r = await wk.createPage(app.client, wiki.id, body);
      app.printer.emit(r, { columns: ["ID", "WIKI_ID"], rows: [[r.id, cell(r.wikiId ?? wiki.id)]] });
    });

  cmd
    .command("update <page>")
    .description("change the title and/or body (referrers are left alone)")
    .option(...WIKI_OPT)
    .option("--subject <text>", "new title")
    .option("--title <text>", "same as --subject")
    .option("--body <markdown>", 'new body ("-" = stdin)')
    .option("--body-file <path>", "new body from a file")
    .option("--editor", "edit the body in $EDITOR")
    .action(async (ref: string, o: { wiki?: string; subject?: string; title?: string; body?: string; bodyFile?: string; editor?: boolean }) => {
      let content = await readText(ctx.io, "body", o.body, o.bodyFile);
      const subject = o.subject ?? o.title;
      if (subject === undefined && content === undefined && !o.editor) throw usageError("nothing to update: pass --subject, --body/--body-file or --editor");
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      if (o.editor) content = await editInEditor(content ?? (await wk.getPage(app.client, wikiId, pageId)).body?.content ?? "", app.io.env);
      if (subject !== undefined) await wk.setTitle(app.client, wikiId, pageId, subject);
      if (content !== undefined) await wk.setContent(app.client, wikiId, pageId, content);
      app.printer.info(`updated page ${pageId}`);
    });

  cmd
    .command("replace <page>")
    .description("replace an exact piece of the body")
    .option(...WIKI_OPT)
    .option("--old <text>", 'text to find ("-" = stdin)')
    .option("--old-file <path>", "text to find, from a file")
    .option("--new <text>", 'replacement ("" deletes; "-" = stdin)')
    .option("--new-file <path>", "replacement, from a file")
    .option("--all", "replace every match")
    .option("--dry-run", "show the changed lines only")
    .action(async (ref: string, o: { wiki?: string; old?: string; oldFile?: string; new?: string; newFile?: string; all?: boolean; dryRun?: boolean }) => {
      const { oldText, newText } = await readReplaceInputs(ctx.io, o);
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      const p = await wk.getPage(app.client, wikiId, pageId);
      const r = applyReplace(p.body?.content ?? "", oldText, newText, o.all === true);
      if (o.dryRun) return app.io.out(r.preview + "\n");
      await wk.setContent(app.client, wikiId, pageId, r.content);
      app.printer.emit({ pageId, replaced: r.replaced }, { columns: ["ID", "REPLACED"], rows: [[pageId, String(r.replaced)]] });
    });

  cmd
    .command("move <page>")
    .description("move under another parent (optionally into another wiki)")
    .option(...WIKI_OPT)
    .option("--parent <page>", "new parent page (id, /path or URL)")
    .option("--to-wiki <wiki>", "target wiki (default: same wiki)")
    .option("--before <page>", "place right after this sibling page")
    .option("--first", "place first among siblings")
    .option("--no-children", "move only this page, not its children")
    .action(async (ref: string, o: { wiki?: string; parent?: string; toWiki?: string; before?: string; first?: boolean; children: boolean }) => {
      if (!o.parent) throw usageError("page move needs --parent");
      if (o.first && o.before) throw usageError("use either --first or --before");
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      const destWiki = o.toWiki ? (await wk.resolveWiki(app.client, app.cache, o.toWiki)).id : wikiId;
      const parent = await wk.resolvePage(app.client, app.cache, o.parent, undefined, destWiki);
      const before = o.before ? (await wk.resolvePage(app.client, app.cache, o.before, undefined, destWiki)).pageId : o.first ? "0" : undefined;
      await wk.movePage(app.client, wikiId, pageId, {
        targetParentPageId: parent.pageId,
        ...(o.toWiki && { targetWikiId: destWiki }),
        withChildren: o.children,
        ...(before && { beforePageId: before }),
      });
      app.printer.info(`moved page ${pageId}`);
    });

  cmd
    .command("delete <page>")
    .description("delete a page (its children move up to its parent)")
    .option(...WIKI_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, o: { wiki?: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete wiki page ${ref}?`, o.yes))) return;
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      await wk.deletePage(app.client, wikiId, pageId);
      app.printer.info(`deleted page ${pageId}`);
    });

  cmd
    .command("referrers <page>")
    .description("show referrers, or replace them all with --set")
    .option(...WIKI_OPT)
    .option("--set <who>", "referrer member (repeatable); replaces the whole list", collect)
    .option("-y, --yes", "do not ask before replacing")
    .action(async (ref: string, o: { wiki?: string; set?: string[]; yes?: boolean }) => {
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      if (!o.set) {
        const rs = (await wk.getPage(app.client, wikiId, pageId)).referrers ?? [];
        return app.printer.emit(rs, { columns: ["MEMBER_ID"], rows: rs.map((r) => [r.member.organizationMemberId]) });
      }
      if (!(await confirmed(ctx, `replace all referrers of page ${pageId}?`, o.yes))) return;
      await wk.setReferrers(app.client, wikiId, pageId, await members(app, o.set));
      app.printer.info(`set ${o.set.length} referrer(s)`);
    });

  cmd
    .command("links <page>")
    .description("shared links of a page (the API only lists them)")
    .option(...WIKI_OPT)
    .option("--expired", "show expired links")
    .action(async (ref: string, o: { wiki?: string; expired?: boolean }) => {
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      const ls = await wk.listSharedLinks(app.client, wikiId, pageId, !o.expired);
      app.printer.emit(ls, {
        columns: ["ID", "SCOPE", "DESCENDANTS", "URL"],
        rows: ls.map((l) => [l.id, cell(l.scope), l.includeDescendants ? "yes" : "no", cell(l.sharedLink)]),
      });
    });

  registerComments(cmd, ctx);
  registerFiles(cmd, ctx);
}

function registerComments(pageCmd: Command, ctx: Ctx): void {
  const cmd = pageCmd.command("comment").description("page comments");

  cmd.command("list <page>").option(...WIKI_OPT).action(async (ref: string, o: { wiki?: string }) => {
    const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
    const cs = await wk.listComments(app.client, wikiId, pageId, app.limit);
    app.printer.emit(cs, commentTable(cs));
  });

  cmd.command("get <page> <commentId>").option(...WIKI_OPT).action(async (ref: string, id: string, o: { wiki?: string }) => {
    const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
    const c = await wk.getComment(app.client, wikiId, pageId, id);
    app.printer.emit(c, commentTable([c]));
    if (app.printer.format === "table") app.io.out(`\n${c.body?.content ?? ""}\n`);
  });

  cmd
    .command("add <page>")
    .option(...WIKI_OPT)
    .option("--body <markdown>", 'comment ("-" = stdin)')
    .option("--body-file <path>", "comment from a file")
    .action(async (ref: string, o: { wiki?: string; body?: string; bodyFile?: string }) => {
      const text = await readText(ctx.io, "body", o.body, o.bodyFile);
      if (!text) throw usageError("comment add needs --body or --body-file");
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      const { id } = await wk.addComment(app.client, wikiId, pageId, text);
      app.printer.emit({ id }, { columns: ["ID"], rows: [[id]] });
    });

  cmd
    .command("update <page> <commentId>")
    .alias("edit")
    .option(...WIKI_OPT)
    .option("--body <markdown>", 'new text ("-" = stdin)')
    .option("--body-file <path>", "new text from a file")
    .action(async (ref: string, id: string, o: { wiki?: string; body?: string; bodyFile?: string }) => {
      const text = await readText(ctx.io, "body", o.body, o.bodyFile);
      if (text === undefined) throw usageError("comment update needs --body or --body-file");
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      await wk.updateComment(app.client, wikiId, pageId, id, text);
      app.printer.info(`updated comment ${id}`);
    });

  cmd
    .command("delete <page> <commentId>")
    .option(...WIKI_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, id: string, o: { wiki?: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete comment ${id}?`, o.yes))) return;
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      await wk.deleteComment(app.client, wikiId, pageId, id);
      app.printer.info(`deleted comment ${id}`);
    });
}

function registerFiles(pageCmd: Command, ctx: Ctx): void {
  const cmd = pageCmd.command("file").description("page attachments and inline images");

  cmd.command("list <page>").option(...WIKI_OPT).action(async (ref: string, o: { wiki?: string }) => {
    const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
    const fs = pageFiles(await wk.getPage(app.client, wikiId, pageId));
    app.printer.emit(fs, fileTable(fs));
  });

  cmd
    .command("upload <page> <localPath>")
    .option(...WIKI_OPT)
    .option("--type <type>", FILE_TYPES.join("|"), "general")
    .action(async (ref: string, localPath: string, o: { wiki?: string; type: string }) => {
      const type = oneOf("--type", FILE_TYPES, o.type)!;
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      const f = await wk.uploadPageFile(app.client, wikiId, pageId, localPath, type);
      app.printer.emit(f, fileTable([f]));
      if (type === "inline_image" && app.printer.format === "table") {
        app.io.out(`\nmarkdown: ![${f.name}](/wikis/${wikiId}/files/${f.attachFileId ?? f.id})\n`);
      }
    });

  cmd
    .command("download <page> <fileId>")
    .option(...WIKI_OPT)
    .option("-O, --output <path>", "destination (default: the file name)")
    .action(async (ref: string, fileId: string, o: { wiki?: string; output?: string }) => {
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      const dest = o.output ?? safeName(pageFiles(await wk.getPage(app.client, wikiId, pageId)).find((f) => f.id === fileId)?.name ?? fileId);
      await saveResponse(await wk.downloadPageFile(app.client, wikiId, pageId, fileId), dest);
      app.printer.emit({ fileId, path: dest }, { columns: ["FILE_ID", "PATH"], rows: [[fileId, dest]] });
    });

  cmd
    .command("download-all <page>")
    .option(...WIKI_OPT)
    .option("-O, --output <dir>", "destination directory", ".")
    .action(async (ref: string, o: { wiki?: string; output: string }) => {
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      await mkdir(o.output, { recursive: true });
      const saved = [];
      for (const f of pageFiles(await wk.getPage(app.client, wikiId, pageId))) {
        const dest = join(o.output, safeName(f.name));
        await saveResponse(await wk.downloadPageFile(app.client, wikiId, pageId, f.id), dest);
        saved.push({ fileId: f.id, path: dest });
      }
      app.printer.emit(saved, { columns: ["FILE_ID", "PATH"], rows: saved.map((s) => [s.fileId, s.path]) });
    });

  cmd
    .command("delete <page> <fileId>")
    .option(...WIKI_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, fileId: string, o: { wiki?: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete page file ${fileId}?`, o.yes))) return;
      const { app, wikiId, pageId } = await target(ctx, ref, o.wiki);
      await wk.deletePageFile(app.client, wikiId, pageId, fileId);
      app.printer.info(`deleted page file ${fileId}`);
    });
}
