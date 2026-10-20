import type { Command } from "commander";
import type { Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { cell, type Table } from "../core/output.js";
import { resolveMember } from "../core/resolve.js";
import { defined } from "./common.js";

interface Member {
  id: string;
  name?: string;
  userCode?: string;
  externalEmailAddress?: string;
}

const table = (ms: Member[]): Table => ({
  columns: ["ID", "CODE", "NAME", "EMAIL"],
  rows: ms.map((m) => [m.id, cell(m.userCode), cell(m.name), cell(m.externalEmailAddress)]),
});

export function registerMember(program: Command, ctx: Ctx): void {
  const cmd = program.command("member").description("organization members");

  cmd
    .command("list")
    .description("search members (Dooray has no 'list everyone': one filter is required)")
    .option("--search <name>", "name")
    .option("--user-code <code>", "user code (ID)")
    .option("--email <address>", "external email address")
    .action(async (o: { search?: string; userCode?: string; email?: string }) => {
      const q = defined({ name: o.search, userCode: o.userCode, externalEmailAddresses: o.email });
      if (!Object.keys(q).length) throw usageError("member list needs --search, --user-code or --email");
      const app = await ctx.app();
      const ms = await app.client.list<Member>("/common/v1/members", q, app.limit);
      app.printer.emit(ms, table(ms));
    });

  cmd
    .command("get <member>")
    .description("show a member: id, me, name or email")
    .action(async (who: string) => {
      const app = await ctx.app();
      const id = await resolveMember(app.client, who);
      const m = await app.client.call<Member>("GET", `/common/v1/members/${id}`);
      app.printer.emit(m, table([m]));
    });
}
