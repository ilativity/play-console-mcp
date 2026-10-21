#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createTokenProvider } from "./google/auth.js";
import { PlayClient } from "./google/client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new PlayClient({ getToken: createTokenProvider(config.authSource) });
  const { server, registered } = createServer({ config, client });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr.
  const mode = config.readOnly ? "read-only" : config.allowDestructive ? "writes + destructive" : "writes (guarded)";
  console.error(`play-console-mcp: ${registered.length} tools, ${mode}${config.authSource ? (config.authSource.kind === "impersonate" ? ", keyless (impersonation)" : "") : ", NO CREDENTIALS CONFIGURED"}`);
}

main().catch((e: unknown) => {
  console.error(`play-console-mcp failed to start: ${(e as Error).message}`);
  process.exit(1);
});
