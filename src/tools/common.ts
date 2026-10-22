import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Config } from "../config.js";
import type { PlayClient } from "../google/client.js";
import type { EditOutcome } from "../google/edits.js";
import type { ToolKind, ToolRequirement } from "../safety.js";
import { SafetyError, resolveUploadFile } from "../safety.js";

export interface ToolContext {
  client: PlayClient;
  config: Config;
  /** Unauthenticated fetch for the one non-Google host a tool may reach (assetlinks.json). */
  publicFetch: typeof fetch;
  /** Resolves the package for a call: the argument, else PLAY_MCP_PACKAGE. */
  pkg(arg: string | undefined): string;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  idempotent?: boolean;
  /** Registered only when this configuration is present. */
  requires?: ToolRequirement;
  input: S;
  handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown>;
}

/** Keeps each tool's argument type precise while letting modules export a plain array. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

export function resolvePackage(arg: string | undefined, fallback: string | undefined): string {
  const pkg = arg?.trim() || fallback;
  if (!pkg) throw new SafetyError("package_name is required (or set PLAY_MCP_PACKAGE for a default).");
  if (!PACKAGE_RE.test(pkg)) throw new SafetyError(`Not a valid Android package name: ${pkg}`);
  return pkg;
}

// Shared argument shapes ------------------------------------------------------

export const packageArg = {
  package_name: z.string().optional().describe("Android package name. Defaults to PLAY_MCP_PACKAGE."),
};

export const trackName = z
  .string()
  .regex(/^[A-Za-z0-9:_-]+$/, "track names contain only letters, digits, ':', '_' and '-'")
  .describe("Track: internal, alpha, beta, production, or a custom/form-factor track (e.g. wear:production).");

export const languageCode = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/, "BCP-47 language code, e.g. en-US")
  .describe("BCP-47 language code, e.g. en-US");

export const validateOnlyArg = {
  validate_only: z.boolean().optional().describe("Dry run: validate the change in an edit, then discard it."),
};

export const productionArgs = {
  confirm_production: z
    .boolean()
    .optional()
    .describe("Must be true to change a production track. Without it the call runs as a dry run and returns a preview."),
  changes_not_sent_for_review: z
    .boolean()
    .optional()
    .describe("Managed publishing: commit without sending for review."),
};

export const releaseNotesArg = z
  .array(z.object({ language: languageCode, text: z.string().max(500) }))
  .optional()
  .describe("Release notes per language (max 500 characters each).");

export const versionCode = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);

// Output helpers --------------------------------------------------------------

/** Flattens an edit outcome into the shape every write tool returns. */
export function editResult<T>(outcome: EditOutcome<T>, forcedReason?: string): Record<string, unknown> {
  return {
    dry_run: outcome.dryRun,
    committed: outcome.committed,
    ...(forcedReason ? { production_guard: forcedReason } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
    ...(outcome.changesNotSentForReview ? { changes_not_sent_for_review: true } : {}),
    result: outcome.result,
  };
}

/** Checks an upload path against the file rules, then reads it. */
export async function readUploadFile(
  ctx: ToolContext,
  path: string,
  extensions: string[],
  maxBytes?: number,
): Promise<{ realPath: string; data: Uint8Array }> {
  const { realPath } = await resolveUploadFile(path, { extensions, maxBytes, fileRoot: ctx.config.fileRoot });
  return { realPath, data: new Uint8Array(await readFile(realPath)) };
}
