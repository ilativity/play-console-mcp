import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPES, createTokenProvider } from "../src/google/auth.js";
import { FakeFetch } from "./helpers.js";

const SA = "play-bot@proj.iam.gserviceaccount.com";
const USER = { type: "authorized_user", client_id: "cid", client_secret: "csecret", refresh_token: "rtok" };

async function adcFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pcm-adc-"));
  const p = join(dir, "application_default_credentials.json");
  await writeFile(p, JSON.stringify(content));
  return p;
}

function google(opts: { refresh?: object; iam?: { status?: number; json: object } } = {}) {
  return new FakeFetch()
    .on("POST", /^oauth2\.googleapis\.com\/token$/, { status: opts.refresh ? 400 : 200, json: opts.refresh ?? { access_token: "user-token", expires_in: 3600 } })
    .on("POST", /^iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/[^/]+:generateAccessToken$/, {
      status: opts.iam?.status ?? 200,
      json: opts.iam?.json ?? { accessToken: "sa-token", expireTime: "2026-10-21T12:00:00Z" },
    });
}

const provider = (adcPath: string, fake: FakeFetch, now = () => Date.parse("2026-10-21T11:00:00Z")) =>
  createTokenProvider({ kind: "impersonate", serviceAccount: SA, adcPath }, fake.fetch, now);

describe("mode B: keyless impersonation", () => {
  it("authorized_user: refreshes the user token, then calls generateAccessToken for the SA", async () => {
    const fake = google();
    expect(await provider(await adcFile(USER), fake)()).toBe("sa-token");

    const refresh = new URLSearchParams(fake.calls[0]!.json as string);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("rtok");

    const iam = fake.calls[1]!;
    expect(iam.url.href).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:generateAccessToken`);
    expect(iam.headers.authorization).toBe("Bearer user-token");
    expect(iam.json).toEqual({ scope: SCOPES, lifetime: "3600s" });
  });

  it("impersonated_service_account: uses source_credentials and the URL as given (with delegates)", async () => {
    const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`;
    const fake = google();
    const path = await adcFile({
      type: "impersonated_service_account",
      source_credentials: USER,
      service_account_impersonation_url: url,
      delegates: ["mid@p.iam.gserviceaccount.com"],
    });
    expect(await provider(path, fake)()).toBe("sa-token");
    expect(fake.calls[1]!.url.href).toBe(url);
    expect(fake.calls[1]!.json).toMatchObject({ delegates: ["mid@p.iam.gserviceaccount.com"] });
  });

  it("refuses an ADC file that impersonates a different account than PLAY_MCP_IMPERSONATE", async () => {
    const fake = google();
    const path = await adcFile({
      type: "impersonated_service_account",
      source_credentials: USER,
      service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/play-admin@p.iam.gserviceaccount.com:generateAccessToken",
    });
    await expect(provider(path, fake)()).rejects.toThrow(/impersonates play-admin@.*PLAY_MCP_IMPERSONATE is play-bot@/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an impersonation URL that is not iamcredentials generateAccessToken", async () => {
    const fake = google();
    const path = await adcFile({
      type: "impersonated_service_account",
      source_credentials: USER,
      service_account_impersonation_url: `https://androidpublisher.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`,
    });
    await expect(provider(path, fake)()).rejects.toThrow(/not an iamcredentials generateAccessToken URL/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an impersonation URL on a non-Google host before sending the user token", async () => {
    const fake = google();
    const path = await adcFile({
      type: "impersonated_service_account",
      source_credentials: USER,
      service_account_impersonation_url: "https://evil.example/generateAccessToken",
    });
    await expect(provider(path, fake)()).rejects.toThrow(/not an iamcredentials generateAccessToken URL/);
    expect(fake.calls).toHaveLength(0);
  });

  it("caches the SA token until 60s before expireTime", async () => {
    const fake = google();
    let t = Date.parse("2026-10-21T11:00:00Z");
    const get = provider(await adcFile(USER), fake, () => t);
    await get();
    t = Date.parse("2026-10-21T11:58:00Z");
    await get();
    expect(fake.calls).toHaveLength(2);
    t = Date.parse("2026-10-21T11:59:30Z");
    await get();
    expect(fake.calls).toHaveLength(4);
  });

  describe("errors name the fix", () => {
    it("403 from iamcredentials → the TokenCreator binding is missing", async () => {
      const fake = google({ iam: { status: 403, json: { error: { message: "Permission 'iam.serviceAccounts.getAccessToken' denied" } } } });
      const err = await provider(await adcFile(USER), fake)().catch((e: Error) => e.message);
      expect(err).toMatch(/roles\/iam\.serviceAccountTokenCreator/);
      expect(err).toContain(`add-iam-policy-binding ${SA}`);
    });

    it("403 SERVICE_DISABLED → enable the IAM Credentials API, not the binding", async () => {
      const fake = google({
        iam: { status: 403, json: { error: { message: "IAM Service Account Credentials API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } } },
      });
      const err = await provider(await adcFile(USER), fake)().catch((e: Error) => e.message);
      expect(err).toMatch(/gcloud services enable iamcredentials\.googleapis\.com/);
      expect(err).not.toMatch(/add-iam-policy-binding/);
    });

    it("invalid_grant on refresh → rerun gcloud auth application-default login", async () => {
      const fake = google({ refresh: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
      const err = await provider(await adcFile(USER), fake)().catch((e: Error) => e.message);
      expect(err).toMatch(/gcloud auth application-default login/);
      expect(fake.calls).toHaveLength(1);
    });

    it("no ADC file → prints both setup commands", async () => {
      const fake = google();
      const err = await provider(join(tmpdir(), "definitely-missing-adc.json"), fake)().catch((e: Error) => e.message);
      expect(err).toContain("roles/iam.serviceAccountTokenCreator");
      expect(err).toContain("gcloud auth application-default login");
      expect(fake.calls).toHaveLength(0);
    });

    it("rejects an unsupported ADC type", async () => {
      const err = await provider(await adcFile({ type: "external_account" }), google())().catch((e: Error) => e.message);
      expect(err).toMatch(/authorized_user or impersonated_service_account/);
    });
  });

  it("never follows a redirect with the refresh token or the user token", async () => {
    const fake = google();
    await provider(await adcFile(USER), fake)();
    expect(fake.calls.map((c) => c.url.hostname)).toEqual(["oauth2.googleapis.com", "iamcredentials.googleapis.com"]);
    const inits: RequestInit[] = [];
    const spy: typeof fetch = (i, init) => {
      inits.push(init ?? {});
      return fake.fetch(i, init);
    };
    await createTokenProvider({ kind: "impersonate", serviceAccount: SA, adcPath: await adcFile(USER) }, spy)();
    expect(inits.map((i) => i.redirect)).toEqual(["error", "error"]);
  });

  it("never puts the refresh token or client secret in an error", async () => {
    const fake = google({ iam: { status: 500, json: { error: { message: "backend" } } } });
    const err = await provider(await adcFile(USER), fake)().catch((e: Error) => e.message);
    expect(err).not.toMatch(/rtok|csecret|user-token/);
  });
});
