import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SCOPES, TOKEN_URL, createTokenProvider, parseServiceAccountKey } from "../src/google/auth.js";
import { FakeFetch } from "./helpers.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  type: "service_account",
  client_email: "bot@proj.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://evil.example/token",
});

function tokenEndpoint(expiresIn = 3600) {
  let n = 0;
  return new FakeFetch().on("POST", /^oauth2\.googleapis\.com\/token$/, () => ({
    json: { access_token: `tok${++n}`, expires_in: expiresIn },
  }));
}

describe("token provider", () => {
  it("signs an RS256 JWT for both scopes and exchanges it at the fixed endpoint (ignoring token_uri)", async () => {
    const fake = tokenEndpoint();
    const get = createTokenProvider({ kind: "inline", json: KEY_JSON }, fake.fetch);
    expect(await get()).toBe("tok1");
    const call = fake.calls[0]!;
    expect(call.url.href).toBe(TOKEN_URL);
    const params = new URLSearchParams(call.json as string);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = decodeJwt(params.get("assertion")!);
    expect(claims.iss).toBe("bot@proj.iam.gserviceaccount.com");
    expect(claims.aud).toBe(TOKEN_URL);
    expect(claims.scope).toBe(SCOPES.join(" "));
  });

  it("caches the token until shortly before expiry, then refreshes", async () => {
    const fake = tokenEndpoint(3600);
    let t = 1_000_000;
    const get = createTokenProvider({ kind: "inline", json: KEY_JSON }, fake.fetch, () => t);
    expect(await get()).toBe("tok1");
    t += 3000 * 1000;
    expect(await get()).toBe("tok1");
    t += 560 * 1000; // within 60s of expiry
    expect(await get()).toBe("tok2");
    expect(fake.calls).toHaveLength(2);
  });

  it("shares one in-flight exchange between concurrent callers", async () => {
    const fake = tokenEndpoint();
    const get = createTokenProvider({ kind: "inline", json: KEY_JSON }, fake.fetch);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(fake.calls).toHaveLength(1);
  });

  it("reports a missing key with the env var names", async () => {
    await expect(createTokenProvider(undefined)()).rejects.toThrow(/PLAY_MCP_KEY_PATH/);
  });

  it("reports a token error without echoing the key", async () => {
    const fake = new FakeFetch().on("POST", /token$/, { status: 400, json: { error: "invalid_grant", error_description: "Invalid JWT" } });
    const err = (await createTokenProvider({ kind: "inline", json: KEY_JSON }, fake.fetch)().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("invalid_grant");
    expect(err.message).not.toContain("PRIVATE KEY");
  });

  it("rejects malformed keys", () => {
    expect(() => parseServiceAccountKey("nope")).toThrow(/JSON/);
    expect(() => parseServiceAccountKey("{}")).toThrow(/client_email/);
  });
});

describe("config", () => {
  it("prefers PLAY_MCP_KEY_PATH, then PLAY_MCP_KEY, then GOOGLE_APPLICATION_CREDENTIALS", () => {
    expect(loadConfig({ PLAY_MCP_KEY_PATH: "/a", PLAY_MCP_KEY: "{}", GOOGLE_APPLICATION_CREDENTIALS: "/c" }).keySource).toEqual({ kind: "path", path: "/a" });
    expect(loadConfig({ PLAY_MCP_KEY: "{}", GOOGLE_APPLICATION_CREDENTIALS: "/c" }).keySource).toEqual({ kind: "inline", json: "{}" });
    expect(loadConfig({ GOOGLE_APPLICATION_CREDENTIALS: "/c" }).keySource).toEqual({ kind: "path", path: "/c" });
    expect(loadConfig({}).keySource).toBeUndefined();
  });

  it("parses flags", () => {
    const c = loadConfig({ PLAY_MCP_READ_ONLY: "1", PLAY_MCP_ALLOW_DESTRUCTIVE: "false", PLAY_MCP_PACKAGE: " com.a.b " });
    expect(c.readOnly).toBe(true);
    expect(c.allowDestructive).toBe(false);
    expect(c.defaultPackage).toBe("com.a.b");
  });
});
