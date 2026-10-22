import { describe, expect, it } from "vitest";
import { FakeFetch, PKG, connect, testConfig, utf16le } from "../helpers.js";

const BUCKET = "pubsite_prod_1234567890";
const config = testConfig({ reportsBucket: BUCKET, readOnly: true });

const OVERVIEW_HEADER =
  "Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Current Device Installs,Daily User Installs,Daily User Uninstalls,Total User Installs";

/** An overview CSV for `month` with one row per day 1..days; user installs = `perDay`. */
function overview(month: string, days: number, perDay = 2): string {
  const rows = Array.from({ length: days }, (_, i) => {
    const d = `${month}-${String(i + 1).padStart(2, "0")}`;
    return `${d},${PKG},${perDay + 1},1,0,${100 + i},${perDay},1,${50 + i * perDay}`;
  });
  return [OVERVIEW_HEADER, ...rows].join("\r\n") + "\r\n";
}

/** A fake bucket: object name → CSV text, served as UTF-16LE; listing honours prefix and pages. */
class FakeBucket extends FakeFetch {
  objects = new Map<string, string>();

  constructor(pageSize = 2) {
    super();
    const base = String.raw`^storage\.googleapis\.com/storage/v1/b/([^/]+)/o`;
    this.on("GET", new RegExp(`${base}$`), (c, m) => {
      if (m[1] !== BUCKET) return { status: 404, json: { error: { code: 404, message: "The specified bucket does not exist." } } };
      const prefix = c.url.searchParams.get("prefix") ?? "";
      const names = [...this.objects.keys()].filter((n) => n.startsWith(prefix)).sort();
      const start = Number(c.url.searchParams.get("pageToken") ?? 0);
      const page = names.slice(start, start + pageSize);
      return {
        json: {
          items: page.map((name) => ({ name, size: "10", updated: "2026-10-05T00:00:00Z" })),
          ...(start + pageSize < names.length ? { nextPageToken: String(start + pageSize) } : {}),
        },
      };
    });
    this.on("GET", new RegExp(`${base}/([^/]+)$`), (c, m) => {
      const name = decodeURIComponent(m[2]!);
      const text = this.objects.get(name);
      if (c.url.searchParams.get("alt") !== "media") return { status: 400, json: { error: { message: "want alt=media" } } };
      // Cloud Storage answers a missing object with a plain-text body.
      return text === undefined ? { status: 404, text: "No such object: " + name } : { bytes: utf16le(text) };
    });
  }

  put(kind: "installs" | "ratings", month: string, dimension: string, text: string, pkg = PKG): this {
    this.objects.set(`stats/${kind}/${kind}_${pkg}_${month.replace("-", "")}_${dimension}.csv`, text);
    return this;
  }
}

