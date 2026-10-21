import { describe, expect, it } from "vitest";
import { normalizeFingerprint } from "../../src/tools/twa.js";
import { FakeFetch, FakePlay, PKG, connect, testConfig } from "../helpers.js";

const HEX = "ab".repeat(32);
const COLON = HEX.toUpperCase().match(/../g)!.join(":");
const OTHER = "CD:".repeat(31) + "CD";

function site(body: unknown, init: { status?: number; type?: string; headers?: Record<string, string> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, reqInit) => {
    calls.push({ url: String(input), init: reqInit });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": init.type ?? "application/json", ...init.headers },
    });
  };
  return { fetchImpl, calls };
}

const statement = (fps: string[], pkg = PKG) => [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fps },
  },
];

function play(hash: string | null = HEX) {
  const fake = new FakePlay();
  fake.tracks = { production: [{ versionCodes: ["7"], status: "completed" }], internal: [{ versionCodes: ["9"], status: "completed" }] };
  fake.on("GET", /generatedApks\/(\d+)$/, { json: { generatedApks: hash ? [{ certificateSha256Hash: hash }] : [] } });
  return fake;
}

describe("normalizeFingerprint", () => {
  it("accepts hex, colon hex and base64", () => {
    expect(normalizeFingerprint(HEX)).toBe(COLON);
    expect(normalizeFingerprint(COLON.toLowerCase())).toBe(COLON);
    expect(normalizeFingerprint(Buffer.from(HEX, "hex").toString("base64"))).toBe(COLON);
    expect(() => normalizeFingerprint("nope")).toThrow();
  });
});

describe("check_asset_links", () => {
  it("reports a match against the signing cert of the highest version code", async () => {
    const fake = play();
    const s = site(statement([COLON]));
    const h = await connect(fake, testConfig(), s.fetchImpl);
    const res = await h.call("check_asset_links", { domain: "example.com" });
    expect(res).toMatchObject({ match: true, matched: [COLON], problems: [] });
    expect(res.play_fingerprint_source).toMatch(/version 9/);
    expect(s.calls[0]!.url).toBe("https://example.com/.well-known/assetlinks.json");
  });

  it("never sends credentials to the site and does not follow redirects", async () => {
    const s = site(statement([COLON]));
    const h = await connect(play(), testConfig(), s.fetchImpl);
    await h.call("check_asset_links", { domain: "example.com" });
    const init = s.calls[0]!.init!;
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
  });

  it("reports a mismatch (the URL-bar case)", async () => {
    const h = await connect(play(), testConfig(), site(statement([OTHER])).fetchImpl);
    const res = await h.call("check_asset_links", { domain: "example.com" });
    expect(res.match).toBe(false);
    expect(res.problems.join(" ")).toMatch(/none is the app-signing certificate/);
  });

  it("flags a missing statement, a redirect and a wrong content type", async () => {
    let h = await connect(play(), testConfig(), site(statement([COLON], "other.pkg")).fetchImpl);
    expect((await h.call("check_asset_links", { domain: "example.com" })).problems.join(" ")).toMatch(/No handle_all_urls statement/);

    h = await connect(play(), testConfig(), site("", { status: 301, headers: { location: "https://www.example.com/" } }).fetchImpl);
    expect((await h.call("check_asset_links", { domain: "example.com" })).problems.join(" ")).toMatch(/redirects/);

    h = await connect(play(), testConfig(), site(statement([COLON]), { type: "text/html" }).fetchImpl);
    const res = await h.call("check_asset_links", { domain: "example.com" });
    expect(res.match).toBe(false);
    expect(res.problems.join(" ")).toMatch(/Content-Type/);
  });

  it("uses an explicit fingerprint without asking Play", async () => {
    const fake = new FakeFetch();
    const h = await connect(fake, testConfig(), site(statement([COLON])).fetchImpl);
    const res = await h.call("check_asset_links", { domain: "example.com", fingerprint: HEX });
    expect(res.match).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("asks for a fingerprint when Play reports no signing cert", async () => {
    const h = await connect(play(null), testConfig(), site(statement([COLON])).fetchImpl);
    expect(await h.callError("check_asset_links", { domain: "example.com" })).toMatch(/Pass fingerprint/);
  });

  it.each(["https://example.com", "example.com/path", "localhost", "127.0.0.1", "example.com:8443", "a@example.com"])(
    "rejects a non-hostname domain %s",
    async (domain) => {
      const s = site([]);
      const h = await connect(play(), testConfig(), s.fetchImpl);
      expect(await h.callError("check_asset_links", { domain })).toMatch(/plain public hostname/);
      expect(s.calls).toHaveLength(0);
    },
  );
});
