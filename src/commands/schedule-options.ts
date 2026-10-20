// Options shared by calendar events and reservations: recurrence, alarms, delete/update scope.
import type { Command } from "commander";
import { usageError } from "../core/errors.js";
import { endOfDay } from "../core/time.js";
import { oneOf } from "./common.js";

export const SCOPES = ["this", "wholeFromThis", "whole"] as const;
const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];

export interface RecurrenceOpts {
  repeat?: string;
  interval?: string;
  until?: string;
  byday?: string;
  bymonthday?: string;
  bymonth?: string;
}

export function addRecurrenceOptions(cmd: Command): Command {
  return cmd
    .option("--repeat <frequency>", "repeat: daily|weekly|monthly|yearly")
    .option("--interval <n>", "repeat every n periods (default 1)")
    .option("--until <date>", "last repetition (YYYY-MM-DD or ISO-8601)")
    .option("--byday <days>", "e.g. MO,WE or 1MO / -1FR")
    .option("--bymonthday <days>", "1-31, comma separated")
    .option("--bymonth <months>", "1-12, comma separated");
}

export function recurrenceRule(o: RecurrenceOpts): Record<string, unknown> | undefined {
  if (!o.repeat) {
    if (o.interval || o.until || o.byday || o.bymonthday || o.bymonth) throw usageError("--interval/--until/--by* need --repeat");
    return undefined;
  }
  if (!FREQUENCIES.includes(o.repeat)) throw usageError(`--repeat must be one of ${FREQUENCIES.join("|")}`);
  const interval = o.interval === undefined ? 1 : Number(o.interval);
  if (!Number.isInteger(interval) || interval < 1) throw usageError("--interval must be a positive integer");
  return {
    frequency: o.repeat,
    interval,
    ...(o.until && { until: endOfDay(o.until) }),
    ...(o.byday && { byday: o.byday }),
    ...(o.bymonthday && { bymonthday: o.bymonthday }),
    ...(o.bymonth && { bymonth: o.bymonth }),
    timezoneName: "Asia/Seoul",
  };
}

/** --alarm <minutes before> (repeatable) → mail alarms. */
export function alarms(minutes: string[] | undefined): { action: string; trigger: string }[] | undefined {
  if (!minutes?.length) return undefined;
  return minutes.map((m) => {
    if (!/^\d+$/.test(m)) throw usageError("--alarm takes minutes before the start, e.g. 10");
    return { action: "mail", trigger: `TRIGGER:-PT${m}M` };
  });
}

export const scope = (flag: string, v: string | undefined): string | undefined => oneOf(flag, SCOPES, v);
