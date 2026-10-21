import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakePlay, connect, testConfig } from "../helpers.js";

function listingApi() {
  return new FakePlay()
    .on("GET", /edits\/[^/]+\/listings$/, { json: { listings: [{ language: "en-US", title: "App" }] } })
    .on("GET", /edits\/[^/]+\/listings\/en-US$/, { json: { language: "en-US", title: "App" } })
    .on("PATCH", /edits\/[^/]+\/listings\/en-US$/, (c) => ({ json: { language: "en-US", ...(c.json as object) } }))
    .on("GET", /edits\/[^/]+\/details$/, { json: { defaultLanguage: "en-US" } })
    .on("PATCH", /edits\/[^/]+\/details$/, (c) => ({ json: c.json }))
    .on("GET", /listings\/en-US\/phoneScreenshots$/, { json: { images: [{ id: "i1" }] } })
    .on("POST", /listings\/en-US\/icon$/, { json: { image: { id: "new" } } })
    .on("DELETE", /listings\/en-US\/phoneScreenshots\/i1$/, { status: 204 })
    .on("DELETE", /listings\/en-US\/phoneScreenshots$/, { json: { deleted: [{ id: "i1" }] } })
    .on("DELETE", /listings\/en-US$/, { status: 204 });
}

describe("listing reads", () => {
  it("list_listings, get_listing, get_app_details, list_images", async () => {
    const fake = listingApi();
    const h = await connect(fake);
    expect((await h.call("list_listings")).listings).toHaveLength(1);
    expect((await h.call("get_listing", { language: "en-US" })).title).toBe("App");
    expect((await h.call("get_app_details")).defaultLanguage).toBe("en-US");
    expect((await h.call("list_images", { language: "en-US", image_type: "phoneScreenshots" })).images).toEqual([{ id: "i1" }]);
    expect(fake.committed).toHaveLength(0);
    expect(fake.openEdits.size).toBe(0);
  });
});

describe("listing writes", () => {
  it("update_listing patches only the given fields and returns before/after", async () => {
    const fake = listingApi();
    const h = await connect(fake);
    const res = await h.call("update_listing", { language: "en-US", short_description: "Short" });
    expect(fake.find("PATCH", /listings\/en-US$/)[0]!.json).toEqual({ shortDescription: "Short" });
    expect(res).toMatchObject({ committed: true, result: { before: { title: "App" }, after: { shortDescription: "Short" } } });
  });

  it("update_listing enforces Google's length limits in the schema", async () => {
    const h = await connect(listingApi());
    expect(await h.callError("update_listing", { language: "en-US", title: "x".repeat(31) })).toMatch(/30/);
  });

  it("update_listing refuses an empty update", async () => {
    const h = await connect(listingApi());
    expect(await h.callError("update_listing", { language: "en-US" })).toMatch(/Nothing to update/);
  });

  it("update_app_details validate_only discards", async () => {
    const fake = listingApi();
    const h = await connect(fake);
    const res = await h.call("update_app_details", { contact_email: "a@b.co", validate_only: true });
    expect(res.dry_run).toBe(true);
    expect(fake.committed).toHaveLength(0);
  });

  it("upload_image accepts png/jpg only, with the right content type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcm-img-"));
    await writeFile(join(dir, "icon.png"), new Uint8Array(10));
    await writeFile(join(dir, "icon.gif"), new Uint8Array(10));
    const fake = listingApi();
    const h = await connect(fake);
    await h.call("upload_image", { language: "en-US", image_type: "icon", file_path: join(dir, "icon.png") });
    expect(fake.find("POST", /icon$/)[0]!.headers["content-type"]).toBe("image/png");
    expect(await h.callError("upload_image", { language: "en-US", image_type: "icon", file_path: join(dir, "icon.gif") })).toMatch(
      /extensions/,
    );
  });

  it("destructive tools work when enabled", async () => {
    const fake = listingApi();
    const h = await connect(fake, testConfig({ allowDestructive: true }));
    await h.call("delete_image", { language: "en-US", image_type: "phoneScreenshots", image_id: "i1" });
    await h.call("delete_all_images", { language: "en-US", image_type: "phoneScreenshots" });
    await h.call("delete_listing", { language: "en-US" });
    expect(fake.committed).toHaveLength(3);
  });

  it("destructive tools are not callable by default", async () => {
    const h = await connect(listingApi());
    expect(await h.callError("delete_listing", { language: "en-US" })).toMatch(/not found/i);
  });
});
