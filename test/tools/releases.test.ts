import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { mergeRelease } from "../../src/tools/releases.js";
import { FakePlay, connect, type Harness } from "../helpers.js";

let fake: FakePlay;
let h: Harness;

beforeEach(async () => {
  fake = new FakePlay();
  fake.tracks = {
    production: [{ versionCodes: ["10"], status: "completed", name: "1.0" }],
    internal: [{ versionCodes: ["11"], status: "completed", name: "1.1", releaseNotes: [{ language: "en-US", text: "Fixes" }] }],
  };
  h = await connect(fake);
});

async function aab(name = "app.aab"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pcm-rel-"));
  const p = join(dir, name);
  await writeFile(p, new Uint8Array(1024));
  return p;
}

describe("mergeRelease", () => {
  const completed = { versionCodes: ["1"], status: "completed" as const };
  const draft = { versionCodes: ["2"], status: "draft" as const };
  it("a staged rollout keeps the completed release serving everyone else", () => {
    const next = { versionCodes: ["3"], status: "inProgress" as const, userFraction: 0.1 };
    expect(mergeRelease([completed, draft], next)).toEqual([completed, draft, next]);
  });
  it("a completed release supersedes live ones but keeps drafts", () => {
    const next = { versionCodes: ["3"], status: "completed" as const };
    expect(mergeRelease([completed, draft, { versionCodes: ["4"], status: "inProgress" }], next)).toEqual([draft, next]);
  });
  it("replaces a release with the same version codes", () => {
    const next = { versionCodes: ["1"], status: "halted" as const };
    expect(mergeRelease([completed], next)).toEqual([next]);
  });
});

describe("read tools", () => {
  it("release_status summarises every track in one call", async () => {
    fake.tracks.beta = [
      { versionCodes: ["10"], status: "completed" },
      { versionCodes: ["12"], status: "halted", userFraction: 0.2 },
    ];
    const res = await h.call("release_status");
    const beta = res.tracks.find((t: { track: string }) => t.track === "beta");
    expect(beta.highest_version_code).toBe(12);
    expect(beta.releases[1]).toMatchObject({ version_codes: ["12"], rollout_percentage: 20, halted: true, status: "halted" });
    expect(beta.releases[0].rollout_percentage).toBe(100);
    expect(fake.openEdits.size).toBe(0);
  });

  it("list_tracks / get_track / list_releases", async () => {
    expect(await h.call("list_tracks")).toEqual([
      { track: "production", releases: 1 },
      { track: "internal", releases: 1 },
    ]);
    expect((await h.call("get_track", { track: "internal" })).releases[0].versionCodes).toEqual(["11"]);
    expect(await h.call("list_releases")).toHaveLength(2);
    expect(fake.committed).toHaveLength(0);
  });
});

describe("create_release", () => {
  it("creates a release on a testing track and commits", async () => {
    const res = await h.call("create_release", {
      track: "internal",
      version_codes: [12],
      status: "completed",
      release_notes: [{ language: "en-US", text: "New" }],
    });
    expect(res).toMatchObject({ dry_run: false, committed: true });
    expect(fake.tracks.internal).toEqual([{ versionCodes: ["12"], status: "completed", releaseNotes: [{ language: "en-US", text: "New" }] }]);
  });

  it("rejects inProgress without rollout_percentage before opening an edit", async () => {
    const err = await h.callError("create_release", { track: "internal", version_codes: [12], status: "inProgress" });
    expect(err).toMatch(/rollout_percentage is required/);
    expect(fake.calls).toHaveLength(0);
  });

  it("production without confirm_production is a dry run: previewed, nothing released", async () => {
    const before = structuredClone(fake.tracks);
    const res = await h.call("create_release", { track: "production", version_codes: [11], status: "inProgress", rollout_percentage: 5 });
    expect(res.dry_run).toBe(true);
    expect(res.committed).toBe(false);
    expect(res.production_guard).toMatch(/confirm_production/);
    expect(res.result.after.map((r: { version_codes: string[] }) => r.version_codes)).toEqual([["10"], ["11"]]);
    expect(fake.find("POST", /:commit$/)).toHaveLength(0);
    expect(fake.tracks).toEqual(before);
    expect(fake.openEdits.size).toBe(0);
  });

  it("production with confirm_production commits a staged rollout and keeps the completed release", async () => {
    const res = await h.call("create_release", {
      track: "production",
      version_codes: [11],
      status: "inProgress",
      rollout_percentage: 5,
      confirm_production: true,
    });
    expect(res).toMatchObject({ dry_run: false, committed: true });
    expect(res.production_guard).toBeUndefined();
    expect(fake.tracks.production).toEqual([
      { versionCodes: ["10"], status: "completed", name: "1.0" },
      { versionCodes: ["11"], status: "inProgress", userFraction: 0.05 },
    ]);
  });

  it("validate_only never commits even with confirm_production", async () => {
    const res = await h.call("create_release", {
      track: "production",
      version_codes: [11],
      status: "completed",
      confirm_production: true,
      validate_only: true,
    });
    expect(res.dry_run).toBe(true);
    expect(fake.committed).toHaveLength(0);
  });

  it("form-factor production tracks are gated too", async () => {
    const res = await h.call("create_release", { track: "wear:production", version_codes: [11], status: "completed" });
    expect(res.dry_run).toBe(true);
    expect(res.production_guard).toBeDefined();
  });
});

