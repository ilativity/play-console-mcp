#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { STORAGE_SCOPE, createTokenProvider } from "./google/auth.js";
import { PlayClient } from "./google/client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // A server without a reports bucket asks Google for exactly the scopes it always did.
  const extraScopes = config.reportsBucket ? [STORAGE_SCOPE] : [];
  const client = new PlayClient({ getToken: createTokenProvider(config.authSource, fetch, Date.now, extraScopes) });
  const { server, registered } = createServer({ config, client });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr.
  const mode = config.readOnly ? "read-only" : config.allowDestructive ? "writes + destructive" : "writes (guarded)";
  console.error(`play-console-mcp: ${registered.length} tools, ${mode}${config.authSource ? (config.authSource.kind === "impersonate" ? ", keyless (impersonation)" : "") : ", NO CREDENTIALS CONFIGURED"}, install stats: ${config.reportsBucket ? "on" : "off (set PLAY_MCP_REPORTS_BUCKET)"}`);
}

main().catch((e: unknown) => {
  console.error(`play-console-mcp failed to start: ${(e as Error).message}`);
  process.exit(1);
});
