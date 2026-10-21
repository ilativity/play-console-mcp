import { describe, expect, it } from "vitest";
import { FakeFetch, connect } from "../helpers.js";

const review = (id: string, stars: number, lang: string, answered: boolean) => ({
  reviewId: id,
  authorName: "A",
  comments: [
    { userComment: { text: ` text ${id} `, starRating: stars, reviewerLanguage: lang, lastModified: { seconds: "1760000000" } } },
    ...(answered ? [{ developerComment: { text: "thanks", lastModified: { seconds: "1760000100" } } }] : []),
  ],
});

function reviewsApi() {
  return new FakeFetch().on("GET", /\/reviews$/, (c) =>
    c.url.searchParams.get("token") === "p2"
      ? { json: { reviews: [review("r3", 5, "he", false)] } }
      : { json: { reviews: [review("r1", 1, "en_US", false), review("r2", 2, "en_GB", true)], tokenPagination: { nextPageToken: "p2" } } },
  );
}

describe("reviews", () => {
  it("list_reviews pages through and filters by stars, language and unanswered", async () => {
    const fake = reviewsApi();
    const h = await connect(fake);
    const all = await h.call("list_reviews");
    expect(all.total_returned_by_api).toBe(3);
    expect(all.note).toMatch(/last week/);
    expect(all.reviews[0]).toMatchObject({ review_id: "r1", star_rating: 1, text: "text r1", answered: false });

    const low = await h.call("list_reviews", { star_ratings: [1, 2], unanswered_only: true });
    expect(low.reviews.map((r: { review_id: string }) => r.review_id)).toEqual(["r1"]);

    const en = await h.call("list_reviews", { language: "en" });
    expect(en.matching).toBe(2);
  });

  it("get_review simplifies one review", async () => {
    const fake = new FakeFetch().on("GET", /\/reviews\/r2$/, { json: review("r2", 2, "en", true) });
    const h = await connect(fake);
    expect(await h.call("get_review", { review_id: "r2" })).toMatchObject({ answered: true, reply: { text: "thanks" } });
  });

  it("reply_to_review enforces 350 characters before any request", async () => {
    const fake = new FakeFetch();
    const h = await connect(fake);
    expect(await h.callError("reply_to_review", { review_id: "r1", reply_text: "x".repeat(351) })).toMatch(/350/);
    expect(fake.calls).toHaveLength(0);
  });

  it("reply_to_review dry_run previews without posting", async () => {
    const fake = new FakeFetch().on("GET", /\/reviews\/r1$/, { json: review("r1", 1, "en", false) });
    const h = await connect(fake);
    const res = await h.call("reply_to_review", { review_id: "r1", reply_text: "Sorry!", dry_run: true });
    expect(res).toMatchObject({ dry_run: true, would_post: "Sorry!", review: { review_id: "r1" } });
    expect(fake.find("POST", /:reply$/)).toHaveLength(0);
  });

  it("reply_to_review posts the reply", async () => {
    const fake = new FakeFetch().on("POST", /\/reviews\/r1:reply$/, { json: { result: { replyText: "Sorry!" } } });
    const h = await connect(fake);
    const res = await h.call("reply_to_review", { review_id: "r1", reply_text: "Sorry!" });
    expect(res.posted).toBe(true);
    expect(fake.calls[0]!.json).toEqual({ replyText: "Sorry!" });
  });
});
