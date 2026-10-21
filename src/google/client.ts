import type { TokenProvider } from "./auth.js";

/**
 * The only hosts the bearer token may ever be sent to. Callers pass paths, never URLs,
 * so no tool argument can redirect an authenticated request somewhere else.
 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "androidpublisher.googleapis.com",
  "playdeveloperreporting.googleapis.com",
  "oauth2.googleapis.com",
  // Mode B (keyless) only: the user token is traded for a service-account token here.
  "iamcredentials.googleapis.com",
]);

export const BASES = {
  publisher: "https://androidpublisher.googleapis.com/androidpublisher/v3",
  upload: "https://androidpublisher.googleapis.com/upload/androidpublisher/v3",
  reporting: "https://playdeveloperreporting.googleapis.com/v1beta1",
} as const;

export type Api = keyof typeof BASES;

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Non-2xx statuses to hand back instead of throwing (e.g. 308 during resumable upload). */
  acceptStatus?: number[];
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Google API error ${status}: ${describeBody(body)}`);
    this.name = "GoogleApiError";
  }
}

function describeBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
    if (typeof err === "string") return err;
  }
  return typeof body === "string" ? body.slice(0, 2000) : JSON.stringify(body);
}

/** Encodes one path segment, refusing anything that could change the path's shape. */
export function seg(value: string | number): string {
  const s = String(value);
  if (s === "" || s === "." || s === "..") throw new Error(`Invalid path segment: ${JSON.stringify(s)}`);
  return encodeURIComponent(s);
}

export function assertAllowedUrl(url: string | URL): URL {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname) || u.port !== "" || u.username || u.password) {
    throw new Error(`Refusing to send credentials to ${u.protocol}//${u.host}: host is not on the allowlist.`);
  }
  return u;
}

function assertRelativePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || /[?#\\]/.test(path)) {
    throw new Error(`Refusing request path ${JSON.stringify(path)}: only API-relative paths are accepted.`);
  }
  if (path.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`Refusing request path ${JSON.stringify(path)}: dot segments are not allowed.`);
  }
}

const IDEMPOTENT = new Set(["GET", "PUT", "DELETE"]);

export interface ClientOptions {
  getToken: TokenProvider;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  defaultTimeoutMs?: number;
}

export class PlayClient {
  private readonly getToken: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultTimeoutMs: number;

  constructor(opts: ClientOptions) {
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
  }

  buildUrl(api: Api, path: string, query?: Query): URL {
    assertRelativePath(path);
    const url = new URL(BASES[api] + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return assertAllowedUrl(url);
  }

  /** JSON request; returns the parsed body, or undefined for an empty response. */
  async request<T = unknown>(api: Api, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(this.buildUrl(api, path, opts.query), opts);
    return parseJson<T>(res);
  }

  /** Like request() but returns the Response, for callers that need headers. */
  async raw(api: Api, path: string, opts: RequestOptions = {}): Promise<Response> {
    return this.send(this.buildUrl(api, path, opts.query), opts);
  }

  /**
   * For server-issued absolute URLs (the resumable-upload session URI). Still checked
   * against the allowlist, so a forged Location header cannot leak the token.
   */
  async rawUrl(url: string, opts: RequestOptions = {}): Promise<Response> {
    return this.send(assertAllowedUrl(url), opts);
  }

  private async send(url: URL, opts: RequestOptions): Promise<Response> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = { ...opts.headers };
    let body: string | Uint8Array | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body) {
      body = opts.body;
    }

    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { ...headers, authorization: `Bearer ${token}` },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
        });
      } catch (e) {
        if (IDEMPOTENT.has(method) && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new Error(`Request to ${url.host}${url.pathname} failed: ${(e as Error).message}`);
      }

      if (res.ok || opts.acceptStatus?.includes(res.status)) return res;

      const retryable = res.status === 429 || (res.status >= 500 && IDEMPOTENT.has(method));
      if (retryable && attempt < this.maxRetries) {
        await res.body?.cancel().catch(() => {});
        await this.sleep(this.retryDelay(res, attempt));
        continue;
      }
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : "";
      } catch {
        // keep the raw text
      }
      throw new GoogleApiError(res.status, parsed);
    }
  }

  private backoff(attempt: number): number {
    return this.baseDelayMs * 2 ** attempt;
  }

  private retryDelay(res: Response, attempt: number): number {
    const after = Number(res.headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 30_000);
    return this.backoff(attempt);
  }
}

export async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function appPath(pkg: string): string {
  return `/applications/${seg(pkg)}`;
}

export function editPath(pkg: string, editId: string): string {
  return `${appPath(pkg)}/edits/${seg(editId)}`;
}
