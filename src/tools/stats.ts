import { z } from "zod";
import { GoogleApiError, seg } from "../google/client.js";
import {
  addMonths,
  lastDayOf,
  monthTotals,
  normaliseMonth,
  parseReportName,
  readReport,
  reportObjectName,
  type ParsedReport,
  type ReportKind,
  type ReportName,
  type ReportRow,
} from "../google/reports.js";
import { SafetyError } from "../safety.js";
import { defineTool, packageArg, type ToolContext } from "./common.js";

// Install and ratings statistics from Play's monthly bulk-report CSVs in the account's
// Cloud Storage bucket. Neither Play API serves install counts; these files are the only
// programmatic source. Registered only when PLAY_MCP_REPORTS_BUCKET is set.

const LIST_FIELDS = "items(name,size,updated),nextPageToken";
const MAX_LIST_PAGES = 20;
const PARALLEL_READS = 3;

const PERMISSION_HINT =
  "The service account needs Play Console → Users and permissions → <the service account> → Account permissions → \"View app information and download bulk reports\". A new grant can take hours (up to a day) to reach the bucket. If it is granted, check the server was restarted after PLAY_MCP_REPORTS_BUCKET was set, so its token carries the storage scope.";
const TOKEN_HINT =
  "Cloud Storage rejected the token itself (401), which is a credentials problem, not a Play permission: check the key or keyless login works for the other tools, then restart the server.";
const BUCKET_HINT =
  "Bucket not found: copy the URI again from Play Console → Manage account → Play apps reports → Statistics → \"Copy Cloud Storage URI\".";
const DELAY_NOTE = "Play posts these files with a 3–7 day delay, so the current month is partial.";

interface StorageObject {
  name: string;
  size?: string;
  updated?: string;
}

export interface ListedReport extends ReportName {
  object: string;
  updated?: string;
}

/** The listing, plus whether it stopped at the page cap (names sort oldest first, so the newest would be missing). */
export type Listing = ListedReport[] & { truncated?: boolean };

function bucketOf(ctx: ToolContext): string {
  const bucket = ctx.config.reportsBucket;
  if (!bucket) throw new SafetyError("PLAY_MCP_REPORTS_BUCKET is not set.");
  return bucket;
}

/** Adds the fix to a refusal from Cloud Storage; anything else passes through untouched. */
function withHint(e: unknown, notFoundHint?: string): unknown {
  if (!(e instanceof GoogleApiError)) return e;
  if (e.status === 401) return new Error(`${e.message}\n\n${TOKEN_HINT}`);
  if (e.status === 403) return new Error(`${e.message}\n\n${PERMISSION_HINT}`);
  if (e.status === 404 && notFoundHint) return new Error(`${e.message}\n\n${notFoundHint}`);
  return e;
}

/** Every report file of one kind for one package, from the bucket listing. */
export async function listReports(ctx: ToolContext, kind: ReportKind, pkg: string): Promise<Listing> {
  const bucket = bucketOf(ctx);
  const objects: StorageObject[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    let res: { items?: StorageObject[]; nextPageToken?: string } | undefined;
    try {
      res = await ctx.client.request("storage", `/b/${seg(bucket)}/o`, {
        query: { prefix: `stats/${kind}/${kind}_${pkg}_`, fields: LIST_FIELDS, pageToken },
      });
    } catch (e) {
      throw withHint(e, BUCKET_HINT);
    }
    objects.push(...(res?.items ?? []));
    pageToken = res?.nextPageToken;
    if (!pageToken) break;
  }
  const out: Listing = [];
  if (pageToken) out.truncated = true;
  for (const o of objects) {
    const parsed = parseReportName(o.name);
    // The prefix also matches a package that merely starts with this one (com.a vs com.a_b).
    if (parsed?.kind === kind && parsed.package === pkg) out.push({ ...parsed, object: o.name, updated: o.updated });
  }
  return out;
}

