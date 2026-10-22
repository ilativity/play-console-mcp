import { describe, expect, it } from "vitest";
import {
  addMonths,
  decodeCsv,
  lastDayOf,
  monthTotals,
  normaliseMonth,
  parseCsv,
  parseReportName,
  readReport,
  reportObjectName,
  totalRule,
} from "../src/google/reports.js";
import { utf16le } from "./helpers.js";

describe("report file names", () => {
  it("parses installs and ratings names, including a package with underscores", () => {
    expect(parseReportName("stats/installs/installs_com.my_app.x_202609_overview.csv")).toEqual({
      kind: "installs",
      package: "com.my_app.x",
      month: "2026-09",
      dimension: "overview",
    });
    expect(parseReportName("stats/ratings/ratings_a.b_202512_app_version.csv")).toMatchObject({
      kind: "ratings",
      month: "2025-12",
      dimension: "app_version",
    });
  });

  it.each([
    "stats/installs/ratings_a.b_202609_overview.csv",
    "stats/installs/installs_a.b_202613_overview.csv",
    "stats/installs/installs_a.b_2026_overview.csv",
    "stats/installs/installs_a.b_202609_overview.csv.gz",
    "stats/crashes/crashes_a.b_202609_overview.csv",
  ])("refuses %s", (name) => {
    expect(parseReportName(name)).toBeUndefined();
  });

  it("builds the object name back from its parts", () => {
    expect(reportObjectName("installs", "a.b", "2026-09", "country")).toBe("stats/installs/installs_a.b_202609_country.csv");
  });
});

describe("decodeCsv", () => {
  const text = "Date,Package Name\r\n2026-09-01,a.b\r\n";

  it("decodes UTF-16LE with a BOM, without one, UTF-16BE and UTF-8", () => {
    expect(decodeCsv(utf16le(text))).toBe(text);
    expect(decodeCsv(utf16le(text, false))).toBe(text);
    const be = Buffer.from(text, "utf16le").swap16();
    expect(decodeCsv(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))).toBe(text);
    expect(decodeCsv(new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])))).toBe(text);
    expect(decodeCsv(new Uint8Array(Buffer.from(text, "utf8")))).toBe(text);
  });

  it("keeps non-ASCII device names", () => {
    expect(decodeCsv(utf16le("Device\nXiaomi Redmi Note 13 Pro+ «ß»\n"))).toContain("«ß»");
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas and newlines inside quotes, CRLF and a missing final newline", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",\n\nlast,1')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", ""],
      ["last", "1"],
    ]);
  });

  it("a quote inside an unquoted field is a literal and does not swallow the rest of the file", () => {
    expect(parseCsv('2024-01-01,Tab 7",5\n2024-01-02,Other,6\n')).toEqual([
      ["2024-01-01", 'Tab 7"', "5"],
      ["2024-01-02", "Other", "6"],
    ]);
  });
});

