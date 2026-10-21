import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SafetyError,
  annotationsFor,
  assertDestructiveAllowed,
  decideDryRun,
  isProductionTrack,
  resolveUploadFile,
  rolloutFraction,
  shouldRegister,
} from "../src/safety.js";

describe("registration gate", () => {
  it("read-only registers only read tools", () => {
    const cfg = { readOnly: true, allowDestructive: true };
    expect(shouldRegister("read", cfg)).toBe(true);
    expect(shouldRegister("write", cfg)).toBe(false);
    expect(shouldRegister("destructive", cfg)).toBe(false);
  });

  it("writes are on by default; destructive needs the opt-in", () => {
    expect(shouldRegister("write", { readOnly: false, allowDestructive: false })).toBe(true);
    expect(shouldRegister("destructive", { readOnly: false, allowDestructive: false })).toBe(false);
    expect(shouldRegister("destructive", { readOnly: false, allowDestructive: true })).toBe(true);
  });

  it("assertDestructiveAllowed refuses without the opt-in", () => {
    expect(() => assertDestructiveAllowed({ allowDestructive: false }, "X")).toThrow(/PLAY_MCP_ALLOW_DESTRUCTIVE/);
    expect(() => assertDestructiveAllowed({ allowDestructive: true }, "X")).not.toThrow();
  });
});

describe("annotations", () => {
  it("marks kinds", () => {
    expect(annotationsFor("read")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(annotationsFor("write")).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(annotationsFor("destructive", true)).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });
});

describe("production gate", () => {
  it("recognises production tracks, including form-factor ones", () => {
    expect(isProductionTrack("production")).toBe(true);
    expect(isProductionTrack("wear:production")).toBe(true);
    expect(isProductionTrack("internal")).toBe(false);
    expect(isProductionTrack("production-like")).toBe(false);
  });

  it("forces a dry run on production without confirm_production", () => {
    const d = decideDryRun(["production"], undefined, false);
    expect(d.dryRun).toBe(true);
    expect(d.forcedReason).toMatch(/confirm_production/);
    expect(decideDryRun(["production"], false, undefined).dryRun).toBe(true);
  });

  it("lets a confirmed production write through, still honouring validate_only", () => {
    expect(decideDryRun(["production"], true, false)).toEqual({ dryRun: false });
    expect(decideDryRun(["production"], true, true)).toEqual({ dryRun: true });
  });

  it("does not gate non-production tracks", () => {
    expect(decideDryRun(["internal"], undefined, undefined)).toEqual({ dryRun: false });
    expect(decideDryRun(["beta"], undefined, true)).toEqual({ dryRun: true });
  });
});

describe("rollout gate", () => {
  it("rejects inProgress without a percentage — never a silent 100%", () => {
    expect(() => rolloutFraction("inProgress", undefined)).toThrow(SafetyError);
    expect(() => rolloutFraction("inProgress", undefined)).toThrow(/required/);
  });

  it.each([0, 100, -5, 150])("rejects out-of-range %s", (p) => {
    expect(() => rolloutFraction("inProgress", p)).toThrow(SafetyError);
  });

  it("converts a percentage to a fraction", () => {
    expect(rolloutFraction("inProgress", 10)).toBe(0.1);
    expect(rolloutFraction("inProgress", 12.5)).toBe(0.125);
  });

  it("refuses a percentage on completed/draft", () => {
    expect(rolloutFraction("completed", undefined)).toBeUndefined();
    expect(() => rolloutFraction("completed", 50)).toThrow(/only applies/);
    expect(() => rolloutFraction("draft", 50)).toThrow(/only applies/);
  });
});

describe("file confinement", () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "pcm-"));
    const root = join(dir, "root");
    await mkdir(root);
    await writeFile(join(root, "app.aab"), "aab");
    await writeFile(join(dir, "outside.aab"), "aab");
    await writeFile(join(dir, "key.json"), "{}");
    return { dir, root };
  }

  it("accepts an allowed file under the root", async () => {
    const { root } = await setup();
    const r = await resolveUploadFile(join(root, "app.aab"), { extensions: [".aab"], fileRoot: root });
    expect(r.size).toBe(3);
  });

  it("rejects wrong extensions and missing files", async () => {
    const { dir } = await setup();
    await expect(resolveUploadFile(join(dir, "key.json"), { extensions: [".aab"] })).rejects.toThrow(/extensions/);
    await expect(resolveUploadFile(join(dir, "nope.aab"), { extensions: [".aab"] })).rejects.toThrow(/not found/);
  });

  it("rejects files outside PLAY_MCP_FILE_ROOT, including via ..", async () => {
    const { root } = await setup();
    await expect(resolveUploadFile(join(root, "..", "outside.aab"), { extensions: [".aab"], fileRoot: root })).rejects.toThrow(
      /outside PLAY_MCP_FILE_ROOT/,
    );
  });

  it("enforces the size cap", async () => {
    const { root } = await setup();
    await expect(resolveUploadFile(join(root, "app.aab"), { extensions: [".aab"], maxBytes: 2 })).rejects.toThrow(/limit/);
  });

  it("a symlink cannot escape the root or disguise a key file", async (ctx) => {
    const { dir, root } = await setup();
    try {
      await symlink(join(dir, "outside.aab"), join(root, "link.aab"));
      await symlink(join(dir, "key.json"), join(root, "key.aab"));
    } catch {
      ctx.skip(); // creating symlinks needs privileges on Windows
    }
    await expect(resolveUploadFile(join(root, "link.aab"), { extensions: [".aab"], fileRoot: root })).rejects.toThrow(/outside/);
    await expect(resolveUploadFile(join(root, "key.aab"), { extensions: [".aab"] })).rejects.toThrow(/allowed extension/);
  });
});
