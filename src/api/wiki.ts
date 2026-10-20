import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { DAY, type Cache } from "../core/cache.js";
import type { Client } from "../core/client.js";
import { notFound, usageError } from "../core/errors.js";
import { isId, matchByName, parseDoorayUrl } from "../core/resolve.js";

export interface Wiki {
  id: string;
  name: string;
  type?: string;
  home?: { pageId: string };
  project?: { id: string };
}

export interface WikiFile {
  id: string;
  attachFileId?: string;
  name: string;
  size?: number;
  type?: string;
}

export interface WikiPage {
  id: string;
  wikiId?: string;
  parentPageId?: string | null;
  subject: string;
  version?: number;
  root?: boolean;
  body?: { mimeType: string; content: string };
  referrers?: { type: string; member: { organizationMemberId: string } }[];
  files?: WikiFile[];
  images?: WikiFile[];
  createdAt?: string;
  updatedAt?: string;
}

export interface WikiComment {
  id: string;
  createdAt?: string;
  creator?: { member?: { organizationMemberId: string; name?: string } };
  body?: { content: string };
}

const pages = (w: string) => `/wiki/v1/wikis/${w}/pages`;
const page = (w: string, p: string) => `${pages(w)}/${p}`;

export const listWikis = (c: Client, limit = 0): Promise<Wiki[]> => c.list("/wiki/v1/wikis", {}, limit);
export const listPages = (c: Client, w: string, parentPageId?: string): Promise<WikiPage[]> => c.list(pages(w), { parentPageId });
export const getPage = (c: Client, w: string, p: string): Promise<WikiPage> => c.call("GET", page(w, p));
/** Page by id alone (no wiki id needed). */
export const getPageById = (c: Client, p: string): Promise<WikiPage> => c.call("GET", `/wiki/v1/pages/${p}`);
export const createPage = (c: Client, w: string, body: Record<string, unknown>): Promise<{ id: string; wikiId?: string }> =>
  c.call("POST", pages(w), { body });
export const setTitle = (c: Client, w: string, p: string, subject: string): Promise<null> =>
  c.call("PUT", `${page(w, p)}/title`, { body: { subject } });
/** Wiki bodies are markdown only. */
export const setContent = (c: Client, w: string, p: string, content: string): Promise<null> =>
  c.call("PUT", `${page(w, p)}/content`, { body: { body: { mimeType: "text/x-markdown", content } } });
export const setReferrers = (c: Client, w: string, p: string, memberIds: string[]): Promise<null> =>
  c.call("PUT", `${page(w, p)}/referrers`, { body: { referrers: memberIds.map((organizationMemberId) => ({ type: "member", member: { organizationMemberId } })) } });
export const movePage = (c: Client, w: string, p: string, body: Record<string, unknown>): Promise<null> =>
  c.call("POST", `${page(w, p)}/move`, { body });
/** Children are re-attached to the deleted page's parent. */
export const deletePage = (c: Client, w: string, p: string): Promise<null> => c.call("DELETE", page(w, p));
export const listSharedLinks = (c: Client, w: string, p: string, valid: boolean) =>
  c.list<{ id: string; sharedLink?: string; scope?: string; includeDescendants?: boolean }>(`${page(w, p)}/shared-links`, { valid });

// ---- comments ----
const comments = (w: string, p: string) => `${page(w, p)}/comments`;
export const listComments = (c: Client, w: string, p: string, limit = 0): Promise<WikiComment[]> => c.list(comments(w, p), {}, limit);
export const getComment = (c: Client, w: string, p: string, id: string): Promise<WikiComment> => c.call("GET", `${comments(w, p)}/${id}`);
export const addComment = (c: Client, w: string, p: string, content: string): Promise<{ id: string }> =>
  c.call("POST", comments(w, p), { body: { body: { content } } });
export const updateComment = (c: Client, w: string, p: string, id: string, content: string): Promise<null> =>
  c.call("PUT", `${comments(w, p)}/${id}`, { body: { body: { content } } });
export const deleteComment = (c: Client, w: string, p: string, id: string): Promise<null> => c.call("DELETE", `${comments(w, p)}/${id}`);

