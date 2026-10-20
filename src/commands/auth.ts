import type { Command } from "commander";
import type { Ctx } from "../core/app.js";
import { hosts, loadConfig, removeProfile, saveConfig, setProfileToken, type Config, type Profile } from "../core/config.js";
import { authError, usageError } from "../core/errors.js";
import { readLine, readSecret } from "../core/prompt.js";
import { DEFAULT_TOKEN_NAME, extractToken } from "../sso/token.js";

interface Me {
  id: string;
  name?: string;
  userCode?: string;
  externalEmailAddress?: string;
}

/** Web host of each env's tenants: https://<domain>.<host>. */
const WEB_HOST: Record<string, string> = { gov: "gov-dooray.com", commercial: "dooray.com" };

/** Writes token (and any extra profile keys) into the named profile and saves. Shared by `auth login` and `auth sso`. */
export async function saveProfileToken(ctx: Ctx, name: string, env: string, token: string, extra: Partial<Profile> = {}): Promise<void> {
  const path = ctx.configPath();
  const cfg = setProfileToken(await loadConfig(path), name, env, token);
  await saveConfig({ ...cfg, profiles: { ...cfg.profiles, [name]: { ...cfg.profiles[name], ...extra } } }, path);
  ctx.printer().info(`saved profile "${name}" (${env})`);
}

/**
 * Which profile/env `auth sso` writes (Go parity): the named or default profile; env from --env,
 * else that profile's env, else gov. A brand-new setup is named after its env.
 */
export function resolveSsoTarget(cfg: Config, profile: string | undefined, envFlag: string | undefined): [string, string] {
  const name = profile || cfg.default_profile || "";
  const env = envFlag || cfg.profiles[name]?.env || "gov";
  if (!hosts(env)) throw usageError("unknown env: " + env);
  return [name || env, env];
}

/** "acme", "acme.gov-dooray.com" or "https://acme.gov-dooray.com/" → "acme". */
export function tenantDomain(raw: string): string {
  const m = /^(?:https:\/\/)?([a-z0-9-]+)(?:\.(?:gov-)?dooray\.com)?\/?$/i.exec(raw.trim());
  if (!m) throw usageError(`invalid Dooray domain: ${raw} (the <domain> in https://<domain>.gov-dooray.com)`);
  return m[1]!.toLowerCase();
}

export function registerAuth(program: Command, ctx: Ctx): void {
  const auth = program.command("auth").description("profiles and API tokens");

  auth
    .command("login")
    .description("store an API token (hidden prompt, or piped on stdin) for --profile (default: env name)")
    .action(async () => {
      const g = ctx.globals();
      const env = g.env || "gov";
      if (!hosts(env)) throw usageError("unknown env: " + env);
      const token = (await readSecret(ctx.io, "Dooray API token: ")).trim();
      if (!token) throw authError("empty token");
      await saveProfileToken(ctx, g.profile || env, env, token);
    });

  auth
    .command("sso")
    .description("mint a Dooray API token by signing in through your organization's SSO (browser automation)")
    .option("--id <username>", "SSO username (default: prompt)")
    .option("--token-name <name>", `Dooray token name (default: ${DEFAULT_TOKEN_NAME})`)
    .action(async (o: { id?: string; tokenName?: string }) => {
      const cfg = await loadConfig(ctx.configPath());
      const [name, env] = resolveSsoTarget(cfg, ctx.profileName(), ctx.globals().env);
      const domain = tenantDomain(cfg.profiles[name]?.domain ?? (await readLine(ctx.io, `Dooray domain (<domain>.${WEB_HOST[env]}): `)));
      const username = o.id?.trim() || (await readLine(ctx.io, "SSO ID: "));
      if (!username) throw authError("empty SSO ID");
      const password = await readSecret(ctx.io, "SSO password: ");
      if (!password.trim()) throw authError("empty password");
      const scrape = ctx.io.sso ?? (await import("../sso/institution.js")).scrapeToken;
      const progress = (p: number, step: string) => ctx.printer().info(`[${String(p).padStart(3)}%] ${step}`);
      const token = extractToken(await scrape(`https://${domain}.${WEB_HOST[env]}`, { username, password }, o.tokenName || DEFAULT_TOKEN_NAME, progress));
      if (!token) throw authError("empty token returned from SSO");
      await saveProfileToken(ctx, name, env, token, { domain });
    });

  auth
    .command("status")
    .description("validate the active profile's token via members/me")
    .action(async () => {
      const { client, profile: prof, printer } = await ctx.app();
      const me = await client.call<Me>("GET", "/common/v1/members/me");
      const status = {
        profile: prof.name,
        env: prof.env,
        baseUrl: prof.baseUrl,
        name: me.name ?? "",
        userCode: me.userCode ?? "",
        email: me.externalEmailAddress ?? "",
        ok: "true",
      };
      printer.emit(status, {
        columns: ["PROFILE", "ENV", "BASE_URL", "NAME", "CODE", "EMAIL", "OK"],
        rows: [[status.profile, status.env, status.baseUrl, status.name, status.userCode, status.email, "true"]],
      });
    });

  auth
    .command("list")
    .description("list configured profiles")
    .action(async () => {
      const cfg = await loadConfig(ctx.configPath());
      const view = Object.keys(cfg.profiles)
        .sort()
        .map((name) => ({ name, env: cfg.profiles[name]?.env ?? "", default: name === cfg.default_profile ? "*" : "" }));
      ctx.printer().emit(view, { columns: ["", "NAME", "ENV"], rows: view.map((v) => [v.default, v.name, v.env]) });
    });

  auth
    .command("remove <profile>")
    .description("delete a stored profile (the default moves to the first remaining one)")
    .action(async (name: string) => {
      const path = ctx.configPath();
      await saveConfig(removeProfile(await loadConfig(path), name), path);
      ctx.printer().info(`removed profile "${name}"`);
    });
}
