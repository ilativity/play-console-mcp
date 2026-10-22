import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { GoogleApiError, type PlayClient } from "./google/client.js";
import { annotationsFor, shouldRegister } from "./safety.js";
import { resolvePackage, type ToolContext, type ToolDef } from "./tools/common.js";
import { appsTools } from "./tools/apps.js";
import { bundleTools } from "./tools/bundles.js";
import { listingTools } from "./tools/listing.js";
import { releaseTools } from "./tools/releases.js";
import { reviewTools } from "./tools/reviews.js";
import { statsTools } from "./tools/stats.js";
import { testerTools } from "./tools/testers.js";
import { twaTools } from "./tools/twa.js";
import { vitalsTools } from "./tools/vitals.js";

export const VERSION = "1.0.0";

export const ALL_TOOLS: ToolDef[] = [
  ...releaseTools,
  ...bundleTools,
  ...vitalsTools,
  ...reviewTools,
  ...listingTools,
  ...testerTools,
  ...appsTools,
  ...twaTools,
  ...statsTools,
];

export interface ServerDeps {
  config: Config;
  client: PlayClient;
  publicFetch?: typeof fetch;
  tools?: ToolDef[];
}

export function formatError(e: unknown): string {
  if (e instanceof GoogleApiError) {
    return `${e.message}\n\n${JSON.stringify(e.body, null, 2)}`;
  }
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export function createServer(deps: ServerDeps): { server: McpServer; registered: string[] } {
  const { config, client } = deps;
  const server = new McpServer({ name: "play-console-mcp", version: VERSION });
  const ctx: ToolContext = {
    client,
    config,
    publicFetch: deps.publicFetch ?? fetch,
    pkg: (arg) => resolvePackage(arg, config.defaultPackage),
  };

  const registered: string[] = [];
  for (const tool of deps.tools ?? ALL_TOOLS) {
    if (!shouldRegister(tool.kind, config, tool.requires)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(tool.input),
        annotations: { title: tool.title, ...annotationsFor(tool.kind, tool.idempotent) },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await tool.handler(args as never, ctx);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text", text: formatError(e) }] };
        }
      },
    );
    registered.push(tool.name);
  }
  return { server, registered };
}
