import type { Command } from "commander";
import * as cal from "../api/calendar.js";
import type { CalendarEvent, CalendarMember } from "../api/calendar.js";
import type { App, Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { cell, type Table } from "../core/output.js";
import { resolveMember } from "../core/resolve.js";
import { timeRange, toKst, wholeDay } from "../core/time.js";
import { collect, confirmed, defined, oneOf, splitList } from "./common.js";
import { addRecurrenceOptions, alarms, recurrenceRule, scope, type RecurrenceOpts } from "./schedule-options.js";

const ROLES = ["delegatee", "all", "read_write", "view", "opaque_view"];
const POST_TYPES = ["toMe", "toCcMe", "fromToCcMe"];
const CATEGORIES = ["general", "post", "milestone"];

const eventTable = (events: CalendarEvent[]): Table => ({
  columns: ["ID", "SUBJECT", "START", "END", "CALENDAR"],
  rows: events.map((e) => [e.id, cell(e.subject), cell(e.startedAt), cell(e.endedAt), cell(e.calendar?.name)]),
});

interface EventOpts extends RecurrenceOpts {
  calendar?: string;
  subject?: string;
  from?: string;
  to?: string;
  body?: string;
  location?: string;
  wholeDay?: boolean;
  attendee?: string[];
  cc?: string[];
  emailAttendee?: string[];
  alarm?: string[];
  private?: boolean;
  free?: boolean;
}

function addEventOptions(cmd: Command): Command {
  cmd
    .option("--calendar <calendar>", "calendar id or name")
    .option("--subject <text>", "event subject")
    .option("--from <time>", 'start: YYYY-MM-DD, "YYYY-MM-DD HH:MM" (KST) or ISO-8601')
    .option("--to <time>", "end (same formats)")
    .option("--body <html>", "event body (HTML)")
    .option("--location <text>", "location")
    .option("--whole-day", "whole-day event")
    .option("--attendee <who>", "attendee: member id, name, email or 'me' (repeatable)", collect)
    .option("--cc <who>", "optional attendee (repeatable)", collect)
    .option("--email-attendee <email>", "external attendee by email (repeatable)", collect)
    .option("--alarm <minutes>", "mail alarm n minutes before (repeatable)", collect)
    .option("--private", "hide details from others (class=private)")
    .option("--free", "show as free instead of busy");
  return addRecurrenceOptions(cmd);
}

async function eventBody(app: App, o: EventOpts, isCreate: boolean): Promise<Record<string, unknown>> {
  const fmt = (s: string | undefined) => (s === undefined ? undefined : o.wholeDay ? wholeDay(s) : toKst(s));
  const member = async (who: string) => ({ type: "member", member: { organizationMemberId: await resolveMember(app.client, who) } });
  const to = [
    ...(await Promise.all((o.attendee ?? []).map(member))),
    ...(o.emailAttendee ?? []).map((emailAddress) => ({ type: "emailUser", emailUser: { emailAddress, name: "" } })),
  ];
  const cc = await Promise.all((o.cc ?? []).map(member));
  const users = to.length || cc.length ? defined({ to: to.length ? to : undefined, cc: cc.length ? cc : undefined }) : undefined;
  const settings = defined({ alarms: alarms(o.alarm), busy: o.free ? false : undefined, class: o.private ? "private" : undefined });
  // An event without a body is rejected (HTTP 500) on create; the Go CLI found this live.
  const body = o.body !== undefined || isCreate ? { mimeType: "text/html", content: o.body ?? "" } : undefined;
  return defined({
    subject: o.subject,
    body,
    startedAt: fmt(o.from),
    endedAt: fmt(o.to),
    wholeDayFlag: isCreate ? o.wholeDay === true : o.wholeDay,
    location: o.location,
    users,
    recurrenceRule: recurrenceRule(o),
    personalSettings: Object.keys(settings).length ? settings : undefined,
  });
}

export function registerCalendar(program: Command, ctx: Ctx): void {
  const cmd = program.command("calendar").description("calendars, events, sharing and busy hours");

  cmd
    .command("list")
    .description("list calendars")
    .action(async () => {
      const app = await ctx.app();
      const cals = await cal.listCalendars(app.client, app.limit);
      app.printer.emit(cals, {
        columns: ["ID", "NAME", "TYPE", "DEFAULT"],
        rows: cals.map((x) => [x.id, x.name, x.type, x.me?.default ? "*" : ""]),
      });
    });

  cmd
    .command("get <calendar>")
    .description("show a calendar (id or name), including its members")
    .action(async (ref: string) => {
      const app = await ctx.app();
      const c = await cal.getCalendar(app.client, await cal.resolveCalendar(app.client, ref));
      app.printer.emit(c, { columns: ["ID", "NAME", "TYPE"], rows: [[c.id, c.name, c.type]] });
    });

  cmd
    .command("create <name>")
    .description("create a private calendar, or a subscription calendar with --subscription-url")
    .option("--color <hex>", "your color for it, e.g. ff0000")
    .option("--subscription-url <url>", "iCal URL to subscribe to")
    .action(async (name: string, o: { color?: string; subscriptionUrl?: string }) => {
      const app = await ctx.app();
      const body = o.subscriptionUrl
        ? defined({ name, type: "subscription", calendarUrl: o.subscriptionUrl, me: o.color ? { color: o.color } : undefined })
        : defined({ name, type: "private", me: o.color ? { color: o.color } : undefined });
      const { id } = await cal.createCalendar(app.client, body);
      app.printer.emit({ id, name }, { columns: ["ID", "NAME"], rows: [[id, name]] });
    });

  cmd
    .command("delete <calendar>")
    .description("delete a calendar")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, o: { yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete calendar ${ref}?`, o.yes))) return;
      const app = await ctx.app();
      await cal.deleteCalendar(app.client, await cal.resolveCalendar(app.client, ref));
      app.printer.info(`deleted calendar ${ref}`);
    });

  cmd
    .command("members <calendar>")
    .description("show sharing members, or replace them all with --member/--group")
    .option("--member <who=role>", `member (id, name, email, me) = ${ROLES.join("|")} (repeatable)`, collect)
    .option("--group <email=role>", "mailing list address = role (repeatable)", collect)
    .option("-y, --yes", "do not ask before replacing the member list")
    .action(async (ref: string, o: { member?: string[]; group?: string[]; yes?: boolean }) => {
      const pairs = [...(o.member ?? []).map((v) => ["member", v] as const), ...(o.group ?? []).map((v) => ["group", v] as const)];
      const parsed = pairs.map(([kind, v]) => {
        const i = v.lastIndexOf("=");
        const [who, role] = [v.slice(0, i), v.slice(i + 1)];
        if (i < 1 || !ROLES.includes(role)) throw usageError(`--${kind} ${v}: expected <who>=<${ROLES.join("|")}>`);
        return { kind, who, role };
      });
      const app = await ctx.app();
      const id = await cal.resolveCalendar(app.client, ref);
      if (!parsed.length) {
        const list = (await cal.getCalendar(app.client, id)).calendarMemberList ?? [];
        app.printer.emit(list, {
          columns: ["TYPE", "WHO", "ROLE"],
          rows: list.map((m) => [m.type, cell(m.member?.organizationMemberId ?? m.distributionList?.emailAddress), m.role]),
        });
        return;
      }
      if (!(await confirmed(ctx, `replace all sharing members of calendar ${ref}?`, o.yes))) return;
      const list: CalendarMember[] = [];
      for (const p of parsed) {
        list.push(
          p.kind === "member"
            ? { type: "member", member: { organizationMemberId: await resolveMember(app.client, p.who) }, role: p.role }
            : { type: "distributionList", distributionList: { emailAddress: p.who }, role: p.role },
        );
      }
      await cal.setCalendarMembers(app.client, id, list);
      app.printer.info(`set ${list.length} member(s) on calendar ${ref}`);
    });

  cmd
    .command("busy <members...>")
    .description("busy hours of up to 20 members (range under 7 days; default: next 24h)")
    .option("--from <time>", "range start (default now)")
    .option("--to <time>", "range end (date-only = through that day)")
    .action(async (members: string[], o: { from?: string; to?: string }) => {
      const [begin, end] = timeRange(o.from, o.to, 1);
      const app = await ctx.app();
      const ids = [];
      for (const m of members) ids.push(await resolveMember(app.client, m));
      const res = await cal.fetchBusyHours(app.client, ids, begin, end);
      app.printer.emit(res, {
        columns: ["MEMBER", "START", "END"],
        rows: res.flatMap((r) => (r.busyHours ?? []).map((b) => [r.member.name ?? r.member.id, b.startedAt, b.endedAt])),
      });
    });

  registerEvents(cmd, ctx);
}

function registerEvents(parent: Command, ctx: Ctx): void {
  const ev = parent.command("event").description("calendar events");

  ev.command("list")
    .description("list events (default: now .. +7 days; long ranges are fetched in 50-day windows)")
    .option("--calendar <calendar>", "calendar id or name (repeatable or comma separated)", collect)
    .option("--from <time>", "range start")
    .option("--to <time>", "range end (date-only = through that day)")
    .option("--post-type <type>", POST_TYPES.join("|"))
    .option("--category <category>", CATEGORIES.join("|"))
    .action(async (o: { calendar?: string[]; from?: string; to?: string; postType?: string; category?: string }) => {
      const [timeMin, timeMax] = timeRange(o.from, o.to, 7);
      const q = { timeMin, timeMax, postType: oneOf("--post-type", POST_TYPES, o.postType), category: oneOf("--category", CATEGORIES, o.category) };
      const app = await ctx.app();
      const calendars = [];
      for (const ref of splitList(o.calendar)) calendars.push(await cal.resolveCalendar(app.client, ref));
      const events = await cal.listEvents(app.client, { ...q, calendars }, app.limit);
      app.printer.emit(events, eventTable(events));
    });

  ev.command("get <eventId>")
    .description("show an event")
    .requiredOption("--calendar <calendar>", "calendar id or name")
    .action(async (eventId: string, o: { calendar: string }) => {
      const app = await ctx.app();
      const e = await cal.getEvent(app.client, await cal.resolveCalendar(app.client, o.calendar), eventId);
      app.printer.emit(e, eventTable([e]));
    });

  addEventOptions(ev.command("create").description("create an event (default calendar unless --calendar)")).action(async (o: EventOpts) => {
    if (!o.subject || !o.from || !o.to) throw usageError("create needs --subject, --from and --to");
    const app = await ctx.app();
    const calendarId = await cal.resolveCalendar(app.client, o.calendar);
    const { id } = await cal.createEvent(app.client, calendarId, await eventBody(app, o, true));
    app.printer.emit({ id, calendarId }, { columns: ["ID", "CALENDAR_ID"], rows: [[id, calendarId]] });
  });

  addEventOptions(ev.command("update <eventId>").description("update an event (only the given fields)")).action(
    async (eventId: string, o: EventOpts) => {
      if (!o.calendar) throw usageError("update needs --calendar");
      const app = await ctx.app();
      const calendarId = await cal.resolveCalendar(app.client, o.calendar);
      await cal.updateEvent(app.client, calendarId, eventId, await eventBody(app, o, false));
      app.printer.info(`updated event ${eventId}`);
    },
  );

  ev.command("delete <eventId>")
    .description("delete an event (recurring: --delete-type this|wholeFromThis|whole)")
    .requiredOption("--calendar <calendar>", "calendar id or name")
    .option("--delete-type <type>", "this|wholeFromThis|whole", "this")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (eventId: string, o: { calendar: string; deleteType: string; yes?: boolean }) => {
      const deleteType = scope("--delete-type", o.deleteType)!;
      if (!(await confirmed(ctx, `delete event ${eventId} (${deleteType})?`, o.yes))) return;
      const app = await ctx.app();
      await cal.deleteEvent(app.client, await cal.resolveCalendar(app.client, o.calendar), eventId, deleteType);
      app.printer.info(`deleted event ${eventId}`);
    });
}
