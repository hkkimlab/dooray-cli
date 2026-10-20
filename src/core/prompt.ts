import { createInterface } from "node:readline";
import { usageError } from "./errors.js";

export interface PromptIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  err: (s: string) => void;
}

// Piped stdin is read once to EOF and handed out line by line, so several prompts
// in one command (e.g. id then password) each get their own line.
const pipedLines = new WeakMap<object, Promise<string[]>>();

function linesOf(stdin: PromptIo["stdin"]): Promise<string[]> {
  let lines = pipedLines.get(stdin);
  if (!lines) {
    lines = (async () => {
      let text = "";
      for await (const chunk of stdin) text += String(chunk);
      return text.split(/\r?\n/);
    })();
    pipedLines.set(stdin, lines);
  }
  return lines;
}

const nextPipedLine = async (stdin: PromptIo["stdin"]) => (await linesOf(stdin)).shift() ?? "";

/** Reads one line (trimmed) from stdin; works for TTYs and pipes. EOF yields "". */
export async function readLine(io: PromptIo, prompt: string): Promise<string> {
  io.err(prompt);
  if (!io.stdin.isTTY) return (await nextPipedLine(io.stdin)).trim();
  const rl = createInterface({ input: io.stdin, terminal: false });
  try {
    for await (const line of rl) return line.trim();
    return "";
  } finally {
    rl.close();
  }
}

/** Reads a secret without echo on a TTY; from a pipe it reads one line. Not trimmed: spaces may be part of a password. */
export async function readSecret(io: PromptIo, prompt: string): Promise<string> {
  if (!io.stdin.isTTY) {
    io.err(prompt);
    return nextPipedLine(io.stdin);
  }
  io.err(prompt);
  const stdin = io.stdin;
  stdin.setEncoding("utf8");
  stdin.setRawMode?.(true);
  return new Promise((resolve, reject) => {
    let buf = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.err("\n");
    };
    const onEnd = () => {
      finish();
      resolve(buf);
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return onEnd();
        if (ch === "\u0003") {
          finish();
          return reject(usageError("cancelled"));
        }
        buf = ch === "\u007f" || ch === "\b" ? buf.slice(0, -1) : buf + ch;
      }
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
  });
}

/**
 * Asks before a destructive action. `--yes` skips the question; without a TTY
 * we refuse (usage error) rather than guess.
 */
export async function confirm(io: PromptIo, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!io.stdin.isTTY) throw usageError(`${question} — not a terminal; pass --yes to confirm`);
  return /^y(es)?$/i.test(await readLine(io, `${question} [y/N] `));
}
