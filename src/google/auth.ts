import type { AuthSource } from "../config.js";
import { mintImpersonated } from "./auth-adc.js";
import { mintFromKey } from "./auth-key.js";

export { SCOPES, TOKEN_URL, parseServiceAccountKey } from "./auth-key.js";

export interface MintedToken {
  token: string;
  /** Epoch ms when Google says the token expires. */
  expiresAt: number;
}

export type TokenProvider = () => Promise<string>;

const REFRESH_MARGIN_MS = 60_000;

/**
 * Returns a function that yields a bearer token, minting a new one 60s before expiry.
 * Tokens live only in this closure — never written to disk or logged.
 */
export function createTokenProvider(
  source: AuthSource | undefined,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): TokenProvider {
  const mint = (): Promise<MintedToken> => {
    if (!source) {
      return Promise.reject(
        new Error(
          "No credentials configured. Set PLAY_MCP_KEY_PATH (a service-account key), PLAY_MCP_KEY, GOOGLE_APPLICATION_CREDENTIALS, or PLAY_MCP_IMPERSONATE=<service-account email> for keyless mode.",
        ),
      );
    }
    return source.kind === "impersonate" ? mintImpersonated(source, fetchImpl, now) : mintFromKey(source, fetchImpl, now);
  };

  let cached: MintedToken | undefined;
  let inflight: Promise<string> | undefined;
  return async () => {
    if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    inflight ??= mint()
      .then((t) => {
        cached = t;
        return t.token;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}
