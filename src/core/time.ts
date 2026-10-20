import { usageError } from "./errors.js";

// Dooray is a Korean service: inputs without an offset are KST. (The Go CLI read date-only
// values as UTC midnight, i.e. 09:00 KST.)
const KST = "+09:00";
const KST_MS = 9 * 3_600_000;
export const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/;

function checked(s: string, original = s): string {
  if (Number.isNaN(Date.parse(s))) throw usageError(`invalid date/time: ${original} (YYYY-MM-DD, "YYYY-MM-DD HH:MM" or ISO-8601)`);
  return s;
}

export const isDateOnly = (s: string): boolean => DATE_ONLY.test(s);

/** YYYY-MM-DD → that day 00:00:00 KST; ISO-8601 passes through. */
export const startOfDay = (s: string): string => checked(DATE_ONLY.test(s) ? `${s}T00:00:00${KST}` : s);

/** YYYY-MM-DD → that day 23:59:59 KST; ISO-8601 passes through. */
export const endOfDay = (s: string): string => checked(DATE_ONLY.test(s) ? `${s}T23:59:59${KST}` : s);

/** Date, local date-time ("2026-10-20 14:00") or ISO with offset → ISO-8601 with an explicit offset. */
export function toKst(s: string): string {
  if (DATE_ONLY.test(s)) return checked(`${s}T00:00:00${KST}`, s);
  const m = LOCAL_DATETIME.exec(s);
  if (m) return checked(`${m[1]}T${m[2]}${m[3] ?? ":00"}${KST}`, s);
  return checked(s);
}

/** Whole-day events/reservations use "YYYY-MM-DD+09:00". */
export const wholeDay = (s: string): string => {
  const iso = toKst(s);
  return `${iso.endsWith(KST) ? iso.slice(0, 10) : kstDate(new Date(iso))}${KST}`;
};

/** An instant formatted as ISO-8601 in KST, e.g. 2026-10-20T05:00:00+09:00. */
export const kstIso = (d: Date): string => new Date(d.getTime() + KST_MS).toISOString().slice(0, 19) + KST;

export const kstDate = (d: Date): string => kstIso(d).slice(0, 10);

export const addDays = (date: string, n: number): string => kstDate(new Date(Date.parse(`${date}T00:00:00${KST}`) + n * DAY_MS));

/**
 * --from/--to → [timeMin, timeMax). A date-only --to includes that whole day.
 * Defaults: now .. now + defaultDays.
 */
export function timeRange(from: string | undefined, to: string | undefined, defaultDays: number, now = new Date()): [string, string] {
  const start = from ? toKst(from) : kstIso(now);
  const end = to
    ? DATE_ONLY.test(to)
      ? `${addDays(to, 1)}T00:00:00${KST}`
      : toKst(to)
    : kstIso(new Date(Date.parse(start) + defaultDays * DAY_MS));
  if (Date.parse(end) <= Date.parse(start)) throw usageError("--to must be after --from");
  return [start, end];
}

/** Milliseconds for ISO-8601 or whole-day "YYYY-MM-DD+09:00" values (NaN-safe: unknown → 0). */
export function instant(s: string | undefined): number {
  const m = /^(\d{4}-\d{2}-\d{2})([+-]\d{2}:\d{2})$/.exec(s ?? "");
  const ms = Date.parse(m ? `${m[1]}T00:00:00${m[2]}` : (s ?? ""));
  return Number.isNaN(ms) ? 0 : ms;
}

/** Splits [from, to) into consecutive windows of at most `days` days. */
export function splitRange(from: string, to: string, days: number): [string, string][] {
  const end = Date.parse(to);
  const out: [string, string][] = [];
  let cur = from;
  while (Date.parse(cur) + days * DAY_MS < end) {
    const next = kstIso(new Date(Date.parse(cur) + days * DAY_MS));
    out.push([cur, next]);
    cur = next;
  }
  return [...out, [cur, to]];
}

const RELATIVE_FILTER = /^(today|thisweek|(prev|next)-[1-9]\d*d)$/;
// The server rejects date-only bounds, an open start (~B) and equal bounds (jon890/dooray-cli ADR-064),
// so ranges are always sent as full ISO A~B; open ends are filled with far bounds.
const OPEN_START = "1970-01-01T00:00:00Z";
const OPEN_END = "2999-12-31T23:59:59Z";

/**
 * --created/--updated/--due value → the posts API DATE_PATTERN: today | thisweek | prev-Nd | next-Nd |
 * A~B | A~ | ~B | a single date (that whole day). Dates are KST days.
 */
export function dateFilter(flag: string, value: string): string {
  if (RELATIVE_FILTER.test(value)) return value;
  const parts = DATE_ONLY.test(value) ? [value, value] : value.split("~");
  const [a, b] = parts as [string, string | undefined];
  if (parts.length !== 2 || (!a && !b)) {
    throw usageError(`${flag} ${value}: use today, thisweek, prev-7d, next-3d, 2026-10-01~2026-10-31, 2026-10-01~ or ~2026-10-31`);
  }
  const start = a ? toKst(a) : OPEN_START;
  const end = b ? (DATE_ONLY.test(b) ? `${b}T23:59:59${KST}` : toKst(b)) : OPEN_END;
  if (Date.parse(start) >= Date.parse(end)) throw usageError(`${flag}: start must be before end`);
  return `${start}~${end}`;
}
