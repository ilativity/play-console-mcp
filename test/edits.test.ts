import { describe, expect, it } from "vitest";
import { withEdit, withReadEdit } from "../src/google/edits.js";
import { FakePlay, PKG, testClient } from "./helpers.js";

describe("withEdit", () => {
  it("commits on success and leaves no open edit", async () => {
    const fake = new FakePlay();
    const out = await withEdit(testClient(fake), PKG, async () => "ok");
    expect(out).toMatchObject({ result: "ok", committed: true, dryRun: false });
    expect(fake.committed).toHaveLength(1);
    expect(fake.openEdits.size).toBe(0);
  });

  it("validate-only validates, then deletes, never commits", async () => {
    const fake = new FakePlay();
    const out = await withEdit(testClient(fake), PKG, async () => "ok", { validateOnly: true });
    expect(out).toMatchObject({ dryRun: true, committed: false });
    expect(fake.find("POST", /:validate$/)).toHaveLength(1);
    expect(fake.find("POST", /:commit$/)).toHaveLength(0);
    expect(fake.find("DELETE", /edits\/edit1$/)).toHaveLength(1);
    expect(fake.openEdits.size).toBe(0);
  });

  it("deletes the edit when the work throws", async () => {
    const fake = new FakePlay();
    await expect(
      withEdit(testClient(fake), PKG, async () => {
        throw new Error("upload failed");
      }),
    ).rejects.toThrow("upload failed");
    expect(fake.find("DELETE", /edits\/edit1$/)).toHaveLength(1);
    expect(fake.openEdits.size).toBe(0);
    expect(fake.committed).toHaveLength(0);
  });

  it("deletes the edit when the commit itself fails", async () => {
    const fake = new FakePlay();
    fake.failCommit = { status: 400, json: { error: { message: "Version code 5 has already been used." } } };
    await expect(withEdit(testClient(fake), PKG, async () => "ok")).rejects.toThrow(/already been used/);
    expect(fake.openEdits.size).toBe(0);
  });

  it("the original error wins even if the cleanup DELETE fails too", async () => {
    const fake = new FakePlay();
    fake.on("DELETE", /edits\/edit1$/, { status: 500 });
    await expect(
      withEdit(testClient(fake), PKG, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("passes changesNotSentForReview when asked", async () => {
    const fake = new FakePlay();
    const out = await withEdit(testClient(fake), PKG, async () => 1, { changesNotSentForReview: true });
    expect(fake.find("POST", /:commit$/)[0]!.url.searchParams.get("changesNotSentForReview")).toBe("true");
    expect(out.changesNotSentForReview).toBe(true);
  });

  it("managed publishing: retries the commit with changesNotSentForReview and says so", async () => {
    const fake = new FakePlay();
    let n = 0;
    fake.on("POST", /:commit$/, (c) => {
      n++;
      if (c.url.searchParams.get("changesNotSentForReview") === "true") return { json: {} };
      return {
        status: 400,
        json: { error: { message: "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true." } },
      };
    });
    const out = await withEdit(testClient(fake), PKG, async () => 1);
    expect(n).toBe(2);
    expect(out.committed).toBe(true);
    expect(out.changesNotSentForReview).toBe(true);
    expect(out.note).toMatch(/send for review/);
  });
});

describe("withReadEdit", () => {
  it("always deletes, on success and on failure", async () => {
    const fake = new FakePlay();
    await withReadEdit(testClient(fake), PKG, async () => 1);
    await expect(
      withReadEdit(testClient(fake), PKG, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(fake.find("DELETE", /edits\/edit\d$/)).toHaveLength(2);
    expect(fake.find("POST", /:commit$/)).toHaveLength(0);
    expect(fake.openEdits.size).toBe(0);
  });
});
