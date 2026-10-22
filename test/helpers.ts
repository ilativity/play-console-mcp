import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { PlayClient } from "../src/google/client.js";
import { createServer } from "../src/server.js";
import type { Release, Track } from "../src/tools/releases.js";

export const PKG = "com.example.app";
export const TOKEN = "test-token-abc";

export interface Call {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  json?: unknown;
  bytes?: number;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type Responder = (call: Call, match: RegExpMatchArray) => Reply | Promise<Reply>;

/** A programmable fetch: routes by method + path regex, records every call. */
export class FakeFetch {
  readonly calls: Call[] = [];
  private routes: { method: string; re: RegExp; fn: Responder }[] = [];

  on(method: string, re: RegExp, fn: Responder | Reply): this {
    this.routes.unshift({ method, re, fn: typeof fn === "function" ? fn : () => fn });
    return this;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { method: init?.method ?? "GET", url, path: url.pathname, headers };
    const body = init?.body;
    if (typeof body === "string") {
      try {
        call.json = JSON.parse(body);
      } catch {
        call.json = body;
      }
    } else if (body instanceof Uint8Array) {
      call.bytes = body.byteLength;
    }
    this.calls.push(call);
    const target = url.hostname + url.pathname;
    for (const r of this.routes) {
      const m = target.match(r.re);
      if (r.method === call.method && m) {
        const reply = await r.fn(call, m);
        const status = reply.status ?? 200;
        // Real fetch turns any 3xx into a network error under redirect: "error".
        if (status >= 300 && status < 400 && init?.redirect === "error") {
          throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
        }
        const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
        return new Response(text === "" && [204, 308].includes(reply.status ?? 200) ? null : text, {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json", ...reply.headers },
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: 404, message: `no fake route for ${call.method} ${target}` } }), {
      status: 404,
    });
  };

  find(method: string, re: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && re.test(c.url.hostname + c.url.pathname));
  }
}

/**
 * A stateful fake of the edits API: tracks live in `tracks`; PUTs inside an edit are
 * staged and only land on commit, like the real thing.
 */
export class FakePlay extends FakeFetch {
  tracks: Record<string, Release[]> = {};
  testers: Record<string, string[]> = {};
  openEdits = new Set<string>();
  committed: string[] = [];
  private staged = new Map<string, { tracks: Record<string, Release[]>; testers: Record<string, string[]> }>();
  private nextEdit = 1;
  nextVersionCode = 100;
  failCommit: Reply | undefined;

  constructor() {
    super();
    const app = String.raw`androidpublisher\.googleapis\.com/(?:upload/)?androidpublisher/v3/applications/[^/]+`;
    const edit = `${app}/edits/([^/:]+)`;
    this.on("POST", new RegExp(`${app}/edits$`), () => {
      const id = `edit${this.nextEdit++}`;
      this.openEdits.add(id);
      this.staged.set(id, { tracks: structuredClone(this.tracks), testers: structuredClone(this.testers) });
      return { json: { id } };
    });
    this.on("DELETE", new RegExp(`${edit}$`), (_c, m) => {
      this.openEdits.delete(m[1]!);
      return { status: 204 };
    });
    this.on("POST", new RegExp(`${edit}:validate$`), () => ({ json: {} }));
    this.on("POST", new RegExp(`${edit}:commit$`), (_c, m) => {
      if (this.failCommit) return this.failCommit;
      const s = this.staged.get(m[1]!)!;
      this.tracks = s.tracks;
      this.testers = s.testers;
      this.openEdits.delete(m[1]!);
      this.committed.push(m[1]!);
      return { json: { id: m[1] } };
    });
    this.on("GET", new RegExp(`${edit}/tracks$`), (_c, m) => ({
      json: { tracks: Object.entries(this.staged.get(m[1]!)!.tracks).map(([track, releases]) => ({ track, releases })) },
    }));
    this.on("GET", new RegExp(`${edit}/tracks/([^/]+)$`), (_c, m) => ({
      json: { track: m[2], releases: this.staged.get(m[1]!)!.tracks[m[2]!] ?? [] },
    }));
    this.on("PUT", new RegExp(`${edit}/tracks/([^/]+)$`), (c, m) => {
      const t = c.json as Track;
      this.staged.get(m[1]!)!.tracks[m[2]!] = t.releases ?? [];
      return { json: t };
    });
    this.on("POST", new RegExp(`${edit}/bundles$`), () => ({ json: { versionCode: this.nextVersionCode++, sha256: "abc" } }));
    this.on("GET", new RegExp(`${edit}/testers/([^/]+)$`), (_c, m) => ({
      json: { googleGroups: this.staged.get(m[1]!)!.testers[m[2]!] ?? [] },
    }));
    this.on("PATCH", new RegExp(`${edit}/testers/([^/]+)$`), (c, m) => {
      const groups = (c.json as { googleGroups: string[] }).googleGroups;
      this.staged.get(m[1]!)!.testers[m[2]!] = groups;
      return { json: { googleGroups: groups } };
    });
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    authSource: undefined,
    defaultPackage: PKG,
    readOnly: false,
    allowDestructive: false,
    fileRoot: undefined,
    reportsBucket: undefined,
    ...overrides,
  };
}

export function testClient(fake: FakeFetch): PlayClient {
  return new PlayClient({ getToken: async () => TOKEN, fetchImpl: fake.fetch, sleep: async () => {} });
}

export interface Harness {
  client: Client;
  registered: string[];
  /** Calls a tool and parses its JSON text; throws with the text if the tool returned isError. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at arbitrary JSON
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  /** Calls a tool expecting an error; returns the error text. */
  callError(name: string, args?: Record<string, unknown>): Promise<string>;
}

export async function connect(fake: FakeFetch, config: Config = testConfig(), publicFetch?: typeof fetch): Promise<Harness> {
  const { server, registered } = createServer({ config, client: testClient(fake), publicFetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, text };
  };
  return {
    client,
    registered,
    async call(name, args) {
      const r = await raw(name, args);
      if (r.isError) throw new Error(`tool ${name} failed: ${r.text}`);
      return JSON.parse(r.text);
    },
    async callError(name, args) {
      const r = await raw(name, args);
      if (!r.isError) throw new Error(`tool ${name} unexpectedly succeeded: ${r.text}`);
      return r.text;
    },
  };
}
