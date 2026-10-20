import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { Client } from "../core/client.js";
import { notFound, usageError } from "../core/errors.js";
import { saveResponse } from "../core/files.js";
import { isId, matchByName } from "../core/resolve.js";

export const FOLDER_MIME = "application/vnd.dooray-drive.folder";

export interface DriveFile {
  id: string;
  driveId?: string;
  name: string;
  mimeType?: string | null;
  size: number;
  type?: string;
  subType?: string;
  version?: number;
  hasFolders?: boolean | null;
  createdAt?: string;
  updatedAt?: string;
  parentFile?: { id: string; path?: string };
}

export interface Drive {
  id: string;
  name: string | null;
  type: string;
  project?: { id: string };
}

export interface SharedLink {
  id: string;
  sharedLink?: string;
  scope?: string;
  createdAt?: string;
  expiredAt?: string;
}

export const isFolder = (f: Pick<DriveFile, "mimeType" | "type">): boolean => f.mimeType === FOLDER_MIME || f.type === "folder";

const filesPath = (driveId: string) => `/drive/v1/drives/${driveId}/files`;
const filePath = (driveId: string, fileId: string) => `${filesPath(driveId)}/${fileId}`;

export const listDrives = (c: Client, query: { type?: string; scope?: string; state?: string } = {}): Promise<Drive[]> =>
  c.list<Drive>("/drive/v1/drives", query);

export const getDrive = (c: Client, driveId: string): Promise<Drive> => c.call("GET", `/drive/v1/drives/${driveId}`);

export const listFiles = (c: Client, driveId: string, parentId?: string, limit = 0): Promise<DriveFile[]> =>
  c.list<DriveFile>(filesPath(driveId), { parentId }, limit);

export const getFile = (c: Client, driveId: string, fileId: string): Promise<DriveFile> =>
  c.call("GET", filePath(driveId, fileId), { query: { media: "meta" } });

export async function downloadFile(c: Client, driveId: string, fileId: string, dest: string): Promise<void> {
  await saveResponse(await c.download(filePath(driveId, fileId), { query: { media: "raw" } }), dest);
}

async function fileForm(localPath: string): Promise<FormData> {
  const form = new FormData();
  form.append("file", await openAsBlob(localPath), basename(localPath));
  return form;
}

// ponytail: the multipart body is sent twice (api host → 307 → file host); send straight to the
// file host if large uploads get slow and the /uploads location pattern is confirmed for drive.
export async function uploadFile(c: Client, driveId: string, parentId: string, localPath: string): Promise<DriveFile> {
  return c.upload<DriveFile>(filesPath(driveId), await fileForm(localPath), { query: { parentId } });
}

/** Uploads a new version of an existing file (PUT media=raw). */
export async function updateFile(c: Client, driveId: string, fileId: string, localPath: string): Promise<DriveFile> {
  return c.upload<DriveFile>(filePath(driveId, fileId), await fileForm(localPath), { method: "PUT", query: { media: "raw" } });
}

export const createFolder = (c: Client, driveId: string, parentId: string, name: string): Promise<{ id: string }> =>
  c.call("POST", `${filePath(driveId, parentId)}/create-folder`, { body: { name } });

export const renameFile = (c: Client, driveId: string, fileId: string, name: string): Promise<null> =>
  c.call("PUT", filePath(driveId, fileId), { query: { media: "meta" }, body: { name } });

/** destFolderId "trash" moves the file to the drive's trash. */
export const moveFile = (c: Client, driveId: string, fileId: string, destFolderId: string): Promise<null> =>
  c.call("POST", `${filePath(driveId, fileId)}/move`, { body: { destinationFileId: destFolderId } });

export const copyFile = (c: Client, driveId: string, fileId: string, destDriveId: string, destFolderId: string): Promise<null> =>
  c.call("POST", `${filePath(driveId, fileId)}/copy`, { body: { destinationDriveId: destDriveId, destinationFileId: destFolderId } });

/** Permanent delete; Dooray only allows it for files already in the trash. */
export const deleteFile = (c: Client, driveId: string, fileId: string): Promise<null> => c.call("DELETE", filePath(driveId, fileId));

export const listChanges = (c: Client, driveId: string, q: { latestRevision?: string; fileId?: string; size?: number }) =>
  c.call<unknown[]>("GET", `/drive/v2/drives/${driveId}/changes`, { query: q });

const linksPath = (driveId: string, fileId: string) => `${filePath(driveId, fileId)}/shared-links`;