describe("promote_release", () => {
  it("keeps the destination's completed release instead of replacing it, and copies notes", async () => {
    const res = await h.call("promote_release", {
      from_track: "internal",
      to_track: "production",
      status: "inProgress",
      rollout_percentage: 10,
      confirm_production: true,
    });
    expect(res.committed).toBe(true);
    expect(fake.tracks.production).toEqual([
      { versionCodes: ["10"], status: "completed", name: "1.0" },
      { versionCodes: ["11"], status: "inProgress", userFraction: 0.1, name: "1.1", releaseNotes: [{ language: "en-US", text: "Fixes" }] },
    ]);
  });

  it("is a dry run into production without confirmation", async () => {
    const res = await h.call("promote_release", { from_track: "internal", to_track: "production", status: "completed" });
    expect(res.dry_run).toBe(true);
    expect(fake.tracks.production).toHaveLength(1);
  });

  it("promotes freely between testing tracks", async () => {
    const res = await h.call("promote_release", { from_track: "internal", to_track: "beta", status: "completed" });
    expect(res.committed).toBe(true);
    expect(fake.tracks.beta?.[0]?.versionCodes).toEqual(["11"]);
  });

  it("errors on an unknown version code", async () => {
    expect(
      await h.callError("promote_release", { from_track: "internal", to_track: "beta", version_codes: [99], status: "completed" }),
    ).toMatch(/No release with version codes 99/);
    expect(fake.openEdits.size).toBe(0);
  });
});

describe("rollout control", () => {
  beforeEach(() => {
    fake.tracks.production = [
      { versionCodes: ["10"], status: "completed" },
      { versionCodes: ["11"], status: "inProgress", userFraction: 0.05 },
    ];
  });

  it("update_rollout changes the percentage (with confirmation)", async () => {
    await h.call("update_rollout", { track: "production", rollout_percentage: 50, confirm_production: true });
    expect(fake.tracks.production?.[1]).toMatchObject({ versionCodes: ["11"], userFraction: 0.5 });
    expect(fake.tracks.production?.[0]).toMatchObject({ status: "completed", versionCodes: ["10"] });
  });

  it("update_rollout on production without confirmation is a preview", async () => {
    const res = await h.call("update_rollout", { track: "production", rollout_percentage: 50 });
    expect(res.dry_run).toBe(true);
    expect(fake.tracks.production?.[1]?.userFraction).toBe(0.05);
  });

  it("complete rolls out to 100% and supersedes the old completed release", async () => {
    await h.call("update_rollout", { track: "production", complete: true, confirm_production: true });
    expect(fake.tracks.production).toEqual([{ versionCodes: ["11"], status: "completed" }]);
  });

  it("needs exactly one of rollout_percentage / complete", async () => {
    expect(await h.callError("update_rollout", { track: "production" })).toMatch(/exactly one/);
    expect(await h.callError("update_rollout", { track: "production", complete: true, rollout_percentage: 5 })).toMatch(/exactly one/);
  });

  it("halt then resume (resume requires a percentage)", async () => {
    await h.call("halt_rollout", { track: "production", confirm_production: true });
    expect(fake.tracks.production?.[1]?.status).toBe("halted");
    expect(await h.callError("resume_rollout", { track: "production", confirm_production: true })).toMatch(/rollout_percentage/);
    await h.call("resume_rollout", { track: "production", rollout_percentage: 20, confirm_production: true });
    expect(fake.tracks.production?.[1]).toMatchObject({ status: "inProgress", userFraction: 0.2 });
    expect(fake.tracks.production?.[0]?.status).toBe("completed");
  });

  it("errors clearly when there is no staged rollout to change", async () => {
    expect(await h.callError("halt_rollout", { track: "internal" })).toMatch(/no inProgress release/);
    expect(fake.openEdits.size).toBe(0);
  });
});

