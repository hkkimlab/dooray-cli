// Small helpers shared by command modules.
import type { Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { confirm } from "../core/prompt.js";

/** Asks (or honours --yes); a declined prompt prints "cancelled" and returns false. */
export async function confirmed(ctx: Ctx, question: string, yes: boolean | undefined): Promise<boolean> {
  if (await confirm(ctx.io, question, yes === true)) return true;
  ctx.printer().info("cancelled");
  return false;
}

/** commander collector for repeatable options. */
export const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

/** Repeatable and/or comma-separated values → flat list. */
export const splitList = (vals: string[] | undefined): string[] =>
  (vals ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

export function oneOf(flag: string, allowed: readonly string[], v: string | undefined): string | undefined {
  if (v !== undefined && !allowed.includes(v)) throw usageError(`${flag} must be one of ${allowed.join("|")}`);
  return v;
}

/** Drops undefined values so update bodies carry only the fields the user gave. */
export const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
