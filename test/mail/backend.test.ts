import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory stand-in for imapflow's ImapFlow.
interface FakeMsg {
  uid: number;
  envelope: Record<string, unknown>;
  flags: Set<string>;
  internalDate: Date;
  source: Buffer;
}

const state = {
  mailboxes: [] as { path: string; specialUse?: string }[],
  messages: [] as FakeMsg[],
  searches: [] as unknown[],
  locked: [] as string[],
  connectError: undefined as Error | undefined,
  sent: [] as unknown[],
  transportOpts: [] as unknown[],
  loggedOut: 0,
};

vi.mock("imapflow", () => ({
  ImapFlow: class {
    usable = true;
    constructor(readonly opts: unknown) {}
    async connect() {
      if (state.connectError) throw state.connectError;
    }
    async list() {
      return state.mailboxes;
    }
    async getMailboxLock(path: string) {
      state.locked.push(path);
      return { release() {} };
    }
    async search(q: unknown) {
      state.searches.push(q);
      return state.messages.map((m) => m.uid);
    }
    async *fetch(range: string) {
      const want = new Set(range.split(",").map(Number));
      for (const m of state.messages) if (want.has(m.uid)) yield m;
    }
    async fetchOne(uid: string) {
      return state.messages.find((m) => m.uid === Number(uid)) ?? false;
    }
    async logout() {
      state.loggedOut++;
    }
    close() {}
  },
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: unknown) => {
      state.transportOpts.push(opts);
      return { sendMail: async (m: unknown) => (state.sent.push(m), { messageId: "<sent@x>" }), verify: async () => true };
    },
  },
}));

const { imapBackend, mailIdTime } = await import("../../src/mail/backend.js");

const settings = { username: "me@example.com", password: "pw", imapHost: "imap.dooray.com", imapPort: 993, smtpHost: "smtp.dooray.com", smtpPort: 465 };

const raw = (subject: string, body: string) =>
  Buffer.from(`From: Hong <hong@x.com>\r\nTo: me@example.com\r\nSubject: ${subject}\r\nMessage-ID: <m1@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);

const msg = (uid: number, subject: string, date: Date, seen = false): FakeMsg => ({
  uid,
  envelope: { subject, from: [{ name: "Hong", address: "hong@x.com" }], to: [{ name: "", address: "me@example.com" }], cc: [], date, messageId: "<m1@x>" },
  flags: new Set(seen ? ["\\Seen"] : []),
  internalDate: date,
  source: raw(subject, `body ${uid}`),
});

beforeEach(() => {
  Object.assign(state, {
    mailboxes: [{ path: "INBOX" }, { path: "보낸메일함", specialUse: "\\Sent" }],
    messages: [],
    searches: [],
    locked: [],
    connectError: undefined,
    sent: [],
    transportOpts: [],
    loggedOut: 0,
  });
});

describe("imapBackend", () => {
  it("list returns newest first, limited, with read flags and the right query", async () => {
    state.messages = [msg(1, "a", new Date("2026-10-01")), msg(3, "c", new Date("2026-10-03"), true), msg(2, "b", new Date("2026-10-02"))];
    const r = await imapBackend().list(settings, { mailbox: "INBOX", unread: true, search: "c", limit: 2 });
    expect(r.map((m) => [m.uid, m.seen])).toEqual([
      [3, true],
      [2, false],
    ]);
    expect(state.searches[0]).toEqual({ seen: false, subject: "c" });
    expect(state.loggedOut).toBe(1);
  });

  it("list with no filter searches all; empty mailbox gives []", async () => {
    expect(await imapBackend().list(settings, { mailbox: "INBOX", limit: 5 })).toEqual([]);
    expect(state.searches[0]).toEqual({ all: true });
  });

  it("special folder names map through specialUse", async () => {
    await imapBackend().list(settings, { mailbox: "sent", limit: 1 });
    expect(state.locked).toEqual(["보낸메일함"]);
  });

  it("get parses the body and headers", async () => {
    state.messages = [msg(7, "hello", new Date("2026-10-05"))];
    const m = await imapBackend().get(settings, 7, "INBOX");
    expect(m).toMatchObject({ uid: 7, subject: "hello", fromAddress: "hong@x.com", messageId: "<m1@x>", body: "body 7" });
  });

  it("get of a missing UID is not-found", async () => {
    await expect(imapBackend().get(settings, 99, "INBOX")).rejects.toMatchObject({ exit: 4 });
  });

  it("uidForMailId matches the arrival second and reports ambiguity", async () => {
    const id = "4446577814482796741";
    const at = new Date(mailIdTime(id));
    state.messages = [msg(10, "x", at), msg(11, "y", new Date(at.getTime() + 60_000))];
    expect(await imapBackend().uidForMailId(settings, id, "INBOX")).toBe(10);
    state.messages = [msg(10, "x", at), msg(12, "z", at)];
    await expect(imapBackend().uidForMailId(settings, id, "INBOX")).rejects.toThrow(/2 messages/);
    state.messages = [];
    await expect(imapBackend().uidForMailId(settings, id, "INBOX")).rejects.toMatchObject({ exit: 4 });
  });

  it("connection failures become network errors without the password", async () => {
    state.connectError = new Error("ECONNREFUSED");
    const e = await imapBackend().verify(settings).catch((x: unknown) => x as Error);
    expect(e.message).toContain("IMAP imap.dooray.com:993");
    expect(e.message).not.toContain("pw");
  });

  it("send uses SMTP over TLS with the account", async () => {
    const r = await imapBackend().send(settings, { from: "me@example.com", to: ["a@x.com"], subject: "s", text: "t", attachments: ["/tmp/a.pdf"] });
    expect(r.messageId).toBe("<sent@x>");
    expect(state.transportOpts[0]).toMatchObject({ host: "smtp.dooray.com", port: 465, secure: true, auth: { user: "me@example.com", pass: "pw" } });
    await imapBackend().send({ ...settings, smtpPort: 587 }, { from: "me@example.com", to: ["a@x.com"], subject: "s", text: "t" });
    expect(state.transportOpts[1]).toMatchObject({ port: 587, secure: false });
    expect(state.sent[0]).toMatchObject({ from: "me@example.com", to: ["a@x.com"], subject: "s", text: "t", attachments: [{ path: "/tmp/a.pdf" }] });
  });
});
