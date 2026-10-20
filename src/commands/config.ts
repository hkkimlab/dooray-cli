import type { Command } from "commander";
import type { Ctx } from "../core/app.js";
import { Cache, cacheDir } from "../core/cache.js";
import { hosts, loadConfig, resolveProfile, saveConfig, type Config, type Profile } from "../core/config.js";
import { usageError } from "../core/errors.js";
import { readLine } from "../core/prompt.js";

type Kind = "string" | "int";

const PROFILE_KEYS: Record<string, Kind> = {
  token: "string",
  env: "string",
  base_url: "string",
  file_url: "string",
  "drive.default_drive_id": "string",
  "mail.username": "string",
  "mail.password": "string",
  "mail.imap_host": "string",
  "mail.imap_port": "int",
  "mail.smtp_host": "string",
  "mail.smtp_port": "int",
};
const SECRET = (key: string) => key === "token" || key === "mail.password" || key.startsWith("hooks.");
const KEY_HELP = ["default_profile", "hooks.<name>", ...Object.keys(PROFILE_KEYS)].join(", ");

const mask = (v: string) => (v.length >= 12 ? `${v.slice(0, 4)}****${v.slice(-4)}` : "****");

function coerce(key: string, kind: Kind, raw: string): string | number {
  if (kind === "int") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw usageError(`${key} must be a positive integer`);
    return n;
  }
  if (key === "env" && !hosts(raw)) throw usageError("unknown env: " + raw + " (gov|commercial)");
  return raw;
}

function targetProfile(ctx: Ctx, cfg: Config): string {
  const name = ctx.profileName() || cfg.default_profile;
  if (!name) throw usageError("no profile selected; pass --profile <name>");
  return name;
}

function setKey(cfg: Config, profileName: string, key: string, value: string | number): Config {
  if (key === "default_profile") return { ...cfg, default_profile: String(value) };
  if (key.startsWith("hooks.")) return { ...cfg, hooks: { ...cfg.hooks, [key.slice(6)]: String(value) } };
  const profile: Profile = cfg.profiles[profileName] ?? {};
  const [a, b] = key.split(".") as [string, string | undefined];
  const next = b === undefined ? { ...profile, [a]: value } : { ...profile, [a]: { ...(profile[a] as object), [b]: value } };
  return { ...cfg, profiles: { ...cfg.profiles, [profileName]: next } };
}

function flatten(cfg: Config, profileName: string): Record<string, string> {
  const p = cfg.profiles[profileName] ?? {};
  const out: Record<string, string> = { default_profile: cfg.default_profile ?? "" };
  for (const key of Object.keys(PROFILE_KEYS)) {
    const [a, b] = key.split(".") as [string, string | undefined];
    const v = b === undefined ? p[a] : (p[a] as Record<string, unknown> | undefined)?.[b];
    if (v !== undefined && v !== "") out[key] = String(v);
  }
  for (const [name, url] of Object.entries(cfg.hooks ?? {})) out[`hooks.${name}`] = url;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, SECRET(k) ? mask(v) : v]));
}

export function registerConfig(program: Command, ctx: Ctx): void {
  const config = program.command("config").description("read and write config.yaml values for the selected profile");

  config
    .command("get [key]")
    .description(`show values (secrets masked); keys: ${KEY_HELP}`)
    .action(async (key?: string) => {
      const cfg = await loadConfig(ctx.configPath());
      const all = flatten(cfg, targetProfile(ctx, cfg));
      const printer = ctx.printer();
      if (key === undefined) {
        printer.emit(all, { columns: ["KEY", "VALUE"], rows: Object.entries(all) });
      } else if (printer.format === "json") {
        printer.emit({ [key]: all[key] ?? null }, { columns: [], rows: [] });
      } else {
        ctx.io.out((all[key] ?? "") + "\n");
      }
    });

  config
    .command("set <key> <value>")
    .description(`set a value ("-" reads it from stdin); keys: ${KEY_HELP}`)
    .action(async (key: string, value: string) => {
      const kind: Kind | undefined =
        key === "default_profile" || /^hooks\.[\w.-]+$/.test(key) ? "string" : PROFILE_KEYS[key];
      if (!kind) throw usageError(`unknown key: ${key} (${KEY_HELP})`);
      const raw = value === "-" ? await readLine(ctx.io, "") : value;
      const path = ctx.configPath();
      const cfg = await loadConfig(path);
      await saveConfig(setKey(cfg, targetProfile(ctx, cfg), key, coerce(key, kind, raw)), path);
      ctx.printer().info(`set ${key}`);
    });

  program
    .command("cache")
    .description("local lookup cache (projects, members, tags, ...)")
    .command("clear")
    .description("delete the selected profile's cache")
    .action(async () => {
      const cfg = await loadConfig(ctx.configPath());
      const name = resolveProfile(cfg, ctx.profileName()).name;
      await new Cache(cacheDir(ctx.io.env, name)).clear();
      ctx.printer().info(`cleared cache for "${name}"`);
    });
}
