import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";

export type ToolKind = "read" | "write" | "destructive";

/** A refusal by one of the server's own gates (as opposed to an error from Google). */
export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

/** Configuration a tool cannot work without; such a tool is not registered when it is missing. */
export type ToolRequirement = "reportsBucket";

/**
 * Read-only mode registers only read tools; destructive tools need an explicit opt-in;
 * a tool that needs configuration (the reports bucket) appears only once it is set.
 */
export function shouldRegister(
  kind: ToolKind,
  config: Pick<Config, "readOnly" | "allowDestructive"> & Partial<Pick<Config, "reportsBucket">>,
  requires?: ToolRequirement,
): boolean {
  if (requires === "reportsBucket" && !config.reportsBucket) return false;
  if (kind === "read") return true;
  if (config.readOnly) return false;
  if (kind === "destructive") return config.allowDestructive;
  return true;
}

export function annotationsFor(kind: ToolKind, idempotent = false): ToolAnnotations {
  return {
    readOnlyHint: kind === "read",
    destructiveHint: kind === "destructive",
    idempotentHint: kind === "read" ? true : idempotent,
    openWorldHint: true,
  };
}

/** `production`, plus form-factor production tracks such as `wear:production`. */
export function isProductionTrack(track: string): boolean {
  const t = track.trim().toLowerCase();
  return t === "production" || t.endsWith(":production");
}

export interface DryRunDecision {
  dryRun: boolean;
  /** Set when the production gate, not the caller, turned this into a dry run. */
  forcedReason?: string;
}

/**
 * A write that touches a production track without `confirm_production: true` is
 * downgraded to a dry run: a careless call produces a preview, never a release.
 */
export function decideDryRun(tracks: string[], confirmProduction: boolean | undefined, validateOnly: boolean | undefined): DryRunDecision {
  const prod = tracks.filter(isProductionTrack);
  if (prod.length > 0 && confirmProduction !== true) {
    return {
      dryRun: true,
      forcedReason: `This targets the production track (${prod.join(", ")}) and confirm_production was not true, so it ran as a dry run: the edit was validated and discarded, nothing was released. Re-run with confirm_production: true to apply it.`,
    };
  }
  return { dryRun: validateOnly === true };
}

/**
 * There is no default rollout. An `inProgress` release must name its percentage;
 * a missing value is an error, never a silent 100%.
 */
export function rolloutFraction(status: string, rolloutPercentage: number | undefined): number | undefined {
  if (status === "inProgress") {
    if (rolloutPercentage === undefined) {
      throw new SafetyError(
        "rollout_percentage is required when status is inProgress (there is no default). Use status \"completed\" for a full rollout.",
      );
    }
    if (!(rolloutPercentage > 0 && rolloutPercentage < 100)) {
      throw new SafetyError(
        "rollout_percentage must be greater than 0 and less than 100 for a staged rollout. Use status \"completed\" for 100%.",
      );
    }
    return toFraction(rolloutPercentage);
  }
  if (rolloutPercentage === undefined) return undefined;
  if (status === "halted" && rolloutPercentage > 0 && rolloutPercentage < 100) return toFraction(rolloutPercentage);
  throw new SafetyError(`rollout_percentage only applies to inProgress (or halted) releases, not "${status}".`);
}

function toFraction(percentage: number): number {
  return Math.round(percentage * 1000) / 100_000;
}

export function assertDestructiveAllowed(config: Pick<Config, "allowDestructive">, what: string): void {
  if (!config.allowDestructive) {
    throw new SafetyError(`${what} is destructive and is disabled. Set PLAY_MCP_ALLOW_DESTRUCTIVE=1 to enable it.`);
  }
}

export interface FileRules {
  extensions: string[];
  maxBytes?: number;
  fileRoot?: string;
}

/**
 * Resolves an upload path to its real location and checks it: allowed extension (on the
 * real path too, so a link named `.aab` can't point at a key file), a regular file, under
 * the size cap, and — when PLAY_MCP_FILE_ROOT is set — inside that root after symlinks.
 */
export async function resolveUploadFile(path: string, rules: FileRules): Promise<{ realPath: string; size: number }> {
  const allowed = rules.extensions.map((e) => e.toLowerCase());
  const hasAllowedExt = (p: string) => allowed.includes(extname(p).toLowerCase());
  if (!hasAllowedExt(path)) {
    throw new SafetyError(`File must have one of these extensions: ${allowed.join(", ")}. Got ${path}.`);
  }
  let realPath: string;
  try {
    realPath = await realpath(path);
  } catch {
    throw new SafetyError(`File not found: ${path}`);
  }
  if (!hasAllowedExt(realPath)) {
    throw new SafetyError(`File resolves to ${realPath}, which does not have an allowed extension.`);
  }
  if (rules.fileRoot) {
    let root: string;
    try {
      root = await realpath(rules.fileRoot);
    } catch {
      throw new SafetyError(`PLAY_MCP_FILE_ROOT does not exist: ${rules.fileRoot}`);
    }
    const rel = relative(root, realPath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new SafetyError(`File ${realPath} is outside PLAY_MCP_FILE_ROOT (${root}).`);
    }
  }
  const info = await stat(realPath);
  if (!info.isFile()) throw new SafetyError(`Not a regular file: ${realPath}`);
  if (rules.maxBytes !== undefined && info.size > rules.maxBytes) {
    throw new SafetyError(`File is ${info.size} bytes; the limit is ${rules.maxBytes}.`);
  }
  return { realPath, size: info.size };
}
