import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { FOLDER_MIME, type DriveFile, type DriveOps } from "../../src/api/drive.js";

interface Node {
  file: DriveFile;
  parent?: string;
  content?: string;
}

/** In-memory remote drive implementing DriveOps; records every mutating call. */
export class FakeDrive implements DriveOps {
  nodes = new Map<string, Node>();
  log: string[] = [];
  private seq = 100;

  constructor() {
    this.add({ id: "root", name: "root", mimeType: FOLDER_MIME, size: 0 });
  }

  add(f: Partial<DriveFile> & { id: string; name: string }, parent?: string, content?: string): this {
    const file: DriveFile = { driveId: "d", mimeType: "text/plain", size: content?.length ?? 0, ...f };
    this.nodes.set(f.id, { file, parent, content });
    return this;
  }

  folder(id: string, name: string, parent = "root"): this {
    return this.add({ id, name, mimeType: FOLDER_MIME, size: 0 }, parent);
  }

  file(id: string, name: string, content: string, parent = "root"): this {
    return this.add({ id, name, size: Buffer.byteLength(content) }, parent, content);
  }

  childrenOf(parentId: string): DriveFile[] {
    return [...this.nodes.values()].filter((n) => n.parent === parentId).map((n) => n.file);
  }

  async list(parentId: string): Promise<DriveFile[]> {
    return this.childrenOf(parentId);
  }

  async download(fileId: string, dest: string): Promise<void> {
    this.log.push(`download ${fileId}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, this.nodes.get(fileId)?.content ?? "");
  }

  async upload(parentId: string, localPath: string): Promise<DriveFile> {
    const id = String(this.seq++);
    const content = readFileSync(localPath, "utf8");
    this.file(id, basename(localPath), content, parentId);
    this.log.push(`upload ${parentId}/${basename(localPath)}`);
    return this.nodes.get(id)!.file;
  }

  async update(fileId: string, localPath: string): Promise<DriveFile> {
    const n = this.nodes.get(fileId)!;
    const content = readFileSync(localPath, "utf8");
    this.nodes.set(fileId, { ...n, content, file: { ...n.file, size: Buffer.byteLength(content) } });
    this.log.push(`update ${fileId}`);
    return this.nodes.get(fileId)!.file;
  }

  async mkdir(parentId: string, name: string): Promise<DriveFile> {
    const id = String(this.seq++);
    this.folder(id, name, parentId);
    this.log.push(`mkdir ${parentId}/${name}`);
    return this.nodes.get(id)!.file;
  }

  async trash(fileId: string): Promise<void> {
    this.log.push(`trash ${fileId}`);
    this.nodes.delete(fileId);
  }
}
