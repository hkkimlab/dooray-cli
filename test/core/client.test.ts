import { describe, expect, it } from "vitest";
import { Client, parseJson } from "../../src/core/client.js";
import { DoorayError } from "../../src/core/errors.js";
import { fail, fakeFetch, ok, type Route } from "../helpers.js";

const TOKEN = "secret-token-123";

function client(routes: Route[], extra: Partial<ConstructorParameters<typeof Client>[0]> = {}) {
  const f = fakeFetch(routes);
  const slept: number[] = [];
  const c = new Client({
    token: TOKEN,
    baseUrl: "https://api.gov-dooray.com/",
    fileUrl: "https://file-api.gov-dooray.com",
    fetch: f,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...extra,
  });
  return { c, f, slept };
}

async function err(p: Promise<unknown>): Promise<DoorayError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DoorayError) return e;
    throw e;
  }
  throw new Error("expected rejection");
}

describe("parseJson", () => {
  it("keeps unsafe integers as their exact source string", () => {
    const v = parseJson('{"id":3036830023878922413,"n":12,"f":1.5,"big":1e400}');
    expect(v).toEqual({ id: "3036830023878922413", n: 12, f: 1.5, big: Infinity });
  });
});

describe("Client.call", () => {
  it("sends the dooray-api auth header and JSON body, returns result", async () => {
    const { c, f } = client([{ method: "POST", path: "/project/v1/projects", body: ok({ id: "1" }) }]);
    const r = await c.call("POST", "/project/v1/projects", { body: { code: "x" }, query: { a: 1, b: undefined, c: ["p", "q"] } });
    expect(r).toEqual({ id: "1" });
    const call = f.calls[0]!;
    expect(call.headers.get("authorization")).toBe(`dooray-api ${TOKEN}`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.body).toEqual({ code: "x" });
    expect(call.url.search).toBe("?a=1&c=p%2Cq");
  });

  it("maps an unsuccessful header to an API error with apiCode and decoded message", async () => {
    const { c } = client([{ path: "/x", body: fail(-100, "Query+params+can+not+be+empty") }]);
    const e = await err(c.call("GET", "/x"));
    expect(e.exit).toBe(5);
    expect(e.apiCode).toBe(-100);
    expect(e.message).toBe("Query params can not be empty");
  });

  it("treats a header with only resultMessage as a failure (manager-gated endpoints)", async () => {
    const { c } = client([{ path: "/x", body: { header: { resultMessage: "no permission" } } }]);
    expect((await err(c.call("GET", "/x"))).message).toBe("no permission");
  });

  it("404 is not-found, 401/403 are auth errors", async () => {
    const { c } = client([
      { path: "/a", status: 404, raw: "" },
      { path: "/b", status: 401, body: fail(401, "invalid token") },
      { path: "/c", status: 403, raw: "<html>" },
    ]);
    expect((await err(c.call("GET", "/a"))).exit).toBe(4);
    const b = await err(c.call("GET", "/b"));
    expect([b.exit, b.message]).toEqual([3, "invalid token"]);
    expect((await err(c.call("GET", "/c"))).exit).toBe(3);
  });

  it("4xx with an envelope surfaces the server message", async () => {
    const { c } = client([{ path: "/x", status: 400, body: fail(-1, "USER_INVALID_EXCEED_MAXIMUM_PERIOD") }]);
    const e = await err(c.call("GET", "/x"));
    expect([e.exit, e.message]).toEqual([5, "USER_INVALID_EXCEED_MAXIMUM_PERIOD"]);
  });

  it("garbage 200 body is a decode error (exit 1)", async () => {
    const { c } = client([{ path: "/x", raw: "not json" }]);
    const e = await err(c.call("GET", "/x"));
    expect(e.exit).toBe(1);
    expect(e.message).toMatch(/^decode envelope/);
  });

  it("retries 429 honouring Retry-After, then succeeds", async () => {
    const { c, slept } = client([
      { path: "/x", status: 429, raw: "", headers: { "retry-after": "3" } },
      { path: "/x", body: ok(7) },
    ]);
    expect(await c.call("GET", "/x")).toBe(7);
    expect(slept).toContain(3000);
  });

  it("POST is retried on 429 (not processed) but not on 5xx", async () => {
    const a = client([
      { method: "POST", path: "/x", status: 429, raw: "" },
      { method: "POST", path: "/x", body: ok(1) },
    ]);
    expect(await a.c.call("POST", "/x", { body: {} })).toBe(1);

    const b = client([{ method: "POST", path: "/x", status: 500, raw: "" }]);
    const e = await err(b.c.call("POST", "/x", { body: {} }));
    expect([e.exit, e.message]).toEqual([5, "server error 500"]);
    expect(b.f.calls).toHaveLength(1);
  });

  it("GET retries 5xx up to 3 attempts with 1s/2s backoff", async () => {
    const { c, f, slept } = client([{ path: "/x", status: 503, raw: "", repeat: true }]);
    const e = await err(c.call("GET", "/x"));
    expect(e.apiCode).toBe(503);
    expect(f.calls).toHaveLength(3);
    expect(slept.filter((ms) => ms >= 1000)).toEqual([1000, 2000]);
  });

  it("gives up after repeated 429 with a rate-limited error", async () => {
    const { c } = client([{ path: "/x", status: 429, raw: "", repeat: true }]);
    expect((await err(c.call("GET", "/x"))).message).toBe("rate limited");
  });

  it("network errors: GET retries, POST does not; token never leaks", async () => {
    let n = 0;
    const flaky = Object.assign(
      async () => {
        n++;
        throw new TypeError("fetch failed");
      },
      { calls: [] },
    );
    const c = new Client({ token: TOKEN, baseUrl: "https://h", fileUrl: "https://f", fetch: flaky, sleep: async () => {} });
    const e = await err(c.call("GET", "/x"));
    expect(n).toBe(3);
    expect(e.message).toBe("network: fetch failed");
    expect(e.message).not.toContain(TOKEN);
    n = 0;
    await err(c.call("POST", "/x", { body: {} }));
    expect(n).toBe(1);
  });

  it("debug logs method and url but never the token", async () => {
    const lines: string[] = [];
    const { c } = client([{ path: "/x", body: ok(1) }], { debug: (l) => lines.push(l) });
    await c.call("GET", "/x", { query: { q: "1" } });
    expect(lines.join("\n")).toContain("GET https://api.gov-dooray.com/x?q=1");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("syncs the rate limiter from response headers", async () => {
    const synced: unknown[] = [];
    const bucket = { acquire: async () => {}, sync: (s: unknown) => synced.push(s), drain: () => {}, available: 1 };
    const { c } = client([{ path: "/x", body: ok(1), headers: { "x-ratelimit-remaining": "4" } }], { bucket });
    await c.call("GET", "/x");
    expect(synced[0]).toMatchObject({ remaining: 4 });
  });
});

describe("Client.list", () => {
  it("pages with size=100 until totalCount", async () => {
    const { c, f } = client([
      { path: /page=0/, body: ok([1, 2], 3) },
      { path: /page=1/, body: ok([3], 3) },
    ]);
    expect(await c.list("/items", { q: "z" })).toEqual([1, 2, 3]);
    expect(f.calls[0]!.url.searchParams.get("size")).toBe("100");
    expect(f.calls[0]!.url.searchParams.get("q")).toBe("z");
  });

  it("stops at limit", async () => {
    const { c, f } = client([{ path: /page=0/, body: ok([1, 2, 3], 10) }]);
    expect(await c.list("/items", {}, 2)).toEqual([1, 2]);
    expect(f.calls).toHaveLength(1);
  });

  it("without totalCount keeps paging while pages are full", async () => {
    const { c } = client([
      { path: /page=0/, body: ok([1, 2]) },
      { path: /page=1/, body: ok([3]) },
      { path: /page=2/, body: ok([]) },
    ]);
    expect(await c.list("/i", { size: 2 })).toEqual([1, 2, 3]);
  });

  it("stops when the server ignores paging and repeats the same page", async () => {
    const { c, f } = client([{ path: /page=/, body: ok([1, 2]), repeat: true }]);
    expect(await c.list("/i", { size: 2 })).toEqual([1, 2]);
    expect(f.calls).toHaveLength(2);
  });

  it("caps Retry-After at 60s", async () => {
    const { c, slept } = client([
      { path: "/x", status: 429, raw: "", headers: { "retry-after": "3600" } },
      { path: "/x", body: ok(1) },
    ]);
    await c.call("GET", "/x");
    expect(slept).toContain(60_000);
  });

  it("stops on an empty page; without totalCount a short page is not trusted as the end", async () => {
    const a = client([{ path: /page=0/, body: ok([], 5) }]);
    expect(await a.c.list("/i")).toEqual([]);
    const b = client([
      { path: /page=0/, body: ok([1]) },
      { path: /page=1/, body: ok([2]) },
      { path: /page=2/, body: ok([]) },
    ]);
    expect(await b.c.list("/i")).toEqual([1, 2]);
  });
});

describe("files", () => {
  it("download follows a 307 to a dooray host with the auth header", async () => {
    const { c, f } = client([
      { path: "/x/files/1", status: 307, raw: "", headers: { location: "https://file-api.gov-dooray.com/dl/1" } },
      { path: "/dl/1", raw: "DATA" },
    ]);
    const res = await c.download("/x/files/1", { query: { media: "raw" } });
    expect(await res.text()).toBe("DATA");
    expect(f.calls[1]!.headers.get("authorization")).toBe(`dooray-api ${TOKEN}`);
    expect(f.calls[0]!.url.search).toBe("?media=raw");
  });

  it("download to a foreign host drops the auth header", async () => {
    const { c, f } = client([
      { path: "/x", status: 302, raw: "", headers: { location: "https://s3.example.com/obj" } },
      { path: "/obj", raw: "D" },
    ]);
    await c.download("/x");
    expect(f.calls[1]!.headers.get("authorization")).toBeNull();
  });

  it("an http downgrade of a dooray host gets no token", async () => {
    const { c, f } = client([
      { path: "/x", status: 302, raw: "", headers: { location: "http://api.gov-dooray.com/y" } },
      { path: "/y", raw: "D" },
    ]);
    await c.download("/x");
    expect(f.calls[1]!.headers.get("authorization")).toBeNull();
  });

  it("upload can PUT (new file version)", async () => {
    const { c, f } = client([{ method: "PUT", path: "/f/1", body: ok({ id: "1", version: 2 }) }]);
    expect(await c.upload("/f/1", new FormData(), { method: "PUT" })).toEqual({ id: "1", version: 2 });
    expect(f.calls[0]!.method).toBe("PUT");
  });

  it("download can target the file host", async () => {
    const { c, f } = client([{ path: "/downloads/a", raw: "D" }]);
    await c.download("/downloads/a", { host: "file" });
    expect(f.calls[0]!.url.host).toBe("file-api.gov-dooray.com");
  });

  it("download errors: 404 not-found, other >=400 api error", async () => {
    const { c } = client([
      { path: "/a", status: 404, raw: "" },
      { path: "/b", status: 500, raw: "", repeat: true },
    ]);
    expect((await err(c.download("/a"))).exit).toBe(4);
    expect((await err(c.download("/b"))).message).toBe("download failed 500");
  });

  it("upload posts multipart and re-posts to the 307 location", async () => {
    const { c, f } = client([
      { method: "POST", path: "/up", status: 307, raw: "", headers: { location: "https://file-api.gov-dooray.com/up" } },
      { method: "POST", path: "/up", body: ok({ id: "f1" }) },
    ]);
    const form = new FormData();
    form.append("file", new Blob(["hi"]), "a.txt");
    expect(await c.upload("/up", form)).toEqual({ id: "f1" });
    expect(f.calls[1]!.url.host).toBe("file-api.gov-dooray.com");
    expect(f.calls[1]!.headers.get("authorization")).toBe(`dooray-api ${TOKEN}`);
    expect(f.calls[1]!.body).toBeInstanceOf(FormData);
  });

  it("refuses too many redirects", async () => {
    const { c } = client([
      { path: "/loop", status: 307, raw: "", headers: { location: "https://api.gov-dooray.com/loop" }, repeat: true },
    ]);
    expect((await err(c.download("/loop"))).message).toBe("too many redirects");
  });
});
