import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import * as pj from "../api/project.js";
import type { App, Ctx } from "../core/app.js";
import { DoorayError, EXIT_API, errorMessage, usageError } from "../core/errors.js";
import { cell } from "../core/output.js";
import { resolveMember, resolveProject } from "../core/resolve.js";
import { MARKDOWN } from "../core/text.js";
import { wholeDay } from "../core/time.js";
import { collect, confirmed, defined, oneOf } from "./common.js";

const SCOPES = ["private", "public"];
const ROLES = ["member", "admin"];
const WORKFLOW_CLASSES = ["backlog", "registered", "working", "closed"];
const HOOK_TYPES = ["task", "project"];
const WIKI_HOOK_MESSAGE_TYPES = ["dooray", "slack"];

const PROJECT_OPT = ["--project <project>", "project code or id"] as const;

async function withProject(ctx: Ctx, ref: string): Promise<{ app: App; pid: string }> {
  const app = await ctx.app();
  return { app, pid: (await resolveProject(app.client, app.cache, ref)).id };
}

const idRow = (id: string) => ({ columns: ["ID"], rows: [[id]] });

export function registerProject(program: Command, ctx: Ctx): void {
  const cmd = program.command("project").description("projects, milestones, workflows, tags, members, templates, hooks");

  cmd
    .command("list")
    .description("list your projects")
    .option("--search <text>", "code contains (case-insensitive)")
    .option("--type <type>", "public (default) | private")
    .option("--scope <scope>", "for public type: private|public")
    .option("--state <state>", "active|archived")
    .action(async (o: { search?: string; type?: string; scope?: string; state?: string }) => {
      const app = await ctx.app();
      const all = await pj.listProjects(app.client, { member: "me", type: o.type, scope: o.scope, state: o.state }, o.search ? 0 : app.limit);
      const hits = o.search ? all.filter((x) => x.code.toLowerCase().includes(o.search!.toLowerCase())) : all;
      const shown = app.limit > 0 ? hits.slice(0, app.limit) : hits;
      app.printer.emit(shown, {
        columns: ["ID", "CODE", "SCOPE", "STATE", "WIKI", "DRIVE"],
        rows: shown.map((x) => [x.id, x.code, cell(x.scope), cell(x.state), cell(x.wiki?.id), cell(x.drive?.id)]),
      });
    });

  cmd
    .command("get <project>")
    .description("show a project (code or id)")
    .action(async (ref: string) => {
      const { app, pid } = await withProject(ctx, ref);
      const x = await pj.getProject(app.client, pid);
      app.printer.emit(x, {
        columns: ["ID", "CODE", "SCOPE", "STATE", "WIKI", "DRIVE"],
        rows: [[x.id, x.code, cell(x.scope), cell(x.state), cell(x.wiki?.id), cell(x.drive?.id)]],
      });
    });

  cmd
    .command("create")
    .description("create a project")
    .requiredOption("--code <code>", "project name (3-30 chars)")
    .option("--description <text>", "description")
    .option("--scope <scope>", "private|public", "private")
    .option("--category <id>", "project category id (see project categories)")
    .action(async (o: { code: string; description?: string; scope: string; category?: string }) => {
      const app = await ctx.app();
      const body = defined({ code: o.code, description: o.description, scope: oneOf("--scope", SCOPES, o.scope), projectCategoryId: o.category });
      const { id } = await pj.createProject(app.client, body as { code: string });
      app.printer.emit({ id, code: o.code }, { columns: ["ID", "CODE"], rows: [[id, o.code]] });
    });

  cmd
    .command("update <project>")
    .description("change code/description/category (project admins; not while archived)")
    .option("--code <code>", "new project name")
    .option("--description <text>", "new description")
    .option("--category <id>", "project category id")
    .action(async (ref: string, o: { code?: string; description?: string; category?: string }) => {
      const body = defined({ code: o.code, description: o.description, projectCategoryId: o.category });
      if (!Object.keys(body).length) throw usageError("nothing to update: pass --code, --description or --category");
      const { app, pid } = await withProject(ctx, ref);
      await pj.updateProject(app.client, pid, body);
      app.printer.info(`updated project ${ref}`);
    });

  for (const [name, state, desc] of [
    ["archive", "archive", "archive a project (project admins)"],
    ["activate", "active", "bring an archived project back into use"],
  ] as const) {
    cmd
      .command(`${name} <project>`)
      .description(desc)
      .action(async (ref: string) => {
        const { app, pid } = await withProject(ctx, ref);
        await pj.setProjectState(app.client, pid, state);
        app.printer.info(`${name}d project ${ref}`);
      });
  }

  cmd
    .command("categories")
    .description("project categories (managed by the tenant admin)")
    .action(async () => {
      const app = await ctx.app();
      const cats = await pj.listCategories(app.client);
      app.printer.emit(cats, { columns: ["ID", "NAME", "PARENT"], rows: cats.map((c) => [c.id, c.name, cell(c.parentProjectCategoryId)]) });
    });

  cmd
    .command("is-creatable <code>")
    .description("check whether a project code is available")
    .action(async (code: string) => {
      const app = await ctx.app();
      let ok = true;
      let reason = "";
      try {
        await pj.isCreatable(app.client, code);
      } catch (e) {
        if (!(e instanceof DoorayError) || e.exit !== EXIT_API) throw e;
        ok = false;
        reason = errorMessage(e);
      }
      app.printer.emit({ code, creatable: ok, reason }, { columns: ["CODE", "CREATABLE", "REASON"], rows: [[code, String(ok), reason]] });
    });

  registerMilestones(cmd, ctx);
  registerWorkflows(cmd, ctx);
  registerTags(cmd, ctx);
  registerMembers(cmd, ctx);
  registerTemplates(cmd, ctx);
  registerHooks(cmd, ctx);
}

