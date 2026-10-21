import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/server.js";
import { FakeFetch, connect, testConfig } from "./helpers.js";

const byKind = (kind: string) => ALL_TOOLS.filter((t) => t.kind === kind).map((t) => t.name);

describe("tool registration", () => {
  it("tool names are unique", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("default: read + write tools, no destructive ones", async () => {
    const h = await connect(new FakeFetch(), testConfig());
    const listed = (await h.client.listTools()).tools.map((t) => t.name);
    for (const n of [...byKind("read"), ...byKind("write")]) expect(listed).toContain(n);
    for (const n of byKind("destructive")) expect(listed).not.toContain(n);
  });

  it("read-only mode does not register a single write or destructive tool", async () => {
    const h = await connect(new FakeFetch(), testConfig({ readOnly: true, allowDestructive: true }));
    const tools = (await h.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(byKind("read").sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("PLAY_MCP_ALLOW_DESTRUCTIVE registers the destructive tools", async () => {
    const h = await connect(new FakeFetch(), testConfig({ allowDestructive: true }));
    const listed = (await h.client.listTools()).tools.map((t) => t.name);
    for (const n of ["delete_image", "delete_all_images", "delete_listing"]) expect(listed).toContain(n);
  });

  it("every tool carries all four annotations", async () => {
    const h = await connect(new FakeFetch(), testConfig({ allowDestructive: true }));
    for (const t of (await h.client.listTools()).tools) {
      expect(t.annotations, t.name).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: true,
      });
    }
  });

  it("includes every tool named in the spec", () => {
    const spec = [
      "list_tracks", "get_track", "list_releases", "release_status", "list_bundles", "upload_bundle",
      "upload_deobfuscation_file", "create_release", "deploy", "promote_release", "update_rollout",
      "halt_rollout", "resume_rollout", "upload_internal_sharing",
      "crash_rate", "anr_rate", "slow_start_rate", "slow_rendering_rate", "excessive_wakeup_rate",
      "stuck_wakelock_rate", "vitals_summary", "vitals_by_version", "search_error_issues",
      "search_error_reports", "list_anomalies", "vitals_freshness",
      "list_reviews", "get_review", "reply_to_review",
      "get_listing", "list_listings", "get_app_details", "list_images", "update_listing",
      "update_app_details", "upload_image", "delete_image", "delete_all_images", "delete_listing",
      "get_testers", "update_testers", "list_apps", "app_overview", "check_asset_links",
    ];
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(spec.sort());
  });
});

describe("errors", () => {
  it("returns Google's error body as an MCP error, without the token", async () => {
    const fake = new FakeFetch().on("GET", /reviews$/, { status: 403, json: { error: { code: 403, message: "no access" } } });
    const h = await connect(fake);
    const text = await h.callError("list_reviews", {});
    expect(text).toContain("no access");
    expect(text).not.toContain("test-token");
  });

  it("requires a package when there is no default", async () => {
    const h = await connect(new FakeFetch(), testConfig({ defaultPackage: undefined }));
    expect(await h.callError("release_status", {})).toMatch(/package_name is required/);
  });

  it("rejects an invalid package name before any request", async () => {
    const fake = new FakeFetch();
    const h = await connect(fake);
    expect(await h.callError("release_status", { package_name: "../../evil" })).toMatch(/valid Android package/);
    expect(fake.calls).toHaveLength(0);
  });
});
