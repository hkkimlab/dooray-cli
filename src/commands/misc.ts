// Smaller official APIs: activity stream, contacts, incoming webhooks.
import type { Command } from "commander";
import type { Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { cell } from "../core/output.js";
import { resolveProject } from "../core/resolve.js";
import { collect, confirmed, oneOf } from "./common.js";

const MAX_STREAM_SIZE = 200;
const HOOK_SERVICES = ["incoming", "github", "jenkins", "trello", "newrelic", "jira", "bitbucket", "ifttt"];

interface StreamItem {
  type: string;
  [k: string]: unknown;
}

interface StreamBody {
  subject?: string;
  name?: string;
  title?: string;
  sentAt?: string;
  createdAt?: string;
  updatedAt?: string;
  users?: { from?: { member?: { name?: string }; emailUser?: { name?: string; emailAddress?: string } } };
}

/** Each item is { type, [type]: {...} }; pull a common summary out of whichever shape it is. */
function summary(it: StreamItem): [string, string, string, string] {
  const b = (it[it.type] ?? {}) as StreamBody;
  const from = b.users?.from?.member?.name ?? b.users?.from?.emailUser?.name ?? b.users?.from?.emailUser?.emailAddress;
  return [it.type, cell(b.sentAt ?? b.createdAt ?? b.updatedAt), cell(from), cell(b.subject ?? b.title ?? b.name)];
}

interface Contact {
  id: string;
  name?: string;
  company?: string;
  department?: string;
  emailAddress?: string;
  emails?: { emailAddress: string; default?: boolean }[];
  phones?: { numberWithCountryCode?: string; number?: string; default?: boolean }[];
}

const pick = <T extends { default?: boolean }>(xs: T[] | undefined) => xs?.find((x) => x.default) ?? xs?.[0];
const contactTable = (cs: Contact[]) => ({
  columns: ["ID", "NAME", "COMPANY", "DEPARTMENT", "EMAIL", "PHONE"],
  rows: cs.map((c) => {
    const phone = pick(c.phones);
    return [c.id, cell(c.name), cell(c.company), cell(c.department), cell(c.emailAddress ?? pick(c.emails)?.emailAddress), cell(phone?.numberWithCountryCode ?? phone?.number)];
  }),
});

export function registerMisc(program: Command, ctx: Ctx): void {
  program
    .command("stream")
    .description("your Dooray activity feed (last 2 weeks)")
    .command("list")
    .description("newest activity first")
    .option("--size <n>", `items per page (max ${MAX_STREAM_SIZE})`, "20")
    .option("--unread", "unread only")
    .option("--before <cursor>", "continue from a previous page's cursor")
    .option("--all", "follow the cursor until the feed is exhausted")
    .action(async (o: { size: string; unread?: boolean; before?: string; all?: boolean }) => {
      const size = Number(o.size);
      if (!Number.isInteger(size) || size < 1 || size > MAX_STREAM_SIZE) throw usageError(`--size must be 1..${MAX_STREAM_SIZE}`);
      const app = await ctx.app();
      let items: StreamItem[] = [];
      let before = o.before;
      let cursor: string | undefined;
      do {
        const env = await app.client.envelope<StreamItem[]>("GET", "/common/v1/streams", { query: { size, before, read: o.unread ? false : undefined } });
        // A short page is not the end; only an empty one is (per the API doc).
        if (!env.result?.length) break;
        items = [...items, ...env.result];
        cursor = env.cursor;
        before = cursor;
      } while (o.all && cursor);
      app.printer.emit(items, { columns: ["TYPE", "TIME", "FROM", "TITLE"], rows: items.map(summary) });
      if (!o.all && cursor) app.printer.info(`next: --before ${cursor}`);
    });

  const contact = program.command("contact").description("your contacts (주소록)");
  contact.command("list").action(async () => {
    const app = await ctx.app();
    const cs = await app.client.list<Contact>("/contacts/v1/contacts", {}, app.limit);
    app.printer.emit(cs, contactTable(cs));
  });
  contact.command("get <id>").action(async (id: string) => {
    const app = await ctx.app();
    const c = await app.client.call<Contact>("GET", `/contacts/v1/contacts/${id}`);
    app.printer.emit(c, contactTable([c]));
  });
  contact
    .command("search <keywords...>")
    .description("search your contacts")
    .action(async (keywords: string[]) => {
      const app = await ctx.app();
      const all = await app.client.call<Contact[]>("POST", "/contacts/v1/contacts/search", { body: { all: keywords } });
      const cs = app.limit > 0 ? all.slice(0, app.limit) : all;
      app.printer.emit(cs, contactTable(cs));
    });

  const hook = program.command("incoming-hook").description("incoming webhooks (bots that post into projects)");
  hook
    .command("create")
    .requiredOption("--name <name>", "bot name shown in Dooray")
    .option("--service <type>", HOOK_SERVICES.join("|"), "incoming")
    .option("--project <project>", "project code or id (repeatable)", collect)
    .action(async (o: { name: string; service: string; project?: string[] }) => {
      const serviceType = oneOf("--service", HOOK_SERVICES, o.service)!;
      const app = await ctx.app();
      const projectIds = [];
      for (const p of o.project ?? []) projectIds.push((await resolveProject(app.client, app.cache, p)).id);
      const r = await app.client.call<{ id: string; url: string }>("POST", "/common/v1/incoming-hooks", { body: { name: o.name, serviceType, projectIds } });
      app.printer.emit(r, { columns: ["ID", "URL"], rows: [[r.id, r.url]] });
    });
  hook.command("get <id>").action(async (id: string) => {
    const app = await ctx.app();
    const h = await app.client.call<{ id: string; name?: string; serviceType?: string; url?: string; projects?: { id: string }[] }>("GET", `/common/v1/incoming-hooks/${id}`);
    app.printer.emit(h, {
      columns: ["ID", "NAME", "SERVICE", "PROJECTS", "URL"],
      rows: [[h.id, cell(h.name), cell(h.serviceType), (h.projects ?? []).map((p) => p.id).join(", "), cell(h.url)]],
    });
  });
  hook
    .command("delete <id>")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (id: string, o: { yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete incoming hook ${id}?`, o.yes))) return;
      const app = await ctx.app();
      await app.client.call("DELETE", `/common/v1/incoming-hooks/${id}`);
      app.printer.info(`deleted incoming hook ${id}`);
    });
}