function registerMilestones(parent: Command, ctx: Ctx): void {
  const cmd = parent.command("milestone").description("milestones (단계)");
  const table = (ms: pj.Milestone[]) => ({
    columns: ["ID", "NAME", "STATUS", "STARTED", "ENDED"],
    rows: ms.map((m) => [m.id, m.name, cell(m.status), cell(m.startedAt), cell(m.endedAt)]),
  });
  const dates = (o: { startedAt?: string; endedAt?: string }) => ({
    startedAt: o.startedAt && wholeDay(o.startedAt),
    endedAt: o.endedAt && wholeDay(o.endedAt),
  });

  cmd.command("list").requiredOption(...PROJECT_OPT).action(async (o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const ms = await pj.listMilestones(app.client, pid, app.limit);
    app.printer.emit(ms, table(ms));
  });

  cmd.command("get <id>").requiredOption(...PROJECT_OPT).action(async (id: string, o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const m = await pj.getMilestone(app.client, pid, id);
    app.printer.emit(m, table([m]));
  });

  cmd
    .command("create")
    .requiredOption(...PROJECT_OPT)
    .requiredOption("--name <name>", "milestone name")
    .option("--started-at <date>", "start date (YYYY-MM-DD)")
    .option("--ended-at <date>", "end date (YYYY-MM-DD)")
    .action(async (o: { project: string; name: string; startedAt?: string; endedAt?: string }) => {
      const { app, pid } = await withProject(ctx, o.project);
      const { id } = await pj.createMilestone(app.client, pid, defined({ name: o.name, ...dates(o) }));
      await app.cache.drop(`milestones/${pid}`);
      app.printer.emit({ id }, idRow(id));
    });

  cmd
    .command("update <id>")
    .requiredOption(...PROJECT_OPT)
    .option("--name <name>", "milestone name")
    .option("--status <status>", "open|closed")
    .option("--started-at <date>", "start date (YYYY-MM-DD)")
    .option("--ended-at <date>", "end date (YYYY-MM-DD)")
    .action(async (id: string, o: { project: string; name?: string; status?: string; startedAt?: string; endedAt?: string }) => {
      const body = defined({ name: o.name, status: oneOf("--status", ["open", "closed"], o.status), ...dates(o) });
      const { app, pid } = await withProject(ctx, o.project);
      await pj.updateMilestone(app.client, pid, id, body);
      await app.cache.drop(`milestones/${pid}`);
      app.printer.info(`updated milestone ${id}`);
    });

  cmd
    .command("delete <id>")
    .requiredOption(...PROJECT_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (id: string, o: { project: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete milestone ${id}?`, o.yes))) return;
      const { app, pid } = await withProject(ctx, o.project);
      await pj.deleteMilestone(app.client, pid, id);
      await app.cache.drop(`milestones/${pid}`);
      app.printer.info(`deleted milestone ${id}`);
    });
}

function registerWorkflows(parent: Command, ctx: Ctx): void {
  const cmd = parent.command("workflow").description("post workflows (업무 상태)");
  const body = (o: { name?: string; class?: string; order?: string }) =>
    defined({ name: o.name, class: oneOf("--class", WORKFLOW_CLASSES, o.class), order: o.order === undefined ? undefined : Number(o.order) });

  cmd.command("list").requiredOption(...PROJECT_OPT).action(async (o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const ws = await pj.listWorkflows(app.client, pid);
    app.printer.emit(ws, { columns: ["ID", "NAME", "CLASS", "ORDER"], rows: ws.map((w) => [w.id, w.name, w.class, cell(w.order)]) });
  });

  cmd
    .command("create")
    .requiredOption(...PROJECT_OPT)
    .requiredOption("--name <name>", "workflow name")
    .requiredOption("--class <class>", WORKFLOW_CLASSES.join("|"))
    .option("--order <n>", "sort order")
    .action(async (o: { project: string; name: string; class: string; order?: string }) => {
      const { app, pid } = await withProject(ctx, o.project);
      await pj.createWorkflow(app.client, pid, body(o));
      await app.cache.drop(`workflows/${pid}`);
      app.printer.info(`created workflow ${o.name}`);
    });

  cmd
    .command("update <workflow>")
    .requiredOption(...PROJECT_OPT)
    .option("--name <name>", "workflow name")
    .option("--class <class>", WORKFLOW_CLASSES.join("|"))
    .option("--order <n>", "sort order")
    .action(async (ref: string, o: { project: string; name?: string; class?: string; order?: string }) => {
      const { app, pid } = await withProject(ctx, o.project);
      const wf = await pj.resolveWorkflow(app.client, app.cache, pid, ref);
      await pj.updateWorkflow(app.client, pid, wf.id, { name: wf.name, class: wf.class, order: wf.order, ...body(o) });
      await app.cache.drop(`workflows/${pid}`);
      app.printer.info(`updated workflow ${wf.name}`);
    });

  cmd
    .command("delete <workflow>")
    .requiredOption(...PROJECT_OPT)
    .requiredOption("--move-to <workflow>", "workflow that receives the posts of the deleted one")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, o: { project: string; moveTo: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete workflow ${ref}?`, o.yes))) return;
      const { app, pid } = await withProject(ctx, o.project);
      const [wf, to] = [await pj.resolveWorkflow(app.client, app.cache, pid, ref), await pj.resolveWorkflow(app.client, app.cache, pid, o.moveTo)];
      await pj.deleteWorkflow(app.client, pid, wf.id, to.id);
      await app.cache.drop(`workflows/${pid}`);
      app.printer.info(`deleted workflow ${wf.name}; posts moved to ${to.name}`);
    });
}

