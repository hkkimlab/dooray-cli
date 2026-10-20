// Body input and partial-replace helpers shared by post and wiki commands.
// The replace rules follow jon890/dooray-cli src/utils/body-replace.ts (MIT, see THIRD_PARTY_NOTICES.md).
import { readFile } from "node:fs/promises";
import { errorMessage, generic, usageError } from "./errors.js";

export const MARKDOWN = "text/x-markdown";
export const HTML = "text/html";

interface StdinIo {
  stdin: NodeJS.ReadableStream;
}

async function readStdin(io: StdinIo): Promise<string> {
  let text = "";
  for await (const chunk of io.stdin) text += String(chunk);
  return text;
}

/** Files and stdin lose a BOM and one trailing newline; inline text is used as-is. */
const clean = (s: string) => s.replace(/^﻿/, "").replace(/\r?\n$/, "");

/**
 * --x <text> / --x-file <path>: one of them, "-" meaning stdin. Returns undefined when neither is given.
 */
export async function readText(io: StdinIo, flag: string, text: string | undefined, file: string | undefined): Promise<string | undefined> {
  if (text !== undefined && file !== undefined) throw usageError(`use either --${flag} or --${flag}-file, not both`);
  if (text === "-" || file === "-") return clean(await readStdin(io));
  if (file !== undefined) {
    try {
      return clean(await readFile(file, "utf8"));
    } catch (e) {
      throw usageError(`--${flag}-file ${file}: ${errorMessage(e)}`);
    }
  }
  return text;
}

/** Every start index of needle, overlaps included (so "aa" in "aaa" counts twice). */
export function findOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

export interface ReplaceResult {
  content: string;
  replaced: number;
  /** Changed lines as "-old"/"+new" pairs for --dry-run. */
  preview: string;
}

const lineBounds = (text: string, from: number, to: number): [number, number] => {
  const start = from === 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1;
  const nl = text.indexOf("\n", to);
  return [start, nl === -1 ? text.length : nl];
};

/**
 * Replaces an exact (whitespace-sensitive) match of oldText. Zero matches, or several without
 * `all`, are usage errors. Avoids String.replace so "$&" in newText stays literal.
 */
export function applyReplace(content: string, oldText: string, newText: string, all: boolean): ReplaceResult {
  if (!oldText) throw usageError("the text to find (--old) is empty");
  if (oldText === newText) throw usageError("--old and --new are the same; nothing would change");
  const hits = findOccurrences(content, oldText);
  if (hits.length === 0) {
    const hints = [
      content.includes("\r\n") && !oldText.includes("\r") ? "the body uses CRLF line endings" : "",
      content.normalize("NFC").includes(oldText.normalize("NFC")) ? "the body and --old differ in Unicode normalization (NFC/NFD)" : "",
    ].filter(Boolean);
    throw usageError(`--old was not found in the body (exact match, whitespace included)${hints.length ? "; note: " + hints.join("; ") : ""}`);
  }
  if (hits.length > 1 && !all) {
    throw usageError(`--old matches ${hits.length} places; pass --all, or add surrounding text to make it unique`);
  }
  const nonOverlapping: number[] = [];
  for (const idx of hits) {
    const prev = nonOverlapping.at(-1);
    if (prev === undefined || idx >= prev + oldText.length) nonOverlapping.push(idx);
  }
  let out = "";
  let cursor = 0;
  const preview: string[] = [];
  for (const idx of nonOverlapping) {
    out += content.slice(cursor, idx) + newText;
    cursor = idx + oldText.length;
    const [s, e] = lineBounds(content, idx, idx + oldText.length);
    const after = content.slice(s, idx) + newText + content.slice(idx + oldText.length, e);
    preview.push(...content.slice(s, e).split("\n").map((l) => `-${l}`), ...after.split("\n").map((l) => `+${l}`));
  }
  return { content: out + content.slice(cursor), replaced: nonOverlapping.length, preview: preview.join("\n") };
}

/** Read --old/--new (or their -file forms) for a replace command. */
export async function readReplaceInputs(
  io: StdinIo,
  o: { old?: string; oldFile?: string; new?: string; newFile?: string },
): Promise<{ oldText: string; newText: string }> {
  const viaStdin = (t?: string, f?: string) => t === "-" || f === "-";
  if (viaStdin(o.old, o.oldFile) && viaStdin(o.new, o.newFile)) throw usageError("only one of --old/--new can read stdin (-)");
  const oldText = await readText(io, "old", o.old, o.oldFile);
  const newText = await readText(io, "new", o.new, o.newFile);
  if (oldText === undefined || newText === undefined) throw usageError("replace needs --old (or --old-file) and --new (or --new-file)");
  // An empty --new deletes the match; an empty file/stdin is more likely a mistake.
  if (newText === "" && (o.newFile !== undefined || o.new === "-")) throw usageError('the new text read from a file/stdin is empty; use --new "" to delete');
  return { oldText, newText };
}

/** Opens $EDITOR on initial text and returns the saved result. */
export async function editInEditor(initial: string, env: Record<string, string | undefined>, suffix = ".md"): Promise<string> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "dooray-edit-"));
  const file = join(dir, `body${suffix}`);
  try {
    await writeFile(file, initial, { mode: 0o600 });
    const editor = env.VISUAL || env.EDITOR || "vi";
    const r = spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true });
    if (r.status !== 0) throw generic(`editor exited with status ${r.status}`);
    return await readFile(file, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
