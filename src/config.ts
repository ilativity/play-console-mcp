import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** Where credentials come from; resolved lazily on the first API call. */
  authSource: AuthSource | undefined;
  defaultPackage: string | undefined;
  readOnly: boolean;
  allowDestructive: boolean;
  /** If set, upload tools only read files under this directory (after realpath). */
  fileRoot: string | undefined;
}

export type AuthSource =
  // Mode A: a service-account key file.
  | { kind: "path"; path: string }
  | { kind: "inline"; json: string }
  // Mode B: the user's gcloud ADC, exchanged for a token of `serviceAccount`. No key on disk.
  | { kind: "impersonate"; serviceAccount: string; adcPath: string };

type Env = Record<string, string | undefined>;

export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** Where `gcloud auth application-default login` writes its file. */
export function defaultAdcPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA) ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "gcloud", "application_default_credentials.json");
  }
  return join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

export function loadConfig(env: Env = process.env, platform: NodeJS.Platform = process.platform): Config {
  const impersonate = nonEmpty(env.PLAY_MCP_IMPERSONATE);
  const keyPath = nonEmpty(env.PLAY_MCP_KEY_PATH);
  const keyInline = nonEmpty(env.PLAY_MCP_KEY);
  const adc = nonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS);

  let authSource: AuthSource | undefined;
  // Mode B wins over any key variable; GOOGLE_APPLICATION_CREDENTIALS then names the ADC file.
  if (impersonate) authSource = { kind: "impersonate", serviceAccount: impersonate, adcPath: adc ?? defaultAdcPath(env, platform) };
  else if (keyPath) authSource = { kind: "path", path: keyPath };
  else if (keyInline) authSource = { kind: "inline", json: keyInline };
  else if (adc) authSource = { kind: "path", path: adc };

  return {
    authSource,
    defaultPackage: nonEmpty(env.PLAY_MCP_PACKAGE),
    readOnly: isTruthy(env.PLAY_MCP_READ_ONLY),
    allowDestructive: isTruthy(env.PLAY_MCP_ALLOW_DESTRUCTIVE),
    fileRoot: nonEmpty(env.PLAY_MCP_FILE_ROOT),
  };
}
