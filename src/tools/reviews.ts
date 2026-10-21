import { z } from "zod";
import { appPath, seg, type PlayClient } from "../google/client.js";
import { SafetyError } from "../safety.js";
import { defineTool, languageCode, packageArg } from "./common.js";

export const REPLY_MAX_CHARS = 350;

const RECENT_ONLY_NOTE =
  "The Play API only returns reviews created or edited in about the last week; older reviews are visible only in Play Console.";

interface Review {
  reviewId: string;
  authorName?: string;
  comments?: {
    userComment?: {
      text?: string;
      starRating?: number;
      reviewerLanguage?: string;
      lastModified?: { seconds?: string };
      appVersionCode?: number;
      appVersionName?: string;
      device?: string;
    };
    developerComment?: { text?: string; lastModified?: { seconds?: string } };
  }[];
}

const toIso = (t: { seconds?: string } | undefined) => (t?.seconds ? new Date(Number(t.seconds) * 1000).toISOString() : undefined);

export function simplifyReview(r: Review) {
  const user = r.comments?.find((c) => c.userComment)?.userComment;
  const dev = r.comments?.find((c) => c.developerComment)?.developerComment;
  return {
    review_id: r.reviewId,
    author: r.authorName,
    star_rating: user?.starRating,
    language: user?.reviewerLanguage,
    text: user?.text?.trim(),
    last_modified: toIso(user?.lastModified),
    app_version_code: user?.appVersionCode,
    app_version_name: user?.appVersionName,
    device: user?.device,
    answered: dev !== undefined,
    reply: dev ? { text: dev.text, last_modified: toIso(dev.lastModified) } : undefined,
  };
}

export interface ReviewFilter {
  starRatings?: number[];
  language?: string;
  unansweredOnly?: boolean;
}

export function matchesFilter(r: ReturnType<typeof simplifyReview>, f: ReviewFilter): boolean {
  if (f.starRatings?.length && (r.star_rating === undefined || !f.starRatings.includes(r.star_rating))) return false;
  if (f.language && !(r.language ?? "").toLowerCase().startsWith(f.language.toLowerCase())) return false;
  if (f.unansweredOnly && r.answered) return false;
  return true;
}

/** Pages through every review the API will return (it only keeps about a week). */
export async function fetchReviews(client: PlayClient, pkg: string, translationLanguage?: string, maxPages = 20) {
  const all: Review[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.request<{ reviews?: Review[]; tokenPagination?: { nextPageToken?: string } }>(
      "publisher",
      `${appPath(pkg)}/reviews`,
      { query: { maxResults: 100, token, translationLanguage } },
    );
    all.push(...(res?.reviews ?? []));
    token = res?.tokenPagination?.nextPageToken;
    if (!token) break;
  }
  return all.map(simplifyReview);
}

export const reviewTools = [
  defineTool({
    name: "list_reviews",
    title: "List reviews",
    description: `Lists recent reviews, filterable by star rating, language and unanswered-only. ${RECENT_ONLY_NOTE}`,
    kind: "read",
    input: {
      ...packageArg,
      star_ratings: z.array(z.number().int().min(1).max(5)).optional().describe("Only these star ratings, e.g. [1, 2]."),
      language: z.string().max(20).optional().describe("Only reviews in this language (prefix match, e.g. en or en-US)."),
      unanswered_only: z.boolean().optional().describe("Only reviews without a developer reply."),
      translation_language: languageCode.optional().describe("Ask Google to translate review text into this language."),
      limit: z.number().int().min(1).max(1000).optional().describe("Maximum reviews returned (default 100)."),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const all = await fetchReviews(ctx.client, pkg, args.translation_language);
      const filtered = all.filter((r) =>
        matchesFilter(r, { starRatings: args.star_ratings, language: args.language, unansweredOnly: args.unanswered_only }),
      );
      return {
        note: RECENT_ONLY_NOTE,
        total_returned_by_api: all.length,
        matching: filtered.length,
        reviews: filtered.slice(0, args.limit ?? 100),
      };
    },
  }),

  defineTool({
    name: "get_review",
    title: "Get review",
    description: "Returns one review with any developer reply.",
    kind: "read",
    input: {
      ...packageArg,
      review_id: z.string().min(1),
      translation_language: languageCode.optional(),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const r = await ctx.client.request<Review>("publisher", `${appPath(pkg)}/reviews/${seg(args.review_id)}`, {
        query: { translationLanguage: args.translation_language },
      });
      return simplifyReview(r);
    },
  }),

  defineTool({
    name: "reply_to_review",
    title: "Reply to review",
    description: `Posts a PUBLIC developer reply to a review (replacing any earlier reply). Max ${REPLY_MAX_CHARS} characters. Use dry_run to preview without posting.`,
    kind: "write",
    idempotent: true,
    input: {
      ...packageArg,
      review_id: z.string().min(1),
      reply_text: z.string().min(1).describe(`Reply text, at most ${REPLY_MAX_CHARS} characters.`),
      dry_run: z.boolean().optional().describe("Preview only: check the reply and show the review, post nothing."),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const length = [...args.reply_text].length;
      if (length > REPLY_MAX_CHARS) {
        throw new SafetyError(`Reply is ${length} characters; Google's limit is ${REPLY_MAX_CHARS}.`);
      }
      const path = `${appPath(pkg)}/reviews/${seg(args.review_id)}`;
      if (args.dry_run) {
        const review = simplifyReview(await ctx.client.request<Review>("publisher", path));
        return { dry_run: true, would_post: args.reply_text, characters: length, review };
      }
      const res = await ctx.client.request("publisher", `${path}:reply`, {
        method: "POST",
        json: { replyText: args.reply_text },
      });
      return { dry_run: false, posted: true, characters: length, result: res };
    },
  }),
];
