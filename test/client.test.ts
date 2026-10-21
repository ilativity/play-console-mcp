import { describe, expect, it } from "vitest";
import { GoogleApiError, PlayClient, assertAllowedUrl, seg } from "../src/google/client.js";
import { FakeFetch, TOKEN, testClient } from "./helpers.js";

describe("host allowlist", () => {
  it("accepts the Google API hosts over https", () => {
    for (const h of ["androidpublisher.googleapis.com", "playdeveloperreporting.googleapis.com", "oauth2.googleapis.com"]) {
      expect(() => assertAllowedUrl(`https://${h}/x`)).not.toThrow();
    }
  });

  it.each([
    "https://evil.example.com/x",
    "http://androidpublisher.googleapis.com/x",
    "https://androidpublisher.googleapis.com.evil.com/x",
    "https://androidpublisher.googleapis.com:8443/x",
    "https://user:pw@androidpublisher.googleapis.com/x",
    "https://storage.googleapis.com/x",
  ])("refuses %s", (url) => {
    expect(() => assertAllowedUrl(url)).toThrow(/allowlist/);
  });

  it.each(["https://evil.com/x", "//evil.com/x", "x/y", "/a/../b", "/a?x=1", "/a#f", "/a\\b"])(
    "request() refuses non-relative path %s without calling fetch",
    async (path) => {
      const fake = new FakeFetch();
      await expect(testClient(fake).request("publisher", path)).rejects.toThrow(/Refusing/);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("rawUrl refuses a forged absolute URL (e.g. a bad Location header) without sending the token", async () => {
    const fake = new FakeFetch();
    await expect(testClient(fake).rawUrl("https://attacker.example/upload")).rejects.toThrow(/allowlist/);
    expect(fake.calls).toHaveLength(0);
  });

  it("seg() encodes and refuses dot segments", () => {
    expect(seg("a/b")).toBe("a%2Fb");
    expect(() => seg("..")).toThrow();
    expect(() => seg("")).toThrow();
  });
});

describe("requests", () => {
  it("sends the bearer token and builds the URL from the fixed base", async () => {
    const fake = new FakeFetch().on("GET", /\/applications\/p\.q\/reviews$/, { json: { ok: 1 } });
    const res = await testClient(fake).request("publisher", "/applications/p.q/reviews", { query: { a: 1, b: undefined } });
    expect(res).toEqual({ ok: 1 });
    expect(fake.calls[0]!.url.href).toBe("https://androidpublisher.googleapis.com/androidpublisher/v3/applications/p.q/reviews?a=1");
    expect(fake.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns undefined for an empty body", async () => {
    const fake = new FakeFetch().on("DELETE", /x$/, { status: 204 });
    expect(await testClient(fake).request("publisher", "/x", { method: "DELETE" })).toBeUndefined();
  });

  it("throws GoogleApiError with Google's error body and no token", async () => {
    const fake = new FakeFetch().on("GET", /x$/, { status: 403, json: { error: { code: 403, message: "The caller does not have permission" } } });
    const err = (await testClient(fake).request("publisher", "/x").catch((e: unknown) => e)) as GoogleApiError;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("does not have permission");
    expect(JSON.stringify(err.body) + err.message).not.toContain(TOKEN);
  });
});

describe("retry", () => {
  function flaky(statuses: number[], method = "GET") {
    let n = 0;
    const fake = new FakeFetch().on(method, /x$/, () => {
      const s = statuses[n++];
      return s ? { status: s, json: { error: { message: "busy" } } } : { json: { done: true } };
    });
    return fake;
  }

  it("retries 429 and 5xx on GET, then succeeds", async () => {
    const fake = flaky([429, 503]);
    expect(await testClient(fake).request("publisher", "/x")).toEqual({ done: true });
    expect(fake.calls).toHaveLength(3);
  });

  it("gives up after maxRetries", async () => {
    const fake = flaky([500, 500, 500, 500, 500]);
    const client = new PlayClient({ getToken: async () => TOKEN, fetchImpl: fake.fetch, sleep: async () => {}, maxRetries: 2 });
    await expect(client.request("publisher", "/x")).rejects.toThrow(/500/);
    expect(fake.calls).toHaveLength(3);
  });

  it("does not retry a 5xx on POST (not idempotent), but does retry 429", async () => {
    const fake5 = flaky([500], "POST");
    await expect(testClient(fake5).request("publisher", "/x", { method: "POST" })).rejects.toThrow(/500/);
    expect(fake5.calls).toHaveLength(1);

    const fake429 = flaky([429], "POST");
    expect(await testClient(fake429).request("publisher", "/x", { method: "POST" })).toEqual({ done: true });
    expect(fake429.calls).toHaveLength(2);
  });

  it("backs off exponentially and honours Retry-After", async () => {
    let n = 0;
    const fake = new FakeFetch().on("GET", /x$/, () =>
      n++ === 0 ? { status: 429, headers: { "retry-after": "2" } } : n === 2 ? { status: 503 } : { json: {} },
    );
    const delays: number[] = [];
    const client = new PlayClient({
      getToken: async () => TOKEN,
      fetchImpl: fake.fetch,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await client.request("publisher", "/x");
    expect(delays).toEqual([2000, 200]);
  });
});
