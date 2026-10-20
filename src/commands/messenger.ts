import type { Command } from "commander";
import * as ms from "../api/messenger.js";
import type { Channel, MessageLog } from "../api/messenger.js";
import type { App, Ctx } from "../core/app.js";
import { usageError } from "../core/errors.js";
import { cell, type Table } from "../core/output.js";
import { memberNames, resolveMember } from "../core/resolve.js";
import { readText } from "../core/text.js";
import { endOfDay, isDateOnly, toKst } from "../core/time.js";
import { collect, confirmed, oneOf } from "./common.js";

const TYPES = ["direct", "private", "me", "bot"];
const DEFAULT_LOGS = 20;
const DEFAULT_BOT_NAME = "dooray-cli";

const channelTable = (cs: Channel[]): Table => ({
  columns: ["ID", "TITLE", "TYPE", "STATUS", "UPDATED"],
  rows: cs.map((c) => [c.id, cell(c.title), cell(c.type), cell(c.status), cell(c.updatedAt)]),
});

/** [text] argument, or stdin with --stdin; empty is an error. */
async function messageText(ctx: Ctx, text: string | undefined, stdin: boolean | undefined): Promise<string> {
  const t = stdin ? await readText(ctx.io, "text", "-", undefined) : text;
  if (!t) throw usageError("message text is empty (pass it as an argument or use --stdin)");
  return t;
}

const channelId = (app: App, ref: string) => ms.resolveChannel(app.client, app.cache, ref);

async function memberIds(app: App, who: string[] | undefined): Promise<string[]> {
  const ids = [];
  for (const w of who?.length ? who : ["me"]) ids.push(await resolveMember(app.client, w));
  return ids;
}

interface LogsOpts {
  count?: string;
  all?: boolean;
  since?: string;
  until?: string;
  countOnly?: boolean;
}

/** --since/--until → inclusive epoch-ms bounds (KST); a date-only --until covers that whole day. */
function logsRange(o: LogsOpts): { since?: number; until?: number } {
  const since = o.since === undefined ? undefined : Date.parse(toKst(o.since));
  const until = o.until === undefined ? undefined : isDateOnly(o.until) ? Date.parse(endOfDay(o.until)) + 999 : Date.parse(toKst(o.until));
  if (since !== undefined && until !== undefined && since > until) throw usageError("--since must not be after --until");
  return { since, until };
}

/** -n → how many to keep; undefined = everything (--all, or a range without -n). */
function logsCount(o: LogsOpts, ranged: boolean): number | undefined {
  if (o.count === undefined) return o.all || ranged ? undefined : DEFAULT_LOGS;
  if (o.all || o.countOnly) throw usageError(`-n/--count cannot be combined with ${o.all ? "--all" : "--count-only"}`);
  const n = Number(o.count);
  if (!Number.isInteger(n) || n < 1) throw usageError("--count must be a positive integer");
  return n;
}

function emitCounts(app: App, channelId: string, latestSeq: number | undefined, logs: MessageLog[]): void {
  const tally = logs.reduce((m, l) => m.set(l.type ?? "UNKNOWN", (m.get(l.type ?? "UNKNOWN") ?? 0) + 1), new Map<string, number>());
  const byType = Object.fromEntries([...tally].sort(([a], [b]) => a.localeCompare(b)));
  const [oldest, newest] = [logs[0]?.sentAt, logs.at(-1)?.sentAt];
  app.printer.emit(
    { channelId, latestSeq, count: logs.length, byType, oldest, newest },
    {
      columns: ["CHANNEL_ID", "LATEST_SEQ", "COUNT", "OLDEST", "NEWEST", "BY_TYPE"],
      rows: [[channelId, cell(latestSeq), String(logs.length), cell(oldest), cell(newest), Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(" ")]],
    },
  );
}

