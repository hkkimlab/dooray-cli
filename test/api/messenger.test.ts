import { describe, expect, it } from "vitest";
import { fetchLogs, listLogsPage, type MessageLog } from "../../src/api/messenger.js";
import { Client } from "../../src/core/client.js";
import { fakeFetch, logsPage as page, msgs, ok, type Route } from "../helpers.js";

const CH = "3000000000000001101";
const PATH = `/messenger/v1/channels/${CH}/logs`;

function client(routes: Route[]) {
  const f = fakeFetch(routes);
  const c = new Client({ token: "t", baseUrl: "https://api.gov-dooray.com", fileUrl: "https://file-api.gov-dooray.com", fetch: f, sleep: async () => {} });
  return { c, f };
}

const q = (f: ReturnType<typeof fakeFetch>, i: number, k: string) => f.calls[i]!.url.searchParams.get(k);
const seqs = (ls: MessageLog[]) => ls.map((l) => l.seq);

describe("listLogsPage", () => {
  it("passes size/logId and reads the top-level hasMore", async () => {
    const { c, f } = client([{ path: PATH, body: page(msgs(5, 4), true) }]);
    expect(await listLogsPage(c, CH, { size: 2, logId: "L6" })).toEqual({ logs: msgs(5, 4), hasMore: true });
    expect([q(f, 0, "size"), q(f, 0, "logId")]).toEqual(["2", "L6"]);
  });

  it("a missing hasMore or result reads as the end", async () => {
    const { c } = client([{ path: PATH, body: ok(null) }]);
    expect(await listLogsPage(c, CH, { size: 1 })).toEqual({ logs: [], hasMore: false });
  });
});

describe("fetchLogs", () => {
  it("walks back with logId in chunks of at most 1000 until the count, oldest first", async () => {
    const { c, f } = client([
      { path: PATH, body: page(msgs(2600, 1601), true) },
      { path: PATH, body: page(msgs(1600, 601), true) },
      { path: PATH, body: page(msgs(600, 101), true) },
    ]);
    const r = await fetchLogs(c, CH, { count: 2500 });
    expect(f.calls.map((_, i) => [q(f, i, "size"), q(f, i, "logId")])).toEqual([
      ["1000", null],
      ["1000", "L1601"],
      ["500", "L601"],
    ]);
    expect(r.logs).toHaveLength(2500);
    expect([r.logs[0]!.seq, r.logs.at(-1)!.seq, r.latestSeq]).toEqual([101, 2600, 2600]);
  });

  it("(a) stops when hasMore is false", async () => {
    const { c, f } = client([
      { path: PATH, body: page(msgs(1030, 31), true) },
      { path: PATH, body: page(msgs(30, 1), false) },
    ]);
    const r = await fetchLogs(c, CH, {});
    expect(f.calls).toHaveLength(2);
    expect(seqs(r.logs)).toEqual(seqs(msgs(1030, 1)).reverse());
  });

  it("dedupes by id when a page repeats the boundary message", async () => {
    const { c } = client([
      { path: PATH, body: page(msgs(10, 6), true) },
      { path: PATH, body: page(msgs(6, 1), false) },
    ]);
    expect(seqs((await fetchLogs(c, CH, {})).logs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("(b) the count counts unique messages and the last request asks only for the rest", async () => {
    const { c, f } = client([
      { path: PATH, body: page(msgs(10, 6), true) },
      { path: PATH, body: page(msgs(6, 3), true) },
    ]);
    const r = await fetchLogs(c, CH, { count: 8 });
    expect(seqs(r.logs)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(q(f, 1, "size")).toBe("3");
    expect(f.calls).toHaveLength(2);
  });

  it("(c) stops once a page reaches past --since and drops the older ones", async () => {
    const since = Date.parse(msgs(1503, 1503)[0]!.sentAt!);
    const { c, f } = client([
      { path: PATH, body: page(msgs(2600, 1601), true) },
      { path: PATH, body: page(msgs(1600, 601), true) },
    ]);
    const r = await fetchLogs(c, CH, { since });
    expect(f.calls).toHaveLength(2);
    expect([r.logs.length, r.logs[0]!.seq, r.logs.at(-1)!.seq]).toEqual([1098, 1503, 2600]);
  });

  it("(d) stops on an empty page", async () => {
    const { c, f } = client([
      { path: PATH, body: page(msgs(3, 1), true) },
      { path: PATH, body: page([], true) },
    ]);
    expect(seqs((await fetchLogs(c, CH, {})).logs)).toEqual([1, 2, 3]);
    expect(f.calls).toHaveLength(2);
  });

  it("(e) stops when the server ignores logId and repeats a page", async () => {
    const { c, f } = client([{ path: PATH, body: page(msgs(3, 1), true), repeat: true }]);
    expect(seqs((await fetchLogs(c, CH, {})).logs)).toEqual([1, 2, 3]);
    expect(f.calls).toHaveLength(2);
  });

  it("--until drops newer messages; the count is the newest n inside the range", async () => {
    const [m] = msgs(7, 7);
    const { c, f } = client([{ path: PATH, body: page(msgs(10, 1), false) }]);
    const r = await fetchLogs(c, CH, { count: 3, until: Date.parse(m!.sentAt!) });
    expect(seqs(r.logs)).toEqual([5, 6, 7]);
    expect(q(f, 0, "size")).toBe("1000");
    expect(r.latestSeq).toBe(10);
  });

  it("reports progress after each page", async () => {
    const seen: [number, number, string | undefined][] = [];
    const { c } = client([
      { path: PATH, body: page(msgs(4, 3), true) },
      { path: PATH, body: page(msgs(2, 1), false) },
    ]);
    await fetchLogs(c, CH, { onPage: (n, got, oldest) => seen.push([n, got, oldest]) });
    expect(seen).toEqual([
      [1, 2, msgs(3, 3)[0]!.sentAt],
      [2, 4, msgs(1, 1)[0]!.sentAt],
    ]);
  });
});
