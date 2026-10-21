import { z } from "zod";
import { editPath, seg, type PlayClient } from "../google/client.js";
import { withEdit, withReadEdit } from "../google/edits.js";
import { SafetyError, decideDryRun, rolloutFraction } from "../safety.js";
import { readBundle, readMapping, uploadBundleToEdit, uploadMappingToEdit } from "./bundles.js";
import {
  defineTool,
  editResult,
  packageArg,
  productionArgs,
  releaseNotesArg,
  trackName,
  validateOnlyArg,
  versionCode,
  type ToolContext,
} from "./common.js";

export type ReleaseStatus = "draft" | "inProgress" | "halted" | "completed";

export interface Release {
  name?: string;
  versionCodes?: string[];
  status?: ReleaseStatus;
  userFraction?: number;
  releaseNotes?: { language: string; text: string }[];
  [extra: string]: unknown;
}

export interface Track {
  track: string;
  releases?: Release[];
}

const statusArg = z
  .enum(["draft", "inProgress", "halted", "completed"])
  .describe("draft = not live; inProgress = staged rollout (needs rollout_percentage); completed = 100%.");

const rolloutArg = z
  .number()
  .gt(0)
  .lt(100)
  .optional()
  .describe("Percentage of users for a staged (inProgress) rollout, e.g. 10. Required for inProgress — there is no default.");

// Track helpers ---------------------------------------------------------------

export async function getTrack(client: PlayClient, pkg: string, editId: string, track: string): Promise<Track> {
  return client.request<Track>("publisher", `${editPath(pkg, editId)}/tracks/${seg(track)}`);
}

export async function listTracks(client: PlayClient, pkg: string, editId: string): Promise<Track[]> {
  const res = await client.request<{ tracks?: Track[] }>("publisher", `${editPath(pkg, editId)}/tracks`);
  return res?.tracks ?? [];
}

async function putTrack(client: PlayClient, pkg: string, editId: string, track: string, releases: Release[]): Promise<Track> {
  return client.request<Track>("publisher", `${editPath(pkg, editId)}/tracks/${seg(track)}`, {
    method: "PUT",
    json: { track, releases },
  });
}

const sameCodes = (a: Release, b: Release) =>
  [...(a.versionCodes ?? [])].sort().join(",") === [...(b.versionCodes ?? [])].sort().join(",");

/**
 * Adds `next` to a track's existing releases without throwing away the ones that must
 * stay. A staged rollout keeps the completed release still serving everyone else; a
 * completed release supersedes the live ones; drafts are left alone unless replaced.
 */
export function mergeRelease(existing: Release[], next: Release): Release[] {
  const others = existing.filter((r) => !sameCodes(r, next));
  let kept: Release[];
  switch (next.status) {
    case "completed":
      kept = others.filter((r) => r.status === "draft");
      break;
    case "inProgress":
    case "halted":
      kept = others.filter((r) => r.status === "completed" || r.status === "draft");
      break;
    default:
      kept = others.filter((r) => r.status !== "draft");
  }
  return [...kept, next];
}

export function buildRelease(opts: {
  versionCodes: (string | number)[];
  status: ReleaseStatus;
  rolloutPercentage?: number;
  releaseNotes?: { language: string; text: string }[];
  name?: string;
}): Release {
  const fraction = rolloutFraction(opts.status, opts.rolloutPercentage);
  return {
    ...(opts.name ? { name: opts.name } : {}),
    versionCodes: opts.versionCodes.map(String),
    status: opts.status,
    ...(fraction !== undefined ? { userFraction: fraction } : {}),
    ...(opts.releaseNotes?.length ? { releaseNotes: opts.releaseNotes } : {}),
  };
}

async function applyRelease(client: PlayClient, pkg: string, editId: string, track: string, release: Release) {
  const before = (await getTrack(client, pkg, editId, track)).releases ?? [];
  const releases = mergeRelease(before, release);
  const after = await putTrack(client, pkg, editId, track, releases);
  return { track, before: before.map(summarizeRelease), after: (after?.releases ?? releases).map(summarizeRelease) };
}

