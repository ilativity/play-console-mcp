import { z } from "zod";
import { GoogleApiError, seg, type PlayClient } from "../google/client.js";
import { defineTool, packageArg, type ToolDef } from "./common.js";

interface MetricSetSpec {
  /** Reporting API resource name, e.g. crashRateMetricSet. */
  resource: string;
  /** The metric compared across versions and against thresholds. */
  primary: string;
  /** The 28-day user-weighted metric Play itself uses for the bad-behaviour check. */
  rolling28d: string;
  metrics: string[];
  /** Dimensions always added to queries of this set, because the unsplit number misleads. */
  alwaysDimensions?: string[];
  /**
   * Google's published bad-behaviour threshold (fraction), where one exists. Only the
   * two core vitals have one; the others are reported but not flagged.
   */
  threshold?: number;
}

const weighted = (m: string) => [m, `${m}7dUserWeighted`, `${m}28dUserWeighted`];

export const METRIC_SETS = {
  crash: {
    resource: "crashRateMetricSet",
    primary: "userPerceivedCrashRate",
    rolling28d: "userPerceivedCrashRate28dUserWeighted",
    metrics: [...weighted("crashRate"), ...weighted("userPerceivedCrashRate"), "distinctUsers"],
    threshold: 0.0109,
  },
  anr: {
    resource: "anrRateMetricSet",
    primary: "userPerceivedAnrRate",
    rolling28d: "userPerceivedAnrRate28dUserWeighted",
    metrics: [...weighted("anrRate"), ...weighted("userPerceivedAnrRate"), "distinctUsers"],
    threshold: 0.0047,
  },
  slow_start: {
    resource: "slowStartRateMetricSet",
    primary: "slowStartRate",
    rolling28d: "slowStartRate28dUserWeighted",
    metrics: [...weighted("slowStartRate"), "distinctUsers"],
    // Cold, warm and hot starts have different norms; one blended rate hides which is slow.
    alwaysDimensions: ["startType"],
  },
  slow_rendering: {
    resource: "slowRenderingRateMetricSet",
    primary: "slowRenderingRate30Fps",
    rolling28d: "slowRenderingRate30Fps28dUserWeighted",
    metrics: [...weighted("slowRenderingRate20Fps"), ...weighted("slowRenderingRate30Fps"), "distinctUsers"],
  },
  excessive_wakeup: {
    resource: "excessiveWakeupRateMetricSet",
    primary: "excessiveWakeupRate",
    rolling28d: "excessiveWakeupRate28dUserWeighted",
    metrics: [...weighted("excessiveWakeupRate"), "distinctUsers"],
  },
  stuck_wakelock: {
    resource: "stuckBackgroundWakelockRateMetricSet",
    primary: "stuckBgWakelockRate",
    rolling28d: "stuckBgWakelockRate28dUserWeighted",
    metrics: [...weighted("stuckBgWakelockRate"), "distinctUsers"],
  },
} satisfies Record<string, MetricSetSpec>;

export type MetricSetKey = keyof typeof METRIC_SETS;
const METRIC_KEYS = Object.keys(METRIC_SETS) as [MetricSetKey, ...MetricSetKey[]];

// Reporting API types -----------------------------------------------------------

interface DateTime {
  year: number;
  month: number;
  day: number;
  hours?: number;
  timeZone?: { id: string };
}

interface MetricRow {
  startTime?: DateTime;
  dimensions?: { dimension: string; stringValue?: string; int64Value?: string }[];
  metrics?: { metric: string; decimalValue?: { value: string } }[];
}

interface Freshness {
  freshnessInfo?: { freshnesses?: { aggregationPeriod: string; latestEndTime: DateTime }[] };
}

// Helpers ---------------------------------------------------------------------

const DEFAULT_TZ = "America/Los_Angeles";

function setPath(pkg: string, spec: MetricSetSpec): string {
  return `/apps/${seg(pkg)}/${spec.resource}`;
}

export function shiftDays(d: DateTime, days: number): DateTime {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) - days * 86_400_000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

const isoDate = (d: DateTime | undefined) =>
  d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : undefined;

