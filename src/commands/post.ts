import type { Command } from "commander";
import * as api from "../api/post.js";
import type { Post, PostUser } from "../api/post.js";
import { resolveMemberGroup, resolveMilestone, resolveTag, resolveTemplate, resolveWorkflow, getTemplate } from "../api/project.js";
import type { App, Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { me, memberMention, taskLink } from "../core/markup.js";
import { cell, type Table } from "../core/output.js";
import { resolveMember, resolveProject } from "../core/resolve.js";
import { applyReplace, editInEditor, HTML, MARKDOWN, readReplaceInputs, readText } from "../core/text.js";
import { dateFilter, endOfDay } from "../core/time.js";
import { collect, defined, oneOf, splitList } from "./common.js";
import { registerPostComments, registerPostFiles } from "./post-extra.js";

const PRIORITIES = ["highest", "high", "normal", "low", "lowest", "none"];
const CLASSES = ["backlog", "registered", "working", "closed"];
const ORDERS = ["createdAt", "-createdAt", "postUpdatedAt", "-postUpdatedAt", "postDueAt", "-postDueAt"];

const userNames = (us: PostUser[] | undefined) =>
  (us ?? []).map((u) => u.member?.name ?? u.emailUser?.emailAddress ?? u.group?.code ?? "").join(", ");

export const postTable = (ps: Post[]): Table => ({
  columns: ["ID", "NUMBER", "SUBJECT", "WORKFLOW", "PRIORITY", "ASSIGNEES"],
  rows: ps.map((p) => [p.id, p.taskNumber ?? cell(p.number), p.subject, cell(p.workflow?.name ?? p.workflowClass), cell(p.priority), userNames(p.users?.to)]),
});

/** Resolves a post reference and returns the app with project/post ids. */
export async function target(ctx: Ctx, ref: string, project: string | undefined): Promise<{ app: App } & api.PostRef> {
  const app = await ctx.app();
  return { app, ...(await api.resolvePost(app.client, app.cache, ref, project)) };
}

const PROJECT_OPT = ["--project <project>", "project code or id (for bare post numbers)"] as const;

// ---------- request bodies ----------

interface WriteOpts {
  subject?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  html?: boolean;
  to?: string[];
  cc?: string[];
  toGroup?: string[];
  ccGroup?: string[];
  due?: string;
  milestone?: string;
  tag?: string[];
  priority?: string;
  mention?: string[];
  linkTask?: string[];
  dryRun?: boolean;
}

function addWriteOptions(cmd: Command): Command {
  return cmd
    .option("--subject <text>", "subject")
    .option("--title <text>", "same as --subject")
    .option("--body <text>", 'body text ("-" reads stdin)')
    .option("--body-file <path>", 'body from a file ("-" = stdin)')
    .option("--html", "body is HTML (default: markdown)")
    .option("--to <who>", "assignee: me, name, email or member id (repeatable)", collect)
    .option("--cc <who>", "cc member (repeatable)", collect)
    .option("--to-group <group>", "assignee member group code or id (repeatable)", collect)
    .option("--cc-group <group>", "cc member group (repeatable)", collect)
    .option("--due <date>", "due date (YYYY-MM-DD = end of that day, or ISO-8601)")
    .option("--milestone <milestone>", "milestone name or id")
    .option("--tag <tag>", "tag name, group:name or id (repeatable)", collect)
    .option("--priority <priority>", PRIORITIES.join("|"))
    .option("--mention <who>", "prepend an @mention (markdown only, repeatable)", collect)
    .option("--link-task <post>", "append a link to another post (markdown only, repeatable)", collect)
    .option("--dry-run", "print the request body instead of sending it");
}

async function usersFrom(app: App, pid: string, o: WriteOpts) {
  const member = async (who: string): Promise<PostUser> => ({ type: "member", member: { organizationMemberId: await resolveMember(app.client, who) } });
  const group = async (ref: string): Promise<PostUser> => ({
    type: "group",
    group: { projectMemberGroupId: await resolveMemberGroup(app.client, app.cache, pid, ref) },
  });
  const list = async (members?: string[], groups?: string[]) =>
    members || groups ? [...(await Promise.all((members ?? []).map(member))), ...(await Promise.all((groups ?? []).map(group)))] : undefined;
  return { to: await list(o.to, o.toGroup), cc: await list(o.cc, o.ccGroup) };
}

/** Mentions go first, task links last; both are markdown links. */
async function decorate(app: App, content: string, mimeType: string, o: WriteOpts): Promise<string> {
  if (!o.mention?.length && !o.linkTask?.length) return content;
  if (mimeType === HTML) throw usageError("--mention/--link-task need a markdown body (the HTML link form is unconfirmed)");
  const self = await me(app.client, app.cache);
  const org = self.defaultOrganization?.id ?? "";
  const mentions = [];
  for (const who of o.mention ?? []) {
    const id = await resolveMember(app.client, who);
    const info = await app.client.call<{ id: string; name: string }>("GET", `/common/v1/members/${id}`);
    mentions.push(memberMention(org, info, self.id));
  }
  const links = [];
  for (const ref of o.linkTask ?? []) {
    const r = await api.resolvePost(app.client, app.cache, ref);
    links.push(taskLink(org, await api.getPost(app.client, r.projectId, r.postId)));
  }
  return [mentions.join(" "), content, links.join("\n")].filter(Boolean).join("\n\n");
}

const toRequestUser = (u: PostUser) => defined({ type: u.type, member: u.member, emailUser: u.emailUser, group: u.group });

async function dryRunOr(app: App, o: { dryRun?: boolean }, body: unknown, send: () => Promise<void>): Promise<void> {
  if (o.dryRun) app.io.out(JSON.stringify(body, null, 2) + "\n");
  else await send();
}

// ---------- registration ----------

export function registerPost(program: Command, ctx: Ctx): void {
  const cmd = program.command("post").alias("task").description("project posts (업무): list, search, create, update, replace, workflow, comments, files");

  cmd
    .command("list [project]")
    .description("list posts of a project (newest first)")
    .option("--project <project>", "project code or id")
    .option("--status <classes>", `workflow class(es), comma separated: ${CLASSES.join("|")}`)
    .option("--workflow <workflow>", "workflow name, class or id (repeatable)", collect)
    .option("--milestone <milestone>", "milestone name or id (repeatable)", collect)
    .option("--tag <tag>", "tag name or id (repeatable)", collect)
    .option("--to <who>", "assignee: me, name, email or id (repeatable)", collect)
    .option("--assignee <who>", "same as --to", collect)
    .option("--from <who>", "author (repeatable)", collect)
    .option("--cc <who>", "cc member (repeatable)", collect)
    .option("--unassigned", "only posts without an assignee")
    .option("--parent <post>", "children of this post")
    .option("--number <n>", "post number")
    .option("--subject <text>", "subject contains")
    .option("--created <range>", "today | thisweek | prev-7d | 2026-10-01~2026-10-31 | 2026-10-01~ | ~2026-10-31")
    .option("--updated <range>", "same forms as --created")
    .option("--due <range>", "same forms as --created")
    .option("--order <order>", ORDERS.join("|"), "-createdAt")
    .action(async (projectArg: string | undefined, o: ListOpts) => {
      const app = await ctx.app();
      const ref = o.project ?? projectArg;
      if (!ref) throw usageError("post list needs a project (argument or --project)");
      const pid = (await resolveProject(app.client, app.cache, ref)).id;
      const ps = await api.listPosts(app.client, pid, await listQuery(app, pid, o), app.limit);
      app.printer.emit(ps, postTable(ps));
    });

  cmd
    .command("search <projectOrKeyword> [keyword]")
    .description("search subjects: post search <project> <keyword>, or <keyword> --project <project>")
    .option("--project <project>", "project code or id")
    .action(async (a: string, b: string | undefined, o: { project?: string }) => {
      const [ref, keyword] = b === undefined ? [o.project, a] : [a, b];
      if (!ref) throw usageError("post search needs a project");
      const app = await ctx.app();
      const pid = (await resolveProject(app.client, app.cache, ref)).id;
      const ps = await api.listPosts(app.client, pid, { subjects: keyword, order: "-createdAt" }, app.limit);
      app.printer.emit(ps, postTable(ps));
    });

  cmd
    .command("get <post>")
    .description("show a post (URL, id, project/number, or number with --project)")
    .option(...PROJECT_OPT)
    .action(async (ref: string, o: { project?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const p = await api.getPost(app.client, projectId, postId);
      if (app.printer.format !== "table") return app.printer.emit(p, postTable([p]));
      app.printer.emit(p, detailTable(p));
      if (p.body?.content) app.io.out(`\n${p.body.content}\n`);
    });

  addWriteOptions(cmd.command("create [project]").description("create a post (or a draft with --draft)"))
    .option("--project <project>", "project code or id")
    .option("--parent <post>", "make it a child of this post")
    .option("--template <template>", "start from a project template (name or id)")
    .option("--workflow <workflow>", "set this workflow after creating")
    .option("--draft", "create a draft and print its URL instead of posting")
    .action(async (projectArg: string | undefined, o: CreateOpts) => {
      const app = await ctx.app();
      const ref = o.project ?? projectArg;
      if (!ref) throw usageError("post create needs a project (argument or --project)");
      const pid = (await resolveProject(app.client, app.cache, ref)).id;
      const body = await createBody(app, pid, o);
      await dryRunOr(app, o, body, async () => {
        if (o.draft) {
          const d = await api.createDraft(app.client, { projectId: pid, ...body });
          app.printer.emit(d, { columns: ["DRAFT_ID", "URL"], rows: [[d.id, cell(d.url)]] });
          return;
        }
        const { id } = await api.createPost(app.client, pid, body);
        if (o.workflow) await api.setWorkflow(app.client, pid, id, (await resolveWorkflow(app.client, app.cache, pid, o.workflow)).id);
        app.printer.emit({ id, projectId: pid }, { columns: ["ID", "PROJECT_ID"], rows: [[id, pid]] });
      });
    });

  addWriteOptions(cmd.command("update <post>").description("update a post; unspecified fields are kept"))
    .option(...PROJECT_OPT)
    .option("--parent <post>", "set the parent post")
    .option("--editor", "edit the body in $EDITOR")
    .action(async (ref: string, o: UpdateOpts) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const cur = await api.getPost(app.client, projectId, postId);
      const body = await updateBody(app, projectId, cur, o);
      await dryRunOr(app, o, body, async () => {
        await api.updatePost(app.client, projectId, postId, body);
        if (o.parent) {
          const parent = await api.resolvePost(app.client, app.cache, o.parent, o.project);
          await api.setParent(app.client, projectId, postId, parent.postId);
        }
        app.printer.info(`updated post ${cur.taskNumber ?? postId}`);
      });
    });

  cmd
    .command("replace <post>")
    .description("replace an exact piece of the body (keeps everything else)")
    .option(...PROJECT_OPT)
    .option("--old <text>", 'text to find, exact incl. whitespace ("-" = stdin)')
    .option("--old-file <path>", "text to find, from a file")
    .option("--new <text>", 'replacement ("" deletes the match; "-" = stdin)')
    .option("--new-file <path>", "replacement, from a file")
    .option("--all", "replace every match (default: exactly one must match)")
    .option("--dry-run", "show the changed lines only")
    .action(async (ref: string, o: ReplaceOpts) => {
      const { oldText, newText } = await readReplaceInputs(ctx.io, o);
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const cur = await api.getPost(app.client, projectId, postId);
      const r = applyReplace(cur.body?.content ?? "", oldText, newText, o.all === true);
      if (o.dryRun) return app.io.out(r.preview + "\n");
      await api.updatePost(app.client, projectId, postId, fullPut(cur, { content: r.content }));
      app.printer.emit({ postId, replaced: r.replaced }, { columns: ["ID", "REPLACED"], rows: [[postId, String(r.replaced)]] });
    });

  cmd
    .command("done <post>")
    .description("mark done (all assignees)")
    .option(...PROJECT_OPT)
    .action(async (ref: string, o: { project?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      await api.setDone(app.client, projectId, postId);
      app.printer.info(`done ${postId}`);
    });

  cmd
    .command("reopen <post>")
    .description("move back to the first 'registered' workflow")
    .option(...PROJECT_OPT)
    .action(async (ref: string, o: { project?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const wf = await resolveWorkflow(app.client, app.cache, projectId, "registered");
      await api.setWorkflow(app.client, projectId, postId, wf.id);
      app.printer.emit({ id: postId, workflow: wf.id }, { columns: ["ID", "WORKFLOW"], rows: [[postId, wf.name]] });
    });

  cmd
    .command("workflow <post> <workflow>")
    .description("set the workflow (name, class or id); --member changes only that assignee's")
    .option(...PROJECT_OPT)
    .option("--member <who>", "assignee whose workflow changes (me, name, id)")
    .action(async (ref: string, wfRef: string, o: { project?: string; member?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const wf = await resolveWorkflow(app.client, app.cache, projectId, wfRef);
      if (o.member) {
        const mid = o.member === "me" ? "me" : await resolveMember(app.client, o.member);
        await api.setAssigneeWorkflow(app.client, projectId, postId, mid, wf.id);
      } else {
        await api.setWorkflow(app.client, projectId, postId, wf.id);
      }
      app.printer.emit({ id: postId, workflow: wf.id }, { columns: ["ID", "WORKFLOW"], rows: [[postId, wf.name]] });
    });

  cmd
    .command("move <post>")
    .description("move a post to another project (milestone and tags are dropped)")
    .option(...PROJECT_OPT)
    .requiredOption("--to-project <project>", "target project code or id")
    .option("--no-sub-posts", "leave child posts behind")
    .action(async (ref: string, o: { project?: string; toProject: string; subPosts: boolean }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const dest = (await resolveProject(app.client, app.cache, o.toProject)).id;
      await api.movePost(app.client, projectId, postId, dest, o.subPosts);
      app.printer.info(`moved ${postId} to ${o.toProject}`);
    });

  cmd
    .command("parent <post> <parentPost>")
    .description("make <post> a child of <parentPost> (one level only)")
    .option(...PROJECT_OPT)
    .action(async (ref: string, parentRef: string, o: { project?: string }) => {
      const { app, projectId, postId } = await target(ctx, ref, o.project);
      const parent = await api.resolvePost(app.client, app.cache, parentRef, o.project);
      await api.setParent(app.client, projectId, postId, parent.postId);
      app.printer.info(`set parent of ${postId} to ${parent.postId}`);
    });

  registerPostComments(cmd, ctx);
  registerPostFiles(cmd, ctx);
}

// ---------- list ----------

interface ListOpts {
  project?: string;
  status?: string;
  workflow?: string[];
  milestone?: string[];
  tag?: string[];
  to?: string[];
  assignee?: string[];
  from?: string[];
  cc?: string[];
  unassigned?: boolean;
  parent?: string;
  number?: string;
  subject?: string;
  created?: string;
  updated?: string;
  due?: string;
  order: string;
}

async function listQuery(app: App, pid: string, o: ListOpts) {
  const members = async (who: string[] | undefined) => {
    const out = [];
    for (const w of splitList(who)) out.push(await resolveMember(app.client, w));
    return out;
  };
  const each = async (refs: string[] | undefined, fn: (r: string) => Promise<string>) => {
    const out = [];
    for (const r of splitList(refs)) out.push(await fn(r));
    return out;
  };
  const classes = splitList(o.status ? [o.status] : undefined);
  classes.forEach((c) => oneOf("--status", CLASSES, c));
  return {
    postWorkflowClasses: classes,
    postWorkflowIds: await each(o.workflow, async (r) => (await resolveWorkflow(app.client, app.cache, pid, r)).id),
    milestoneIds: await each(o.milestone, (r) => resolveMilestone(app.client, app.cache, pid, r)),
    tagIds: await each(o.tag, (r) => resolveTag(app.client, app.cache, pid, r)),
    toMemberIds: await members([...(o.to ?? []), ...(o.assignee ?? [])]),
    fromMemberIds: await members(o.from),
    ccMemberIds: await members(o.cc),
    toMemberSize: o.unassigned ? 0 : undefined,
    parentPostId: o.parent ? (await api.resolvePost(app.client, app.cache, o.parent, pid)).postId : undefined,
    postNumber: o.number,
    subjects: o.subject,
    createdAt: o.created && dateFilter("--created", o.created),
    updatedAt: o.updated && dateFilter("--updated", o.updated),
    dueAt: o.due && dateFilter("--due", o.due),
    order: oneOf("--order", ORDERS, o.order),
  };
}

// ---------- create/update bodies ----------

interface CreateOpts extends WriteOpts {
  project?: string;
  parent?: string;
  template?: string;
  workflow?: string;
  draft?: boolean;
}

interface UpdateOpts extends WriteOpts {
  project?: string;
  parent?: string;
  editor?: boolean;
}

interface ReplaceOpts {
  project?: string;
  old?: string;
  oldFile?: string;
  new?: string;
  newFile?: string;
  all?: boolean;
  dryRun?: boolean;
}

async function commonFields(app: App, pid: string, o: WriteOpts) {
  const tags = [];
  for (const t of splitList(o.tag)) tags.push(await resolveTag(app.client, app.cache, pid, t));
  return {
    users: await usersFrom(app, pid, o),
    milestoneId: o.milestone ? await resolveMilestone(app.client, app.cache, pid, o.milestone) : undefined,
    tagIds: o.tag ? tags : undefined,
    priority: oneOf("--priority", PRIORITIES, o.priority),
    dueDate: o.due ? endOfDay(o.due) : undefined,
  };
}

async function createBody(app: App, pid: string, o: CreateOpts): Promise<Record<string, unknown>> {
  const tpl = o.template
    ? await getTemplate(app.client, pid, await resolveTemplate(app.client, app.cache, pid, o.template), true)
    : undefined;
  const subject = o.subject ?? o.title ?? tpl?.subject;
  if (!subject) throw usageError("post create needs --subject (or a template with a subject)");
  const mimeType = o.html ? HTML : (tpl?.body?.mimeType ?? MARKDOWN);
  const text = (await readText(app.io, "body", o.body, o.bodyFile)) ?? tpl?.body?.content ?? "";
  const f = await commonFields(app, pid, o);
  return defined({
    parentPostId: o.parent ? (await api.resolvePost(app.client, app.cache, o.parent, pid)).postId : undefined,
    subject,
    body: { mimeType, content: await decorate(app, text, mimeType, o) },
    users: { to: f.users.to ?? tpl?.users?.to ?? [], cc: f.users.cc ?? tpl?.users?.cc ?? [] },
    dueDate: f.dueDate,
    dueDateFlag: f.dueDate ? true : undefined,
    milestoneId: f.milestoneId ?? tpl?.milestone?.id ?? undefined,
    tagIds: f.tagIds ?? tpl?.tagIds ?? tpl?.tags?.map((t) => t.id),
    priority: f.priority ?? tpl?.priority ?? "none",
  });
}

/**
 * PUT replaces the post, so unchanged fields are sent back as they are (subject, body,
 * priority, due date, users, milestone). Tags are only sent when changing (omitted = kept).
 */
function fullPut(cur: Post, change: { content?: string; mimeType?: string } & Record<string, unknown>): Record<string, unknown> {
  const { content, mimeType, ...rest } = change;
  return defined({
    subject: cur.subject,
    body: { mimeType: mimeType ?? cur.body?.mimeType ?? MARKDOWN, content: content ?? cur.body?.content ?? "" },
    priority: cur.priority,
    dueDate: cur.dueDate ?? undefined,
    dueDateFlag: cur.dueDateFlag,
    milestoneId: cur.milestone?.id,
    users: { to: (cur.users?.to ?? []).map(toRequestUser), cc: (cur.users?.cc ?? []).map(toRequestUser) },
    ...defined(rest),
  });
}

async function updateBody(app: App, pid: string, cur: Post, o: UpdateOpts): Promise<Record<string, unknown>> {
  let text = await readText(app.io, "body", o.body, o.bodyFile);
  if (o.html && text === undefined && !o.editor) throw usageError("--html needs a new body (--body/--body-file/--editor); the current text is not converted");
  const mimeType = o.html ? HTML : (cur.body?.mimeType ?? MARKDOWN);
  if (o.editor) text = await editInEditor(text ?? cur.body?.content ?? "", app.io.env, mimeType === HTML ? ".html" : ".md");
  const content = text === undefined && !o.mention?.length && !o.linkTask?.length ? undefined : await decorate(app, text ?? cur.body?.content ?? "", mimeType, o);
  const f = await commonFields(app, pid, o);
  const users = f.users.to || f.users.cc ? { to: f.users.to ?? (cur.users?.to ?? []).map(toRequestUser), cc: f.users.cc ?? (cur.users?.cc ?? []).map(toRequestUser) } : undefined;
  return fullPut(cur, {
    content,
    mimeType,
    subject: o.subject ?? o.title,
    users,
    milestoneId: f.milestoneId,
    tagIds: f.tagIds,
    priority: f.priority,
    dueDate: f.dueDate,
    dueDateFlag: f.dueDate ? true : undefined,
  });
}

function detailTable(p: Post): Table {
  const rows: [string, string][] = [
    ["ID", p.id],
    ["NUMBER", p.taskNumber ?? cell(p.number)],
    ["SUBJECT", p.subject],
    ["WORKFLOW", cell(p.workflow?.name ?? p.workflowClass)],
    ["PRIORITY", cell(p.priority)],
    ["FROM", userNames(p.users?.from ? [p.users.from] : [])],
    ["TO", userNames(p.users?.to)],
    ["CC", userNames(p.users?.cc)],
    ["DUE", cell(p.dueDate)],
    ["MILESTONE", cell(p.milestone?.name)],
    ["TAGS", (p.tags ?? []).map((t) => t.name ?? t.id).join(", ")],
    ["PARENT", cell(p.parent?.id)],
    ["CREATED", cell(p.createdAt)],
    ["UPDATED", cell(p.updatedAt)],
  ];
  return { columns: ["FIELD", "VALUE"], rows };
}