describe("readReport", () => {
  const overview = [
    "Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Current Device Installs,Daily User Installs,Total User Installs",
    "2026-09-02,a.b,3,1,101,2,50",
    "2026-09-01,a.b,5,0,99,4,48",
    "2026-09-03,a.b,,2,,1,51",
  ].join("\r\n");

  it("maps columns by header name; an empty cell is null, not 0", () => {
    const r = readReport(utf16le(overview), false);
    expect(r.dimensionHeader).toBeUndefined();
    expect(r.metrics).toEqual([
      "daily_device_installs",
      "daily_device_uninstalls",
      "current_device_installs",
      "daily_user_installs",
      "total_user_installs",
    ]);
    expect(r.rows[2]).toEqual({
      date: "2026-09-03",
      daily_device_installs: null,
      daily_device_uninstalls: 2,
      current_device_installs: null,
      daily_user_installs: 1,
      total_user_installs: 51,
    });
  });

  it("finds the dimension column, whatever it is called, and keeps a comma in its value", () => {
    const r = readReport(utf16le('Date,Package Name,Device,Daily User Installs\n2026-09-01,a.b,"Samsung, Galaxy S24",7\n'), true);
    expect(r.dimensionHeader).toBe("Device");
    expect(r.rows[0]).toEqual({ date: "2026-09-01", dimension_value: "Samsung, Galaxy S24", daily_user_installs: 7 });
  });

  it("reads an old-style header set (Active Device Installs, * events)", () => {
    const r = readReport(utf16le("Date,Package Name,Country,Current Device Installs,Active Device Installs,Install events,Uninstall events\n2018-01-01,a.b,IL,10,8,2,1\n"), true);
    expect(r.metrics).toEqual(["current_device_installs", "active_device_installs", "install_events", "uninstall_events"]);
    expect(r.rows[0]!.dimension_value).toBe("IL");
  });

  it("an overview never grows a dimension: an unknown column passes through as a value", () => {
    const r = readReport(utf16le("Date,Package Name,Daily User Installs,Daily Active Users,Source\n2026-09-01,a.b,3,100,organic\n"), false);
    expect(r.dimensionHeader).toBeUndefined();
    expect(r.rows[0]).toEqual({ date: "2026-09-01", daily_user_installs: 3, daily_active_users: 100, source: "organic" });
    expect(monthTotals(r.rows, r.metrics).totals.daily_active_users).toBe(100);
  });

  it("a dimension file keeps a second unknown column instead of dropping it", () => {
    const r = readReport(utf16le("Date,Package Name,Device,Brand,Daily User Installs\n2026-09-01,a.b,SM-S921,Samsung,2\n"), true);
    expect(r.dimensionHeader).toBe("Device");
    expect(r.rows[0]).toEqual({ date: "2026-09-01", dimension_value: "SM-S921", brand: "Samsung", daily_user_installs: 2 });
    expect(() => readReport(utf16le("Date,Package Name,Daily User Installs\n2026-09-01,a.b,2\n"), true)).toThrow(/dimension column/);
  });

  it("drops rows without a date and refuses a date that isn't YYYY-MM-DD", () => {
    expect(readReport(utf16le("Date,Package Name,Daily User Installs\n,a.b,9\n2026-09-01,a.b,1\n"), false).rows).toHaveLength(1);
    expect(() => readReport(utf16le('Date,Package Name,Daily User Installs\n"Jan 9, 2024",a.b,1\n'), false)).toThrow(/YYYY-MM-DD/);
  });

  it("refuses a file without a Date column", () => {
    expect(() => readReport(utf16le("Package Name,Daily User Installs\na.b,1\n"), false)).toThrow(/Date/);
  });
});

describe("month totals", () => {
  it("sums Daily columns and takes snapshots from the last date that has a value", () => {
    const r = readReport(utf16le(
        [
          "Date,Package Name,Daily Device Installs,Current Device Installs,Total User Installs,Installs on active devices",
          "2026-09-02,a.b,3,101,50,90",
          "2026-09-01,a.b,5,99,48,88",
          "2026-09-03,a.b,,,51,",
        ].join("\n"),
      ),
      false,
    );
    const t = monthTotals(r.rows, r.metrics);
    expect(t.totals).toEqual({
      daily_device_installs: 8,
      current_device_installs: 101,
      total_user_installs: 51,
      installs_on_active_devices: 90,
    });
    expect(t.rules).toEqual({
      sum: ["daily_device_installs"],
      last_date: ["current_device_installs", "total_user_installs", "installs_on_active_devices"],
    });
    expect(t.last_date_present).toBe("2026-09-03");
  });

  it("an all-empty column totals null, not 0", () => {
    const t = monthTotals([{ date: "2026-09-01", daily_user_installs: null }], ["daily_user_installs"]);
    expect(t.totals.daily_user_installs).toBeNull();
  });

  it("never sums or averages a daily average rating", () => {
    expect(totalRule("daily_average_rating")).toBeUndefined();
    expect(totalRule("total_average_rating")).toBe("last_date");
    expect(totalRule("install_events")).toBe("sum");
  });
});

describe("months", () => {
  it("normalises, shifts and finds month ends", () => {
    expect(normaliseMonth("202609")).toBe("2026-09");
    expect(normaliseMonth("2026-09")).toBe("2026-09");
    expect(normaliseMonth("2026-13")).toBeUndefined();
    expect(normaliseMonth("Sept")).toBeUndefined();
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2025-12", 2)).toBe("2026-02");
    expect(lastDayOf("2024-02")).toBe("2024-02-29");
    expect(lastDayOf("2026-09")).toBe("2026-09-30");
  });
});
