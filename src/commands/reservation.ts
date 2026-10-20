import type { Command } from "commander";
import * as rv from "../api/reservation.js";
import type { Reservation, Resource } from "../api/reservation.js";
import type { App, Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { cell, type Table } from "../core/output.js";
import { timeRange, toKst, wholeDay } from "../core/time.js";
import { collect, confirmed, defined, oneOf, splitList } from "./common.js";
import { addRecurrenceOptions, alarms, recurrenceRule, scope, type RecurrenceOpts } from "./schedule-options.js";

const CLASSES = ["public", "private"];

const resourceTable = (rs: Resource[]): Table => ({
  columns: ["ID", "NAME", "USE"],
  rows: rs.map((r) => [r.id, r.name, r.use === undefined ? "" : r.use ? "yes" : "no"]),
});

const reservationTable = (rs: Reservation[]): Table => ({
  columns: ["ID", "RESOURCE", "SUBJECT", "START", "END"],
  rows: rs.map((r) => [r.id, cell(r.resource?.name), cell(r.subject), cell(r.startedAt), cell(r.endedAt)]),
});

interface ReservationOpts extends RecurrenceOpts {
  resource?: string;
  subject?: string;
  from?: string;
  to?: string;
  wholeDay?: boolean;
  class?: string;
  alarm?: string[];
  updateType?: string;
}

function addReservationOptions(cmd: Command): Command {
  cmd
    .option("--subject <text>", "subject")
    .option("--from <time>", 'start: YYYY-MM-DD, "YYYY-MM-DD HH:MM" (KST) or ISO-8601')
    .option("--to <time>", "end (same formats)")
    .option("--whole-day", "whole-day reservation")
    .option("--class <class>", "visibility: public|private")
    .option("--alarm <minutes>", "mail alarm n minutes before (repeatable)", collect);
  return addRecurrenceOptions(cmd);
}

function reservationBody(o: ReservationOpts, isCreate: boolean): Record<string, unknown> {
  const fmt = (s: string | undefined) => (s === undefined ? undefined : o.wholeDay ? wholeDay(s) : toKst(s));
  return defined({
    resourceId: o.resource,
    subject: o.subject,
    startedAt: fmt(o.from),
    endedAt: fmt(o.to),
    wholeDayFlag: isCreate ? o.wholeDay === true : o.wholeDay,
    class: oneOf("--class", CLASSES, o.class),
    alarms: alarms(o.alarm),
    recurrenceRule: recurrenceRule(o),
  });
}

async function categoryId(app: App, ref: string | undefined): Promise<string | undefined> {
  return ref === undefined ? undefined : rv.resolveCategory(app.client, ref);
}

export function registerReservation(program: Command, ctx: Ctx): void {
  const cmd = program.command("reservation").description("resource (room, equipment, vehicle) reservations");
  const res = cmd.command("resource").description("resources and resource categories");

  res
    .command("list")
    .description("list resource categories (as in the Go CLI)")
    .action(async () => {
      const app = await ctx.app();
      const cats = await rv.listCategories(app.client, app.limit);
      app.printer.emit(cats, { columns: ["ID", "TYPE", "NAME"], rows: cats.map((c) => [c.id, c.type, c.name]) });
    });

  res
    .command("reservable")
    .description("resources you may reserve")
    .option("--category <category>", "category id or name")
    .action(async (o: { category?: string }) => {
      const app = await ctx.app();
      const rs = await rv.listReservable(app.client, await categoryId(app, o.category), app.limit);
      app.printer.emit(rs, resourceTable(rs));
    });

  res
    .command("all")
    .description("every resource in use (reservation managers only)")
    .option("--category <category>", "category id or name")
    .action(async (o: { category?: string }) => {
      const app = await ctx.app();
      const rs = await rv.listAllResources(app.client, await categoryId(app, o.category), app.limit);
      app.printer.emit(rs, resourceTable(rs));
    });

  res
    .command("get <resourceId>")
    .description("show a resource")
    .action(async (id: string) => {
      const app = await ctx.app();
      const r = await rv.getResource(app.client, id);
      app.printer.emit(r, resourceTable([r]));
    });

  cmd
    .command("list")
    .description("list reservations (default: now .. +7 days)")
    .option("--resource <id>", "resource id(s), repeatable or comma separated (default: all)", collect)
    .option("--from <time>", "range start")
    .option("--to <time>", "range end (date-only = through that day)")
    .action(async (o: { resource?: string[]; from?: string; to?: string }) => {
      const [timeMin, timeMax] = timeRange(o.from, o.to, 7);
      const app = await ctx.app();
      const rs = await rv.listReservations(app.client, timeMin, timeMax, splitList(o.resource), app.limit);
      app.printer.emit(rs, reservationTable(rs));
    });

  cmd
    .command("get <reservationId>")
    .description("show a reservation (recurring occurrence: <id>-<yyyyMMddTHHmmssZ>)")
    .action(async (id: string) => {
      const app = await ctx.app();
      const r = await rv.getReservation(app.client, id);
      app.printer.emit(r, reservationTable([r]));
    });

  addReservationOptions(cmd.command("create").description("reserve a resource").requiredOption("--resource <id>", "resource id")).action(
    async (o: ReservationOpts) => {
      if (!o.subject || !o.from || !o.to) throw usageError("create needs --subject, --from and --to");
      const app = await ctx.app();
      const r = await rv.createReservation(app.client, reservationBody(o, true));
      app.printer.emit(r, { columns: ["ID", "MASTER_ID"], rows: [[r.id, cell(r.masterResourceReservationId)]] });
    },
  );

  addReservationOptions(
    cmd
      .command("update <reservationId>")
      .description("update a reservation (only the given fields)")
      .option("--update-type <type>", "recurring: whole|this|wholeFromThis (a --repeat change needs whole)"),
  ).action(async (id: string, o: ReservationOpts) => {
    const updateType = scope("--update-type", o.updateType);
    if (o.repeat && updateType && updateType !== "whole") throw usageError("changing the recurrence needs --update-type whole");
    const body = { ...reservationBody(o, false), ...defined({ updateType: updateType ?? (o.repeat ? "whole" : undefined) }) };
    const app = await ctx.app();
    await rv.updateReservation(app.client, id, body);
    app.printer.info(`updated reservation ${id}`);
  });

  cmd
    .command("cancel <reservationId>")
    .description("cancel a reservation")
    .option("--delete-type <type>", "recurring: this|wholeFromThis|whole (empty for a single reservation)")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (id: string, o: { deleteType?: string; yes?: boolean }) => {
      const deleteType = scope("--delete-type", o.deleteType) ?? "";
      if (!(await confirmed(ctx, `cancel reservation ${id}?`, o.yes))) return;
      const app = await ctx.app();
      await rv.cancelReservation(app.client, id, deleteType);
      app.printer.info(`cancelled reservation ${id}`);
    });
}
