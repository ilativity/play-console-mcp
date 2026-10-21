import { describe, expect, it } from "vitest";
import { FakePlay, connect } from "../helpers.js";

describe("apps", () => {
  it("list_apps pages through apps:search", async () => {
    const fake = new FakePlay().on("GET", /playdeveloperreporting\.googleapis\.com\/v1beta1\/apps:search$/, (c) =>
      c.url.searchParams.get("pageToken")
        ? { json: { apps: [{ packageName: "b.b", displayName: "B" }] } }
        : { json: { apps: [{ packageName: "a.a", displayName: "A" }], nextPageToken: "t" } },
    );
    const h = await connect(fake);
    const res = await h.call("list_apps");
    expect(res.apps).toEqual([
      { package_name: "a.a", display_name: "A" },
      { package_name: "b.b", display_name: "B" },
    ]);
  });

  it("app_overview combines releases, vitals and unanswered reviews; parts fail independently", async () => {
    const fake = new FakePlay();
    fake.tracks = { production: [{ versionCodes: ["5"], status: "completed" }] };
    fake
      .on("GET", /\/reviews$/, {
        json: {
          reviews: [
            { reviewId: "1", comments: [{ userComment: { starRating: 1 } }] },
            { reviewId: "2", comments: [{ userComment: { starRating: 4 } }] },
            { reviewId: "3", comments: [{ userComment: { starRating: 2 } }, { developerComment: { text: "hi" } }] },
          ],
        },
      })
      .on("GET", /MetricSet$/, { status: 403, json: { error: { message: "reporting denied" } } });
    const h = await connect(fake);
    const res = await h.call("app_overview");
    expect(res.releases[0]).toMatchObject({ track: "production", highest_version_code: 5 });
    expect(res.reviews).toMatchObject({ recent_total: 3, unanswered: 2, unanswered_low_rated: 1 });
    expect(res.vitals.metrics.crash.error).toMatch(/reporting denied/);
    expect(fake.openEdits.size).toBe(0);
  });
});
