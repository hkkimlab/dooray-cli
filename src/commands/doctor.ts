import { stat } from "node:fs/promises";
import type { Command } from "commander";
import type { Ctx } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { errorMessage, generic } from "../core/errors.js";

interface Check {
  check: string;
  ok: boolean;
  detail: string;
}

async function runChecks(ctx: Ctx): Promise<Check[]> {
  const path = ctx.configPath();
  const st = await stat(path).catch(() => undefined);
  if (!st) return [{ check: "config", ok: false, detail: `${path} not found; run "dooray auth login"` }];
  const checks: Check[] = [];
  try {
    await loadConfig(path);
    checks.push({ check: "config", ok: true, detail: path });
  } catch (e) {
    return [{ check: "config", ok: false, detail: errorMessage(e) }];
  }
  const mode = (st.mode & 0o777).toString(8).padStart(4, "0");
  checks.push(
    mode === "0600"
      ? { check: "permissions", ok: true, detail: mode }
      : { check: "permissions", ok: false, detail: `${mode} (run: chmod 600 ${path})` },
  );
  try {
    const app = await ctx.app();
    const p = app.profile;
    if (!p.token) return [...checks, { check: "profile", ok: false, detail: `${p.name} has no token` }];
    checks.push({ check: "profile", ok: true, detail: `${p.name} (${p.env}) ${p.baseUrl}` });
    const me = await app.client.call<{ name?: string }>("GET", "/common/v1/members/me");
    checks.push({ check: "api", ok: true, detail: `members/me ok: ${me.name ?? ""}` });
  } catch (e) {
    const failed = checks.some((c) => c.check === "profile") ? "api" : "profile";
    checks.push({ check: failed, ok: false, detail: errorMessage(e) });
  }
  return checks;
}

export function registerDoctor(program: Command, ctx: Ctx): void {
  program
    .command("doctor")
    .description("check config, file permissions, profile and API connectivity")
    .action(async () => {
      const checks = await runChecks(ctx);
      ctx.printer().emit(checks, {
        columns: ["CHECK", "STATUS", "DETAIL"],
        rows: checks.map((c) => [c.check, c.ok ? "ok" : "FAIL", c.detail]),
      });
      if (!checks.every((c) => c.ok)) throw generic("doctor found problems");
    });
}