function registerTags(parent: Command, ctx: Ctx): void {
  const cmd = parent.command("tag").description("tags and tag groups");
  const table = (ts: pj.Tag[]) => ({
    columns: ["ID", "NAME", "COLOR", "GROUP"],
    rows: ts.map((t) => [t.id, cell(t.name), cell(t.color), cell(t.tagGroup?.name)]),
  });

  cmd.command("list").requiredOption(...PROJECT_OPT).action(async (o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const ts = await pj.listTags(app.client, pid, app.limit);
    app.printer.emit(ts, table(ts));
  });

  cmd.command("get <tag>").requiredOption(...PROJECT_OPT).action(async (ref: string, o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const t = await pj.getTag(app.client, pid, await pj.resolveTag(app.client, app.cache, pid, ref));
    app.printer.emit(t, table([t]));
  });

  cmd
    .command("create")
    .requiredOption(...PROJECT_OPT)
    .requiredOption("--name <name>", 'tag name; "group:name" puts it in a tag group')
    .option("--color <hex>", "color, e.g. FFFFFF")
    .action(async (o: { project: string; name: string; color?: string }) => {
      const { app, pid } = await withProject(ctx, o.project);
      const { id } = await pj.createTag(app.client, pid, defined({ name: o.name, color: o.color }) as { name: string });
      await app.cache.drop(`tags/${pid}`);
      app.printer.emit({ id }, idRow(id));
    });

  cmd
    .command("group <group>")
    .description("tag group rules: --mandatory / --select-one (use --no-… to turn off)")
    .requiredOption(...PROJECT_OPT)
    .option("--mandatory", "a post must have a tag from this group")
    .option("--no-mandatory", "not mandatory")
    .option("--select-one", "at most one tag from this group")
    .option("--no-select-one", "allow several")
    .action(async (groupRef: string, o: { project: string; mandatory?: boolean; selectOne?: boolean }) => {
      const body = defined({ mandatory: o.mandatory, selectOne: o.selectOne });
      if (!Object.keys(body).length) throw usageError("pass --mandatory/--no-mandatory and/or --select-one/--no-select-one");
      const { app, pid } = await withProject(ctx, o.project);
      const tags = await pj.listTags(app.client, pid);
      const group = tags.map((t) => t.tagGroup).find((g) => g && (g.id === groupRef || g.name === groupRef));
      if (!group) throw usageError(`no tag group '${groupRef}' in this project`);
      await pj.updateTagGroup(app.client, pid, group.id, body);
      await app.cache.drop(`tags/${pid}`);
      app.printer.info(`updated tag group ${group.name ?? group.id}`);
    });
}

