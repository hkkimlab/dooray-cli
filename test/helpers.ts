import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../src/cli.js";
import type { Io } from "../src/core/app.js";
import type { MailBackend } from "../src/mail/backend.js";
import type { Scraper } from "../src/sso/token.js";

export const ok = (result: unknown, totalCount?: number) => ({
  header: { resultCode: 0, resultMessage: "", isSuccessful: true },
  result,
  ...(totalCount === undefined ? {} : { totalCount }),
});

export const fail = (resultCode: number, resultMessage: string) => ({
  header: { resultCode, resultMessage, isSuccessful: false },
  result: null,
});

export interface Route {
  method?: string;
  /** exact pathname, or a RegExp tested against pathname+search */
  path: string | RegExp;
  status?: number;
  body?: unknown;
  raw?: string | Uint8Array;
  headers?: Record<string, string>;
  /** keep the route after it matches (default: consumed once) */
  repeat?: boolean;
}

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

export type FakeFetch = typeof fetch & { calls: Call[] };

export function fakeFetch(routes: Route[]): FakeFetch {
  const queue = [...routes];
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep raw */
      }
    }
    calls.push({ method, url, headers, body });
    const idx = queue.findIndex(
      (r) =>
        (!r.method || r.method === method) &&
        (typeof r.path === "string" ? url.pathname === r.path : r.path.test(url.pathname + url.search)),
    );
    if (idx < 0) throw new Error(`unexpected request ${method} ${url}`);
    const r = queue[idx]!;
    if (!r.repeat) queue.splice(idx, 1);
    const payload = r.raw ?? JSON.stringify(r.body ?? ok(null));
    return new Response(payload as BodyInit, { status: r.status ?? 200, headers: r.headers });
  };
  return Object.assign(fn, { calls }) as FakeFetch;
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "dooray-test-"));
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export interface RunOpts {
  fetch?: typeof fetch;
  home?: string;
  stdin?: string;
  tty?: boolean;
  env?: Record<string, string>;
  mail?: MailBackend;
  sso?: Scraper;
}

/** Runs the CLI in-process with an isolated HOME/XDG dirs. */
export async function runCli(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const home = opts.home ?? tempHome();
  let out = "";
  let err = "";
  const stdin = Readable.from(opts.stdin === undefined ? [] : [opts.stdin]) as Io["stdin"];
  stdin.isTTY = opts.tty ?? false;
  const io: Io = {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    stdin,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      ...opts.env,
    },
    fetch: opts.fetch ?? fakeFetch([]),
    sleep: async () => {},
    mail: opts.mail,
    sso: opts.sso,
  };
  const code = await run(["node", "dooray", ...args], io);
  return { code, out, err };
}

export const GOV_CONFIG = `default_profile: gov
profiles:
  gov:
    token: secret-token-123
    env: gov
hooks:
  alerts: https://hook.dooray.com/services/1/2/abc
`;

/** Messenger logs seq hi..lo, newest first; seq n was sent n minutes after 2026-10-01 00:00 KST. */
export const msgs = (hi: number, lo: number, type = "NORMAL") =>
  Array.from({ length: hi - lo + 1 }, (_, i) => {
    const seq = hi - i;
    return { id: `L${seq}`, seq, type, sentAt: new Date(Date.parse("2026-10-01T00:00:00+09:00") + seq * 60_000).toISOString() };
  });

/** A messenger logs page: hasMore is a top-level envelope field. */
export const logsPage = (logs: unknown[], hasMore: boolean) => ({ ...ok(logs), hasMore });
