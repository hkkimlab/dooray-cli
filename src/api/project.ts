import { DAY, type Cache } from "../core/cache.js";
import type { Client } from "../core/client.js";
import { isId, matchByName } from "../core/resolve.js";

export interface Project {
  id: string;
  code: string;
  description?: string;
  state?: string;
  scope?: string;
  type?: string;
  wiki?: { id?: string };
  drive?: { id?: string };
}

export interface Milestone {
  id: string;
  name: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface Workflow {
  id: string;
  name: string;
  class: string;
  order?: number;
}

export interface Tag {
  id: string;
  name?: string;
  color?: string;
  tagGroup?: { id: string; name?: string; mandatory?: boolean; selectOne?: boolean } | null;
}

export interface MemberGroup {
  id: string;
  code?: string;
  members?: { organizationMember?: { id: string; name?: string } }[];
}

export interface Template {
  id: string;
  templateName?: string;
  subject?: string;
  body?: { mimeType: string; content: string };
  users?: { to?: unknown[]; cc?: unknown[] };
  tags?: { id: string }[];
  tagIds?: string[];
  milestone?: { id: string } | null;
  priority?: string;
}

const P = "/project/v1/projects";
const p = (id: string) => `${P}/${id}`;

// ---- projects ----
export const listProjects = (c: Client, q: { member?: string; type?: string; scope?: string; state?: string }, limit = 0): Promise<Project[]> =>
  c.list(P, q, limit);
export const getProject = (c: Client, id: string): Promise<Project> => c.call("GET", p(id));
export const createProject = (c: Client, body: { code: string; description?: string; scope?: string }): Promise<{ id: string }> =>
  c.call("POST", P, { body });
export const updateProject = (c: Client, id: string, body: Record<string, unknown>): Promise<null> => c.call("PUT", p(id), { body });
export const setProjectState = (c: Client, id: string, state: "archive" | "active"): Promise<null> => c.call("POST", `${p(id)}/set-${state}`);
export const isCreatable = (c: Client, code: string): Promise<unknown> => c.call("POST", `${P}/is-creatable`, { body: { code } });
export const listCategories = (c: Client): Promise<{ id: string; name: string; parentProjectCategoryId?: string | null }[]> =>
  c.call("GET", "/project/v1/project-categories");

// ---- milestones ----
export const listMilestones = (c: Client, pid: string, limit = 0): Promise<Milestone[]> => c.list(`${p(pid)}/milestones`, {}, limit);
export const getMilestone = (c: Client, pid: string, id: string): Promise<Milestone> => c.call("GET", `${p(pid)}/milestones/${id}`);
export const createMilestone = (c: Client, pid: string, body: Record<string, unknown>): Promise<{ id: string }> =>
  c.call("POST", `${p(pid)}/milestones`, { body });
export const updateMilestone = (c: Client, pid: string, id: string, body: Record<string, unknown>): Promise<null> =>
  c.call("PUT", `${p(pid)}/milestones/${id}`, { body });
export const deleteMilestone = (c: Client, pid: string, id: string): Promise<null> => c.call("DELETE", `${p(pid)}/milestones/${id}`);

// ---- workflows ----
export const listWorkflows = (c: Client, pid: string): Promise<Workflow[]> => c.list(`${p(pid)}/workflows`);
export const createWorkflow = (c: Client, pid: string, body: Record<string, unknown>): Promise<null> =>
  c.call("POST", `${p(pid)}/workflows`, { body });
export const updateWorkflow = (c: Client, pid: string, id: string, body: Record<string, unknown>): Promise<null> =>
  c.call("PUT", `${p(pid)}/workflows/${id}`, { body });
/** Posts in the deleted workflow move to toBeWorkflowId. */
export const deleteWorkflow = (c: Client, pid: string, id: string, toBeWorkflowId: string): Promise<null> =>
  c.call("POST", `${p(pid)}/workflows/${id}/delete`, { body: { toBeWorkflowId } });

// ---- tags ----
export const listTags = (c: Client, pid: string, limit = 0): Promise<Tag[]> => c.list(`${p(pid)}/tags`, {}, limit);
export const getTag = (c: Client, pid: string, id: string): Promise<Tag> => c.call("GET", `${p(pid)}/tags/${id}`);
export const createTag = (c: Client, pid: string, body: { name: string; color?: string }): Promise<{ id: string }> =>
  c.call("POST", `${p(pid)}/tags`, { body });
export const updateTagGroup = (c: Client, pid: string, groupId: string, body: { mandatory?: boolean; selectOne?: boolean }): Promise<null> =>
  c.call("PUT", `${p(pid)}/tag-groups/${groupId}`, { body });

// ---- members & groups ----
export const listProjectMembers = (c: Client, pid: string, limit = 0): Promise<{ organizationMemberId: string; role?: string }[]> =>
  c.list(`${p(pid)}/members`, {}, limit);
export const getProjectMember = (c: Client, pid: string, mid: string): Promise<unknown> => c.call("GET", `${p(pid)}/members/${mid}`);
export const addProjectMember = (c: Client, pid: string, organizationMemberId: string, role: string): Promise<unknown> =>
  c.call("POST", `${p(pid)}/members`, { body: { organizationMemberId, role } });
export const removeProjectMember = (c: Client, pid: string, mid: string): Promise<null> => c.call("DELETE", `${p(pid)}/members/${mid}`);

/** The API has been seen returning a nested array ([[g1, g2]]); flatten either shape. */
export async function listMemberGroups(c: Client, pid: string): Promise<MemberGroup[]> {
  const raw = await c.list<MemberGroup | MemberGroup[]>(`${p(pid)}/member-groups`);
  return raw.flat();
}
export const getMemberGroup = (c: Client, pid: string, id: string): Promise<MemberGroup> => c.call("GET", `${p(pid)}/member-groups/${id}`);

// ---- templates ----
export const listTemplates = (c: Client, pid: string, limit = 0): Promise<Template[]> => c.list(`${p(pid)}/templates`, {}, limit);
export const getTemplate = (c: Client, pid: string, id: string, interpolation = false): Promise<Template> =>
  c.call("GET", `${p(pid)}/templates/${id}`, { query: { interpolation } });
export const createTemplate = (c: Client, pid: string, body: unknown): Promise<{ id: string }> => c.call("POST", `${p(pid)}/templates`, { body });
export const updateTemplate = (c: Client, pid: string, id: string, body: unknown): Promise<null> =>
  c.call("PUT", `${p(pid)}/templates/${id}`, { body });
export const deleteTemplate = (c: Client, pid: string, id: string): Promise<null> => c.call("DELETE", `${p(pid)}/templates/${id}`);

// ---- hooks & email ----
export const createHook = (c: Client, pid: string, body: Record<string, unknown>): Promise<{ id: string }> =>
  c.call("POST", `${p(pid)}/hooks`, { body });
export const createWikiHook = (c: Client, pid: string, body: Record<string, unknown>): Promise<{ id: string }> =>
  c.call("POST", `${p(pid)}/wiki-hooks`, { body });
export const createEmailAddress = (c: Client, pid: string, body: { emailAddress: string; name?: string }): Promise<{ id: string }> =>
  c.call("POST", `${p(pid)}/email-addresses`, { body });
export const getEmailAddress = (c: Client, pid: string, id: string): Promise<{ id: string; emailAddress: string; name?: string }> =>
  c.call("GET", `${p(pid)}/email-addresses/${id}`);

// ---- name lookups (cached per project) ----
const byName = <T>(kind: string, name: (t: T) => string, id: (t: T) => string) => ({ kind, name, id });

export async function resolveWorkflow(c: Client, cache: Cache, pid: string, ref: string): Promise<Workflow> {
  const all = await cache.get(`workflows/${pid}`, DAY, () => listWorkflows(c, pid));
  const hit = all.find((w) => w.id === ref) ?? [...all].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).find((w) => w.class === ref);
  return hit ?? matchByName(all, ref, byName<Workflow>("workflow", (w) => w.name, (w) => `${w.id}, ${w.class}`));
}