function registerMembers(parent: Command, ctx: Ctx): void {
  const cmd = parent.command("member").description("project members");

  cmd.command("list").requiredOption(...PROJECT_OPT).action(async (o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const ms = await pj.listProjectMembers(app.client, pid, app.limit);
    app.printer.emit(ms, { columns: ["MEMBER_ID", "ROLE"], rows: ms.map((m) => [m.organizationMemberId, cell(m.role)]) });
  });

  cmd.command("get <member>").requiredOption(...PROJECT_OPT).action(async (who: string, o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const m = (await pj.getProjectMember(app.client, pid, await resolveMember(app.client, who))) as { organizationMemberId?: string; role?: string };
    app.printer.emit(m, { columns: ["MEMBER_ID", "ROLE"], rows: [[cell(m.organizationMemberId), cell(m.role)]] });
  });

  cmd
    .command("add <member>")
    .requiredOption(...PROJECT_OPT)
    .option("--role <role>", ROLES.join("|"), "member")
    .action(async (who: string, o: { project: string; role: string }) => {
      const role = oneOf("--role", ROLES, o.role)!;
      const { app, pid } = await withProject(ctx, o.project);
      const mid = await resolveMember(app.client, who);
      await pj.addProjectMember(app.client, pid, mid, role);
      app.printer.emit({ organizationMemberId: mid, role }, { columns: ["MEMBER_ID", "ROLE"], rows: [[mid, role]] });
    });

  cmd
    .command("remove <member>")
    .requiredOption(...PROJECT_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (who: string, o: { project: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `remove ${who} from project ${o.project}?`, o.yes))) return;
      const { app, pid } = await withProject(ctx, o.project);
      await pj.removeProjectMember(app.client, pid, await resolveMember(app.client, who));
      app.printer.info(`removed ${who}`);
    });

  const groups = parent.command("member-group").description("project member groups");
  groups.command("list").requiredOption(...PROJECT_OPT).action(async (o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const gs = await pj.listMemberGroups(app.client, pid);
    app.printer.emit(gs, { columns: ["ID", "CODE"], rows: gs.map((g) => [g.id, cell(g.code)]) });
  });
  groups.command("get <group>").requiredOption(...PROJECT_OPT).action(async (ref: string, o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const g = await pj.getMemberGroup(app.client, pid, await pj.resolveMemberGroup(app.client, app.cache, pid, ref));
    app.printer.emit(g, {
      columns: ["GROUP", "MEMBER_ID", "NAME"],
      rows: (g.members ?? []).map((m) => [cell(g.code), cell(m.organizationMember?.id), cell(m.organizationMember?.name)]),
    });
  });
}

/** --body-json takes inline JSON or @file. */
async function jsonArg(v: string): Promise<unknown> {
  const text = v.startsWith("@") ? await readFile(v.slice(1), "utf8") : v;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw usageError(`--body-json: ${errorMessage(e)}`);
  }
}

