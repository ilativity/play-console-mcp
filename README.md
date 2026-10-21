# play-console-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Google Play Console**: releases and
staged rollouts, Android vitals, reviews, store listing, testers, and a Digital Asset Links check
for Trusted Web Activities. Write tools are on by default but guarded, so a careless call gives you
a preview, not a release.

- stdio only (no network listener), Node ≥ 20
- three runtime dependencies: `@modelcontextprotocol/sdk`, `zod`, `jose`
- talks straight to the Google REST APIs over `fetch`; the bearer token can only go to a
  hard-coded list of Google hosts
- published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  so you can check that the tarball was built from this repository

## Install

Pin an exact version. Don't use a floating `latest`:

```bash
claude mcp add -s user play-console \
  -e PLAY_MCP_KEY_PATH=/path/to/service-account.json \
  -e PLAY_MCP_PACKAGE=com.example.app \
  -- npx -y @ilativity/play-console-mcp@1.0.0
```

Or in any MCP client's JSON config:

```json
{
  "mcpServers": {
    "play-console": {
      "command": "npx",
      "args": ["-y", "@ilativity/play-console-mcp@1.0.0"],
      "env": { "PLAY_MCP_KEY_PATH": "/path/to/service-account.json", "PLAY_MCP_READ_ONLY": "1" }
    }
  }
}
```

Check the published build: `npm view @ilativity/play-console-mcp@1.0.0` and the provenance
panel on npmjs.com.

## Service account: grant the narrowest role

**The real security boundary is the service account's role in Play Console.** This server's gates
are a second layer on top of it.

1. In Google Cloud, create a service account and a JSON key, then enable the **Google Play Android
   Developer API** and the **Google Play Developer Reporting API**.
2. In Play Console → **Users and permissions**, invite the service account's email. Give it access
   to **only the apps it needs**, with only the permissions you want an agent to have. For a
   read-only setup that means *View app information* and *View app quality information*. Add the
   release permissions only if you'll use the release tools.
3. Keep the key file outside any repository.

## Configuration

| Variable | Meaning |
|---|---|
| `PLAY_MCP_KEY_PATH` | Path to the service-account JSON key (preferred). |
| `PLAY_MCP_KEY` | The key JSON inline (for secret managers). |
| `GOOGLE_APPLICATION_CREDENTIALS` | Fallback key path. |
| `PLAY_MCP_PACKAGE` | Default package name; every tool also accepts `package_name`. |
| `PLAY_MCP_READ_ONLY=1` | Register **only** read tools. The client never sees a write tool. |
| `PLAY_MCP_ALLOW_DESTRUCTIVE=1` | Register the destructive tools (delete images or listings) and allow replacing a whole tester list. |
| `PLAY_MCP_FILE_ROOT` | If set, upload tools only read files under this directory. Symlinks are resolved first, so they can't escape it. |

The token is cached in memory only. The key and the token never appear in tool output or logs.

## Safety model

1. **Writes are on, but guarded.** Use `PLAY_MCP_READ_ONLY=1` to turn them off completely.
2. **There is no default rollout.** A release with status `inProgress` needs
   `rollout_percentage`. Leaving it out is an error. It never becomes a silent 100%.
3. **Production needs explicit confirmation.** Any write that touches `production` (or a
   form-factor production track such as `wear:production`) needs `confirm_production: true`.
   That covers creating, deploying, promoting into it, and changing, halting, resuming or
   completing its rollout. Without the flag the call runs as a **dry run**: the edit is validated,
   then discarded, and you get back what *would* have happened.
4. **Dry runs everywhere.** Edit-based writes accept `validate_only`. `reply_to_review` accepts
   `dry_run`.
5. **Destructive tools are off** unless you set `PLAY_MCP_ALLOW_DESTRUCTIVE=1`.
6. **Every tool has MCP annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
   `openWorldHint`), so your client can ask you before a write.
7. **Edits never leak.** Every edit that isn't committed is deleted, whether the call fails or was
   a dry run. For apps with managed publishing, a commit that Google won't send for review is
   committed *without* sending, and the result tells you to send it from Play Console.
8. **Releases keep what must stay.** When a staged rollout starts, the completed release that still
   serves everyone else stays on the track. `promote_release` keeps the destination's other
   releases instead of replacing them.

## Tools

**R** = read, **W** = write, **D** = destructive (off by default).

| Area | Tools |
|---|---|
| Releases | `list_tracks` R, `get_track` R, `list_releases` R, `release_status` R (all tracks in one call), `create_release` W, `deploy` W (upload AAB, add mapping, create release and notes in **one edit**), `promote_release` W, `update_rollout` W, `halt_rollout` W, `resume_rollout` W |
| Bundles | `list_bundles` R, `upload_bundle` W (resumable above 10 MB), `upload_deobfuscation_file` W, `upload_internal_sharing` W |
| Vitals | `crash_rate`, `anr_rate`, `slow_start_rate`, `slow_rendering_rate`, `excessive_wakeup_rate`, `stuck_wakelock_rate`, `vitals_summary` (flagged against Google's thresholds: user-perceived crash rate 1.09%, ANR rate 0.47%), `vitals_by_version` (did the last release make things worse?), `search_error_issues`, `search_error_reports`, `list_anomalies`, `vitals_freshness`. All R |
| Reviews | `list_reviews` R (filter by stars, language, unanswered only), `get_review` R, `reply_to_review` W (public; 350-character limit; `dry_run`) |
| Store listing | `list_listings`, `get_listing`, `get_app_details`, `list_images` R; `update_listing`, `update_app_details`, `upload_image` (PNG/JPEG, 15 MB) W; `delete_image`, `delete_all_images`, `delete_listing` **D** |
| Testers | `get_testers` R, `update_testers` W (add/remove with a before/after diff; `replace` is **D**) |
| Apps | `list_apps` R (the apps this service account can see), `app_overview` R (release status, vitals and unanswered reviews in one answer) |
| TWA | `check_asset_links` R: compares `https://<domain>/.well-known/assetlinks.json` with the app-signing certificate Play reports. A mismatch is the usual reason a TWA shows the browser URL bar. This is the only tool that contacts a non-Google host, and it sends no credentials there. |

## What the Play APIs don't offer

Google provides no API for these, so this server can't do them: the **Data safety** form,
**content rating**, the **production access** questionnaire, and **tester opt-in counts**.

Two other limits are worth knowing:
- Reviews: the API returns only reviews from about the **last week**. Older ones are in Play
  Console only.
- Vitals: values lag a day or two. Use `vitals_freshness` to see the latest date available.

Out of scope on purpose: purchases, subscriptions, refunds and in-app products; managing Play
Console users and permissions; app recovery; HTTP transport.

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
npm run build      # → dist/
```

Tests use vitest with `fetch` mocked: a stateful fake of the edits API, driven through a real
MCP client over an in-memory transport.

## License

MIT, see [LICENSE](LICENSE). Credits for design ideas are in [NOTICE.md](NOTICE.md).
