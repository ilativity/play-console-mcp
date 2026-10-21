import { z } from "zod";
import { appPath, seg } from "../google/client.js";
import { withReadEdit } from "../google/edits.js";
import { SafetyError } from "../safety.js";
import { defineTool, packageArg, versionCode } from "./common.js";
import { listTracks } from "./releases.js";

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const MAX_ASSETLINKS_BYTES = 1024 * 1024;
const HANDLE_ALL_URLS = "delegate_permission/common.handle_all_urls";

/** Normalises a SHA-256 fingerprint (hex with/without colons, or base64) to AA:BB:… form. */
export function normalizeFingerprint(raw: string): string {
  const s = raw.trim();
  const hex = s.replace(/:/g, "");
  let bytes: string;
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    bytes = hex.toUpperCase();
  } else {
    const buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length !== 32) throw new SafetyError(`Not a SHA-256 fingerprint: ${raw}`);
    bytes = buf.toString("hex").toUpperCase();
  }
  return bytes.match(/../g)!.join(":");
}

interface Statement {
  relation?: string[];
  target?: { namespace?: string; package_name?: string; sha256_cert_fingerprints?: string[] };
}

export function siteFingerprints(statements: unknown, pkg: string): { found: boolean; fingerprints: string[] } {
  if (!Array.isArray(statements)) return { found: false, fingerprints: [] };
  const matching = (statements as Statement[]).filter(
    (s) =>
      s?.relation?.includes(HANDLE_ALL_URLS) && s.target?.namespace === "android_app" && s.target.package_name === pkg,
  );
  const fps = matching.flatMap((s) => s.target?.sha256_cert_fingerprints ?? []);
  const normalized: string[] = [];
  for (const fp of fps) {
    try {
      normalized.push(normalizeFingerprint(fp));
    } catch {
      // reported via the raw list below
    }
  }
  return { found: matching.length > 0, fingerprints: [...new Set(normalized)] };
}

export const twaTools = [
  defineTool({
    name: "check_asset_links",
    title: "Check Digital Asset Links",
    description:
      "For a Trusted Web Activity: fetches https://<domain>/.well-known/assetlinks.json and compares its SHA-256 fingerprints for this package with the app-signing certificate Play reports (generatedApks). A mismatch is the classic reason a TWA shows the browser URL bar. Sends no credentials to the domain. If Play reports no signing certificate, pass `fingerprint` instead.",
    kind: "read",
    input: {
      ...packageArg,
      domain: z.string().describe("Site hostname only, e.g. example.com (no scheme, port or path)."),
      version_code: versionCode.optional().describe("Version code to read the signing certificate from. Default: the highest on any track."),
      fingerprint: z.string().optional().describe("App-signing SHA-256 fingerprint to compare against, instead of asking Play."),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const domain = args.domain.trim().toLowerCase();
      if (!HOSTNAME_RE.test(domain)) throw new SafetyError(`Not a plain public hostname: ${args.domain}`);

      // 1. What Play says the app is signed with.
      let playFingerprints: string[];
      let source: string;
      if (args.fingerprint) {
        playFingerprints = [normalizeFingerprint(args.fingerprint)];
        source = "argument";
      } else {
        let code = args.version_code !== undefined ? String(args.version_code) : undefined;
        if (!code) {
          const tracks = await withReadEdit(ctx.client, pkg, (editId) => listTracks(ctx.client, pkg, editId));
          const codes = tracks.flatMap((t) => (t.releases ?? []).flatMap((r) => (r.versionCodes ?? []).map(Number)));
          if (!codes.length) throw new SafetyError("No releases found to read a signing certificate from; pass version_code or fingerprint.");
          code = String(Math.max(...codes));
        }
        const res = await ctx.client.request<{ generatedApks?: { certificateSha256Hash?: string }[] }>(
          "publisher",
          `${appPath(pkg)}/generatedApks/${seg(code)}`,
        );
        const hashes = (res?.generatedApks ?? []).map((g) => g.certificateSha256Hash).filter((h): h is string => !!h);
        if (!hashes.length) {
          throw new SafetyError(
            `Play reported no signing certificate for version ${code} (is Play App Signing enabled?). Pass fingerprint from Play Console → App integrity instead.`,
          );
        }
        playFingerprints = [...new Set(hashes.map(normalizeFingerprint))];
        source = `generatedApks for version ${code}`;
      }

      // 2. What the site publishes. Plain fetch, no credentials, no redirects.
      const url = `https://${domain}/.well-known/assetlinks.json`;
      const problems: string[] = [];
      let statements: unknown;
      try {
        const res = await ctx.publicFetch(url, {
          redirect: "manual",
          credentials: "omit",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status >= 300 && res.status < 400) {
          problems.push(`${url} redirects (${res.status}); Android does not follow redirects for asset links.`);
        } else if (!res.ok) {
          problems.push(`${url} returned HTTP ${res.status}.`);
        } else {
          const type = res.headers.get("content-type") ?? "";
          if (!type.includes("application/json")) problems.push(`Content-Type is "${type}", should be application/json.`);
          const text = await res.text();
          if (text.length > MAX_ASSETLINKS_BYTES) problems.push("assetlinks.json is larger than 1 MB.");
          else {
            try {
              statements = JSON.parse(text);
            } catch {
              problems.push("assetlinks.json is not valid JSON.");
            }
          }
        }
      } catch (e) {
        problems.push(`Could not fetch ${url}: ${(e as Error).message}`);
      }

      const site = siteFingerprints(statements, pkg);
      if (statements !== undefined && !site.found) {
        problems.push(`No handle_all_urls statement for android_app ${pkg} in assetlinks.json.`);
      }
      const matched = playFingerprints.filter((fp) => site.fingerprints.includes(fp));
      if (site.found && !matched.length) {
        problems.push("assetlinks.json lists fingerprints, but none is the app-signing certificate Play uses. Add the Play App Signing SHA-256.");
      }
      return {
        package_name: pkg,
        url,
        match: matched.length > 0 && problems.length === 0,
        play_fingerprints: playFingerprints,
        play_fingerprint_source: source,
        site_fingerprints: site.fingerprints,
        matched,
        problems,
      };
    },
  }),
];
