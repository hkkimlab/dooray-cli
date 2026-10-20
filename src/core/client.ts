import { createTokenBucket, parseRateLimitHeaders, realSleep, type TokenBucket } from "./rate-limit.js";
import { apiError, authError, DoorayError, EXIT_API, errorMessage, generic, notFound } from "./errors.js";

export type QueryValue = string | number | boolean | readonly string[] | undefined | null;
export type Query = Record<string, QueryValue>;

export interface ClientOptions {
  token: string;
  baseUrl: string;
  fileUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  bucket?: Pick<TokenBucket, "acquire" | "sync" | "drain">;
  /** Receives request/response trace lines. Never includes the token. */
  debug?: (line: string) => void;
}

export interface Envelope<T> {
  result: T;
  totalCount?: number;
  /** next-page cursor of cursor-paged endpoints (streams) */
  cursor?: string;
  /** "older messages exist" flag of messenger logs */
  hasMore?: boolean;
}

interface RequestOpts {
  query?: Query;
  body?: unknown;
}

interface FileOpts {
  host?: "api" | "file";
  query?: Query;
  method?: "POST" | "PUT";
}

type ReqBody = NonNullable<RequestInit["body"]>;

const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;
const PAGE_SIZE = 100;
const JSON_TIMEOUT_MS = 120_000;
const TRUSTED_HOST = /(^|\.)(gov-)?dooray\.(com|co\.kr)$/;
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/** JSON.parse that keeps integers beyond 2^53 (19-digit Dooray ids) as their exact source text. */
export function parseJson(text: string): unknown {
  return JSON.parse(text, function (_key, value: unknown, ctx?: { source?: string }) {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      const src = ctx?.source;
      if (src && /^-?\d+$/.test(src)) return src;
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

export function buildUrl(base: string, path: string, query: Query = {}): string {
  const u = new URL(base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, ""));
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) u.searchParams.set(k, v.join(","));
    } else {
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

// Dooray form-encodes some messages ("Query+params+can+not+be+empty").
const decodeMessage = (m: string) => m.replaceAll("+", " ");
const backoff = (attempt: number) => 1000 * 2 ** attempt;

function retryAfterMs(res: Response): number | undefined {
  const secs = Number(res.headers.get("retry-after"));
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

interface EnvelopeHeader {
  resultCode?: number;
  resultMessage?: string;
  isSuccessful?: boolean;
}

export class Client {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bucket: Pick<TokenBucket, "acquire" | "sync" | "drain">;
  private readonly trustedOrigins: Set<string>;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.bucket = opts.bucket ?? createTokenBucket({ sleep: this.sleep });
    this.trustedOrigins = new Set([opts.baseUrl, opts.fileUrl].flatMap((u) => (URL.canParse(u) ? [new URL(u).origin] : [])));
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** Calls a JSON endpoint and returns the envelope's `result`. */
  async call<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    return (await this.envelope<T>(method, path, opts)).result;
  }

  async envelope<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<Envelope<T>> {
    const hasBody = opts.body !== undefined;
    const res = await this.exchange(method, buildUrl(this.opts.baseUrl, path, opts.query), {
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      json: hasBody,
      timeout: true,
    });
    return this.parse<T>(res);
  }

  /** Accumulates a paginated list (page/size) until totalCount, an empty page, or limit. */
  async list<T = unknown>(path: string, query: Query = {}, limit = 0): Promise<T[]> {
    const size = Number(query.size) > 0 ? Number(query.size) : PAGE_SIZE;
    let all: T[] = [];
    let prevFirst: string | undefined;
    for (let page = 0; ; page++) {
      const env = await this.envelope<T[] | null>("GET", path, { query: { ...query, size, page } });
      const batch = env.result ?? [];
      // Some endpoints ignore page/size and return everything each time; stop on a repeated page.
      const first = JSON.stringify(batch[0]);
      if (page > 0 && batch.length > 0 && first === prevFirst) return all;
      prevFirst = first;
      all = [...all, ...batch];
      if (limit > 0 && all.length >= limit) return all.slice(0, limit);
      // Without totalCount a short page is not proof of the end (some APIs cap size silently);
      // keep going until an empty page (or the repeated-page guard above).
      if (batch.length === 0 || (env.totalCount !== undefined && all.length >= env.totalCount)) return all;
    }
  }

  /** Multipart upload; follows the 307 to the file host by re-posting the form. */
  async upload<T = unknown>(path: string, form: FormData, opts: FileOpts = {}): Promise<T> {
    const res = await this.exchange(opts.method ?? "POST", this.fileTarget(path, opts), { body: form });
    return (await this.parse<T>(res)).result;
  }

  /** Raw download (not enveloped); follows redirects. Caller consumes the body. */
  async download(path: string, opts: FileOpts = {}): Promise<Response> {
    const res = await this.exchange("GET", this.fileTarget(path, opts), {});
    if (res.ok) return res;
    await res.body?.cancel();
    if (res.status === 404) throw notFound("file not found");
    if (res.status === 401 || res.status === 403) throw authError(`download unauthorized (${res.status})`);
    throw apiError(res.status, `download failed ${res.status}`);
  }

  private fileTarget(path: string, opts: FileOpts): string {
    return buildUrl(opts.host === "file" ? this.opts.fileUrl : this.opts.baseUrl, path, opts.query);
  }

  private async exchange(
    method: string,
    url: string,
    init: { body?: ReqBody; json?: boolean; timeout?: boolean },
  ): Promise<Response> {
    let target = url;
    let m = method;
    let body = init.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.send(m, target, body, init.json === true, init.timeout === true);
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return res;
      await res.body?.cancel();
      target = new URL(location, target).toString();
      if (res.status !== 307 && res.status !== 308) {
        m = "GET";
        body = undefined;
      }
    }
    throw generic("too many redirects");
  }

  private headersFor(url: string, json: boolean): Headers {
    const h = new Headers();
    // The token only goes to the configured origins or https Dooray hosts; pre-signed
    // foreign redirects (and any http downgrade) get no credentials.
    const u = new URL(url);
    if (this.trustedOrigins.has(u.origin) || (u.protocol === "https:" && TRUSTED_HOST.test(u.hostname))) {
      h.set("Authorization", `dooray-api ${this.opts.token}`);
    }
    if (json) h.set("Content-Type", "application/json");
    return h;
  }

  private async send(method: string, url: string, body: ReqBody | undefined, json: boolean, timeout: boolean): Promise<Response> {
    const idempotent = IDEMPOTENT.has(method);
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= MAX_ATTEMPTS - 1;
      await this.bucket.acquire();
      this.opts.debug?.(`${method} ${url}`);
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: this.headersFor(url, json),
          body,
          redirect: "manual",
          signal: timeout ? AbortSignal.timeout(JSON_TIMEOUT_MS) : undefined,
        });
      } catch (e) {
        if (!idempotent || last) throw networkError(e);
        await this.sleep(backoff(attempt));
        continue;
      }
      this.bucket.sync(parseRateLimitHeaders(res.headers));
      this.opts.debug?.(`<- ${res.status}`);
      // 429 means the request was not processed, so even POST is safe to resend.
      if (res.status === 429) {
        this.bucket.drain();
        await res.body?.cancel();
        if (last) throw apiError(429, "rate limited");
        await this.sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }
      if (res.status >= 500 && idempotent && !last) {
        await res.body?.cancel();
        await this.sleep(backoff(attempt));
        continue;
      }
      return res;
    }
  }

  private async parse<T>(res: Response): Promise<Envelope<T>> {
    const text = await res.text();
    let data: { header?: EnvelopeHeader; result?: T; totalCount?: number; cursor?: string; hasMore?: unknown } | undefined;
    let parseErr: unknown;
    try {
      data = text ? (parseJson(text) as typeof data) : undefined;
    } catch (e) {
      parseErr = e;
    }
    const header = typeof data === "object" && data !== null ? data.header : undefined;
    const msg = header?.resultMessage ? decodeMessage(header.resultMessage) : undefined;
    if (res.status === 401 || res.status === 403) throw authError(msg ?? `unauthorized (${res.status})`);
    if (res.status === 404) throw notFound(msg ?? "not found");
    if (res.status >= 500) throw apiError(res.status, msg ?? `server error ${res.status}`);
    if (res.status >= 400) throw apiError(header?.resultCode ?? res.status, msg ?? `http error ${res.status}`);
    if (typeof data !== "object" || data === null) {
      throw generic("decode envelope: " + (parseErr ? errorMessage(parseErr) : "empty body"));
    }
    // Gated endpoints return a header with only resultMessage; isSuccessful absent ⇒ failure.
    if (!header?.isSuccessful || (header.resultCode ?? 0) !== 0) {
      const code = header?.resultCode ?? 0;
      throw apiError(code, msg ?? `api error ${code}`);
    }
    return {
      result: data.result as T,
      totalCount: data.totalCount,
      ...(data.cursor !== undefined && { cursor: String(data.cursor) }),
      ...(typeof data.hasMore === "boolean" && { hasMore: data.hasMore }),
    };
  }
}

function networkError(e: unknown): DoorayError {
  const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : "";
  return new DoorayError(EXIT_API, `network: ${errorMessage(e)}${cause}`);
}
