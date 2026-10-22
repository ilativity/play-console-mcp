/**
 * Reading Play's bulk-report CSVs (stats/installs, stats/ratings). The files are
 * UTF-16, their columns change between years, and device/carrier names contain commas,
 * so nothing here trusts position, encoding or a naive split.
 */

export type ReportKind = "installs" | "ratings";

export interface ReportName {
  kind: ReportKind;
  package: string;
  /** YYYY-MM */
  month: string;
  /** overview, app_version, carrier, country, device, language, os_version, … */
  dimension: string;
}

const NAME_RE = /^stats\/(installs|ratings)\/(installs|ratings)_(.+)_(\d{4})(\d{2})_([a-z][a-z_]*)\.csv$/;

/** `stats/installs/installs_<pkg>_<yyyyMM>_<dimension>.csv` → its parts; anything else → undefined. */
export function parseReportName(name: string): ReportName | undefined {
  const m = NAME_RE.exec(name);
  if (!m || m[1] !== m[2]) return undefined;
  const month = Number(m[5]);
  if (month < 1 || month > 12) return undefined;
  return { kind: m[1] as ReportKind, package: m[3]!, month: `${m[4]}-${m[5]}`, dimension: m[6]! };
}

export function reportObjectName(kind: ReportKind, pkg: string, month: string, dimension: string): string {
  return `stats/${kind}/${kind}_${pkg}_${month.replace("-", "")}_${dimension}.csv`;
}

function swapBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1]!;
    out[i + 1] = bytes[i]!;
  }
  return out;
}

/** Decodes by BOM (UTF-16LE/BE, UTF-8); without one, sniffs for UTF-16LE, else UTF-8. */
export function decodeCsv(bytes: Uint8Array): string {
  const le = new TextDecoder("utf-16le");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return le.decode(bytes.subarray(2));
  // Swapped and decoded as LE, so it doesn't depend on Node's ICU build having utf-16be.
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return le.decode(swapBytes(bytes.subarray(2)));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  // ASCII-range text in UTF-16LE has a zero at most odd offsets; UTF-8 text has none.
  const sample = Math.min(bytes.length - (bytes.length % 2), 2048);
  let oddZeros = 0;
  for (let i = 1; i < sample; i += 2) if (bytes[i] === 0) oddZeros++;
  if (sample >= 2 && oddZeros >= sample / 2 / 2) return le.decode(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  return new TextDecoder("utf-8").decode(bytes);
}

/** RFC 4180: quoted fields, "" escapes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    field = "";
    // A blank line (one empty field) is not a row.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") endRow();
    else field += c;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

export function snakeCase(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// A metric column counts something or rates something; everything else is a label.
const METRIC_RE = /(^|_)(installs?|uninstalls?|upgrades?|updates?|events?|rating|ratings)(_|$)/;

export type ReportValue = string | number | null;

export interface ReportRow {
  date: string;
  /** The value of the file's dimension column (country code, device, …); absent in overview files. */
  dimension_value?: string;
  [metric: string]: ReportValue | undefined;
}

export interface ParsedReport {
  /** snake_case metric columns, in file order. */
  metrics: string[];
  /** The original header of the dimension column, if the file has one. */
  dimensionHeader?: string;
  rows: ReportRow[];
}

function toNumber(cell: string | undefined): number | null {
  const t = cell?.trim() ?? "";
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Maps rows by header name. Metric cells become numbers (an empty cell is null, never 0);
 * the one column that is neither Date, Package Name nor a metric is `dimension_value`.
 */
export function normaliseReport(table: string[][]): ParsedReport {
  const [header, ...body] = table;
  if (!header) return { metrics: [], rows: [] };
  const keys = header.map(snakeCase);
  const dateIdx = keys.indexOf("date");
  if (dateIdx < 0) throw new Error(`Report has no Date column (header: ${header.join(", ")}).`);
  const metricIdx: number[] = [];
  let dimIdx: number | undefined;
  keys.forEach((k, i) => {
    if (i === dateIdx || k === "package_name") return;
    if (METRIC_RE.test(k)) metricIdx.push(i);
    else dimIdx ??= i;
  });
  const rows = body.map((cells) => {
    const row: ReportRow = { date: cells[dateIdx]?.trim() ?? "" };
    if (dimIdx !== undefined) row.dimension_value = cells[dimIdx]?.trim() ?? "";
    for (const i of metricIdx) row[keys[i]!] = toNumber(cells[i]);
    return row;
  });
  return {
    metrics: metricIdx.map((i) => keys[i]!),
    ...(dimIdx !== undefined ? { dimensionHeader: header[dimIdx] } : {}),
    rows,
  };
}

export function readReport(bytes: Uint8Array): ParsedReport {
  return normaliseReport(parseCsv(decodeCsv(bytes)));
}

export type TotalRule = "sum" | "last_date";

/**
 * How a column becomes one number for the month: per-day counts (`Daily *`, old `* events`)
 * are summed; snapshots (`Current *`, `Total *`, `Active *`, installs on active devices)
 * take the value on the last date present. Anything else — daily average ratings above
 * all — has no month total.
 */
export function totalRule(metric: string): TotalRule | undefined {
  if (metric.includes("rating")) return metric.startsWith("total_") ? "last_date" : undefined;
  if (metric.startsWith("daily_") || metric.endsWith("_events")) return "sum";
  if (/^(current|total|active)_/.test(metric) || metric === "installs_on_active_devices") return "last_date";
  return undefined;
}

export interface MonthTotals {
  totals: Record<string, number | null>;
  /** Which columns each rule produced, so no reader mistakes a snapshot for a sum. */
  rules: Partial<Record<TotalRule, string[]>>;
  last_date_present: string | undefined;
}

/** Month totals over rows of ONE series (an overview file, or one dimension value). */
export function monthTotals(rows: ReportRow[], metrics: string[]): MonthTotals {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted.at(-1);
  const totals: Record<string, number | null> = {};
  const rules: Partial<Record<TotalRule, string[]>> = {};
  for (const m of metrics) {
    const rule = totalRule(m);
    if (!rule) continue;
    (rules[rule] ??= []).push(m);
    if (rule === "sum") {
      const values = sorted.map((r) => r[m]).filter((v): v is number => typeof v === "number");
      totals[m] = values.length ? values.reduce((a, b) => a + b, 0) : null;
    } else {
      // The last date that has a value, so one blank trailing cell doesn't erase the snapshot.
      const withValue = sorted.filter((r) => typeof r[m] === "number");
      totals[m] = (withValue.at(-1)?.[m] as number | undefined) ?? null;
    }
  }
  return { totals, rules, last_date_present: last?.date };
}

/** The last calendar day of a YYYY-MM month, as YYYY-MM-DD. */
export function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** `YYYY-MM` or `YYYYMM` → `YYYY-MM`; anything else → undefined. */
export function normaliseMonth(value: string): string | undefined {
  const m = /^(\d{4})-?(\d{2})$/.exec(value.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return undefined;
  return `${m[1]}-${m[2]}`;
}

/** Shifts a YYYY-MM month by `delta` months. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
