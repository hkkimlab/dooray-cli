import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MailBackend, MailFull, MailSettings, OutgoingMail } from "../../src/mail/backend.js";
import { mailIdTime } from "../../src/mail/backend.js";
import { GOV_CONFIG, runCli, tempHome } from "../helpers.js";

const MAIL_CFG = `    mail:
      username: me@example.com
      password: app-pass
`;

function home(withMail = true): string {
  const h = tempHome();
  mkdirSync(join(h, ".config", "dooray"), { recursive: true });
  writeFileSync(join(h, ".config", "dooray", "config.yaml"), GOV_CONFIG.replace("    env: gov\n", `    env: gov\n${withMail ? MAIL_CFG : ""}`));
  return h;
}

const full: MailFull = {
  uid: 42,
  subject: "회의 안내",
  from: "홍길동 <hong@example.com>",
  fromAddress: "hong@example.com",
  to: ["나사용 <Me@example.com>", "이몽룡 <lee@example.com>"],
  cc: ["성춘향 <sung@example.com>"],
  date: "2026-10-19T01:00:00.000Z",
  seen: false,
  messageId: "<abc@example.com>",
  references: ["<root@example.com>"],
  body: "본문입니다",
  attachments: [{ filename: "a.pdf", size: 10 }],
};

function fakeBackend() {
  const calls: { op: string; settings: MailSettings; arg?: unknown }[] = [];
  const backend: MailBackend = {
    verify: async (s) => {
      calls.push({ op: "verify", settings: s });
    },
    list: async (s, q) => {
      calls.push({ op: "list", settings: s, arg: q });
      return [{ uid: 42, subject: full.subject, from: full.from, to: full.to, date: full.date, seen: false }];
    },
    get: async (s, uid, mailbox) => {
      calls.push({ op: "get", settings: s, arg: { uid, mailbox } });
      return full;
    },
    uidForMailId: async (s, mailId, mailbox) => {
      calls.push({ op: "uidForMailId", settings: s, arg: { mailId, mailbox } });
      return 42;
    },
    send: async (s, m: OutgoingMail) => {
      calls.push({ op: "send", settings: s, arg: m });
      return { messageId: "<new@example.com>" };
    },
  };
  return { backend, calls };
}

describe("mail settings", () => {
  it("commercial hosts are the defaults (gov uses them too)", async () => {
    const { backend, calls } = fakeBackend();
    await runCli(["mail", "list"], { home: home(), mail: backend });
    expect(calls[0]!.settings).toEqual({
      username: "me@example.com",
      password: "app-pass",
      imapHost: "imap.dooray.com",
      imapPort: 993,
      smtpHost: "smtp.dooray.com",
      smtpPort: 465,
    });
  });

  it("without credentials it tells you to run mail login (exit 3)", async () => {
    const r = await runCli(["mail", "list"], { home: home(false), mail: fakeBackend().backend });
    expect(r.code).toBe(3);
    expect(r.err).toContain("dooray mail login");
  });

  it("login stores username/password (0600), verifies, never echoes the password", async () => {
    const h = home(false);
    const { backend, calls } = fakeBackend();
    const r = await runCli(["mail", "login", "--username", "me@example.com", "--imap-host", "imap.example.com"], { home: h, mail: backend, stdin: "s3cret\n" });
    expect(r.code).toBe(0);
    const file = join(h, ".config", "dooray", "config.yaml");
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/username: me@example.com/);
    expect(text).toMatch(/password: s3cret/);
    expect(text).toMatch(/imap_host: imap.example.com/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(calls[0]!.op).toBe("verify");
    expect(r.out + r.err).not.toContain("s3cret");
  });

  it("logout removes the credentials after confirmation", async () => {
    const h = home();
    expect((await runCli(["mail", "logout"], { home: h })).code).toBe(2);
    expect((await runCli(["mail", "logout", "--yes"], { home: h })).code).toBe(0);
    const text = readFileSync(join(h, ".config", "dooray", "config.yaml"), "utf8");
    expect(text).not.toContain("app-pass");
    expect(text).not.toContain("me@example.com");
  });
});

