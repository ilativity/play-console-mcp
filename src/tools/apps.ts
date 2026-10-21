import { withReadEdit } from "../google/edits.js";
import { defineTool, packageArg } from "./common.js";
import { listTracks, summarizeTracks } from "./releases.js";
import { fetchReviews } from "./reviews.js";
import { vitalsSummary } from "./vitals.js";

interface ReportingApp {
  name?: string;
  packageName?: string;
  displayName?: string;
}

export const appsTools = [
  defineTool({
    name: "list_apps",
    title: "List apps",
    description:
      "Lists the apps this service account can see, according to its Play permissions (Play Developer Reporting API apps:search).",
    kind: "read",
    input: {},
    async handler(_args, ctx) {
      const apps: ReportingApp[] = [];
      let pageToken: string | undefined;
      do {
        const res = await ctx.client.request<{ apps?: ReportingApp[]; nextPageToken?: string }>("reporting", "/apps:search", {
          query: { pageSize: 1000, pageToken },
        });
        apps.push(...(res?.apps ?? []));
        pageToken = res?.nextPageToken;
      } while (pageToken);
      return {
        default_package: ctx.config.defaultPackage ?? null,
        apps: apps.map((a) => ({ package_name: a.packageName, display_name: a.displayName })),
      };
    },
  }),

  defineTool({
    name: "app_overview",
    title: "App overview",
    description:
      "\"How is my app doing\" in one call: release status on every track, the vitals summary against Google's thresholds, and the number of unanswered recent reviews. Each part reports its own error without failing the others.",
    kind: "read",
    input: { ...packageArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const settle = async <T>(p: Promise<T>) => {
        try {
          return await p;
        } catch (e) {
          return { error: (e as Error).message };
        }
      };
      const [releases, vitals, reviews] = await Promise.all([
        settle(withReadEdit(ctx.client, pkg, (editId) => listTracks(ctx.client, pkg, editId)).then(summarizeTracks)),
        settle(vitalsSummary(ctx.client, pkg)),
        settle(
          fetchReviews(ctx.client, pkg).then((all) => {
            const unanswered = all.filter((r) => !r.answered);
            return {
              recent_total: all.length,
              unanswered: unanswered.length,
              unanswered_low_rated: unanswered.filter((r) => (r.star_rating ?? 5) <= 2).length,
              note: "Recent = roughly the last week; that is all the API returns.",
            };
          }),
        ),
      ]);
      return { package_name: pkg, releases, vitals, reviews };
    },
  }),
];
