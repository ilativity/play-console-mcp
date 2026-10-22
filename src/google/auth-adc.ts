import { readFile } from "node:fs/promises";
import type { MintedToken } from "./auth.js";
import { SCOPES, TOKEN_URL } from "./auth-key.js";
import { assertAllowedUrl } from "./client.js";

const IAM_BASE = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";

interface AuthorizedUser {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

interface ImpersonatedFile {
  type: "impersonated_service_account";
  source_credentials: AuthorizedUser;
  service_account_impersonation_url: string;
  delegates?: string[];
}

export interface ImpersonationSource {
  serviceAccount: string;
  adcPath: string;
}

const setupCommands = (sa: string) =>
  [
    `  gcloud iam service-accounts add-iam-policy-binding ${sa} --member=user:<you> --role=roles/iam.serviceAccountTokenCreator`,
    "  gcloud auth application-default login",
  ].join("\n");

/** The service account a generateAccessToken URL targets, or undefined if it isn't one. */
export function impersonationTarget(url: string): string | undefined {
  let u: URL;
  try {
    u = assertAllowedUrl(url);
  } catch {
    return undefined;
  }
  if (u.hostname !== "iamcredentials.googleapis.com" || u.search || u.hash) return undefined;
  const m = /^\/v1\/projects\/-\/serviceAccounts\/([^/]+):generateAccessToken$/.exec(u.pathname);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

function isAuthorizedUser(x: unknown): x is AuthorizedUser {
  const u = x as Partial<AuthorizedUser> | undefined;
  return u?.type === "authorized_user" && !!u.client_id && !!u.client_secret && !!u.refresh_token;
}

/** Reads the ADC file and works out the user credential plus the generateAccessToken URL. */
export async function loadAdc(src: ImpersonationSource): Promise<{ user: AuthorizedUser; url: string; delegates?: string[] }> {
  let text: string;
  try {
    text = await readFile(src.adcPath, "utf8");
  } catch {
    throw new Error(
      `PLAY_MCP_IMPERSONATE is set but there are no Application Default Credentials at ${src.adcPath}. One-time setup:\n${setupCommands(src.serviceAccount)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`ADC file ${src.adcPath} is not valid JSON.`);
  }
  if (isAuthorizedUser(parsed)) {
    return { user: parsed, url: `${IAM_BASE}/${encodeURIComponent(src.serviceAccount)}:generateAccessToken` };
  }
  const imp = parsed as Partial<ImpersonatedFile>;
  if (imp.type === "impersonated_service_account") {
    if (!isAuthorizedUser(imp.source_credentials) || typeof imp.service_account_impersonation_url !== "string") {
      throw new Error(`ADC file ${src.adcPath}: impersonated_service_account needs authorized_user source_credentials and service_account_impersonation_url.`);
    }
    // Used as given, but only if it is a generateAccessToken call for the SAME account as
    // PLAY_MCP_IMPERSONATE: otherwise every Play call would silently run as another account.
    const target = impersonationTarget(imp.service_account_impersonation_url);
    if (!target) {
      throw new Error(
        `ADC file ${src.adcPath}: service_account_impersonation_url is not an iamcredentials generateAccessToken URL.`,
      );
    }
    if (target.toLowerCase() !== src.serviceAccount.toLowerCase()) {
      throw new Error(
        `ADC file ${src.adcPath} impersonates ${target}, but PLAY_MCP_IMPERSONATE is ${src.serviceAccount}. Refusing to act as a different account; make them match.`,
      );
    }
    return { user: imp.source_credentials, url: imp.service_account_impersonation_url, delegates: imp.delegates };
  }
  throw new Error(
    `ADC file ${src.adcPath} has type "${(parsed as { type?: string })?.type ?? "unknown"}"; mode B accepts authorized_user or impersonated_service_account.`,
  );
}

async function refreshUserToken(user: AuthorizedUser, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: user.client_id,
      client_secret: user.client_secret,
      refresh_token: user.refresh_token,
    }).toString(),
    // Never let a redirect carry the refresh token and client secret to another host.
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (body.error === "invalid_grant") {
    throw new Error("Your gcloud login has expired or was revoked (invalid_grant). Rerun: gcloud auth application-default login");
  }
  if (!res.ok || !body.access_token) {
    throw new Error(`Refreshing the gcloud user token failed (${res.status}): ${body.error ?? "unknown"}${body.error_description ? ` — ${body.error_description}` : ""}`);
  }
  return body.access_token;
}

/**
 * Mode B: refreshes the user's ADC token, then trades it for a short-lived token of the
 * service account via iamcredentials generateAccessToken. No private key exists anywhere.
 */
export async function mintImpersonated(
  src: ImpersonationSource,
  fetchImpl: typeof fetch,
  now: () => number,
  scopes: string[] = SCOPES,
): Promise<MintedToken> {
  const { user, url, delegates } = await loadAdc(src);
  const userToken = await refreshUserToken(user, fetchImpl);
  const res = await fetchImpl(assertAllowedUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ scope: scopes, lifetime: "3600s", ...(delegates?.length ? { delegates } : {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string; expireTime?: string; error?: { message?: string } };
  if (res.status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(JSON.stringify(body))) {
    throw new Error(
      `The IAM Service Account Credentials API is not enabled (403: ${body.error?.message ?? "service disabled"}). Enable it once: gcloud services enable iamcredentials.googleapis.com`,
    );
  }
  if (res.status === 403) {
    throw new Error(
      `Not allowed to impersonate ${src.serviceAccount} (403: ${body.error?.message ?? "permission denied"}). Your Google account needs the Service Account Token Creator role on it:\n${setupCommands(src.serviceAccount).split("\n")[0]}`,
    );
  }
  if (!res.ok || !body.accessToken) {
    throw new Error(`generateAccessToken failed (${res.status}): ${body.error?.message ?? "no token returned"}`);
  }
  const expires = body.expireTime ? Date.parse(body.expireTime) : NaN;
  return { token: body.accessToken, expiresAt: Number.isFinite(expires) ? expires : now() + 3600_000 };
}
