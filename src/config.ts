export interface Config {
  /** Where the service-account key comes from; resolved lazily on the first API call. */
  keySource: KeySource | undefined;
  defaultPackage: string | undefined;
  readOnly: boolean;
  allowDestructive: boolean;
  /** If set, upload tools only read files under this directory (after realpath). */
  fileRoot: string | undefined;
}

export type KeySource = { kind: "path"; path: string } | { kind: "inline"; json: string };

type Env = Record<string, string | undefined>;

export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function loadConfig(env: Env = process.env): Config {
  const keyPath = nonEmpty(env.PLAY_MCP_KEY_PATH);
  const keyInline = nonEmpty(env.PLAY_MCP_KEY);
  const adc = nonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS);

  let keySource: KeySource | undefined;
  if (keyPath) keySource = { kind: "path", path: keyPath };
  else if (keyInline) keySource = { kind: "inline", json: keyInline };
  else if (adc) keySource = { kind: "path", path: adc };

  return {
    keySource,
    defaultPackage: nonEmpty(env.PLAY_MCP_PACKAGE),
    readOnly: isTruthy(env.PLAY_MCP_READ_ONLY),
    allowDestructive: isTruthy(env.PLAY_MCP_ALLOW_DESTRUCTIVE),
    fileRoot: nonEmpty(env.PLAY_MCP_FILE_ROOT),
  };
}