describe("mail list/get", () => {
  it("list passes filters and prints a table", async () => {
    const { backend, calls } = fakeBackend();
    const r = await runCli(["mail", "list", "--unread", "--search", "회의", "--size", "5", "--folder", "sent"], { home: home(), mail: backend });
    expect(calls[0]!.arg).toEqual({ mailbox: "sent", unread: true, search: "회의", limit: 5 });
    expect(r.out).toMatch(/UID\s+DATE\s+FROM\s+SUBJECT\s+READ/);
    expect(r.out).toMatch(/42\s+2026-10-19T10:00:00\+09:00\s+홍길동 <hong@example.com>\s+회의 안내\s+no/);
  });

  it("get by UID shows headers and body", async () => {
    const { backend, calls } = fakeBackend();
    const r = await runCli(["mail", "get", "42"], { home: home(), mail: backend });
    expect(calls[0]!.arg).toEqual({ uid: 42, mailbox: "INBOX" });
    expect(r.out).toContain("본문입니다");
    expect(r.out).toMatch(/ATTACHMENTS\s+a.pdf \(10\)/);
  });

  it("get by mail URL resolves the mail id in the URL's folder", async () => {
    const { backend, calls } = fakeBackend();
    const id = "4446577814482796741";
    await runCli(["mail", "get", `https://acme.gov-dooray.com/mail/systems/sent/${id}`, "-o", "json"], { home: home(), mail: backend });
    expect(calls[0]).toMatchObject({ op: "uidForMailId", arg: { mailId: id, mailbox: "sent" } });
    expect(calls[1]).toMatchObject({ op: "get", arg: { uid: 42, mailbox: "sent" } });
  });

  it("a bad target is a usage error", async () => {
    expect((await runCli(["mail", "get", "abc"], { home: home(), mail: fakeBackend().backend })).code).toBe(2);
  });
});

describe("mail send/reply", () => {
  it("send builds the message from the profile account", async () => {
    const att = join(tempHome(), "r.pdf");
    writeFileSync(att, "x");
    const { backend, calls } = fakeBackend();
    const r = await runCli(
      ["mail", "send", "--to", "a@x.com", "--to", "b@x.com", "--cc", "c@x.com", "--subject", "제목", "--body", "내용", "--attach", att],
      { home: home(), mail: backend },
    );
    expect(r.code).toBe(0);
    expect(calls[0]!.arg).toEqual({ from: "me@example.com", to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], subject: "제목", text: "내용", attachments: [att] });
  });

  it("send --html and required fields", async () => {
    const { backend, calls } = fakeBackend();
    await runCli(["mail", "send", "--to", "a@x.com", "--subject", "s", "--body", "<b>x</b>", "--html"], { home: home(), mail: backend });
    expect(calls[0]!.arg).toMatchObject({ html: "<b>x</b>" });
    expect((await runCli(["mail", "send", "--to", "a@x.com"], { home: home(), mail: backend })).code).toBe(2);
  });

  it("reply threads to the original and asks first", async () => {
    const { backend, calls } = fakeBackend();
    const refused = await runCli(["mail", "reply", "42", "--body", "답장"], { home: home(), mail: backend });
    expect(refused.code).toBe(2);
    const r = await runCli(["mail", "reply", "42", "--body", "답장", "--all", "--yes"], { home: home(), mail: backend });
    expect(r.code).toBe(0);
    const sent = calls.find((c) => c.op === "send")!.arg as OutgoingMail;
    expect(sent).toEqual({
      from: "me@example.com",
      to: ["hong@example.com"],
      cc: ["lee@example.com", "sung@example.com"],
      subject: "Re: 회의 안내",
      text: "답장",
      inReplyTo: "<abc@example.com>",
      references: "<root@example.com> <abc@example.com>",
    });
  });
});

describe("mailIdTime", () => {
  it("decodes the arrival time from a Dooray mail id", () => {
    expect(mailIdTime("4446577814482796741")).toBe(Number((4446577814482796741n >> 23n) + 1262304000000n));
    expect(() => mailIdTime("12")).toThrow();
  });
});