export function registerMessenger(program: Command, ctx: Ctx): void {
  const cmd = program.command("messenger").description("Dooray messenger: send, channels, message logs, threads");

  cmd
    .command("send [text]")
    .description("send a message to a member (--to), a channel (--channel) or a configured webhook (--hook)")
    .option("--to <who>", "member: id, name, email or me")
    .option("--channel <channel>", "channel id or title")
    .option("--hook <name>", "webhook name from config.yaml hooks")
    .option("--bot-name <name>", "sender name for --hook", DEFAULT_BOT_NAME)
    .option("--stdin", "read the message from stdin")
    .action(async (text: string | undefined, o: { to?: string; channel?: string; hook?: string; botName: string; stdin?: boolean }) => {
      if ([o.to, o.channel, o.hook].filter(Boolean).length !== 1) throw usageError("pass exactly one of --to, --channel or --hook");
      const body = await messageText(ctx, text, o.stdin);
      const app = await ctx.app();
      if (o.hook) {
        const url = app.cfg.hooks?.[o.hook];
        if (!url) throw usageError(`no hook named '${o.hook}' in config.yaml (hooks: ${Object.keys(app.cfg.hooks ?? {}).join(", ") || "none"})`);
        await ms.sendHook(app.io.fetch, url, { botName: o.botName, text: body });
        return app.printer.info(`sent via hook ${o.hook}`);
      }
      const r = o.channel
        ? await ms.sendToChannel(app.client, await channelId(app, o.channel), body)
        : await ms.sendDirect(app.client, await resolveMember(app.client, o.to!), body);
      app.printer.emit(r, { columns: ["LOG_ID"], rows: [[cell(r?.id)]] });
    });

  const ch = cmd.command("channel").description("channels");

  ch.command("list")
    .description("your channels, newest activity first (archived/hidden ones only with --all)")
    .option("--type <type>", TYPES.join("|"))
    .option("--search <text>", "title contains")
    .option("--all", "include archived and hidden channels")
    .action(async (o: { type?: string; search?: string; all?: boolean }) => {
      oneOf("--type", TYPES, o.type);
      const app = await ctx.app();
      const shown = (await ms.listChannels(app.client))
        .filter((c) => o.all || (c.status === "normal" && c.displayed !== false))
        .filter((c) => !o.type || c.type === o.type)
        .filter((c) => !o.search || (c.title ?? "").toLowerCase().includes(o.search.toLowerCase()))
        .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
      const limited = app.limit > 0 ? shown.slice(0, app.limit) : shown;
      app.printer.emit(limited, channelTable(limited));
    });

  ch.command("create")
    .description("create a private (or direct) channel")
    .requiredOption("--title <title>", "channel title")
    .option("--type <type>", "private|direct", "private")
    .option("--member <who>", "member to add (repeatable; default: me)", collect)
    .option("--capacity <n>", "maximum members", "100")
    .action(async (o: { title: string; type: string; member?: string[]; capacity: string }) => {
      const type = oneOf("--type", ["private", "direct"], o.type)!;
      const app = await ctx.app();
      const { id } = await ms.createChannel(app.client, { type, title: o.title, memberIds: await memberIds(app, o.member), capacity: o.capacity });
      await app.cache.drop("channels");
      app.printer.emit({ id }, { columns: ["ID"], rows: [[id]] });
    });

  ch.command("join <channel>")
    .description("add members (default: you) to a channel")
    .option("--member <who>", "member (repeatable; default: me)", collect)
    .action(async (ref: string, o: { member?: string[] }) => {
      const app = await ctx.app();
      await ms.joinChannel(app.client, await channelId(app, ref), await memberIds(app, o.member));
      app.printer.info(`joined ${ref}`);
    });

  ch.command("leave <channel>")
    .description("remove members (default: you) from a channel")
    .option("--member <who>", "member (repeatable; default: me)", collect)
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, o: { member?: string[]; yes?: boolean }) => {
      if (!(await confirmed(ctx, `leave channel ${ref}?`, o.yes))) return;
      const app = await ctx.app();
      await ms.leaveChannel(app.client, await channelId(app, ref), await memberIds(app, o.member));
      app.printer.info(`left ${ref}`);
    });

  cmd
    .command("logs <channel>")
    .description("messages, oldest first (undocumented API; pages back 1000 at a time; dates are filtered locally)")
    .option("-n, --count <n>", `how many of the newest (default ${DEFAULT_LOGS}; with --since/--until: all in the range)`)
    .option("--all", "every message back to the first one")
    .option("--since <time>", "sent at/after this time (KST; date, \"YYYY-MM-DD HH:MM\" or ISO-8601)")
    .option("--until <time>", "sent at/before this time (a date includes that whole day)")
    .option("--count-only", "print counts instead of messages (alone: latest seq as an upper bound, one request)")
    .action(async (ref: string, o: LogsOpts) => {
      const range = logsRange(o);
      const ranged = o.since !== undefined || o.until !== undefined;
      const count = logsCount(o, ranged);
      const app = await ctx.app();
      const id = await channelId(app, ref);
      if (o.countOnly && !o.all && !ranged) {
        const latestSeq = (await ms.listLogsPage(app.client, id, { size: 1 })).logs[0]?.seq;
        const bound = latestSeq === undefined ? "0" : `<= ${latestSeq}`;
        return app.printer.emit({ channelId: id, latestSeq, approximate: true }, { columns: ["CHANNEL_ID", "LATEST_SEQ", "COUNT"], rows: [[id, cell(latestSeq), bound]] });
      }
      const { logs, latestSeq } = await ms.fetchLogs(app.client, id, {
        count,
        ...range,
        onPage: (pages, fetched, oldest) => pages > 1 && app.printer.info(`logs: ${fetched} messages, oldest ${cell(oldest)}`),
      });
      if (o.countOnly) return emitCounts(app, id, latestSeq, logs);
      const names = await memberNames(app.client, logs.flatMap((l) => (l.sender?.member ? [l.sender.member.organizationMemberId] : [])));
      const named: MessageLog[] = logs.map((l) =>
        l.sender?.member ? { ...l, sender: { member: { ...l.sender.member, name: names.get(l.sender.member.organizationMemberId) } } } : l,
      );
      app.printer.emit(named, {
        columns: ["ID", "SEQ", "SENT", "SENDER", "TEXT"],
        rows: named.map((l) => [l.id, cell(l.seq), cell(l.sentAt), cell(l.sender?.member?.name ?? l.type), (l.text ?? "").replace(/\s+/g, " ")]),
      });
    });

  cmd
    .command("thread <channel> [text]")
    .description("start a thread: on a new message, or on an existing one with --log")
    .option("--log <logId>", "message to start the thread on")
    .option("--thread-text <text>", "first message inside the new thread (new-message form only)")
    .option("--stdin", "read the text from stdin")
    .action(async (ref: string, text: string | undefined, o: { log?: string; threadText?: string; stdin?: boolean }) => {
      if (o.log && o.threadText) throw usageError("--thread-text only applies without --log");
      const body = await messageText(ctx, text, o.stdin);
      const app = await ctx.app();
      const id = await channelId(app, ref);
      const r = o.log ? await ms.threadOnLog(app.client, id, o.log, body) : await ms.createThread(app.client, id, body, o.threadText);
      app.printer.emit(r, { columns: ["LOG_ID", "THREAD_CHANNEL_ID"], rows: [[r.id, r.channelId]] });
    });

  cmd
    .command("reply <channel> <logId> [text]")
    .description("reply to a message")
    .option("--stdin", "read the text from stdin")
    .action(async (ref: string, logId: string, text: string | undefined, o: { stdin?: boolean }) => {
      const body = await messageText(ctx, text, o.stdin);
      const app = await ctx.app();
      const r = await ms.reply(app.client, await channelId(app, ref), logId, body);
      app.printer.emit(r, { columns: ["LOG_ID", "CHANNEL_ID"], rows: [[r.id, cell(r.channelId)]] });
    });

  cmd
    .command("edit <channel> <logId> [text]")
    .description("edit one of your messages")
    .option("--stdin", "read the text from stdin")
    .action(async (ref: string, logId: string, text: string | undefined, o: { stdin?: boolean }) => {
      const body = await messageText(ctx, text, o.stdin);
      const app = await ctx.app();
      await ms.editLog(app.client, await channelId(app, ref), logId, body);
      app.printer.info(`edited ${logId}`);
    });

  cmd
    .command("delete <channel> <logId>")
    .description("delete one of your messages")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (ref: string, logId: string, o: { yes?: boolean }) => {
      if (!(await confirmed(ctx, `delete message ${logId}?`, o.yes))) return;
      const app = await ctx.app();
      await ms.deleteLog(app.client, await channelId(app, ref), logId);
      app.printer.info(`deleted ${logId}`);
    });
}