describe("deploy", () => {
  it("uploads, releases and adds notes in ONE edit", async () => {
    const file = await aab();
    const res = await h.call("deploy", {
      file_path: file,
      track: "internal",
      status: "completed",
      release_notes: [{ language: "en-US", text: "Hi" }],
    });
    expect(res.committed).toBe(true);
    expect(res.result.bundle.versionCode).toBe(100);
    expect(fake.find("POST", /\/edits$/)).toHaveLength(1);
    expect(fake.committed).toEqual(["edit1"]);
    expect(fake.tracks.internal).toEqual([{ versionCodes: ["100"], status: "completed", releaseNotes: [{ language: "en-US", text: "Hi" }] }]);
  });

  it("uploads the mapping file for the new version code in the same edit", async () => {
    const file = await aab();
    const mapping = join(file, "..", "mapping.txt");
    await writeFile(mapping, "a -> b");
    fake.on("POST", /deobfuscationFiles\/proguard$/, { json: { deobfuscationFile: { symbolType: "proguard" } } });
    const res = await h.call("deploy", { file_path: file, mapping_file_path: mapping, track: "internal", status: "completed" });
    expect(res.result.mapping_uploaded).toBe(true);
    expect(fake.find("POST", /apks\/100\/deobfuscationFiles\/proguard$/)).toHaveLength(1);
  });

  it("a failure after the upload leaves nothing half-done", async () => {
    const file = await aab();
    fake.on("PUT", /tracks\/internal$/, { status: 400, json: { error: { message: "bad release" } } });
    expect(await h.callError("deploy", { file_path: file, track: "internal", status: "completed" })).toMatch(/bad release/);
    expect(fake.committed).toHaveLength(0);
    expect(fake.openEdits.size).toBe(0);
    expect(fake.tracks.internal?.[0]?.versionCodes).toEqual(["11"]);
  });

  it("validate_only uploads into a throwaway edit and changes nothing", async () => {
    const file = await aab();
    const res = await h.call("deploy", { file_path: file, track: "internal", status: "completed", validate_only: true });
    expect(res.dry_run).toBe(true);
    expect(fake.committed).toHaveLength(0);
    expect(fake.openEdits.size).toBe(0);
  });

  it("production without confirmation is a dry run", async () => {
    const file = await aab();
    const res = await h.call("deploy", { file_path: file, track: "production", status: "inProgress", rollout_percentage: 1 });
    expect(res.dry_run).toBe(true);
    expect(res.production_guard).toBeDefined();
    expect(fake.committed).toHaveLength(0);
  });

  it("checks the rollout and the file before opening an edit", async () => {
    const file = await aab();
    expect(await h.callError("deploy", { file_path: file, track: "internal", status: "inProgress" })).toMatch(/rollout_percentage/);
    expect(await h.callError("deploy", { file_path: file.replace(".aab", ".apk"), track: "internal", status: "completed" })).toMatch(
      /extensions/,
    );
    expect(await h.callError("deploy", { file_path: join(file, "..", "missing.aab"), track: "internal", status: "completed" })).toMatch(
      /not found/,
    );
    expect(fake.calls).toHaveLength(0);
  });
});
