import { describe, expect, it } from "vitest";
import { FakePlay, connect, testConfig } from "../helpers.js";

function withGroups() {
  const fake = new FakePlay();
  fake.testers = { internal: ["a@googlegroups.com", "b@googlegroups.com"] };
  return fake;
}

describe("testers", () => {
  it("get_testers", async () => {
    const h = await connect(withGroups());
    expect(await h.call("get_testers", { track: "internal" })).toEqual({
      track: "internal",
      google_groups: ["a@googlegroups.com", "b@googlegroups.com"],
    });
  });

  it("update_testers adds and removes, showing the diff", async () => {
    const fake = withGroups();
    const h = await connect(fake);
    const res = await h.call("update_testers", { track: "internal", add: ["c@googlegroups.com", "A@googlegroups.com"], remove: ["b@googlegroups.com"] });
    expect(res.result.diff).toEqual({
      added: ["c@googlegroups.com"],
      removed: ["b@googlegroups.com"],
      unchanged: ["a@googlegroups.com"],
    });
    expect(fake.testers.internal).toEqual(["a@googlegroups.com", "c@googlegroups.com"]);
  });

  it("validate_only shows the diff without changing anything", async () => {
    const fake = withGroups();
    const h = await connect(fake);
    const res = await h.call("update_testers", { track: "internal", add: ["c@googlegroups.com"], validate_only: true });
    expect(res.dry_run).toBe(true);
    expect(res.result.diff.added).toEqual(["c@googlegroups.com"]);
    expect(fake.testers.internal).toHaveLength(2);
  });

  it("replace counts as destructive", async () => {
    const fake = withGroups();
    let h = await connect(fake);
    expect(await h.callError("update_testers", { track: "internal", replace: ["z@googlegroups.com"] })).toMatch(/PLAY_MCP_ALLOW_DESTRUCTIVE/);
    expect(fake.calls).toHaveLength(0);

    h = await connect(fake, testConfig({ allowDestructive: true }));
    const res = await h.call("update_testers", { track: "internal", replace: ["z@googlegroups.com"] });
    expect(res.result.diff.removed).toHaveLength(2);
    expect(fake.testers.internal).toEqual(["z@googlegroups.com"]);
  });

  it("refuses an empty or mixed update", async () => {
    const h = await connect(withGroups(), testConfig({ allowDestructive: true }));
    expect(await h.callError("update_testers", { track: "internal" })).toMatch(/Nothing to change/);
    expect(await h.callError("update_testers", { track: "internal", add: ["c@googlegroups.com"], replace: [] })).toMatch(/either replace/);
  });
});
