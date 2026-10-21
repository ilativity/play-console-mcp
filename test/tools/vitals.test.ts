import { describe, expect, it } from "vitest";
import { aggregateByVersion, shiftDays } from "../../src/tools/vitals.js";
import { FakeFetch, connect, type Call } from "../helpers.js";

const LATEST = { year: 2026, month: 10, day: 20, timeZone: { id: "America/Los_Angeles" } };
const freshness = { freshnessInfo: { freshnesses: [{ aggregationPeriod: "DAILY", latestEndTime: LATEST }] } };

const metric = (name: string, value: number) => ({ metric: name, decimalValue: { value: String(value) } });

function reporting(rowsFor: (set: string, call: Call) => unknown[]) {
  return new FakeFetch()
    .on("GET", /playdeveloperreporting\.googleapis\.com\/v1beta1\/apps\/[^/]+\/\w+MetricSet$/, { json: freshness })
    .on("POST", /playdeveloperreporting\.googleapis\.com\/v1beta1\/apps\/[^/]+\/(\w+MetricSet):query$/, (c, m) => ({
      json: { rows: rowsFor(m[1]!, c) },
    }));
}

describe("vitals helpers", () => {
  it("shiftDays crosses month boundaries", () => {
    expect(shiftDays({ year: 2026, month: 3, day: 1 }, 1)).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it("aggregateByVersion weights by users and compares with the previous version", () => {
    const rows = [
      { dimensions: { versionCode: "1" }, metrics: { userPerceivedCrashRate: 0.01, distinctUsers: 100 } },
      { dimensions: { versionCode: "1" }, metrics: { userPerceivedCrashRate: 0.03, distinctUsers: 300 } },
      { dimensions: { versionCode: "2" }, metrics: { userPerceivedCrashRate: 0.04, distinctUsers: 10 } },
    ];
    const out = aggregateByVersion(rows, "userPerceivedCrashRate");
    expect(out[0]).toMatchObject({ version_code: "2", value_percent: 4 });
    expect(out[1]).toMatchObject({ version_code: "1", value_percent: 2.5, user_days: 400, days_with_data: 2 });
    expect(out[0]!.change_vs_previous_percent_points).toBe(1.5);
  });
});

describe("vitals tools", () => {
  it("crash_rate queries the window ending at the freshness date", async () => {
    const fake = reporting(() => [
      { startTime: { year: 2026, month: 10, day: 19 }, metrics: [metric("crashRate", 0.002)] },
    ]);
    const h = await connect(fake);
    const res = await h.call("crash_rate", { days: 7, dimensions: ["versionCode"] });
    const body = fake.find("POST", /:query$/)[0]!.json as { timelineSpec: { startTime: object; endTime: object }; dimensions: string[] };
    expect(body.timelineSpec.endTime).toMatchObject({ year: 2026, month: 10, day: 20 });
    expect(body.timelineSpec.startTime).toMatchObject({ year: 2026, month: 10, day: 13 });
    expect(body.dimensions).toEqual(["versionCode"]);
    expect(res.rows[0]).toEqual({ date: "2026-10-19", dimensions: {}, metrics: { crashRate: 0.002 } });
  });

  it("slow_start_rate always splits by startType", async () => {
    const fake = reporting(() => []);
    const h = await connect(fake);
    await h.call("slow_start_rate", {});
    expect((fake.find("POST", /:query$/)[0]!.json as { dimensions: string[] }).dimensions).toEqual(["startType"]);
  });

  it("vitals_summary flags metrics over Google's thresholds", async () => {
    const fake = reporting((set) =>
      set === "crashRateMetricSet"
        ? [{ metrics: [metric("userPerceivedCrashRate28dUserWeighted", 0.02), metric("distinctUsers", 1000)] }]
        : set === "anrRateMetricSet"
          ? [{ metrics: [metric("userPerceivedAnrRate28dUserWeighted", 0.001)] }]
          : [],
    );
    const h = await connect(fake);
    const res = await h.call("vitals_summary");
    expect(res.over_threshold).toEqual(["crash"]);
    expect(res.metrics.crash).toMatchObject({ bad_behaviour: true, threshold_percent: 1.09, values: [{ value_percent: 2 }] });
    expect(res.metrics.anr).toMatchObject({ bad_behaviour: false, threshold_percent: 0.47 });
    expect(res.metrics.slow_rendering.threshold_percent).toBeNull();
    // No rows is unknown, not healthy.
    expect(res.metrics.slow_rendering).toMatchObject({ no_data: true });
    expect(res.no_data).toEqual(["slow_start", "slow_rendering", "excessive_wakeup", "stuck_wakelock"]);
    expect(Object.keys(res.metrics)).toHaveLength(6);
  });

  it("vitals_summary: an app with no vitals data is 'no data', never 'healthy'", async () => {
    const h = await connect(reporting(() => []));
    const res = await h.call("vitals_summary");
    expect(res.metrics.crash).toMatchObject({ bad_behaviour: null, no_data: true });
    expect(res.over_threshold).toEqual([]);
    expect(res.no_data).toHaveLength(6);
  });

  it("vitals_summary marks games-only metrics as not applicable, not as errors", async () => {
    const fake = reporting(() => []).on("GET", /slowRenderingRateMetricSet$/, {
      status: 403,
      json: { error: { code: 403, message: "slowRenderingRateMetricSet resource is only accessible to games" } },
    });
    const res = await (await connect(fake)).call("vitals_summary");
    expect(res.metrics.slow_rendering).toEqual({ not_applicable: "Google offers this metric for games only." });
    expect(res.errors).toEqual([]);
  });

  it("vitals_summary reports one metric's failure without failing the rest", async () => {
    const fake = reporting(() => []).on("GET", /anrRateMetricSet$/, { status: 403, json: { error: { message: "denied" } } });
    const h = await connect(fake);
    const res = await h.call("vitals_summary");
    expect(res.metrics.anr.error).toMatch(/denied/);
    expect(res.metrics.crash.bad_behaviour).toBeNull();
    expect(res.errors).toEqual(["anr"]);
  });

  it("vitals_by_version groups by versionCode", async () => {
    const fake = reporting((set) =>
      set === "crashRateMetricSet"
        ? [
            { dimensions: [{ dimension: "versionCode", int64Value: "5" }], metrics: [metric("userPerceivedCrashRate", 0.01), metric("distinctUsers", 10)] },
            { dimensions: [{ dimension: "versionCode", int64Value: "6" }], metrics: [metric("userPerceivedCrashRate", 0.03), metric("distinctUsers", 10)] },
          ]
        : [],
    );
    const h = await connect(fake);
    const res = await h.call("vitals_by_version", { metric_sets: ["crash"] });
    expect(res.crash.versions.map((v: { version_code: string }) => v.version_code)).toEqual(["6", "5"]);
    expect(res.crash.versions[0].change_vs_previous_percent_points).toBe(2);
    expect((fake.find("POST", /:query$/)[0]!.json as { dimensions: string[] }).dimensions).toEqual(["versionCode"]);
  });

  it("vitals_by_version for slow start keeps start types apart", async () => {
    const row = (v: string, type: string, rate: number) => ({
      dimensions: [
        { dimension: "versionCode", int64Value: v },
        { dimension: "startType", stringValue: type },
      ],
      metrics: [metric("slowStartRate", rate), metric("distinctUsers", 10)],
    });
    const fake = reporting((set) => (set === "slowStartRateMetricSet" ? [row("5", "COLD", 0.2), row("5", "HOT", 0.01), row("6", "COLD", 0.1)] : []));
    const h = await connect(fake);
    const res = await h.call("vitals_by_version", { metric_sets: ["slow_start"] });
    expect(res.slow_start.split_by).toBe("startType");
    expect(res.slow_start.groups.COLD.map((v: { value_percent: number }) => v.value_percent)).toEqual([10, 20]);
    expect(res.slow_start.groups.HOT).toEqual([expect.objectContaining({ version_code: "5", value_percent: 1 })]);
    expect((fake.find("POST", /:query$/)[0]!.json as { dimensions: string[] }).dimensions).toEqual(["startType", "versionCode"]);
  });

  it("error issues, reports, anomalies and freshness hit the reporting API", async () => {
    const fake = reporting(() => [])
      .on("GET", /errorIssues:search$/, { json: { errorIssues: [] } })
      .on("GET", /errorReports:search$/, { json: { errorReports: [] } })
      .on("GET", /anomalies$/, { json: { anomalies: [] } });
    const h = await connect(fake);
    await h.call("search_error_issues", { filter: "errorIssueType = CRASH", page_size: 5 });
    expect(fake.find("GET", /errorIssues:search$/)[0]!.url.searchParams.get("filter")).toBe("errorIssueType = CRASH");
    await h.call("search_error_reports", {});
    await h.call("list_anomalies", {});
    const fresh = await h.call("vitals_freshness");
    expect(fresh.crash[0].aggregation_period).toBe("DAILY");
  });
});
