import { z } from "zod";
import { editPath, seg } from "../google/client.js";
import { withEdit, withReadEdit } from "../google/edits.js";
import { uploadMedia } from "../google/upload.js";
import { SafetyError } from "../safety.js";
import { defineTool, editResult, languageCode, packageArg, readUploadFile, validateOnlyArg } from "./common.js";

export const IMAGE_TYPES = [
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "tvScreenshots",
  "wearScreenshots",
  "icon",
  "featureGraphic",
  "tvBanner",
] as const;

export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

const imageType = z.enum(IMAGE_TYPES);

const listingPath = (pkg: string, editId: string, language: string) => `${editPath(pkg, editId)}/listings/${seg(language)}`;

export const listingTools = [
  defineTool({
    name: "list_listings",
    title: "List store listings",
    description: "Lists the store listing (title, descriptions) for every language.",
    kind: "read",
    input: { ...packageArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return withReadEdit(ctx.client, pkg, async (editId) => {
        const res = await ctx.client.request<{ listings?: unknown[] }>("publisher", `${editPath(pkg, editId)}/listings`);
        return { listings: res?.listings ?? [] };
      });
    },
  }),

  defineTool({
    name: "get_listing",
    title: "Get store listing",
    description: "Returns the store listing for one language.",
    kind: "read",
    input: { ...packageArg, language: languageCode },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return withReadEdit(ctx.client, pkg, (editId) => ctx.client.request("publisher", listingPath(pkg, editId, args.language)));
    },
  }),

  defineTool({
    name: "get_app_details",
    title: "Get app details",
    description: "Returns the app's default language and contact email, phone and website.",
    kind: "read",
    input: { ...packageArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return withReadEdit(ctx.client, pkg, (editId) => ctx.client.request("publisher", `${editPath(pkg, editId)}/details`));
    },
  }),

  defineTool({
    name: "list_images",
    title: "List images",
    description: "Lists the images of one type (screenshots, icon, feature graphic…) for a language.",
    kind: "read",
    input: { ...packageArg, language: languageCode, image_type: imageType },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return withReadEdit(ctx.client, pkg, async (editId) => {
        const res = await ctx.client.request<{ images?: unknown[] }>(
          "publisher",
          `${listingPath(pkg, editId, args.language)}/${seg(args.image_type)}`,
        );
        return { images: res?.images ?? [] };
      });
    },
  }),

  defineTool({
    name: "update_listing",
    title: "Update store listing",
    description:
      "Updates the store listing for one language. Only the fields you pass change. Limits: title 30, short description 80, full description 4000 characters.",
    kind: "write",
    idempotent: true,
    input: {
      ...packageArg,
      language: languageCode,
      title: z.string().max(30).optional(),
      short_description: z.string().max(80).optional(),
      full_description: z.string().max(4000).optional(),
      video: z.string().url().optional().describe("YouTube URL for the promo video."),
      ...validateOnlyArg,
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const patch: Record<string, string> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.short_description !== undefined) patch.shortDescription = args.short_description;
      if (args.full_description !== undefined) patch.fullDescription = args.full_description;
      if (args.video !== undefined) patch.video = args.video;
      if (Object.keys(patch).length === 0) throw new SafetyError("Nothing to update: pass at least one listing field.");
      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => {
          const path = listingPath(pkg, editId, args.language);
          const before = await ctx.client.request("publisher", path).catch(() => null);
          const after = await ctx.client.request("publisher", path, { method: "PATCH", json: patch });
          return { before, after };
        },
        { validateOnly: args.validate_only },
      );
      return editResult(outcome);
    },
  }),

  defineTool({
    name: "update_app_details",
    title: "Update app details",
    description: "Updates the app's default language and/or contact email, phone and website.",
    kind: "write",
    idempotent: true,
    input: {
      ...packageArg,
      default_language: languageCode.optional(),
      contact_email: z.string().email().optional(),
      contact_phone: z.string().max(40).optional(),
      contact_website: z.string().url().optional(),
      ...validateOnlyArg,
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const patch: Record<string, string> = {};
      if (args.default_language !== undefined) patch.defaultLanguage = args.default_language;
      if (args.contact_email !== undefined) patch.contactEmail = args.contact_email;
      if (args.contact_phone !== undefined) patch.contactPhone = args.contact_phone;
      if (args.contact_website !== undefined) patch.contactWebsite = args.contact_website;
      if (Object.keys(patch).length === 0) throw new SafetyError("Nothing to update: pass at least one field.");
      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => {
          const path = `${editPath(pkg, editId)}/details`;
          const before = await ctx.client.request("publisher", path);
          const after = await ctx.client.request("publisher", path, { method: "PATCH", json: patch });
          return { before, after };
        },
        { validateOnly: args.validate_only },
      );
      return editResult(outcome);
    },
  }),

  defineTool({
    name: "upload_image",
    title: "Upload image",
    description: "Uploads one listing image (PNG or JPEG, max 15 MB) of the given type for a language.",
    kind: "write",
    input: {
      ...packageArg,
      language: languageCode,
      image_type: imageType,
      file_path: z.string().describe("Path to a .png, .jpg or .jpeg file."),
      ...validateOnlyArg,
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const { realPath, data } = await readUploadFile(ctx, args.file_path, [".png", ".jpg", ".jpeg"], IMAGE_MAX_BYTES);
      const contentType = realPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => ({
          file: realPath,
          image: await uploadMedia(ctx.client, `${listingPath(pkg, editId, args.language)}/${seg(args.image_type)}`, data, contentType),
        }),
        { validateOnly: args.validate_only },
      );
      return editResult(outcome);
    },
  }),

  defineTool({
    name: "delete_image",
    title: "Delete image",
    description: "DESTRUCTIVE: deletes one listing image by id.",
    kind: "destructive",
    idempotent: true,
    input: { ...packageArg, language: languageCode, image_type: imageType, image_id: z.string().min(1), ...validateOnlyArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => {
          await ctx.client.request("publisher", `${listingPath(pkg, editId, args.language)}/${seg(args.image_type)}/${seg(args.image_id)}`, {
            method: "DELETE",
          });
          return { deleted: args.image_id };
        },
        { validateOnly: args.validate_only },
      );
      return editResult(outcome);
    },
  }),

  defineTool({
    name: "delete_all_images",
    title: "Delete all images",
    description: "DESTRUCTIVE: deletes every image of one type for a language.",
    kind: "destructive",
    idempotent: true,
    input: { ...packageArg, language: languageCode, image_type: imageType, ...validateOnlyArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const outcome = await withEdit(
        ctx.client,
        pkg,
        (editId) =>
          ctx.client.request("publisher", `${listingPath(pkg, editId, args.language)}/${seg(args.image_type)}`, { method: "DELETE" }),
        { validateOnly: args.validate_only },
      );
      return editResult(outcome);
    },
  }),

  defineTool({
    name: "delete_listing",
    title: "Delete store listing",
    description: "DESTRUCTIVE: deletes the store listing for one language.",
    kind: "destructive",
    idempotent: true,
    input: { ...packageArg, language: languageCode, ...validateOnlyArg },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => {
          await ctx.client.request("publisher", listingPath(pkg, editId, args.language), { method: "DELETE" });
          return { deleted_language: args.language };
        },
        { validateOnly: args.validate_only },
      );
      return editResult(outcome);
    },
  }),
];