async function latestDailyEnd(client: PlayClient, pkg: string, spec: MetricSetSpec): Promise<DateTime> {
  const info = await client.request<Freshness>("reporting", setPath(pkg, spec));
  const daily = info?.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === "DAILY");
  if (!daily) throw new Error(`No daily data is available yet for ${spec.resource}.`);
  return daily.latestEndTime;
}

export interface QueryOptions {
  days: number;
  dimensions?: string[];
  metrics?: string[];
  filter?: string;
  pageSize?: number;
}

/** Queries a metric set over the last `days` days of available data. */
export async function queryMetricSet(client: PlayClient, pkg: string, spec: MetricSetSpec, opts: QueryOptions) {
  const end = await latestDailyEnd(client, pkg, spec);
  const tz = { id: end.timeZone?.id ?? DEFAULT_TZ };
  const start = shiftDays(end, opts.days);
  const dimensions = [...new Set([...(spec.alwaysDimensions ?? []), ...(opts.dimensions ?? [])])];
  const rows: MetricRow[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.request<{ rows?: MetricRow[]; nextPageToken?: string }>("reporting", `${setPath(pkg, spec)}:query`, {
      method: "POST",
      json: {
        timelineSpec: {
          aggregationPeriod: "DAILY",
          startTime: { year: start.year, month: start.month, day: start.day, timeZone: tz },
          endTime: { year: end.year, month: end.month, day: end.day, timeZone: tz },
        },
        dimensions,
        metrics: opts.metrics ?? spec.metrics,
        ...(opts.filter ? { filter: opts.filter } : {}),
        pageSize: opts.pageSize ?? 1000,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    rows.push(...(res?.rows ?? []));
    pageToken = res?.nextPageToken;
  } while (pageToken && rows.length < 10_000);
  return { start: isoDate(start), end_exclusive: isoDate(end), rows: rows.map(flattenRow) };
}

export interface FlatRow {
  date?: string;
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
}

export function flattenRow(row: MetricRow): FlatRow {
  const dimensions: Record<string, string> = {};
  for (const d of row.dimensions ?? []) dimensions[d.dimension] = d.stringValue ?? d.int64Value ?? "";
  const metrics: Record<string, number> = {};
  for (const m of row.metrics ?? []) {
    if (m.decimalValue?.value !== undefined) metrics[m.metric] = Number(m.decimalValue.value);
  }
  return { date: isoDate(row.startTime), dimensions, metrics };
}

const pct = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 100_000) / 1000);

/** Latest 28-day user-weighted value of one metric set, flagged against its threshold. */
export async function summarizeMetricSet(client: PlayClient, pkg: string, key: MetricSetKey) {
  const spec: MetricSetSpec = METRIC_SETS[key];
  const res = await queryMetricSet(client, pkg, spec, { days: 1, metrics: [spec.rolling28d, "distinctUsers"] });
  // Sets with an always-on dimension (slow start → startType) return one row per value.
  const byDim = res.rows.map((r) => ({
    ...(Object.keys(r.dimensions).length ? { breakdown: r.dimensions } : {}),
    value_percent: pct(r.metrics[spec.rolling28d]),
    distinct_users: r.metrics.distinctUsers,
  }));
  const hasData = res.rows.some((r) => r.metrics[spec.rolling28d] !== undefined);
  const worst = Math.max(...res.rows.map((r) => r.metrics[spec.rolling28d] ?? 0), 0);
  return {
    metric: spec.rolling28d,
    as_of: res.start,
    values: byDim,
    // No rows is "unknown", never "healthy": Google withholds vitals for apps with too few users.
    ...(hasData ? {} : { no_data: true, note: NO_DATA_NOTE }),
    ...(spec.threshold !== undefined
      ? { threshold_percent: pct(spec.threshold), bad_behaviour: hasData ? worst > spec.threshold : null }
      : { threshold_percent: null, threshold_note: "Google publishes no overall bad-behaviour threshold for this metric." }),
  };
}

const NO_DATA_NOTE = "No data in this window. Google withholds vitals until an app has enough active users.";

/** Google answers 403 for metric sets that don't apply to the app (slow rendering is games-only). */
function notApplicable(e: unknown): string | undefined {
  return e instanceof GoogleApiError && e.status === 403 && /only accessible to games/i.test(e.message)
    ? "Google offers this metric for games only."
    : undefined;
}

export async function vitalsSummary(client: PlayClient, pkg: string) {
  const out: Record<string, unknown> = {};
  await Promise.all(
    METRIC_KEYS.map(async (key) => {
      try {
        out[key] = await summarizeMetricSet(client, pkg, key);
      } catch (e) {
        const na = notApplicable(e);
        out[key] = na ? { not_applicable: na } : { error: (e as Error).message };
      }
    }),
  );
  const pick = (test: (v: Record<string, unknown>) => boolean) => METRIC_KEYS.filter((k) => test(out[k] as Record<string, unknown>));
  return {
    package_name: pkg,
    over_threshold: pick((v) => v.bad_behaviour === true),
    no_data: pick((v) => v.no_data === true),
    errors: pick((v) => "error" in v),
    metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, out[k]])),
  };
}