export function summarizeRelease(r: Release) {
  return {
    name: r.name,
    status: r.status,
    version_codes: r.versionCodes ?? [],
    rollout_percentage:
      r.userFraction !== undefined ? Math.round(r.userFraction * 100_000) / 1000 : r.status === "completed" ? 100 : undefined,
    halted: r.status === "halted",
    release_notes_languages: (r.releaseNotes ?? []).map((n) => n.language),
  };
}

export function summarizeTracks(tracks: Track[]) {
  return tracks.map((t) => {
    const releases = (t.releases ?? []).map(summarizeRelease);
    const codes = releases.flatMap((r) => r.version_codes.map(Number));
    return {
      track: t.track,
      highest_version_code: codes.length ? Math.max(...codes) : undefined,
      releases,
    };
  });
}

/** The release a rollout tool acts on: the one in `status` on that track. */
function findRelease(track: Track, statuses: ReleaseStatus[]): Release {
  const found = (track.releases ?? []).find((r) => r.status && statuses.includes(r.status));
  if (!found) {
    const present = (track.releases ?? []).map((r) => r.status).join(", ") || "none";
    throw new SafetyError(`Track ${track.track} has no ${statuses.join("/")} release (releases present: ${present}).`);
  }
  return found;
}

/** Edits the single matching release on a track in place, under the production gate. */
async function modifyRollout(
  ctx: ToolContext,
  args: {
    package_name?: string;
    track: string;
    validate_only?: boolean;
    confirm_production?: boolean;
    changes_not_sent_for_review?: boolean;
  },
  from: ReleaseStatus[],
  change: (r: Release) => Release,
) {
  const pkg = ctx.pkg(args.package_name);
  const decision = decideDryRun([args.track], args.confirm_production, args.validate_only);
  const outcome = await withEdit(
    ctx.client,
    pkg,
    async (editId) => {
      const track = await getTrack(ctx.client, pkg, editId, args.track);
      const target = findRelease(track, from);
      return applyRelease(ctx.client, pkg, editId, args.track, change(target));
    },
    { validateOnly: decision.dryRun, changesNotSentForReview: args.changes_not_sent_for_review },
  );
  return editResult(outcome, decision.forcedReason);
}

// Tools -----------------------------------------------------------------------