/** Downloads and parses one report; undefined when that file does not exist. */
async function fetchReport(
  ctx: ToolContext,
  kind: ReportKind,
  pkg: string,
  month: string,
  dimension: string,
): Promise<{ file: string; report: ParsedReport } | undefined> {
  const file = reportObjectName(kind, pkg, month, dimension);
  let res: Response;
  try {
    res = await ctx.client.raw("storage", `/b/${seg(bucketOf(ctx))}/o/${seg(file)}`, { query: { alt: "media" } });
  } catch (e) {
    if (e instanceof GoogleApiError && e.status === 404) return undefined;
    throw withHint(e);
  }
  return { file, report: readReport(new Uint8Array(await res.arrayBuffer()), dimension !== "overview") };
}

function summarise(items: ListedReport[]): { months: string[]; dimensions: string[]; files: number } {
  return {
    months: [...new Set(items.map((i) => i.month))].sort().reverse(),
    dimensions: [...new Set(items.map((i) => i.dimension))].sort(),
    files: items.length,
  };
}

function monthArg(value: string | undefined, name = "month"): string | undefined {
  if (value === undefined) return undefined;
  const m = normaliseMonth(value);
  if (!m) throw new SafetyError(`${name} must be YYYY-MM or YYYYMM, got ${JSON.stringify(value)}.`);
  return m;
}

function latestMonth(items: ListedReport[], dimension: string): string | undefined {
  return items
    .filter((i) => i.dimension === dimension)
    .map((i) => i.month)
    .sort()
    .at(-1);
}

function noReportError(kind: ReportKind, pkg: string, month: string | undefined, dimension: string, items: ListedReport[]): Error {
  const s = summarise(items);
  const what = month ? `No ${kind} report for ${pkg}, ${month}, dimension ${dimension}.` : `No ${kind} reports with dimension ${dimension} for ${pkg}.`;
  const have = items.length
    ? ` Months available: ${s.months.join(", ")}. Dimensions available: ${s.dimensions.join(", ")}.`
    : " The bucket has no reports for this package at all.";
  return new Error(`${what}${have} ${DELAY_NOTE}`);
}

/** Resolves the month to read (the newest for this dimension when not given) and reads it. */
async function readMonth(
  ctx: ToolContext,
  kind: ReportKind,
  pkg: string,
  monthInput: string | undefined,
  dimension: string,
): Promise<{ month: string; file: string; report: ParsedReport }> {
  let month = monthArg(monthInput);
  let listing: ListedReport[] | undefined;
  if (!month) {
    listing = await listReports(ctx, kind, pkg);
    month = latestMonth(listing, dimension);
    if (!month) throw noReportError(kind, pkg, undefined, dimension, listing);
  }
  const got = await fetchReport(ctx, kind, pkg, month, dimension);
  if (!got) throw noReportError(kind, pkg, month, dimension, listing ?? (await listReports(ctx, kind, pkg)));
  return { month, ...got };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** True while Play may still add days: the current month, or one whose last day isn't in yet. */
function isPartial(month: string, lastDate: string | undefined): boolean {
  return month >= currentMonth() || !lastDate || lastDate < lastDayOf(month);
}

const byDate = (a: ReportRow, b: ReportRow) => a.date.localeCompare(b.date);

function lastDateOf(rows: ReportRow[]): string | undefined {
  return rows.map((r) => r.date).sort().at(-1);
}

function groupByValue(rows: ReportRow[]): Map<string, ReportRow[]> {
  const groups = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const key = r.dimension_value ?? "";
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }
  return groups;
}

function withoutDimension(rows: ReportRow[]): Omit<ReportRow, "dimension_value">[] {
  return [...rows].sort(byDate).map(({ dimension_value: _drop, ...rest }) => rest);
}

const dimensionArg = z
  .string()
  .regex(/^[a-z][a-z_]*$/)
  .optional()
  .describe("overview (default), app_version, carrier, country, device, language or os_version. list_reports shows what exists.");

const monthArgSchema = z.string().optional().describe("YYYY-MM or YYYYMM. Defaults to the newest month in the bucket.");