/** Per-version averages, weighted by daily distinct users. */
export function aggregateByVersion(rows: FlatRow[], metric: string) {
  const acc = new Map<string, { weighted: number; users: number; days: number }>();
  for (const r of rows) {
    const v = r.dimensions.versionCode;
    const value = r.metrics[metric];
    if (v === undefined || value === undefined) continue;
    const users = r.metrics.distinctUsers ?? 1;
    const a = acc.get(v) ?? { weighted: 0, users: 0, days: 0 };
    a.weighted += value * users;
    a.users += users;
    a.days += 1;
    acc.set(v, a);
  }
  const versions = [...acc.entries()]
    .map(([version, a]) => ({ version_code: version, value: a.users ? a.weighted / a.users : 0, user_days: a.users, days: a.days }))
    .sort((x, y) => Number(y.version_code) - Number(x.version_code));
  return versions.map((v, i) => {
    const prev = versions[i + 1];
    return {
      version_code: v.version_code,
      value_percent: pct(v.value),
      user_days: v.user_days,
      days_with_data: v.days,
      change_vs_previous_percent_points: prev ? pct(v.value - prev.value) : undefined,
    };
  });
}

// Tools -------------------------------------------------------------------------

const windowArgs = {
  days: z.number().int().min(1).max(365).optional().describe("How many days back from the latest available data (default 28)."),
  dimensions: z
    .array(z.string().regex(/^[A-Za-z]+$/))
    .optional()
    .describe("Break down by dimensions, e.g. versionCode, apiLevel, deviceModel, countryCode."),
  filter: z.string().max(1000).optional().describe('Reporting API filter, e.g. "versionCode = 123".'),
};

function metricTool(name: string, key: MetricSetKey, label: string): ToolDef {
  return defineTool({
    name,
    title: label,
    description: `Daily ${label.toLowerCase()} from Android vitals (Play Developer Reporting API), including 7- and 28-day user-weighted values. Rates are fractions (0.01 = 1%).`,
    kind: "read",
    input: { ...packageArg, ...windowArgs },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return queryMetricSet(ctx.client, pkg, METRIC_SETS[key], {
        days: args.days ?? 28,
        dimensions: args.dimensions,
        filter: args.filter,
      });
    },
  });
}

const pagedArgs = {
  filter: z.string().max(1000).optional().describe("Reporting API filter expression."),
  page_size: z.number().int().min(1).max(1000).optional(),
  page_token: z.string().optional(),
};