export const releaseTools = [
  defineTool({
    name: "list_tracks",
    title: "List tracks",
    description: "Lists the app's tracks and how many releases each has.",
    kind: "read",
    input: { ...packageArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const tracks = await withReadEdit(ctx.client, pkg, (editId) => listTracks(ctx.client, pkg, editId));
      return tracks.map((t) => ({ track: t.track, releases: t.releases?.length ?? 0 }));
    },
  }),

  defineTool({
    name: "get_track",
    title: "Get track",
    description: "Returns one track with its full release objects, as Google reports them.",
    kind: "read",
    input: { ...packageArg, track: trackName },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return withReadEdit(ctx.client, pkg, (editId) => getTrack(ctx.client, pkg, editId, args.track));
    },
  }),

  defineTool({
    name: "list_releases",
    title: "List releases",
    description: "Lists releases on one track, or on every track when no track is given.",
    kind: "read",
    input: { ...packageArg, track: trackName.optional() },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return withReadEdit(ctx.client, pkg, async (editId) => {
        const tracks = args.track ? [await getTrack(ctx.client, pkg, editId, args.track)] : await listTracks(ctx.client, pkg, editId);
        return tracks.flatMap((t) => (t.releases ?? []).map((r) => ({ track: t.track, ...r })));
      });
    },
  }),

  defineTool({
    name: "release_status",
    title: "Release status",
    description:
      "One call, every track: each release's version codes, status, rollout percentage and halted flag, plus the highest version code per track.",
    kind: "read",
    input: { ...packageArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const tracks = await withReadEdit(ctx.client, pkg, (editId) => listTracks(ctx.client, pkg, editId));
      return { package_name: pkg, tracks: summarizeTracks(tracks) };
    },
  }),

  defineTool({
    name: "create_release",
    title: "Create release",
    description:
      "Creates a release of already-uploaded version codes on a track. Keeps the track's other releases that must stay (e.g. the completed release during a staged rollout). Production requires confirm_production: true, otherwise this is a dry run.",
    kind: "write",
    input: {
      ...packageArg,
      track: trackName,
      version_codes: z.array(versionCode).min(1).describe("Version codes to release."),
      status: statusArg,
      rollout_percentage: rolloutArg,
      release_notes: releaseNotesArg,
      release_name: z.string().max(50).optional().describe("Release name shown in Play Console."),
      ...validateOnlyArg,
      ...productionArgs,
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const release = buildRelease({
        versionCodes: args.version_codes,
        status: args.status,
        rolloutPercentage: args.rollout_percentage,
        releaseNotes: args.release_notes,
        name: args.release_name,
      });
      const decision = decideDryRun([args.track], args.confirm_production, args.validate_only);
      const outcome = await withEdit(ctx.client, pkg, (editId) => applyRelease(ctx.client, pkg, editId, args.track, release), {
        validateOnly: decision.dryRun,
        changesNotSentForReview: args.changes_not_sent_for_review,
      });
      return editResult(outcome, decision.forcedReason);
    },
  }),

  defineTool({
    name: "deploy",
    title: "Deploy",
    description:
      "Uploads an .aab, optionally its mapping.txt, and creates the release with notes — all in ONE edit, so a failure at any step leaves nothing half-done. With validate_only (or on production without confirm_production) the bundle is uploaded into a throwaway edit, validated and discarded.",
    kind: "write",
    input: {
      ...packageArg,
      file_path: z.string().describe("Path to the .aab file."),
      mapping_file_path: z.string().optional().describe("Optional path to mapping.txt for the new version code."),
      track: trackName,
      status: statusArg,
      rollout_percentage: rolloutArg,
      release_notes: releaseNotesArg,
      release_name: z.string().max(50).optional(),
      ...validateOnlyArg,
      ...productionArgs,
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      // Check everything local before opening an edit.
      rolloutFraction(args.status, args.rollout_percentage);
      const bundleFile = await readBundle(ctx, args.file_path);
      const mappingFile = args.mapping_file_path ? await readMapping(ctx, args.mapping_file_path) : undefined;
      const decision = decideDryRun([args.track], args.confirm_production, args.validate_only);

      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => {
          const bundle = await uploadBundleToEdit(ctx.client, pkg, editId, bundleFile.data);
          if (mappingFile) await uploadMappingToEdit(ctx.client, pkg, editId, bundle.versionCode, mappingFile.data);
          const release = buildRelease({
            versionCodes: [bundle.versionCode],
            status: args.status,
            rolloutPercentage: args.rollout_percentage,
            releaseNotes: args.release_notes,
            name: args.release_name,
          });
          const applied = await applyRelease(ctx.client, pkg, editId, args.track, release);
          return { bundle, mapping_uploaded: mappingFile !== undefined, ...applied };
        },
        { validateOnly: decision.dryRun, changesNotSentForReview: args.changes_not_sent_for_review },
      );
      return editResult(outcome, decision.forcedReason);
    },
  }),

  defineTool({
    name: "promote_release",
    title: "Promote release",
    description:
      "Copies a release from one track to another (e.g. internal → production). The destination's other releases that must stay are kept, not replaced. Promoting into production requires confirm_production: true, otherwise this is a dry run.",
    kind: "write",
    input: {
      ...packageArg,
      from_track: trackName,
      to_track: trackName,
      version_codes: z
        .array(versionCode)
        .min(1)
        .optional()
        .describe("Which release to promote, by version codes. Default: the source track's in-progress release, else its completed one."),
      status: statusArg,
      rollout_percentage: rolloutArg,
      release_notes: releaseNotesArg.describe("Release notes for the destination. Default: copied from the source release."),
      release_name: z.string().max(50).optional(),
      ...validateOnlyArg,
      ...productionArgs,
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      rolloutFraction(args.status, args.rollout_percentage);
      const decision = decideDryRun([args.to_track], args.confirm_production, args.validate_only);
      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => {
          const source = await getTrack(ctx.client, pkg, editId, args.from_track);
          let picked: Release | undefined;
          if (args.version_codes) {
            const wanted: Release = { versionCodes: args.version_codes.map(String) };
            picked = (source.releases ?? []).find((r) => sameCodes(r, wanted));
            if (!picked) throw new SafetyError(`No release with version codes ${wanted.versionCodes?.join(", ")} on ${args.from_track}.`);
          } else {
            picked = findRelease(source, ["inProgress", "completed", "halted", "draft"]);
            const inProgress = (source.releases ?? []).find((r) => r.status === "inProgress");
            if (inProgress) picked = inProgress;
          }
          const release = buildRelease({
            versionCodes: picked.versionCodes ?? [],
            status: args.status,
            rolloutPercentage: args.rollout_percentage,
            releaseNotes: args.release_notes ?? picked.releaseNotes,
            name: args.release_name ?? picked.name,
          });
          return { from_track: args.from_track, ...(await applyRelease(ctx.client, pkg, editId, args.to_track, release)) };
        },
        { validateOnly: decision.dryRun, changesNotSentForReview: args.changes_not_sent_for_review },
      );
      return editResult(outcome, decision.forcedReason);
    },
  }),

  defineTool({
    name: "update_rollout",
    title: "Update rollout",
    description:
      "Changes the percentage of a staged (inProgress) rollout, or completes it to 100% with complete: true. On production this requires confirm_production: true, otherwise it is a dry run.",
    kind: "write",
    idempotent: true,
    input: {
      ...packageArg,
      track: trackName,
      rollout_percentage: rolloutArg.describe("New percentage (0 < x < 100). Omit when complete is true."),
      complete: z.boolean().optional().describe("Roll out to 100% and mark the release completed."),
      ...validateOnlyArg,
      ...productionArgs,
    },
    async handler(args, ctx) {
      if ((args.rollout_percentage === undefined) === (args.complete !== true)) {
        throw new SafetyError("Give exactly one of rollout_percentage or complete: true.");
      }
      return modifyRollout(ctx, args, ["inProgress"], (r) => {
        if (args.complete) {
          const { userFraction: _drop, ...rest } = r;
          return { ...rest, status: "completed" };
        }
        return { ...r, userFraction: rolloutFraction("inProgress", args.rollout_percentage) };
      });
    },
  }),

  defineTool({
    name: "halt_rollout",
    title: "Halt rollout",
    description:
      "Halts a staged rollout: no new users get the release (existing installs keep it). On production this requires confirm_production: true, otherwise it is a dry run.",
    kind: "write",
    idempotent: true,
    input: { ...packageArg, track: trackName, ...validateOnlyArg, ...productionArgs },
    async handler(args, ctx) {
      return modifyRollout(ctx, args, ["inProgress"], (r) => ({ ...r, status: "halted" }));
    },
  }),

  defineTool({
    name: "resume_rollout",
    title: "Resume rollout",
    description:
      "Resumes a halted rollout at the percentage you give (required — the previous percentage is not assumed). On production this requires confirm_production: true, otherwise it is a dry run.",
    kind: "write",
    idempotent: true,
    input: {
      ...packageArg,
      track: trackName,
      rollout_percentage: z.number().gt(0).lt(100).describe("Percentage to resume at, e.g. 20."),
      ...validateOnlyArg,
      ...productionArgs,
    },
    async handler(args, ctx) {
      return modifyRollout(ctx, args, ["halted"], (r) => ({
        ...r,
        status: "inProgress",
        userFraction: rolloutFraction("inProgress", args.rollout_percentage),
      }));
    },
  }),
];
