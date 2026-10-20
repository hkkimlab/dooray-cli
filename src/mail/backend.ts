// IMAP (imapflow) / SMTP (nodemailer) access for `dooray mail`. The mail-id → UID lookup follows
// jon890/dooray-cli src/api/imapClient.ts (MIT, see THIRD_PARTY_NOTICES.md).
import { DoorayError, EXIT_API, errorMessage, notFound } from "../core/errors.js";

export interface MailSettings {
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  to: string[];
  date?: string;
  seen: boolean;
}

export interface MailFull extends MailSummary {
  fromAddress?: string;
  replyTo?: string;
  cc: string[];
  messageId?: string;
  /** the original's References chain (for threading replies) */
  references?: string[];
  body: string;
  attachments: { filename: string; size: number }[];
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: string[];
}

export interface ListQuery {
  mailbox: string;
  unread?: boolean;
  search?: string;
  limit: number;
}

export interface MailBackend {
  verify(s: MailSettings): Promise<void>;
  list(s: MailSettings, q: ListQuery): Promise<MailSummary[]>;
  get(s: MailSettings, uid: number, mailbox: string): Promise<MailFull>;
  uidForMailId(s: MailSettings, mailId: string, mailbox: string): Promise<number>;
  send(s: MailSettings, m: OutgoingMail): Promise<{ messageId?: string }>;
}

/** Dooray ids carry their creation time: (id >> 23) ms after 2010-01-01T00:00:00Z. */
export function mailIdTime(mailId: string): number {
  if (!/^\d{15,}$/.test(mailId)) throw new DoorayError(2, `not a Dooray mail id: ${mailId}`);
  return Number((BigInt(mailId) >> 23n) + 1262304000000n);
}

const DAY_MS = 86_400_000;
const MAX_CANDIDATES = 2000;
const SPECIAL: Record<string, string> = {
  sent: "\\Sent",
  draft: "\\Drafts",
  drafts: "\\Drafts",
  archive: "\\Archive",
  spam: "\\Junk",
  junk: "\\Junk",
  trash: "\\Trash",
};

interface Address {
  name?: string;
  address?: string;
}
const fmt = (a: Address) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? ""));

type Imap = import("imapflow").ImapFlow;

async function withImap<T>(s: MailSettings, fn: (c: Imap) => Promise<T>): Promise<T> {
  const { ImapFlow } = await import("imapflow");
  // 143 is plain/STARTTLS; anything else (993 by default) is implicit TLS.
  const client = new ImapFlow({ host: s.imapHost, port: s.imapPort, secure: s.imapPort !== 143, auth: { user: s.username, pass: s.password }, logger: false });
  try {
    await client.connect();
  } catch (e) {
    throw new DoorayError(EXIT_API, `IMAP ${s.imapHost}:${s.imapPort}: ${errorMessage(e)}`);
  }
  try {
    return await fn(client);
  } finally {
    if (client.usable) await client.logout().catch(() => client.close());
    else client.close();
  }
}

/** inbox → INBOX; sent/draft/archive/spam/trash → the folder with that special use; anything else as given. */
async function mailboxPath(c: Imap, name: string): Promise<string> {
  if (name.toUpperCase() === "INBOX") return "INBOX";
  const use = SPECIAL[name.toLowerCase()];
  if (!use) return name;
  const box = (await c.list()).find((b) => b.specialUse === use);
  if (!box) throw notFound(`no ${name} folder on the mail server`);
  return box.path;
}

