# Notice

play-console-mcp is an original implementation. Its design draws on three MIT-licensed
community MCP servers for Google Play, which we read and compared before writing it:

- [lusky3/play-store-mcp](https://github.com/lusky3/play-store-mcp) — the one-call `deploy`
  idea and a read-only switch.
- [OrellBuehler/play-console-mcp](https://github.com/OrellBuehler/play-console-mcp) — the
  overall architecture: TypeScript, direct REST calls over `fetch`, a local service-account JWT.
- [AgiMaulana/GooglePlayConsoleMcp](https://github.com/AgiMaulana/GooglePlayConsoleMcp) —
  flagging vitals against Google's bad-behaviour thresholds.

No code was copied from these projects; everything here was written from scratch. If that
ever changes, the copied file keeps its project's MIT copyright line and it is listed here.
