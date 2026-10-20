import { Cache, cacheDir } from "./cache.js";
import { Client } from "./client.js";
import { configPath, loadConfig, resolveProfile, type Config, type ResolvedProfile } from "./config.js";
import { createPrinter, parseFormat, type Printer } from "./output.js";
import type { PromptIo } from "./prompt.js";
import type { MailBackend } from "../mail/backend.js";
import type { Scraper } from "../sso/token.js";

/** Everything that touches the outside world, injectable for tests. */
export interface Io extends PromptIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** IMAP/SMTP access; tests inject a fake. */
  mail?: MailBackend;
  /** Organization SSO browser flow; tests inject a fake. */
  sso?: Scraper;
}

export interface Globals {
  profile?: string;
  env?: string;
  format: string;
  limit?: number;
  quiet?: boolean;
  debug?: boolean;
}

export interface App {
  io: Io;
  globals: Globals;
  printer: Printer;
  cfgPath: string;
  cfg: Config;
  profile: ResolvedProfile;
  client: Client;
  cache: Cache;
  /** --limit, 0 when unset */
  limit: number;
}

/** Command-side view of the runtime: lazily builds the printer/app from global options. */
export interface Ctx {
  io: Io;
  globals(): Globals;
  printer(): Printer;
  configPath(): string;
  /** profile name from --profile or DOORAY_PROFILE (undefined → config default) */
  profileName(): string | undefined;
  app(): Promise<App>;
}

export function createCtx(io: Io, globals: () => Globals): Ctx {
  const ctx: Ctx = {
    io,
    globals,
    printer: () => createPrinter(parseFormat(globals().format), io, globals().quiet),
    configPath: () => configPath(io.env),
    profileName: () => globals().profile || io.env.DOORAY_PROFILE || undefined,
    async app() {
      const g = globals();
      const printer = ctx.printer();
      const cfgPath = ctx.configPath();
      const cfg = await loadConfig(cfgPath);
      const profile = resolveProfile(cfg, ctx.profileName(), g.env);
      const client = new Client({
        token: profile.token,
        baseUrl: profile.baseUrl,
        fileUrl: profile.fileUrl,
        fetch: io.fetch,
        sleep: io.sleep,
        debug: g.debug ? (line) => io.err(`[debug] ${line}\n`) : undefined,
      });
      const cache = new Cache(cacheDir(io.env, profile.name));
      return { io, globals: g, printer, cfgPath, cfg, profile, client, cache, limit: g.limit ?? 0 };
    },
  };
  return ctx;
}