export const vitalsTools: ToolDef[] = [
  metricTool("crash_rate", "crash", "Crash rate"),
  metricTool("anr_rate", "anr", "ANR rate"),
  metricTool("slow_start_rate", "slow_start", "Slow start rate"),
  metricTool("slow_rendering_rate", "slow_rendering", "Slow rendering rate"),
  metricTool("excessive_wakeup_rate", "excessive_wakeup", "Excessive wakeup rate"),
  metricTool("stuck_wakelock_rate", "stuck_wakelock", "Stuck background wakelock rate"),

  defineTool({
    name: "vitals_summary",
    title: "Vitals summary",
    description:
      "All six vitals at once: the latest 28-day user-weighted value of each, flagged against Google's bad-behaviour thresholds (user-perceived crash rate 1.09%, user-perceived ANR rate 0.47%).",
    kind: "read",
    input: { ...packageArg },
    async handler(args, ctx) {
      return vitalsSummary(ctx.client, ctx.pkg(args.package_name));
    },
  }),

  defineTool({
    name: "vitals_by_version",
    title: "Vitals by version",
    description:
      "Compares vitals across version codes over a window (weighted by daily users), newest first, with the change versus the previous version — to see whether the last release made things worse.",
    kind: "read",
    input: {
      ...packageArg,
      metric_sets: z.array(z.enum(METRIC_KEYS)).optional().describe("Default: crash and anr."),
      days: z.number().int().min(1).max(365).optional().describe("Window in days (default 28)."),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const keys = args.metric_sets ?? (["crash", "anr"] as MetricSetKey[]);
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const spec: MetricSetSpec = METRIC_SETS[key];
        try {
          const res = await queryMetricSet(ctx.client, pkg, spec, {
            days: args.days ?? 28,
            dimensions: ["versionCode"],
            metrics: [spec.primary, "distinctUsers"],
          });
          const window = { start: res.start, end_exclusive: res.end_exclusive };
          const split = spec.alwaysDimensions?.[0];
          if (split) {
            // Compare like with like: one version table per start type, never a blend.
            const groups = new Map<string, FlatRow[]>();
            for (const r of res.rows) {
              const g = r.dimensions[split] ?? "unknown";
              groups.set(g, [...(groups.get(g) ?? []), r]);
            }
            out[key] = {
              metric: spec.primary,
              window,
              split_by: split,
              groups: Object.fromEntries([...groups].map(([g, rows]) => [g, aggregateByVersion(rows, spec.primary)])),
            };
          } else {
            out[key] = { metric: spec.primary, window, versions: aggregateByVersion(res.rows, spec.primary) };
          }
        } catch (e) {
          const na = notApplicable(e);
          out[key] = na ? { not_applicable: na } : { error: (e as Error).message };
        }
      }
      return { package_name: pkg, ...out };
    },
  }),

  defineTool({
    name: "search_error_issues",
    title: "Search error issues",
    description: "Searches grouped crash/ANR issues (Reporting API errorIssues:search).",
    kind: "read",
    input: { ...packageArg, ...pagedArgs, order_by: z.string().max(200).optional() },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return ctx.client.request("reporting", `/apps/${seg(pkg)}/errorIssues:search`, {
        query: { filter: args.filter, pageSize: args.page_size, pageToken: args.page_token, orderBy: args.order_by },
      });
    },
  }),

  defineTool({
    name: "search_error_reports",
    title: "Search error reports",
    description: "Searches individual crash/ANR reports with stack traces (Reporting API errorReports:search).",
    kind: "read",
    input: { ...packageArg, ...pagedArgs },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return ctx.client.request("reporting", `/apps/${seg(pkg)}/errorReports:search`, {
        query: { filter: args.filter, pageSize: args.page_size, pageToken: args.page_token },
      });
    },
  }),

  defineTool({
    name: "list_anomalies",
    title: "List anomalies",
    description: "Lists anomalies Google detected in the app's vitals metrics.",
    kind: "read",
    input: { ...packageArg, ...pagedArgs },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return ctx.client.request("reporting", `/apps/${seg(pkg)}/anomalies`, {
        query: { filter: args.filter, pageSize: args.page_size, pageToken: args.page_token },
      });
    },
  }),

  defineTool({
    name: "vitals_freshness",
    title: "Vitals freshness",
    description: "For each vitals metric set, the latest date (and hour) for which data is available.",
    kind: "read",
    input: { ...packageArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const out: Record<string, unknown> = {};
      await Promise.all(
        METRIC_KEYS.map(async (key) => {
          const spec: MetricSetSpec = METRIC_SETS[key];
          try {
            const info = await ctx.client.request<Freshness>("reporting", setPath(pkg, spec));
            out[key] = (info?.freshnessInfo?.freshnesses ?? []).map((f) => ({
              aggregation_period: f.aggregationPeriod,
              latest_end: f.latestEndTime,
            }));
          } catch (e) {
            out[key] = { error: (e as Error).message };
          }
        }),
      );
      return Object.fromEntries(METRIC_KEYS.map((k) => [k, out[k]]));
    },
  }),
];
