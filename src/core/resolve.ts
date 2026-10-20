import { HOUR, type Cache } from "./cache.js";
import type { Client } from "./client.js";
import { notFound, usageError } from "./errors.js";

/** Dooray ids are 15+ digit numbers; anything shorter is a name, code or post number. */
export const isId = (s: string): boolean => /^\d{15,}$/.test(s);

export interface MatchOpts<T> {
  kind: string;
  name: (t: T) => string;
  id: (t: T) => string;
}

const MAX_SAMPLES = 5;

/**
 * Exact name first, then a unique case-insensitive partial match.
 * Several matches stop with the candidate list (usage error); none is not-found.
 */
export function matchByName<T>(items: readonly T[], query: string, o: MatchOpts<T>): T {
  const exact = items.filter((t) => o.name(t) === query);
  if (exact.length === 1) return exact[0]!;
  const q = query.toLowerCase();
  const pool = exact.length > 1 ? exact : items.filter((t) => o.name(t).toLowerCase().includes(q));
  if (pool.length === 1) return pool[0]!;
  const list = (ts: readonly T[]) => ts.map((t) => `  - ${o.name(t)} (${o.id(t)})`).join("\n");
  if (pool.length > 1) {
    throw usageError(`${pool.length} ${o.kind}s match '${query}'; use the id or a more specific name:\n${list(pool)}`);
  }
  const samples = items.length ? `\ncandidates:\n${list(items.slice(0, MAX_SAMPLES))}` : "";
  throw notFound(`no ${o.kind} matches '${query}'${samples}`);
}

export type DoorayUrl =
  | { kind: "post"; postId: string; projectId?: string }
  | { kind: "wiki"; wikiId: string; pageId: string }
  | { kind: "mail"; mailbox: string | null; mailId: string };

const DOORAY_HOST = /^([\w-]+\.)*(gov-)?dooray\.(com|co\.kr)$/;

/** Parses task/wiki/mail URLs from commercial and gov Dooray hosts. */
export function parseDoorayUrl(input: string): DoorayUrl | null {
  if (!URL.canParse(input)) return null;
  const u = new URL(input);
  if (!/^https?:$/.test(u.protocol) || !DOORAY_HOST.test(u.hostname)) return null;
  const p = u.pathname.split("/").filter(Boolean);
  const id = (s: string | undefined) => (s && /^\d+$/.test(s) ? s : undefined);
  const [a, b, c, d] = p;
  if (a === "task" && b === "to" && id(c)) return { kind: "post", postId: c! };
  if (a === "task" && id(b) && id(c)) return { kind: "post", projectId: b!, postId: c! };
  if (a === "project" && b === "tasks" && id(c)) return { kind: "post", postId: c! };
  if (a === "project" && b && isId(b) && c && isId(c) && !d) return { kind: "post", projectId: b, postId: c };
  if (a === "wiki" && id(b) && id(c)) return { kind: "wiki", wikiId: b!, pageId: c! };
  if (a === "mail") {
    const last = p.at(-1);
    if (!last || !/^\d{15,}$/.test(last)) return null;
    return { kind: "mail", mailbox: b === "systems" && p.length === 4 ? c! : null, mailId: last };
  }
  return null;
}

export interface ProjectRef {
  id: string;
  code: string;
  wikiId?: string;
  driveId?: string;
}

interface ApiProject {
  id: string;
  code: string;
  wiki?: { id?: string };
  drive?: { id?: string };
}

const toRef = (p: ApiProject): ProjectRef => ({ id: p.id, code: p.code, wikiId: p.wiki?.id, driveId: p.drive?.id });

/** Project id/code → ref. My projects first, then the private list (private projects only appear there). */
export async function resolveProject(client: Client, cache: Cache, input: string): Promise<ProjectRef> {
  if (isId(input)) return { id: input, code: input };
  const opts = { kind: "project", name: (p: ProjectRef) => p.code, id: (p: ProjectRef) => p.id };
  const mine = await cache.get("projects", HOUR, async () =>
    (await client.list<ApiProject>("/project/v1/projects", { member: "me" })).map(toRef),
  );
  if (mine.some((p) => p.code.toLowerCase().includes(input.toLowerCase()))) return matchByName(mine, input, opts);
  const priv = await cache.get("projects-private", HOUR, async () =>
    (await client.list<ApiProject>("/project/v1/projects", { member: "me", type: "private" })).map(toRef),
  );
  return matchByName([...mine, ...priv], input, opts);
}

interface ApiMember {
  id: string;
  name: string;
  userCode?: string;
  externalEmailAddress?: string;
}

/** id → name for each distinct id (one members/{id} call each; failures fall back to the id). */
export async function memberNames(client: Client, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = await Promise.all(
    unique.map((id) => client.call<ApiMember>("GET", `/common/v1/members/${id}`).then((m) => m.name, () => id)),
  );
  return new Map(unique.map((id, i) => [id, names[i]!]));
}

/** me | id | email | name → organization member id (common member id == organizationMemberId). */
export async function resolveMember(client: Client, input: string): Promise<string> {
  if (isId(input)) return input;
  if (input.toLowerCase() === "me") return (await client.call<ApiMember>("GET", "/common/v1/members/me")).id;
  const query = input.includes("@") ? { externalEmailAddresses: input } : { name: input };
  const found = await client.list<ApiMember>("/common/v1/members", query);
  return matchByName(found, input, {
    kind: "member",
    name: (m) => (input.includes("@") ? (m.externalEmailAddress ?? "") : m.name),
    id: (m) => `${m.id}${m.userCode ? ", " + m.userCode : ""}`,
  }).id;
}
