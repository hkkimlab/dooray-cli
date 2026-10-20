import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { Client, Query } from "../core/client.js";
import { notFound, usageError } from "../core/errors.js";
import { isId, parseDoorayUrl, resolveProject } from "../core/resolve.js";
import type { Cache } from "../core/cache.js";

export interface PostUser {
  type: "member" | "emailUser" | "group";
  member?: { organizationMemberId: string; name?: string };
  emailUser?: { emailAddress: string; name?: string };
  group?: { projectMemberGroupId: string; code?: string };
  workflow?: { id: string; name?: string };
}

export interface Body {
  mimeType: string;
  content: string;
}

export interface Post {
  id: string;
  subject: string;
  number?: number;
  taskNumber?: string;
  project?: { id: string; code?: string };
  body?: Body;
  priority?: string;
  dueDate?: string | null;
  dueDateFlag?: boolean;
  milestone?: { id: string; name?: string } | null;
  tags?: { id: string; name?: string }[];
  users?: { from?: PostUser; to?: PostUser[]; cc?: PostUser[] };
  workflowClass?: string;
  workflow?: { id: string; name?: string };
  parent?: { id: string; number?: number; subject?: string } | null;
  createdAt?: string;
  updatedAt?: string;
  files?: { id: string; name?: string; size?: number }[];
}

export interface PostLog {
  id: string;
  type?: string;
  subtype?: string;
  createdAt?: string;
  modifiedAt?: string;
  creator?: { type?: string; member?: { organizationMemberId: string; name?: string }; emailUser?: { emailAddress: string; name?: string } };
  body?: Body;
  files?: { id: string; name?: string; size?: number }[];
}

export interface PostFile {
  id: string;
  name: string;
  size?: number;
  mimeType?: string;
  createdAt?: string;
}

const P = "/project/v1/projects";
const posts = (pid: string) => `${P}/${pid}/posts`;
const post = (pid: string, id: string) => `${posts(pid)}/${id}`;

export const listPosts = (c: Client, pid: string, q: Query, limit = 0): Promise<Post[]> => c.list(posts(pid), q, limit);
export const getPost = (c: Client, pid: string, id: string): Promise<Post> => c.call("GET", post(pid, id));
/** Post by id alone (no project needed). */
export const getPostById = (c: Client, id: string): Promise<Post> => c.call("GET", `/project/v1/posts/${id}`);
export const createPost = (c: Client, pid: string, body: Record<string, unknown>): Promise<{ id: string }> =>
  c.call("POST", posts(pid), { body });
export const updatePost = (c: Client, pid: string, id: string, body: Record<string, unknown>): Promise<null> =>
  c.call("PUT", post(pid, id), { body });
export const setDone = (c: Client, pid: string, id: string): Promise<null> => c.call("POST", `${post(pid, id)}/set-done`);
export const setWorkflow = (c: Client, pid: string, id: string, workflowId: string): Promise<null> =>
  c.call("POST", `${post(pid, id)}/set-workflow`, { body: { workflowId } });
/** One assignee's workflow; memberId may be "me". */
export const setAssigneeWorkflow = (c: Client, pid: string, id: string, memberId: string, workflowId: string): Promise<null> =>
  c.call("PUT", `${post(pid, id)}/to/${memberId}`, { body: { workflowId } });
export const setParent = (c: Client, pid: string, id: string, parentPostId: string): Promise<unknown> =>
  c.call("POST", `${post(pid, id)}/set-parent-post`, { body: { parentPostId } });
export const movePost = (c: Client, pid: string, id: string, targetProjectId: string, includeSubPosts: boolean): Promise<unknown> =>
  c.call("POST", `${post(pid, id)}/move`, { body: { targetProjectId, includeSubPosts } });
export const createDraft = (c: Client, body: Record<string, unknown>): Promise<{ id: string; url?: string }> =>
  c.call("POST", "/project/v1/post-drafts", { body });

// ---- comments (logs) ----
const logs = (pid: string, id: string) => `${post(pid, id)}/logs`;
export const listLogs = (c: Client, pid: string, id: string, order: string | undefined, limit = 0): Promise<PostLog[]> =>
  c.list(logs(pid, id), { order }, limit);
export const getLog = (c: Client, pid: string, id: string, logId: string): Promise<PostLog> => c.call("GET", `${logs(pid, id)}/${logId}`);
export const createLog = (c: Client, pid: string, id: string, body: Body, attachFileIds?: string[]): Promise<{ id: string }> =>
  c.call("POST", logs(pid, id), { body: { body, ...(attachFileIds?.length && { attachFileIds }) } });
export const updateLog = (c: Client, pid: string, id: string, logId: string, body: Body): Promise<null> =>
  c.call("PUT", `${logs(pid, id)}/${logId}`, { body: { body } });
export const deleteLog = (c: Client, pid: string, id: string, logId: string): Promise<null> => c.call("DELETE", `${logs(pid, id)}/${logId}`);

// ---- files ----
const files = (pid: string, id: string) => `${post(pid, id)}/files`;
export const listFiles = (c: Client, pid: string, id: string): Promise<PostFile[]> => c.list(files(pid, id));
export const getFileMeta = (c: Client, pid: string, id: string, fileId: string): Promise<PostFile> =>
  c.call("GET", `${files(pid, id)}/${fileId}`, { query: { media: "meta" } });
export const downloadFile = (c: Client, pid: string, id: string, fileId: string): Promise<Response> =>
  c.download(`${files(pid, id)}/${fileId}`, { query: { media: "raw" } });
export const deleteFile = (c: Client, pid: string, id: string, fileId: string): Promise<null> => c.call("DELETE", `${files(pid, id)}/${fileId}`);

export async function uploadFile(c: Client, pid: string, id: string, localPath: string): Promise<{ id: string }> {
  const form = new FormData();
  form.append("file", await openAsBlob(localPath), basename(localPath));
  return c.upload(files(pid, id), form);
}

// ---- references ----

export interface PostRef {
  projectId: string;
  postId: string;
}

/**
 * Post reference → ids. Accepts a Dooray task URL, a post id, "project/number"
 * (the taskNumber form, e.g. 개발팀/12), or a bare number with --project.
 */
export async function resolvePost(c: Client, cache: Cache, ref: string, project?: string): Promise<PostRef> {
  const projectId = async () => {
    if (!project) throw usageError(`'${ref}' needs --project (or use project/number, a post id or a URL)`);
    return (await resolveProject(c, cache, project)).id;
  };
  const byNumber = async (pid: string, n: string) => {
    const [hit] = await c.list<Post>(posts(pid), { postNumber: n }, 1);
    if (!hit) throw notFound(`no post #${n} in project ${project ?? pid}`);
    return { projectId: pid, postId: hit.id };
  };
  const url = parseDoorayUrl(ref);
  if (url?.kind === "post") {
    return { projectId: url.projectId ?? (await getPostById(c, url.postId)).project!.id, postId: url.postId };
  }
  if (url) throw usageError(`'${ref}' is a ${url.kind} URL, not a task URL`);
  if (isId(ref)) return { projectId: project ? await projectId() : (await getPostById(c, ref)).project!.id, postId: ref };
  const m = /^(.+)\/(\d+)$/.exec(ref);
  if (m) return byNumber((await resolveProject(c, cache, m[1]!)).id, m[2]!);
  if (/^\d+$/.test(ref)) return byNumber(await projectId(), ref);
  throw usageError(`'${ref}': use a task URL, a post id, project/number, or a number with --project`);
}