export async function resolveMilestone(c: Client, cache: Cache, pid: string, ref: string): Promise<string> {
  if (isId(ref)) return ref;
  const all = await cache.get(`milestones/${pid}`, DAY, () => listMilestones(c, pid));
  return matchByName(all, ref, byName<Milestone>("milestone", (m) => m.name, (m) => m.id)).id;
}

/** Tag id, name, or "group:name". */
export async function resolveTag(c: Client, cache: Cache, pid: string, ref: string): Promise<string> {
  if (isId(ref)) return ref;
  const all = await cache.get(`tags/${pid}`, DAY, () => listTags(c, pid));
  const full = (t: Tag) => (t.tagGroup?.name ? `${t.tagGroup.name}:${t.name ?? ""}` : (t.name ?? ""));
  const exact = all.filter((t) => full(t) === ref);
  if (exact.length === 1) return exact[0]!.id;
  return matchByName(all, ref, byName<Tag>("tag", (t) => (ref.includes(":") ? full(t) : (t.name ?? "")), (t) => `${t.id}, ${full(t)}`)).id;
}

export async function resolveMemberGroup(c: Client, cache: Cache, pid: string, ref: string): Promise<string> {
  if (isId(ref)) return ref;
  const all = await cache.get(`member-groups/${pid}`, DAY, () => listMemberGroups(c, pid));
  return matchByName(all, ref, byName<MemberGroup>("member group", (g) => g.code ?? "", (g) => g.id)).id;
}

export async function resolveTemplate(c: Client, cache: Cache, pid: string, ref: string): Promise<string> {
  if (isId(ref)) return ref;
  const all = await cache.get(`templates/${pid}`, DAY, () => listTemplates(c, pid));
  return matchByName(all, ref, byName<Template>("template", (t) => t.templateName ?? "", (t) => t.id)).id;
}