// ---- files ----
/** The server requires the `type` field before `file` in the multipart body. */
async function typedForm(localPath: string, type: string): Promise<FormData> {
  const form = new FormData();
  form.append("type", type);
  form.append("file", await openAsBlob(localPath), basename(localPath));
  return form;
}

export const uploadPageFile = async (c: Client, w: string, p: string, localPath: string, type: string): Promise<WikiFile> =>
  c.upload(`${page(w, p)}/files`, await typedForm(localPath, type));
export const downloadPageFile = (c: Client, w: string, p: string, fileId: string): Promise<Response> => c.download(`${page(w, p)}/files/${fileId}`);
export const deletePageFile = (c: Client, w: string, p: string, fileId: string): Promise<null> => c.call("DELETE", `${page(w, p)}/files/${fileId}`);
/** A wiki-level file (not on a page); its attachFileId can be attached when creating a page. */
export const uploadWikiFile = async (c: Client, w: string, localPath: string): Promise<WikiFile> =>
  c.upload(`/wiki/v1/wikis/${w}/files`, await typedForm(localPath, "general"));
export const downloadAttachFile = (c: Client, w: string, attachFileId: string): Promise<Response> =>
  c.download(`/wiki/v1/wikis/${w}/attachFiles/${attachFileId}`);

// ---- references ----

const cachedWikis = (c: Client, cache: Cache) => cache.get("wikis", DAY, () => listWikis(c));

/** Wiki id, the owning project's id, or the wiki name (= project code). */
export async function resolveWiki(c: Client, cache: Cache, ref: string): Promise<Wiki> {
  const all = await cachedWikis(c, cache);
  const hit = all.find((w) => w.id === ref || w.project?.id === ref);
  if (hit) return hit;
  if (isId(ref)) return { id: ref, name: ref };
  return matchByName(all, ref, { kind: "wiki", name: (w) => w.name, id: (w) => w.id });
}

/** The wiki's home page id (from the wiki list, else the root top-level page). */
export async function homePage(c: Client, wiki: Wiki): Promise<string> {
  if (wiki.home?.pageId) return wiki.home.pageId;
  const top = await listPages(c, wiki.id);
  const root = top.find((p) => p.root) ?? top[0];
  if (!root) throw notFound(`wiki ${wiki.name} has no pages`);
  return root.id;
}

export interface PageRef {
  wikiId: string;
  pageId: string;
}

/**
 * Page reference: a wiki page URL, a page id, or a /path of subjects under the home page
 * ("/" = home, needs --wiki). knownWikiId skips a lookup when the wiki is already known.
 */
export async function resolvePage(c: Client, cache: Cache, ref: string, wikiRef?: string, knownWikiId?: string): Promise<PageRef> {
  const url = parseDoorayUrl(ref);
  if (url?.kind === "wiki") return { wikiId: url.wikiId, pageId: url.pageId };
  if (url) throw usageError(`'${ref}' is a ${url.kind} URL, not a wiki page URL`);
  if (isId(ref)) {
    const wikiId = knownWikiId ?? (wikiRef ? (await resolveWiki(c, cache, wikiRef)).id : (await getPageById(c, ref)).wikiId);
    if (!wikiId) throw notFound(`page ${ref} has no wiki id`);
    return { wikiId, pageId: ref };
  }
  if (!ref.startsWith("/")) throw usageError(`'${ref}': use a page URL, a page id, or a /path with --wiki`);
  if (!wikiRef && !knownWikiId) throw usageError(`'${ref}': a /path needs --wiki`);
  const wiki = knownWikiId ? { id: knownWikiId, name: knownWikiId } : await resolveWiki(c, cache, wikiRef!);
  let cur = await homePage(c, wiki);
  let at = "";
  for (const part of ref.split("/").filter(Boolean)) {
    const children = await listPages(c, wiki.id, cur);
    const hits = children.filter((p) => p.subject === part);
    if (!hits.length) {
      const names = children.slice(0, 10).map((p) => p.subject);
      throw notFound(`no page '${part}' under ${at || "/"}${names.length ? `; children: ${names.join(", ")}` : " (no children)"}`);
    }
    cur = matchByName(hits, part, { kind: "page", name: (p) => p.subject, id: (p) => p.id }).id;
    at += "/" + part;
  }
  return { wikiId: wiki.id, pageId: cur };
}
