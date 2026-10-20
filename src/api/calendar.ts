import type { Client } from "../core/client.js";
import { notFound } from "../core/errors.js";
import { isId, matchByName } from "../core/resolve.js";
import { instant, splitRange } from "../core/time.js";

export interface Calendar {
  id: string;
  name: string;
  type: string;
  me?: { default?: boolean; role?: string; color?: string };
  calendarMemberList?: CalendarMember[];
}

export interface CalendarMember {
  type: "member" | "distributionList";
  member?: { organizationMemberId: string };
  distributionList?: { emailAddress: string };
  role: string;
}

export interface CalendarEvent {
  id: string;
  subject?: string;
  startedAt?: string;
  endedAt?: string;
  calendar?: { id: string; name?: string };
}

export interface EventQuery {
  timeMin: string;
  timeMax: string;
  calendars?: string[];
  postType?: string;
  category?: string;
}

// Measured on gov-dooray (and jon890/dooray-cli ADR-063): ranges over ~50 days fail with
// USER_INVALID_EXCEED_MAXIMUM_PERIOD although the doc says one year.
const MAX_RANGE_DAYS = 50;

const CALS = "/calendar/v1/calendars";

export const listCalendars = (c: Client, limit = 0): Promise<Calendar[]> => c.list<Calendar>(CALS, {}, limit);
export const getCalendar = (c: Client, id: string): Promise<Calendar> => c.call("GET", `${CALS}/${id}`);
export const createCalendar = (c: Client, body: Record<string, unknown>): Promise<{ id: string }> => c.call("POST", CALS, { body });
export const deleteCalendar = (c: Client, id: string): Promise<null> => c.call("DELETE", `${CALS}/${id}`);
export const setCalendarMembers = (c: Client, id: string, calendarMemberList: CalendarMember[]): Promise<null> =>
  c.call("PUT", `${CALS}/${id}/members`, { body: { calendarMemberList } });

/** Lists events sorted by start, splitting long ranges into server-acceptable windows and de-duplicating. */
export async function listEvents(c: Client, q: EventQuery, limit = 0): Promise<CalendarEvent[]> {
  const seen = new Set<string>();
  let all: CalendarEvent[] = [];
  for (const [timeMin, timeMax] of splitRange(q.timeMin, q.timeMax, MAX_RANGE_DAYS)) {
    // This endpoint ignores page/size and returns the whole window at once (no totalCount).
    const batch =
      (await c.call<CalendarEvent[] | null>("GET", `${CALS}/*/events`, {
        query: { timeMin, timeMax, calendars: q.calendars, postType: q.postType, category: q.category },
      })) ?? [];
    const fresh = batch.filter((e) => !seen.has(`${e.id}@${e.startedAt}`));
    fresh.forEach((e) => seen.add(`${e.id}@${e.startedAt}`));
    all = [...all, ...fresh];
    if (limit > 0 && all.length >= limit) break;
  }
  const sorted = [...all].sort((a, b) => instant(a.startedAt) - instant(b.startedAt));
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

const eventPath = (calendarId: string, eventId: string) => `${CALS}/${calendarId}/events/${eventId}`;

export const getEvent = (c: Client, calendarId: string, eventId: string): Promise<CalendarEvent> =>
  c.call("GET", eventPath(calendarId, eventId));
export const createEvent = (c: Client, calendarId: string, body: Record<string, unknown>): Promise<{ id: string }> =>
  c.call("POST", `${CALS}/${calendarId}/events`, { body });
/** The server only updates non-empty fields. */
export const updateEvent = (c: Client, calendarId: string, eventId: string, body: Record<string, unknown>): Promise<null> =>
  c.call("PUT", eventPath(calendarId, eventId), { body });
/** Dooray deletes events with POST .../delete, not HTTP DELETE. */
export const deleteEvent = (c: Client, calendarId: string, eventId: string, deleteType: string): Promise<null> =>
  c.call("POST", `${eventPath(calendarId, eventId)}/delete`, { body: { deleteType } });

export interface BusyHours {
  member: { id: string; name?: string };
  busyHours?: { startedAt: string; endedAt: string }[];
}

/** Range must be under 7 days, at most 20 members. */
export const fetchBusyHours = (c: Client, organizationMemberIds: string[], beginDateTime: string, endDateTime: string): Promise<BusyHours[]> =>
  c.call("POST", "/calendar/v1/fetch-busy-hours", { body: { organizationMemberIds, beginDateTime, endDateTime } });

/** Calendar id or name → id. Without a ref, the member's default calendar. */
export async function resolveCalendar(c: Client, ref: string | undefined): Promise<string> {
  if (ref && isId(ref)) return ref;
  const cals = await listCalendars(c);
  if (!ref) {
    const def = cals.find((x) => x.me?.default);
    if (!def) throw notFound("no default calendar; pass --calendar");
    return def.id;
  }
  return matchByName(cals, ref, { kind: "calendar", name: (x) => x.name, id: (x) => x.id }).id;
}
