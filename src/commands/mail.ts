import type { Command } from "commander";
import type { Ctx } from "../core/app.js";
import { loadConfig, saveConfig, type Config, type MailCfg } from "../core/config.js";
import { authError, usageError } from "../core/errors.js";
import { cell, type Table } from "../core/output.js";
import { readLine, readSecret } from "../core/prompt.js";
import { parseDoorayUrl } from "../core/resolve.js";
import { readText } from "../core/text.js";
import { kstIso } from "../core/time.js";
import type { MailBackend, MailSettings, MailSummary } from "../mail/backend.js";
import { collect, confirmed } from "./common.js";

// Commercial Dooray mail hosts; the user chose to use them for gov profiles as well.
const DEFAULTS = { imap_host: "imap.dooray.com", imap_port: 993, smtp_host: "smtp.dooray.com", smtp_port: 465 };
const MAX_UID = 2 ** 32 - 1;

const backend = async (ctx: Ctx): Promise<MailBackend> => ctx.io.mail ?? (await import("../mail/backend.js")).imapBackend();

function settings(m: MailCfg): MailSettings {
  if (!m.username || !m.password) throw authError('mail is not set up for this profile; run "dooray mail login"');
  return {
    username: m.username,
    password: m.password,
    imapHost: m.imap_host ?? DEFAULTS.imap_host,
    imapPort: m.imap_port ?? DEFAULTS.imap_port,
    smtpHost: m.smtp_host ?? DEFAULTS.smtp_host,
    smtpPort: m.smtp_port ?? DEFAULTS.smtp_port,
  };
}

const when = (iso: string | undefined) => (iso ? kstIso(new Date(iso)) : "");
const address = (s: string) => /<([^>]+)>/.exec(s)?.[1] ?? s;

const listTable = (ms: MailSummary[]): Table => ({
  columns: ["UID", "DATE", "FROM", "SUBJECT", "READ"],
  rows: ms.map((m) => [String(m.uid), when(m.date), m.from, m.subject, m.seen ? "yes" : "no"]),
});

/** UID, Dooray mail id, or a Dooray mail URL → { uid, mailbox }. */
async function target(mail: MailBackend, s: MailSettings, ref: string, folder: string): Promise<{ uid: number; mailbox: string }> {
  const url = parseDoorayUrl(ref);
  if (url && url.kind !== "mail") throw usageError(`'${ref}' is a ${url.kind} URL, not a mail URL`);
  if (url?.kind === "mail") {
    const mailbox = url.mailbox ?? folder;
    return { uid: await mail.uidForMailId(s, url.mailId, mailbox), mailbox };
  }
  if (/^\d+$/.test(ref) && Number(ref) <= MAX_UID) return { uid: Number(ref), mailbox: folder };
  if (/^\d{15,}$/.test(ref)) return { uid: await mail.uidForMailId(s, ref, folder), mailbox: folder };
  throw usageError(`'${ref}': use a UID, a Dooray mail id or a mail URL`);
}

async function saveMail(ctx: Ctx, update: (m: MailCfg) => MailCfg): Promise<string> {
  const path = ctx.configPath();
  const cfg: Config = await loadConfig(path);
  const name = ctx.profileName() || cfg.default_profile;
  if (!name || !cfg.profiles[name]) throw usageError("no profile to store mail settings in; run dooray auth login first or pass --profile");
  const profile = cfg.profiles[name]!;
  await saveConfig({ ...cfg, profiles: { ...cfg.profiles, [name]: { ...profile, mail: update(profile.mail ?? {}) } } }, path);
  return name;
}

