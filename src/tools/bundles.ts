import { z } from "zod";
import { editPath, seg, type PlayClient } from "../google/client.js";
import { withEdit, withReadEdit } from "../google/edits.js";
import { uploadMedia } from "../google/upload.js";
import {
  defineTool,
  editResult,
  packageArg,
  readUploadFile,
  validateOnlyArg,
  versionCode,
  type ToolContext,
} from "./common.js";

export interface Bundle {
  versionCode: number;
  sha1?: string;
  sha256?: string;
}

/** Uploads an AAB inside an open edit and returns the new bundle (with its version code). */
export async function uploadBundleToEdit(client: PlayClient, pkg: string, editId: string, data: Uint8Array): Promise<Bundle> {
  return uploadMedia<Bundle>(client, `${editPath(pkg, editId)}/bundles`, data, "application/octet-stream");
}

export async function uploadMappingToEdit(
  client: PlayClient,
  pkg: string,
  editId: string,
  version: number | string,
  data: Uint8Array,
): Promise<unknown> {
  return uploadMedia(
    client,
    `${editPath(pkg, editId)}/apks/${seg(version)}/deobfuscationFiles/proguard`,
    data,
    "application/octet-stream",
  );
}

export async function readBundle(ctx: ToolContext, path: string) {
  return readUploadFile(ctx, path, [".aab"]);
}

export async function readMapping(ctx: ToolContext, path: string) {
  return readUploadFile(ctx, path, [".txt"], 300 * 1024 * 1024);
}

export const bundleTools = [
  defineTool({
    name: "list_bundles",
    title: "List bundles",
    description: "Lists the app bundles (AABs) uploaded for the app, with version codes and hashes.",
    kind: "read",
    input: { ...packageArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return withReadEdit(ctx.client, pkg, async (editId) => {
        const res = await ctx.client.request<{ bundles?: Bundle[] }>("publisher", `${editPath(pkg, editId)}/bundles`);
        return { bundles: res?.bundles ?? [] };
      });
    },
  }),

  defineTool({
    name: "upload_bundle",
    title: "Upload bundle",
    description:
      "Uploads an Android App Bundle (.aab) to the app's bundle library without assigning it to a track. Files over 10 MB use a resumable upload. Use `deploy` to upload and release in one step.",
    kind: "write",
    input: {
      ...packageArg,
      file_path: z.string().describe("Path to the .aab file."),
      ...validateOnlyArg,
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const { realPath, data } = await readBundle(ctx, args.file_path);
      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => ({ file: realPath, bundle: await uploadBundleToEdit(ctx.client, pkg, editId, data) }),
        { validateOnly: args.validate_only },
      );
      return editResult(outcome);
    },
  }),

  defineTool({
    name: "upload_deobfuscation_file",
    title: "Upload deobfuscation file",
    description: "Uploads a ProGuard/R8 mapping.txt for a version code, so crash stack traces are readable.",
    kind: "write",
    idempotent: true,
    input: {
      ...packageArg,
      version_code: versionCode.describe("Version code the mapping belongs to."),
      file_path: z.string().describe("Path to mapping.txt."),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const { realPath, data } = await readMapping(ctx, args.file_path);
      const outcome = await withEdit(ctx.client, pkg, async (editId) => ({
        file: realPath,
        response: await uploadMappingToEdit(ctx.client, pkg, editId, args.version_code, data),
      }));
      return editResult(outcome);
    },
  }),

  defineTool({
    name: "upload_internal_sharing",
    title: "Upload for internal app sharing",
    description:
      "Uploads an .aab or .apk to internal app sharing and returns a download link for testers. Bypasses tracks and review; links are for testing only.",
    kind: "write",
    input: {
      ...packageArg,
      file_path: z.string().describe("Path to an .aab or .apk file."),
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const { realPath, data } = await readUploadFile(ctx, args.file_path, [".aab", ".apk"]);
      const kind = realPath.toLowerCase().endsWith(".apk") ? "apk" : "bundle";
      const res = await uploadMedia(
        ctx.client,
        `/applications/internalappsharing/${seg(pkg)}/artifacts/${kind}`,
        data,
        "application/octet-stream",
      );
      return { file: realPath, artifact: res };
    },
  }),
];