describe("list_reports", () => {
  it("lists months (newest first) and dimensions, follows pages, ignores a longer package name", async () => {
    const fake = new FakeBucket()
      .put("installs", "2026-08", "overview", overview("2026-08", 31))
      .put("installs", "2026-09", "overview", overview("2026-09", 30))
      .put("installs", "2026-09", "country", "")
      .put("installs", "2026-09", "overview", "", `${PKG}_beta`)
      .put("ratings", "2026-09", "overview", "");
    fake.objects.set("stats/installs/README.txt", "");
    const h = await connect(fake, config);
    const res = await h.call("list_reports");
    expect(res.installs).toEqual({ months: ["2026-09", "2026-08"], dimensions: ["country", "overview"], files: 3 });
    expect(res.ratings).toEqual({ months: ["2026-09"], dimensions: ["overview"], files: 1 });
    expect(res.latest_month).toBe("2026-09");

    const list = fake.find("GET", /\/o$/);
    expect(list.length).toBeGreaterThan(2); // paged
    expect(list[0]!.url.searchParams.get("prefix")).toMatch(new RegExp(`^stats/(installs|ratings)/(installs|ratings)_${PKG.replace(/\./g, "\\.")}_$`));
    expect(list[0]!.url.searchParams.get("fields")).toBe("items(name,size,updated),nextPageToken");
  });

  it("a 403 names the Play Console permission and the propagation delay", async () => {
    const fake = new FakeFetch().on("GET", /\/o$/, {
      status: 403,
      text: "play-console-mcp@x.iam.gserviceaccount.com does not have storage.objects.list access to the Google Cloud Storage bucket.",
    });
    const err = await (await connect(fake, config)).callError("list_reports");
    expect(err).toContain("storage.objects.list");
    expect(err).toContain("View app information and download bulk reports");
    expect(err).toMatch(/hours/);
  });

  it("a 401 points at the credentials, not at a Play permission", async () => {
    const fake = new FakeFetch().on("GET", /\/o$/, { status: 401, text: "Invalid Credentials" });
    const err = await (await connect(fake, config)).callError("list_reports");
    expect(err).toMatch(/credentials problem/);
    expect(err).not.toContain("bulk reports");
  });

  it("says so when the listing hits the page cap", async () => {
    const fake = new FakeBucket(1);
    for (let i = 0; i < 25; i++) fake.put("installs", `${2010 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, "overview", "");
    const res = await (await connect(fake, config)).call("list_reports");
    expect(res.installs.files).toBe(20);
    expect(res.truncated).toMatch(/20 pages/);
  });

  it("a missing bucket says where to copy the URI", async () => {
    const h = await connect(new FakeBucket(), testConfig({ reportsBucket: "pubsite_prod_999" }));
    expect(await h.callError("list_reports")).toMatch(/Copy Cloud Storage URI/);
  });
});

describe("get_install_stats", () => {
  it("overview defaults to the newest month: per-day rows, totals and their rules", async () => {
    const fake = new FakeBucket()
      .put("installs", "2026-08", "overview", overview("2026-08", 31, 2))
      .put("installs", "2026-09", "overview", overview("2026-09", 30, 3));
    const res = await (await connect(fake, config)).call("get_install_stats");
    expect(res).toMatchObject({ month: "2026-09", dimension: "overview", last_date_present: "2026-09-30", partial_month: false });
    expect(res.file).toBe(`stats/installs/installs_${PKG}_202609_overview.csv`);
    expect(res.days).toHaveLength(30);
    expect(res.totals.daily_user_installs).toBe(90);
    expect(res.totals.current_device_installs).toBe(129); // snapshot on the 30th, not a sum
    expect(res.total_rules.sum).toContain("daily_user_installs");
    expect(res.total_rules.last_date).toContain("total_user_installs");
    const get = fake.find("GET", /\/o\/[^/]+$/)[0]!;
    expect(get.url.pathname).toContain("/o/stats%2Finstalls%2F");
  });

  it("a month missing its last days is partial", async () => {
    const fake = new FakeBucket().put("installs", "2026-09", "overview", overview("2026-09", 26));
    const res = await (await connect(fake, config)).call("get_install_stats", { month: "202609" });
    expect(res).toMatchObject({ month: "2026-09", last_date_present: "2026-09-26", partial_month: true });
  });

  it("by dimension: sorted by user installs, cut to top, the rest summed as other", async () => {
    const csv = [
      "Date,Package Name,Country,Daily User Installs,Current Device Installs",
      `2026-09-01,${PKG},IL,5,40`,
      `2026-09-02,${PKG},IL,5,42`,
      `2026-09-01,${PKG},US,20,10`,
      `2026-09-01,${PKG},DE,1,3`,
      `2026-09-01,${PKG},FR,2,4`,
    ].join("\n");
    const fake = new FakeBucket().put("installs", "2026-09", "country", csv);
    const h = await connect(fake, config);
    const res = await h.call("get_install_stats", { month: "2026-09", dimension: "country", top: 2 });
    expect(res.dimension_column).toBe("Country");
    expect(res.sorted_by).toBe("daily_user_installs");
    expect(res.values_total).toBe(4);
    expect(res.rows.map((r: { dimension_value: string }) => r.dimension_value)).toEqual(["US", "IL"]);
    expect(res.rows[1].totals).toEqual({ daily_user_installs: 10, current_device_installs: 42 });
    expect(res.rows[0].days).toBeUndefined();
    expect(res.other).toEqual({ values: 2, totals: { daily_user_installs: 3, current_device_installs: 7 } });

    const daily = await h.call("get_install_stats", { month: "2026-09", dimension: "country", top: 1, daily: true });
    expect(daily.rows[0].days).toEqual([{ date: "2026-09-01", daily_user_installs: 20, current_device_installs: 10 }]);
  });

  it("a missing month says which months exist and that Play posts late", async () => {
    const fake = new FakeBucket().put("installs", "2026-08", "overview", overview("2026-08", 31));
    const err = await (await connect(fake, config)).callError("get_install_stats", { month: "2026-10" });
    expect(err).toMatch(/No installs report .*2026-10/);
    expect(err).toContain("Months available: 2026-08");
    expect(err).toMatch(/3–7 day/);
  });

  it("a 403 on the download names the permission", async () => {
    const fake = new FakeFetch().on("GET", /\/o\/[^/]+$/, { status: 403, text: "Access denied." });
    expect(await (await connect(fake, config)).callError("get_install_stats", { month: "2026-09" })).toMatch(/bulk reports/);
  });

  it("refuses a malformed month without calling Google", async () => {
    const fake = new FakeBucket();
    expect(await (await connect(fake, config)).callError("get_install_stats", { month: "Sept" })).toMatch(/YYYY-MM/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("install_trend", () => {
  it("returns months oldest first, no_data for a missing month, and month-on-month change", async () => {
    const fake = new FakeBucket()
      .put("installs", "2026-07", "overview", overview("2026-07", 31, 1))
      .put("installs", "2026-09", "overview", overview("2026-09", 30, 2))
      .put("installs", "2026-10", "overview", overview("2026-10", 5, 4));
    const res = await (await connect(fake, config)).call("install_trend", { months: 5 });
    expect(res.months.map((m: { month: string }) => m.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(res.months[0]).toEqual({ month: "2026-06", no_data: true });
    expect(res.months[2]).toEqual({ month: "2026-08", no_data: true });
    expect(res.months[1].change_from_previous_month).toBeUndefined();
    expect(res.months[3].totals.daily_user_installs).toBe(60);
    expect(res.months[4]).toMatchObject({ partial_month: true, last_date_present: "2026-10-05" });
    expect(res.months[4].change_from_previous_month).toEqual({
      daily_user_installs: { delta: -40, pct: -66.7 },
      daily_user_uninstalls: { delta: -25, pct: -83.3 },
      compares_partial_month: true,
    });
    expect(res.total_rules.sum).toContain("daily_user_uninstalls");
    // Only months the listing showed were downloaded.
    expect(fake.find("GET", /\/o\/[^/]+$/)).toHaveLength(3);
  });
});

describe("get_ratings_stats", () => {
  const csv = [
    "Date,Package Name,Daily Average Rating,Total Average Rating",
    `2026-09-01,${PKG},5,4.61`,
    `2026-09-02,${PKG},,4.61`,
    `2026-09-03,${PKG},3,4.58`,
  ].join("\n");

  it("returns per-day ratings and the newest lifetime average, never a mean of daily averages", async () => {
    const fake = new FakeBucket().put("ratings", "2026-09", "overview", csv);
    const res = await (await connect(fake, config)).call("get_ratings_stats");
    expect(res.file).toBe(`stats/ratings/ratings_${PKG}_202609_overview.csv`);
    expect(res.latest).toEqual({ total_average_rating: 4.58, as_of: "2026-09-03" });
    expect(res.days[1]).toEqual({ date: "2026-09-02", daily_average_rating: null, total_average_rating: 4.61 });
    expect(JSON.stringify(res)).not.toMatch(/month_average|totals/);
  });

  it("by dimension: the newest lifetime average per value", async () => {
    const byCountry = [
      "Date,Package Name,Country,Daily Average Rating,Total Average Rating",
      `2026-09-01,${PKG},US,4,4.2`,
      `2026-09-02,${PKG},US,5,4.3`,
      `2026-09-01,${PKG},IL,5,4.9`,
    ].join("\n");
    const fake = new FakeBucket().put("ratings", "2026-09", "country", byCountry);
    const res = await (await connect(fake, config)).call("get_ratings_stats", { month: "2026-09", dimension: "country" });
    expect(res.values).toEqual([
      { dimension_value: "IL", total_average_rating: 4.9, as_of: "2026-09-01" },
      { dimension_value: "US", total_average_rating: 4.3, as_of: "2026-09-02" },
    ]);
  });
});