export function registerMail(program: Command, ctx: Ctx): void {
  const cmd = program.command("mail").description("Dooray mail over IMAP/SMTP (imap.dooray.com / smtp.dooray.com by default)");

  cmd
    .command("login")
    .description("store the mail account for this profile (password prompt or stdin), after checking IMAP login")
    .option("--username <email>", "mail account (default: prompt)")
    .option("--imap-host <host>", `IMAP host (default ${DEFAULTS.imap_host})`)
    .option("--imap-port <port>", `IMAP port (default ${DEFAULTS.imap_port})`)
    .option("--smtp-host <host>", `SMTP host (default ${DEFAULTS.smtp_host})`)
    .option("--smtp-port <port>", `SMTP port (default ${DEFAULTS.smtp_port})`)
    .option("--no-verify", "save without trying to log in")
    .action(async (o: { username?: string; imapHost?: string; imapPort?: string; smtpHost?: string; smtpPort?: string; verify: boolean }) => {
      const port = (flag: string, v: string | undefined) => {
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw usageError(`${flag} must be a port number`);
        return n;
      };
      const username = o.username ?? (await readLine(ctx.io, "mail account (email): "));
      const password = await readSecret(ctx.io, "mail password: ");
      if (!username || !password) throw authError("empty mail account or password");
      const hosts: MailCfg = {
        ...(o.imapHost && { imap_host: o.imapHost }),
        ...(o.imapPort && { imap_port: port("--imap-port", o.imapPort) }),
        ...(o.smtpHost && { smtp_host: o.smtpHost }),
        ...(o.smtpPort && { smtp_port: port("--smtp-port", o.smtpPort) }),
      };
      if (o.verify) await (await backend(ctx)).verify(settings({ ...hosts, username, password }));
      const name = await saveMail(ctx, (m) => ({ ...m, ...hosts, username, password }));
      ctx.printer().info(`saved mail account for profile "${name}"`);
    });

  cmd
    .command("logout")
    .description("remove the stored mail account (host settings are kept)")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (o: { yes?: boolean }) => {
      if (!(await confirmed(ctx, "remove the stored mail account and password?", o.yes))) return;
      const name = await saveMail(ctx, ({ username: _u, password: _p, ...rest }) => rest);
      ctx.printer().info(`removed mail account from profile "${name}"`);
    });

  cmd
    .command("list")
    .description("newest mails in a folder")
    .option("--unread", "unread only")
    .option("--search <text>", "subject contains")
    .option("--size <n>", "how many", "20")
    .option("--folder <folder>", "INBOX (default), sent, draft, archive, spam, trash, or a folder path", "INBOX")
    .action(async (o: { unread?: boolean; search?: string; size: string; folder: string }) => {
      const limit = Number(o.size);
      if (!Number.isInteger(limit) || limit < 1) throw usageError("--size must be a positive integer");
      const app = await ctx.app();
      const ms = await (await backend(ctx)).list(settings(app.profile.mail), { mailbox: o.folder, unread: o.unread, search: o.search, limit });
      app.printer.emit(ms, listTable(ms));
    });

  cmd
    .command("get <mail>")
    .description("show a mail: UID, Dooray mail id, or mail URL")
    .option("--folder <folder>", "folder for UIDs/mail ids", "INBOX")
    .action(async (ref: string, o: { folder: string }) => {
      const app = await ctx.app();
      const mail = await backend(ctx);
      const s = settings(app.profile.mail);
      const t = await target(mail, s, ref, o.folder);
      const m = await mail.get(s, t.uid, t.mailbox);
      if (app.printer.format !== "table") return app.printer.emit(m, listTable([m]));
      app.printer.emit(m, {
        columns: ["FIELD", "VALUE"],
        rows: [
          ["UID", String(m.uid)],
          ["DATE", when(m.date)],
          ["FROM", m.from],
          ["TO", m.to.join(", ")],
          ["CC", m.cc.join(", ")],
          ["SUBJECT", m.subject],
          ["ATTACHMENTS", m.attachments.map((a) => `${a.filename} (${a.size})`).join(", ")],
        ],
      });
      app.io.out(`\n${m.body}\n`);
    });

  cmd
    .command("send")
    .description("send a mail from the profile's account")
    .option("--to <address>", "recipient (repeatable)", collect)
    .option("--cc <address>", "cc (repeatable)", collect)
    .option("--bcc <address>", "bcc (repeatable)", collect)
    .option("--subject <text>", "subject")
    .option("--body <text>", 'body ("-" = stdin)')
    .option("--body-file <path>", "body from a file")
    .option("--html", "the body is HTML")
    .option("--attach <path>", "attach a file (repeatable)", collect)
    .action(async (o: { to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string; bodyFile?: string; html?: boolean; attach?: string[] }) => {
      if (!o.to?.length || !o.subject) throw usageError("mail send needs --to and --subject");
      const body = (await readText(ctx.io, "body", o.body, o.bodyFile)) ?? "";
      const app = await ctx.app();
      const s = settings(app.profile.mail);
      const r = await (await backend(ctx)).send(s, {
        from: s.username,
        to: o.to,
        ...(o.cc && { cc: o.cc }),
        ...(o.bcc && { bcc: o.bcc }),
        subject: o.subject,
        ...(o.html ? { html: body } : { text: body }),
        ...(o.attach && { attachments: o.attach }),
      });
      app.printer.emit(r, { columns: ["MESSAGE_ID"], rows: [[cell(r.messageId)]] });
    });

  cmd
    .command("reply <mail>")
    .description("reply to a mail (asks first)")
    .option("--folder <folder>", "folder for UIDs/mail ids", "INBOX")
    .option("--body <text>", 'reply text ("-" = stdin)')
    .option("--body-file <path>", "reply text from a file")
    .option("--html", "the body is HTML")
    .option("--cc <address>", "extra cc (repeatable)", collect)
    .option("--all", "reply to all: original To/Cc (except you) go to Cc")
    .option("-y, --yes", "send without asking")
    .action(async (ref: string, o: { folder: string; body?: string; bodyFile?: string; html?: boolean; cc?: string[]; all?: boolean; yes?: boolean }) => {
      const body = await readText(ctx.io, "body", o.body, o.bodyFile);
      if (!body) throw usageError("mail reply needs --body or --body-file");
      const app = await ctx.app();
      const mail = await backend(ctx);
      const s = settings(app.profile.mail);
      const t = await target(mail, s, ref, o.folder);
      const orig = await mail.get(s, t.uid, t.mailbox);
      const to = orig.replyTo ?? orig.fromAddress ?? address(orig.from);
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      const others = o.all ? [...orig.to, ...orig.cc].map(address).filter((a) => !same(a, s.username) && !same(a, to)) : [];
      const cc = [...new Set([...others, ...(o.cc ?? [])])];
      const subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
      if (!(await confirmed(ctx, `send "${subject}" to ${to}${cc.length ? ` (cc ${cc.join(", ")})` : ""}?`, o.yes))) return;
      const r = await mail.send(s, {
        from: s.username,
        to: [to],
        ...(cc.length && { cc }),
        subject,
        ...(o.html ? { html: body } : { text: body }),
        ...(orig.messageId && { inReplyTo: orig.messageId, references: [...(orig.references ?? []), orig.messageId].join(" ") }),
      });
      app.printer.emit(r, { columns: ["MESSAGE_ID"], rows: [[cell(r.messageId)]] });
    });
}