function pctChange(prev: number | null | undefined, cur: number | null | undefined): number | null {
  if (typeof prev !== "number" || typeof cur !== "number" || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

export const statsTools = [
  defineTool({
    name: "list_reports",
    title: "List install and ratings reports",
    description:
      "Lists the monthly install and ratings report files Play has written for an app to the account's reports bucket: which months and which dimensions exist. The cheapest check that bucket access works, so call it first. " +
      DELAY_NOTE,
    kind: "read",
    requires: "reportsBucket",
    input: { ...packageArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const [installs, ratings] = await Promise.all([listReports(ctx, "installs", pkg), listReports(ctx, "ratings", pkg)]);
      const inst = summarise(installs);
      return {
        package_name: pkg,
        installs: inst,
        ratings: summarise(ratings),
        latest_month: inst.months[0] ?? null,
        ...(installs.truncated || ratings.truncated
          ? { truncated: `The listing stopped after ${MAX_LIST_PAGES} pages, so the newest months may be missing.` }
          : {}),
        ...(installs.length || ratings.length
          ? {}
          : { note: "No reports for this package. A new app gets its first files a few days after its first installs." }),
      };
    },
  }),

  defineTool({
    name: "get_install_stats",
    title: "Install statistics for a month",
    description:
      "Installs, uninstalls and upgrades for one month from Play's monthly install report. Overview: per-day rows plus month totals. With a dimension (country, device, app_version, …): one row per value with month totals, sorted by user installs and cut to `top`, the remainder summed as `other`. Totals sum the Daily columns; Current/Total/Active columns are snapshots taken on the last date present (see total_rules). " +
      DELAY_NOTE,
    kind: "read",
    requires: "reportsBucket",
    input: {
      ...packageArg,
      month: monthArgSchema,
      dimension: dimensionArg,
      top: z.number().int().min(1).max(200).optional().describe("With a dimension: how many values to keep (default 25)."),
      daily: z.boolean().optional().describe("With a dimension: also return per-day rows for the kept values."),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const dimension = args.dimension ?? "overview";
      const { month, file, report } = await readMonth(ctx, "installs", pkg, args.month, dimension);
      const lastDate = lastDateOf(report.rows);
      const head = {
        package_name: pkg,
        month,
        dimension,
        file,
        last_date_present: lastDate ?? null,
        partial_month: isPartial(month, lastDate),
      };

      if (report.dimensionHeader === undefined) {
        const t = monthTotals(report.rows, report.metrics);
        return { ...head, totals: t.totals, total_rules: t.rules, days: report.rows.slice().sort(byDate) };
      }

      const groups = [...groupByValue(report.rows)].map(([value, rows]) => ({ value, rows, ...monthTotals(rows, report.metrics) }));
      const sortKey = ["daily_user_installs", "daily_device_installs"].find((k) => report.metrics.includes(k));
      if (sortKey) groups.sort((a, b) => (b.totals[sortKey] ?? -Infinity) - (a.totals[sortKey] ?? -Infinity));
      const top = args.top ?? 25;
      const kept = groups.slice(0, top);
      const rest = groups.slice(top);
      const other: Record<string, number> = {};
      for (const g of rest) {
        for (const [k, v] of Object.entries(g.totals)) if (typeof v === "number") other[k] = (other[k] ?? 0) + v;
      }
      return {
        ...head,
        dimension_column: report.dimensionHeader,
        sorted_by: sortKey ?? null,
        values_total: groups.length,
        total_rules: groups[0]?.rules ?? {},
        rows: kept.map((g) => ({
          dimension_value: g.value,
          totals: g.totals,
          ...(args.daily ? { days: withoutDimension(g.rows) } : {}),
        })),
        ...(rest.length ? { other: { values: rest.length, totals: other } } : {}),
      };
    },
  }),

  defineTool({
    name: "install_trend",
    title: "Install trend over months",
    description:
      "Month-by-month installs and uninstalls from the overview install reports, oldest first, with the change from the previous month for daily_user_installs and daily_user_uninstalls. A month without a report (before the app existed, or not posted yet) is {month, no_data: true}. " +
      DELAY_NOTE,
    kind: "read",
    requires: "reportsBucket",
    input: {
      ...packageArg,
      months: z.number().int().min(1).max(24).optional().describe("How many months, ending at end_month (default 6)."),
      end_month: z.string().optional().describe("YYYY-MM or YYYYMM. Defaults to the newest overview report."),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const listing = await listReports(ctx, "installs", pkg);
      const end = monthArg(args.end_month, "end_month") ?? latestMonth(listing, "overview");
      if (!end) throw noReportError("installs", pkg, undefined, "overview", listing);
      const count = args.months ?? 6;
      const wanted = Array.from({ length: count }, (_, i) => addMonths(end, i - count + 1));
      const present = new Set(listing.filter((i) => i.dimension === "overview").map((i) => i.month));

      type MonthResult =
        | { month: string; no_data: true }
        | { month: string; partial_month: boolean; last_date_present: string | null; totals: Record<string, number | null>; rules: object };
      const results: MonthResult[] = [];
      for (let i = 0; i < wanted.length; i += PARALLEL_READS) {
        const batch = wanted.slice(i, i + PARALLEL_READS);
        results.push(
          ...(await Promise.all(
            batch.map(async (month): Promise<MonthResult> => {
              if (!present.has(month)) return { month, no_data: true };
              const got = await fetchReport(ctx, "installs", pkg, month, "overview");
              if (!got) return { month, no_data: true };
              const t = monthTotals(got.report.rows, got.report.metrics);
              const last = t.last_date_present;
              return { month, partial_month: isPartial(month, last), last_date_present: last ?? null, totals: t.totals, rules: t.rules };
            }),
          )),
        );
      }

      let totalRules: object | undefined;
      const months = results.map((r, i) => {
        if ("no_data" in r) return r;
        totalRules ??= r.rules;
        const prev = results[i - 1];
        const { rules: _rules, ...rest } = r;
        if (!prev || "no_data" in prev) return rest;
        const change: Record<string, unknown> = {};
        for (const k of ["daily_user_installs", "daily_user_uninstalls"]) {
          const a = prev.totals[k];
          const b = r.totals[k];
          if (typeof a === "number" && typeof b === "number") change[k] = { delta: b - a, pct: pctChange(a, b) };
        }
        // The newest month is nearly always partial; a "drop" against a full month is mostly the posting delay.
        if (r.partial_month || prev.partial_month) change.compares_partial_month = true;
        return { ...rest, change_from_previous_month: change };
      });
      return {
        package_name: pkg,
        months,
        total_rules: totalRules ?? {},
        ...(present.size === 0 && listing.length
          ? { note: `No overview files; dimensions present: ${summarise(listing).dimensions.join(", ")}. Use get_install_stats with one of them.` }
          : {}),
      };
    },
  }),

  defineTool({
    name: "get_ratings_stats",
    title: "Ratings statistics for a month",
    description:
      "Per-day average star ratings for one month from Play's monthly ratings report: daily_average_rating (that day's new ratings) and total_average_rating (the lifetime average), plus the newest total_average_rating. It does NOT average the daily averages into a month figure: the files carry no rating counts, so that mean would be meaningless. With a dimension, returns the newest total_average_rating per value. " +
      DELAY_NOTE,
    kind: "read",
    requires: "reportsBucket",
    input: { ...packageArg, month: monthArgSchema, dimension: dimensionArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const dimension = args.dimension ?? "overview";
      const { month, file, report } = await readMonth(ctx, "ratings", pkg, args.month, dimension);
      const lastDate = lastDateOf(report.rows);
      const head = {
        package_name: pkg,
        month,
        dimension,
        file,
        last_date_present: lastDate ?? null,
        partial_month: isPartial(month, lastDate),
      };
      const latestTotal = (rows: ReportRow[]) => {
        const r = [...rows].sort(byDate).filter((x) => typeof x.total_average_rating === "number").at(-1);
        return r ? { total_average_rating: r.total_average_rating as number, as_of: r.date } : { total_average_rating: null, as_of: null };
      };

      if (report.dimensionHeader === undefined) {
        return { ...head, latest: latestTotal(report.rows), days: report.rows.slice().sort(byDate) };
      }
      const values = [...groupByValue(report.rows)].map(([value, rows]) => ({ dimension_value: value, ...latestTotal(rows) }));
      values.sort((a, b) => a.dimension_value.localeCompare(b.dimension_value));
      const MAX_VALUES = 200;
      return {
        ...head,
        dimension_column: report.dimensionHeader,
        values_total: values.length,
        values: values.slice(0, MAX_VALUES),
        ...(values.length > MAX_VALUES ? { truncated: `first ${MAX_VALUES} of ${values.length} values, by name` } : {}),
      };
    },
  }),
];
