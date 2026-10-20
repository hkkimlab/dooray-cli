import { HOUR, type Cache } from "../core/cache.js";
import type { Client } from "../core/client.js";
import { apiError, DoorayError, EXIT_API, errorMessage } from "../core/errors.js";
import { isId, matchByName } from "../core/resolve.js";
import { instant } from "../core/time.js";

export interface Channel {
  id: string;
  title?: string | null;
  type?: string;
  status?: string;
  displayed?: boolean;
  updatedAt?: string;
}

export interface MessageLog {
  id: string;
  seq?: number;
  type?: string;
  sentAt?: string;
  text?: string;
  sender?: { member?: { organizationMemberId: string; name?: string } };
}

const M = "/messenger/v1/channels";

/** The server ignores paging here and returns every channel. */
export const listChannels = (c: Client): Promise<Channel[]> => c.list(M);
export const sendDirect = (c: Client, organizationMemberId: string, text: string): Promise<{ id?: string } | null> =>
  c.call("POST", `${M}/direct-send`, { body: { text, organizationMemberId } });
export const sendToChannel = (c: Client, ch: string, text: string): Promise<{ id: string; channelId?: string }> =>
  c.call("POST", `${M}/${ch}/logs`, { body: { text } });
export const createChannel = (c: Client, body: Record<string, unknown>): Promise<{ id: string }> =>
  c.call("POST", M, { query: { idType: "member-id" }, body });
export const joinChannel = (c: Client, ch: string, memberIds: string[]): Promise<null> =>
  c.call("POST", `${M}/${ch}/members/join`, { body: { memberIds } });
export const leaveChannel = (c: Client, ch: string, memberIds: string[]): Promise<null> =>
  c.call("POST", `${M}/${ch}/members/leave`, { body: { memberIds } });
export interface LogsPage {
  logs: MessageLog[];
  /** older messages exist (missing ⇒ false) */
  hasMore: boolean;
}

/** Largest page the logs endpoint returns. */
export const LOGS_PAGE_MAX = 1000;

/**
 * Undocumented endpoint (jon890/dooray-cli ADR-061). Newest first, at most LOGS_PAGE_MAX (larger sizes
 * are capped silently). `logId` returns the messages older than that one (exclusive); direction/page/
 * before and date filters are ignored by the server.
 */
export async function listLogsPage(c: Client, ch: string, q: { size: number; logId?: string }): Promise<LogsPage> {
  const env = await c.envelope<MessageLog[] | null>("GET", `${M}/${ch}/logs`, { query: q });
  return { logs: env.result ?? [], hasMore: env.hasMore === true };
}

export interface FetchLogsOpts {
  /** newest n messages inside [since, until]; undefined = all of them */
  count?: number;
  /** sentAt bounds in epoch ms, both inclusive; the server cannot filter, so this is done here */
  since?: number;
  until?: number;
  onPage?: (pages: number, fetched: number, oldestSentAt: string | undefined) => void;
}

/**
 * Walks back from the newest message with logId until hasMore=false, the count is met, a page reaches
 * past `since`, an empty page, or a repeated logId. Deduped by id; returned oldest first.
 * `latestSeq` is the channel's newest seq (an upper bound on its message count, not the count).
 */
export async function fetchLogs(c: Client, ch: string, o: FetchLogsOpts): Promise<{ logs: MessageLog[]; latestSeq?: number }> {
  const inRange = (l: MessageLog) => (o.since === undefined || instant(l.sentAt) >= o.since) && (o.until === undefined || instant(l.sentAt) <= o.until);
  const seen = new Set<string>();
  const asked = new Set<string>();
  let kept: MessageLog[] = [];
  let latestSeq: number | undefined;
  let logId: string | undefined;
  for (let pages = 1; ; pages++) {
    // With --until the newer, out-of-range messages also take room in a page, so ask for full pages.
    const want = o.count === undefined || o.until !== undefined ? LOGS_PAGE_MAX : Math.min(LOGS_PAGE_MAX, o.count - kept.length);
    const page = await listLogsPage(c, ch, { size: want, logId });
    latestSeq ??= page.logs[0]?.seq;
    const fresh = page.logs.filter((l) => !seen.has(l.id));
    fresh.forEach((l) => seen.add(l.id));
    kept = [...kept, ...fresh.filter(inRange)].slice(0, o.count);
    const oldest = page.logs.at(-1);
    o.onPage?.(pages, seen.size, oldest?.sentAt);
    if (logId) asked.add(logId);
    const done =
      !page.hasMore ||
      !oldest ||
      (o.count !== undefined && kept.length >= o.count) ||
      (o.since !== undefined && instant(oldest.sentAt) < o.since) ||
      asked.has(oldest.id);
    if (done) return { logs: [...kept].reverse(), latestSeq };
    logId = oldest.id;
  }
}
export const createThread = (c: Client, ch: string, text: string, threadText?: string): Promise<{ id: string; channelId: string }> =>
  c.call("POST", `${M}/${ch}/threads/create-and-send`, { body: { text, ...(threadText && { threadText }) } });
export const threadOnLog = (c: Client, ch: string, log: string, text: string): Promise<{ id: string; channelId: string }> =>
  c.call("POST", `${M}/${ch}/logs/${log}/threads/create-and-send`, { body: { text } });
export const reply = (c: Client, ch: string, log: string, text: string): Promise<{ id: string; channelId: string }> =>
  c.call("POST", `${M}/${ch}/logs/${log}/reply`, { body: { text } });
export const editLog = (c: Client, ch: string, log: string, text: string): Promise<null> => c.call("PUT", `${M}/${ch}/logs/${log}`, { body: { text } });
export const deleteLog = (c: Client, ch: string, log: string): Promise<null> => c.call("DELETE", `${M}/${ch}/logs/${log}`);

/** Channel id or title (only channels with a title can be matched by name). */
export async function resolveChannel(c: Client, cache: Cache, ref: string): Promise<string> {
  if (isId(ref)) return ref;
  const titled = (await cache.get("channels", HOUR, () => listChannels(c))).filter((ch) => ch.title);
  return matchByName(titled, ref, { kind: "channel", name: (ch) => ch.title ?? "", id: (ch) => ch.id }).id;
}

/** Incoming webhook: the URL is the credential, so no Authorization header is sent. */
export async function sendHook(fetchFn: typeof fetch, url: string, body: { botName: string; text: string }): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new DoorayError(EXIT_API, `network: ${errorMessage(e)}`);
  }
  await res.body?.cancel();
  if (res.status >= 400) throw apiError(res.status, `hook send failed ${res.status}`);
}
