# comic-archive architecture

comic-archive is a NanoClaw v2 install (fork of `qwibitai/nanoclaw`) plus one agent, ComicCatalog, that identifies comic covers sent as Slack photos. Upstream's own architecture writeup is [`../architecture.md`](../architecture.md); this file covers only what comic-archive adds and where it plugs in. The full plan is [`/PLAN.md`](../../PLAN.md).

## Principle

Everything comic-specific rides NanoClaw's supported extension points. No core patches so far. New files only, plus a one-line `.gitignore` exception, so upstream updates merge cleanly.

## Extension points used

| Need | Extension point | Where |
| --- | --- | --- |
| Agent persona and rules | Agent template (Agent Plugins 1.0.0) | `templates/comic-catalog/` |
| Slack intake and threaded replies | `/add-slack` channel skill (Chat SDK, upstream `channels` branch) | installed into `src/channels/` by the skill |
| Images reaching the agent | Host downloads attachments to the session inbox; agent opens them with `Read` | `src/channels/chat-sdk-bridge.ts`, `src/session-manager.ts`, `container/agent-runner/src/formatter.ts` |
| Credentials (model, later Metron/Airtable) | OneCLI credential gateway, per-host secrets granted per agent | `/add-onecli` |
| Comic tools (built, Phase 2) | stdio MCP server `comic-catalog` shipped inside the template (`mcp.json`), mounted read-only at `/workspace/agent/plugins/comic-catalog`; tools `identify_comic` and `get_comic` | `templates/comic-catalog/` |

The template is stamped into a group with `ncl groups create --template comic-catalog`. `/templates/*` is gitignored upstream; `.gitignore` re-includes `templates/comic-catalog/` because it is source, not install state.

## Image path, as verified in the code

1. `@chat-adapter/slack` exposes Slack files as Chat SDK attachments; the bridge calls `fetchData()` and stores the bytes (`src/channels/chat-sdk-bridge.ts:882-904`).
2. The host writes them to `data/v2-sessions/<group>/<session>/inbox/<msgId>/<file>` (`src/session-manager.ts`), mounted at `/workspace` in the container.
3. The agent-runner tells the model only `[image: <name> — saved to /workspace/inbox/...]` (`container/agent-runner/src/formatter.ts:451-466`). No image content block is sent.
4. The ComicCatalog instructions require the agent to `Read` each image. The SDK's `Read` returns image blocks for png/jpg/gif/webp, which is how the model sees the cover.

## Gap list

| Gap | Impact | Plan |
| --- | --- | --- |
| Images only reach the model if the agent chooses to `Read` them | Vision depends on instruction-following | Instruction in template (done). Phase 1 live test: agent read the image and described the cover accurately. Patch agent-runner to send image blocks only if it proves unreliable |
| `@chat-adapter/slack` download with bot token | Saved file could be an HTML login page | Verified in Phase 1 live test: the saved inbox file is the real PNG |
| No size or MIME cap on inbound attachments (core) | Large uploads go base64 through memory and the DB | Document; validate in comic tools (Phase 2); consider upstream issue |
| No per-group tool restriction; all agents run `bypassPermissions` with Bash | Agent instructions cannot be the write-authorization boundary | Enforce in MCP tool code and gateway grants (Phase 4) |
| Gateway holds non-model requests for approval by default | Metron/Airtable calls would each prompt | Metron: no prompt on a granted secret (verified). Recheck for Airtable writes |
| Metron credential via OneCLI | Resolved | API token as a generic secret (`metron`, host `metron.cloud`, path `/api/*`, `Authorization: Bearer {value}`), granted to ComicCatalog only. Verified with `onecli run --agent <ComicCatalog identifier> -- curl …` |
| Pre-2000s UPCs identify the series, not the issue (issue is in the add-on digits) | `upc_starts_with` returns many issues, and Metron lacks UPCs for some | Use UPC to narrow the series, then `series_name` + `number` (+ `cover_year`); never accept a UPC hit alone |

## Metron lookup

Findings that shape `identify_comic`:

- Modern barcodes are stored as 17 digits: the 12-digit main code with its check digit, plus a 5-digit add-on.
- Older Marvel barcodes are stored as an 11-digit body plus a 2-digit add-on (the cover month), with no check digit.
- `upc_starts_with` takes 11 digits.
- Some issues (for example 13806) have no barcode in Metron, so a barcode miss is not a no-match.
- Trades: there is no ISBN search. A multi-type `series_type_id` returns 400, so the lookup runs a TPB search, then one unfiltered title search keeping Hardcover and Omnibus.
- A 60 s total wait budget applies per lookup; beyond it the tool returns `lookup_failed`.