async function inMailbox<T>(c: Imap, name: string, fn: () => Promise<T>): Promise<T> {
  const lock = await c.getMailboxLock(await mailboxPath(c, name));
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

export function imapBackend(): MailBackend {
  return {
    verify: (s) => withImap(s, async () => undefined),

    list: (s, q) =>
      withImap(s, (c) =>
        inMailbox(c, q.mailbox, async () => {
          const query = { ...(q.unread && { seen: false }), ...(q.search && { subject: q.search }) };
          const uids = await c.search(Object.keys(query).length ? query : { all: true }, { uid: true });
          if (!Array.isArray(uids) || !uids.length) return [];
          const newest = [...uids].sort((a, b) => b - a).slice(0, q.limit);
          const out: MailSummary[] = [];
          for await (const m of c.fetch(newest.join(","), { uid: true, flags: true, envelope: true }, { uid: true })) {
            out.push({
              uid: m.uid,
              subject: m.envelope?.subject ?? "",
              from: m.envelope?.from?.[0] ? fmt(m.envelope.from[0]) : "",
              to: (m.envelope?.to ?? []).map(fmt),
              date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : undefined,
              seen: m.flags?.has("\\Seen") ?? false,
            });
          }
          return out.sort((a, b) => b.uid - a.uid);
        }),
      ),

    get: (s, uid, mailbox) =>
      withImap(s, (c) =>
        inMailbox(c, mailbox, async () => {
          const m = await c.fetchOne(String(uid), { uid: true, flags: true, envelope: true, source: true }, { uid: true });
          if (!m || !m.source) throw notFound(`no mail with UID ${uid} in ${mailbox}`);
          const { simpleParser } = await import("mailparser");
          const parsed = await simpleParser(m.source);
          const env = m.envelope;
          return {
            uid: m.uid,
            subject: env?.subject ?? parsed.subject ?? "",
            from: env?.from?.[0] ? fmt(env.from[0]) : "",
            fromAddress: env?.from?.[0]?.address,
            replyTo: env?.replyTo?.[0]?.address,
            to: (env?.to ?? []).map(fmt),
            cc: (env?.cc ?? []).map(fmt),
            date: env?.date ? new Date(env.date).toISOString() : undefined,
            seen: m.flags?.has("\\Seen") ?? false,
            messageId: env?.messageId ?? parsed.messageId,
            references: typeof parsed.references === "string" ? [parsed.references] : parsed.references,
            body: (parsed.text ?? (typeof parsed.html === "string" ? parsed.html : "")).replace(/\s+$/, ""),
            attachments: parsed.attachments.map((a) => ({ filename: a.filename ?? "", size: a.size })),
          };
        }),
      ),

    uidForMailId: (s, mailId, mailbox) =>
      withImap(s, (c) =>
        inMailbox(c, mailbox, async () => {
          const at = mailIdTime(mailId);
          const uids = await c.search({ since: new Date(at - DAY_MS), before: new Date(at + DAY_MS) }, { uid: true });
          if (!Array.isArray(uids) || !uids.length) throw notFound(`no mail for id ${mailId} in ${mailbox}`);
          if (uids.length > MAX_CANDIDATES) throw new DoorayError(EXIT_API, `too many mails around id ${mailId} (${uids.length}); use the UID`);
          const want = Math.floor(at / 1000);
          const hits: { uid: number; subject: string }[] = [];
          for await (const m of c.fetch(uids.join(","), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
            const sec = Math.floor(new Date(m.internalDate ?? 0).getTime() / 1000);
            if (sec === want || sec === want + 1) hits.push({ uid: m.uid, subject: m.envelope?.subject ?? "" });
          }
          if (hits.length === 1) return hits[0]!.uid;
          if (!hits.length) throw notFound(`no mail for id ${mailId} in ${mailbox}`);
          throw new DoorayError(2, `${hits.length} messages match mail id ${mailId}; use a UID:\n${hits.map((h) => `  - ${h.uid} ${h.subject}`).join("\n")}`);
        }),
      ),

    async send(s, m) {
      const { default: nodemailer } = await import("nodemailer");
      // 465 is implicit TLS; 587/25 upgrade with STARTTLS.
      const transport = nodemailer.createTransport({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465, auth: { user: s.username, pass: s.password } });
      try {
        const info = await transport.sendMail({
          from: m.from,
          to: m.to,
          cc: m.cc,
          bcc: m.bcc,
          subject: m.subject,
          text: m.text,
          html: m.html,
          inReplyTo: m.inReplyTo,
          references: m.references,
          attachments: m.attachments?.map((path) => ({ path })),
        });
        return { messageId: info.messageId };
      } catch (e) {
        throw new DoorayError(EXIT_API, `SMTP ${s.smtpHost}:${s.smtpPort}: ${errorMessage(e)}`);
      }
    },
  };
}
