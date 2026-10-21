import { readFile } from "node:fs/promises";
import { SignJWT, importPKCS8 } from "jose";
import type { AuthSource } from "../config.js";
import type { MintedToken } from "./auth.js";

// The token endpoint is fixed. A key file's own `token_uri` is ignored on purpose:
// honouring it would let a tampered key file send the signed assertion elsewhere.
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const SCOPES = [
  "https://www.googleapis.com/auth/androidpublisher",
  "https://www.googleapis.com/auth/playdeveloperreporting",
];

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export type KeySource = Extract<AuthSource, { kind: "path" | "inline" }>;

export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Service-account key is not valid JSON.");
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error("Service-account key must contain client_email and private_key.");
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

async function loadKey(source: KeySource): Promise<ServiceAccountKey> {
  if (source.kind === "inline") return parseServiceAccountKey(source.json);
  let text: string;
  try {
    text = await readFile(source.path, "utf8");
  } catch (e) {
    throw new Error(`Cannot read service-account key at ${source.path}: ${(e as Error).message}`);
  }
  return parseServiceAccountKey(text);
}

/** Mode A: signs a service-account JWT locally (RS256) and exchanges it for a token. */
export async function mintFromKey(source: KeySource, fetchImpl: typeof fetch, now: () => number): Promise<MintedToken> {
  const key = await loadKey(source);
  const privateKey = await importPKCS8(key.private_key, "RS256");
  const iat = Math.floor(now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPES.join(" ") })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(key.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(privateKey);

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // Google's error body holds a code and description only, never the assertion.
    throw new Error(
      `Token exchange failed (${res.status}): ${body.error ?? "unknown"}${body.error_description ? ` — ${body.error_description}` : ""}`,
    );
  }
  return { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
}
