import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { authError, errorMessage, generic, notFound, usageError } from "./errors.js";

// The on-disk shape is the Go CLI's config.yaml (snake_case keys). Unknown keys are preserved.
export interface DriveCfg {
  default_drive_id?: string;
}

export interface MailCfg {
  username?: string;
  password?: string;
  imap_host?: string;
  imap_port?: number;
  smtp_host?: string;
  smtp_port?: number;
}

export interface Profile {
  token?: string;
  env?: string;
  base_url?: string;
  file_url?: string;
  /** tenant: the <domain> in https://<domain>.gov-dooray.com (auth sso) */
  domain?: string;
  drive?: DriveCfg;
  mail?: MailCfg;
  [key: string]: unknown;
}

export interface Config {
  default_profile?: string;
  profiles: Record<string, Profile>;
  hooks?: Record<string, string>;
  [key: string]: unknown;
}

export interface ResolvedProfile {
  name: string;
  token: string;
  env: string;
  baseUrl: string;
  fileUrl: string;
  drive: DriveCfg;
  mail: MailCfg;
}

type Env = Record<string, string | undefined>;

export function configPath(env: Env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? ".", ".config");
  return join(base, "dooray", "config.yaml");
}

const PRESETS: Record<string, { baseUrl: string; fileUrl: string }> = {
  gov: { baseUrl: "https://api.gov-dooray.com", fileUrl: "https://file-api.gov-dooray.com" },
  commercial: { baseUrl: "https://api.dooray.com", fileUrl: "https://file-api.dooray.com" },
};

/** Host preset for an env name. Empty env means gov (the Go CLI defaulted to commercial). */
export function hosts(env: string): { baseUrl: string; fileUrl: string } | undefined {
  return PRESETS[env === "" ? "gov" : env];
}

const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw generic("read config: " + errorMessage(e));
  }
  let data: unknown;
  try {
    data = parse(text) ?? {};
  } catch (e) {
    throw generic("parse config: " + errorMessage(e));
  }
  if (!isMapping(data)) throw generic("parse config: top level must be a mapping");
  const profiles = data.profiles ?? {};
  if (!isMapping(profiles) || !Object.values(profiles).every((p) => p === null || isMapping(p))) {
    throw generic("parse config: profiles must be a mapping of profile names");
  }
  return { ...data, profiles: profiles as Record<string, Profile> } as Config;
}

/** Atomically writes the config as 0600 inside a 0700 directory. */
export async function saveConfig(cfg: Config, path: string): Promise<void> {
  const dir = dirname(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeFile(tmp, stringify(cfg), { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw generic("write config: " + errorMessage(e));
  }
}

export function resolveProfile(cfg: Config, name?: string, envOverride?: string): ResolvedProfile {
  const profileName = name || cfg.default_profile || "";
  const p = cfg.profiles[profileName];
  if (!p) {
    if (Object.keys(cfg.profiles).length === 0) {
      throw authError('no profile configured; run "dooray auth login" first');
    }
    throw authError("unknown profile: " + profileName);
  }
  let env = p.env ?? "";
  let baseUrl = p.base_url || hosts(env)?.baseUrl || "";
  let fileUrl = p.file_url || hosts(env)?.fileUrl || "";
  if (envOverride) {
    const preset = hosts(envOverride);
    if (!preset) throw usageError("unknown env: " + envOverride);
    ({ baseUrl, fileUrl } = preset);
    env = envOverride;
  }
  return {
    name: profileName,
    token: p.token ?? "",
    env: env || "gov",
    baseUrl,
    fileUrl,
    drive: p.drive ?? {},
    mail: p.mail ?? {},
  };
}

export function setProfileToken(cfg: Config, name: string, env: string, token: string): Config {
  return {
    ...cfg,
    default_profile: cfg.default_profile || name,
    profiles: { ...cfg.profiles, [name]: { ...cfg.profiles[name], token, env } },
  };
}

export function removeProfile(cfg: Config, name: string): Config {
  if (!cfg.profiles[name]) throw notFound("no such profile: " + name);
  const profiles = Object.fromEntries(Object.entries(cfg.profiles).filter(([n]) => n !== name));
  const default_profile =
    cfg.default_profile === name ? (Object.keys(profiles).sort()[0] ?? "") : cfg.default_profile;
  return { ...cfg, default_profile, profiles };
}