export const listLinks = (c: Client, driveId: string, fileId: string, valid = true): Promise<SharedLink[]> =>
  c.call("GET", linksPath(driveId, fileId), { query: { valid } });
export const getLink = (c: Client, driveId: string, fileId: string, linkId: string): Promise<SharedLink> =>
  c.call("GET", `${linksPath(driveId, fileId)}/${linkId}`);
export const createLink = (c: Client, driveId: string, fileId: string, scope: string, expiredAt: string): Promise<{ id: string }> =>
  c.call("POST", linksPath(driveId, fileId), { body: { scope, expiredAt } });
export const updateLink = (c: Client, driveId: string, fileId: string, linkId: string, body: { scope?: string; expiredAt?: string }) =>
  c.call<null>("PUT", `${linksPath(driveId, fileId)}/${linkId}`, { body });
export const deleteLink = (c: Client, driveId: string, fileId: string, linkId: string) =>
  c.call<null>("DELETE", `${linksPath(driveId, fileId)}/${linkId}`);

// ---------- references (id or /path) ----------

/** The drive's root folder (listing without parentId returns the root and trash folders). */
export async function rootFolder(c: Client, driveId: string): Promise<DriveFile> {
  const top = await c.list<DriveFile>(filesPath(driveId), { type: "folder", subTypes: "root" });
  const root = top.find((f) => f.subType === "root");
  if (!root) throw notFound(`drive ${driveId} has no root folder`);
  return root;
}

/**
 * Resolves a file/folder reference: a numeric id, or an absolute path like "/2025/회의록.hwp"
 * ("/" is the root folder). Path lookups match names exactly within each folder.
 */
export async function resolveRef(c: Client, driveId: string, ref: string): Promise<DriveFile> {
  if (isId(ref)) return { id: ref, name: ref, size: 0 };
  if (!ref.startsWith("/")) throw usageError(`'${ref}': use a file id or an absolute path like /folder/file`);
  let cur = await rootFolder(c, driveId);
  let at = "";
  for (const part of ref.split("/").filter(Boolean)) {
    if (!isFolder(cur)) throw notFound(`${at || "/"} is not a folder`);
    const children = await listFiles(c, driveId, cur.id);
    const hits = children.filter((f) => f.name === part);
    if (hits.length === 0) {
      const names = children.slice(0, 10).map((f) => f.name + (isFolder(f) ? "/" : ""));
      throw notFound(`no '${part}' in ${at || "/"}${names.length ? `; entries: ${names.join(", ")}` : " (empty folder)"}`);
    }
    cur = matchByName(hits, part, { kind: "file", name: (f) => f.name, id: (f) => f.id });
    at += "/" + part;
  }
  return cur;
}

/** --drive value → drive id: an id (project ids are accepted by the API too) or a drive name; default = profile/private drive. */
export async function resolveDrive(c: Client, ref: string | undefined, profileDefault: string | undefined): Promise<string> {
  const want = ref || profileDefault;
  if (want && isId(want)) return want;
  if (!want) {
    const mine = await listDrives(c, { type: "private" });
    if (!mine[0]) throw notFound("no private drive found; pass --drive");
    return mine[0].id;
  }
  const drives = [...(await listDrives(c, { type: "private" })), ...(await listDrives(c, { type: "project" }))];
  return matchByName(drives, want, { kind: "drive", name: (d) => d.name ?? "내 드라이브", id: (d) => d.id }).id;
}

/** The operations the pull/push mirror needs, bound to one drive. */
export interface DriveOps {
  list(parentId: string): Promise<DriveFile[]>;
  download(fileId: string, dest: string): Promise<void>;
  upload(parentId: string, localPath: string): Promise<DriveFile>;
  update(fileId: string, localPath: string): Promise<DriveFile>;
  mkdir(parentId: string, name: string): Promise<{ id: string }>;
  trash(fileId: string): Promise<void>;
}

export function driveOps(c: Client, driveId: string): DriveOps {
  return {
    list: (parentId) => listFiles(c, driveId, parentId),
    download: (fileId, dest) => downloadFile(c, driveId, fileId, dest),
    upload: (parentId, localPath) => uploadFile(c, driveId, parentId, localPath),
    update: (fileId, localPath) => updateFile(c, driveId, fileId, localPath),
    mkdir: (parentId, name) => createFolder(c, driveId, parentId, name),
    trash: async (fileId) => {
      await moveFile(c, driveId, fileId, "trash");
    },
  };
}
