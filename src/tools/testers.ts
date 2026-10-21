import { z } from "zod";
import { editPath, seg } from "../google/client.js";
import { withEdit, withReadEdit } from "../google/edits.js";
import { SafetyError, assertDestructiveAllowed } from "../safety.js";
import { defineTool, editResult, packageArg, trackName, validateOnlyArg } from "./common.js";

interface Testers {
  googleGroups?: string[];
}

const groupEmail = z.string().email().describe("Google Group email address.");

export function diffGroups(before: string[], after: string[]) {
  const b = new Set(before.map((g) => g.toLowerCase()));
  const a = new Set(after.map((g) => g.toLowerCase()));
  return {
    added: after.filter((g) => !b.has(g.toLowerCase())),
    removed: before.filter((g) => !a.has(g.toLowerCase())),
    unchanged: after.filter((g) => b.has(g.toLowerCase())),
  };
}

export const testerTools = [
  defineTool({
    name: "get_testers",
    title: "Get testers",
    description: "Returns the Google Groups of testers for a testing track.",
    kind: "read",
    input: { ...packageArg, track: trackName },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      return withReadEdit(ctx.client, pkg, async (editId) => {
        const res = await ctx.client.request<Testers>("publisher", `${editPath(pkg, editId)}/testers/${seg(args.track)}`);
        return { track: args.track, google_groups: res?.googleGroups ?? [] };
      });
    },
  }),

  defineTool({
    name: "update_testers",
    title: "Update testers",
    description:
      "Adds and/or removes tester Google Groups on a testing track and shows the before/after difference. Replacing the whole list (replace) is destructive and needs PLAY_MCP_ALLOW_DESTRUCTIVE=1.",
    kind: "write",
    idempotent: true,
    input: {
      ...packageArg,
      track: trackName,
      add: z.array(groupEmail).optional(),
      remove: z.array(groupEmail).optional(),
      replace: z.array(groupEmail).optional().describe("DESTRUCTIVE: the complete new list. Cannot be combined with add/remove."),
      ...validateOnlyArg,
    },
    async handler(args, ctx) {
      const pkg = ctx.pkg(args.package_name);
      const hasDelta = (args.add?.length ?? 0) + (args.remove?.length ?? 0) > 0;
      if (args.replace && hasDelta) throw new SafetyError("Use either replace, or add/remove — not both.");
      if (!args.replace && !hasDelta) throw new SafetyError("Nothing to change: pass add, remove, or replace.");
      if (args.replace) assertDestructiveAllowed(ctx.config, "Replacing the whole tester list");

      const outcome = await withEdit(
        ctx.client,
        pkg,
        async (editId) => {
          const path = `${editPath(pkg, editId)}/testers/${seg(args.track)}`;
          const before = (await ctx.client.request<Testers>("publisher", path))?.googleGroups ?? [];
          let next: string[];
          if (args.replace) {
            next = [...args.replace];
          } else {
            const removing = new Set((args.remove ?? []).map((g) => g.toLowerCase()));
            next = before.filter((g) => !removing.has(g.toLowerCase()));
            for (const g of args.add ?? []) {
              if (!next.some((x) => x.toLowerCase() === g.toLowerCase())) next.push(g);
            }
          }
          const res = await ctx.client.request<Testers>("publisher", path, { method: "PATCH", json: { googleGroups: next } });
          const after = res?.googleGroups ?? next;
          return { track: args.track, before, after, diff: diffGroups(before, after) };
        },
        { validateOnly: args.validate_only },
      );
      return editResult(outcome);
    },
  }),
];