function registerTemplates(parent: Command, ctx: Ctx): void {
  const cmd = parent.command("template").description("post templates");
  interface TplOpts {
    project: string;
    bodyJson?: string;
    name?: string;
    subject?: string;
    body?: string;
  }
  const tplBody = async (o: TplOpts) => {
    if (o.bodyJson) return jsonArg(o.bodyJson);
    if (!o.name) throw usageError("pass --body-json, or at least --name");
    return defined({ templateName: o.name, subject: o.subject, body: o.body === undefined ? undefined : { mimeType: MARKDOWN, content: o.body } });
  };
  const withBodyOpts = (c: Command) =>
    c
      .requiredOption(...PROJECT_OPT)
      .option("--body-json <json>", "full template object as JSON (or @file.json)")
      .option("--name <name>", "template name")
      .option("--subject <text>", "post subject")
      .option("--body <markdown>", "post body");

  cmd.command("list").requiredOption(...PROJECT_OPT).action(async (o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const ts = await pj.listTemplates(app.client, pid, app.limit);
    app.printer.emit(ts, { columns: ["ID", "NAME"], rows: ts.map((t) => [t.id, cell(t.templateName)]) });
  });

  cmd
    .command("get <template>")
    .requiredOption(...PROJECT_OPT)
    .option("--no-interpolation", "keep macros like ${year} as written")
    .action(async (ref: string, o: { project: string; interpolation: boolean }) => {
      const { app, pid } = await withProject(ctx, o.project);
      const t = await pj.getTemplate(app.client, pid, await pj.resolveTemplate(app.client, app.cache, pid, ref), o.interpolation);
      app.printer.emit(t, { columns: ["ID", "NAME", "SUBJECT"], rows: [[t.id, cell(t.templateName), cell(t.subject)]] });
    });

  withBodyOpts(cmd.command("create")).action(async (o: TplOpts) => {
    const body = await tplBody(o);
    const { app, pid } = await withProject(ctx, o.project);
    const { id } = await pj.createTemplate(app.client, pid, body);
    await app.cache.drop(`templates/${pid}`);
    app.printer.emit({ id }, idRow(id));
  });

  withBodyOpts(cmd.command("update <template>")).action(async (ref: string, o: TplOpts) => {
    const body = await tplBody(o);
    const { app, pid } = await withProject(ctx, o.project);
    await pj.updateTemplate(app.client, pid, await pj.resolveTemplate(app.client, app.cache, pid, ref), body);
    await app.cache.drop(`templates/${pid}`);
    app.printer.info(`updated template ${ref}`);
  });

  cmd
    .command("delete <template>")
    .requiredOption(...PROJECT_OPT)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, o: { project: string; yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete template ${ref}?`, o.yes))) return;
      const { app, pid } = await withProject(ctx, o.project);
      await pj.deleteTemplate(app.client, pid, await pj.resolveTemplate(app.client, app.cache, pid, ref));
      await app.cache.drop(`templates/${pid}`);
      app.printer.info(`deleted template ${ref}`);
    });
}

function registerHooks(parent: Command, ctx: Ctx): void {
  parent
    .command("hook")
    .description("project webhooks (the API has no list/delete)")
    .command("create")
    .requiredOption(...PROJECT_OPT)
    .requiredOption("--url <url>", "receiver URL")
    .option("--type <type>", HOOK_TYPES.join("|"), "task")
    .option("--event <event>", "event to send, e.g. postCreated (repeatable)", collect)
    .option("--include-body", "include the post/comment body in the payload")
    .action(async (o: { project: string; url: string; type: string; event?: string[]; includeBody?: boolean }) => {
      if (!o.event?.length) throw usageError("pass at least one --event");
      const { app, pid } = await withProject(ctx, o.project);
      const body = defined({
        url: o.url,
        type: oneOf("--type", HOOK_TYPES, o.type),
        sendEvents: o.event,
        option: o.includeBody ? { body: { include: true, embedInlineImage: false } } : undefined,
      });
      const { id } = await pj.createHook(app.client, pid, body);
      app.printer.emit({ id }, idRow(id));
    });

  parent
    .command("wiki-hook")
    .description("webhooks for the project's wiki")
    .command("create")
    .requiredOption(...PROJECT_OPT)
    .requiredOption("--url <url>", "https receiver URL")
    .option("--event <event>", "pageCreated, pageUpdated, ... (repeatable)", collect)
    .option("--message-type <type>", WIKI_HOOK_MESSAGE_TYPES.join("|"), "dooray")
    .option("--disabled", "create it disabled")
    .action(async (o: { project: string; url: string; event?: string[]; messageType: string; disabled?: boolean }) => {
      if (!o.event?.length) throw usageError("pass at least one --event");
      const { app, pid } = await withProject(ctx, o.project);
      const body = { url: o.url, eventTypes: o.event, messageType: oneOf("--message-type", WIKI_HOOK_MESSAGE_TYPES, o.messageType), enabled: !o.disabled };
      const { id } = await pj.createWikiHook(app.client, pid, body);
      app.printer.emit({ id }, idRow(id));
    });

  const email = parent.command("email").description("project email addresses");
  email
    .command("create")
    .requiredOption(...PROJECT_OPT)
    .requiredOption("--email <address>", "address the project receives mail at")
    .option("--name <name>", "display name")
    .action(async (o: { project: string; email: string; name?: string }) => {
      const { app, pid } = await withProject(ctx, o.project);
      const { id } = await pj.createEmailAddress(app.client, pid, defined({ emailAddress: o.email, name: o.name }) as { emailAddress: string });
      app.printer.emit({ id }, idRow(id));
    });
  email.command("get <id>").requiredOption(...PROJECT_OPT).action(async (id: string, o: { project: string }) => {
    const { app, pid } = await withProject(ctx, o.project);
    const e = await pj.getEmailAddress(app.client, pid, id);
    app.printer.emit(e, { columns: ["ID", "EMAIL", "NAME"], rows: [[e.id, e.emailAddress, cell(e.name)]] });
  });
}
