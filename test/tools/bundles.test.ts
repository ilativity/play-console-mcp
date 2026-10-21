import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakePlay, connect, testConfig } from "../helpers.js";

async function file(name: string, size = 64): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pcm-b-"));
  const p = join(dir, name);
  await writeFile(p, new Uint8Array(size));
  return p;
}

describe("bundles", () => {
  it("list_bundles reads through a throwaway edit", async () => {
    const fake = new FakePlay().on("GET", /edits\/[^/]+\/bundles$/, { json: { bundles: [{ versionCode: 3 }] } });
    const h = await connect(fake);
    expect(await h.call("list_bundles")).toEqual({ bundles: [{ versionCode: 3 }] });
    expect(fake.openEdits.size).toBe(0);
  });

  it("upload_bundle uploads to the upload host and commits", async () => {
    const fake = new FakePlay();
    const h = await connect(fake);
    const res = await h.call("upload_bundle", { file_path: await file("a.aab") });
    expect(res).toMatchObject({ committed: true, result: { bundle: { versionCode: 100 } } });
    const up = fake.find("POST", /bundles$/)[0]!;
    expect(up.url.pathname).toMatch(/^\/upload\//);
    expect(up.bytes).toBe(64);
  });

  it("upload_bundle validate_only discards the edit", async () => {
    const fake = new FakePlay();
    const h = await connect(fake);
    const res = await h.call("upload_bundle", { file_path: await file("a.aab"), validate_only: true });
    expect(res.dry_run).toBe(true);
    expect(fake.committed).toHaveLength(0);
  });

  it("upload_bundle refuses non-.aab files and files outside PLAY_MCP_FILE_ROOT", async () => {
    const fake = new FakePlay();
    const p = await file("secret.json");
    let h = await connect(fake);
    expect(await h.callError("upload_bundle", { file_path: p })).toMatch(/extensions/);
    const outside = await file("a.aab");
    const root = await mkdtemp(join(tmpdir(), "pcm-root-"));
    h = await connect(fake, testConfig({ fileRoot: root }));
    expect(await h.callError("upload_bundle", { file_path: outside })).toMatch(/outside PLAY_MCP_FILE_ROOT/);
    expect(fake.calls).toHaveLength(0);
  });

  it("upload_deobfuscation_file targets the version code", async () => {
    const fake = new FakePlay().on("POST", /apks\/42\/deobfuscationFiles\/proguard$/, { json: { deobfuscationFile: {} } });
    const h = await connect(fake);
    const res = await h.call("upload_deobfuscation_file", { version_code: 42, file_path: await file("mapping.txt") });
    expect(res.committed).toBe(true);
  });

  it("upload_internal_sharing picks the bundle or apk endpoint", async () => {
    const fake = new FakePlay()
      .on("POST", /internalappsharing\/com\.example\.app\/artifacts\/bundle$/, { json: { downloadUrl: "https://play.google.com/x" } })
      .on("POST", /internalappsharing\/com\.example\.app\/artifacts\/apk$/, { json: { downloadUrl: "https://play.google.com/y" } });
    const h = await connect(fake);
    expect((await h.call("upload_internal_sharing", { file_path: await file("a.aab") })).artifact.downloadUrl).toMatch(/x$/);
    expect((await h.call("upload_internal_sharing", { file_path: await file("a.apk") })).artifact.downloadUrl).toMatch(/y$/);
  });
});
