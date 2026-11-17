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
| Comic tools (Phase 2+) | stdio MCP server shipped inside the template (`mcp.json`), mounted read-only at `/workspace/agent/plugins/comic-catalog` | `templates/comic-catalog/` |

The template is stamped into a group with `ncl groups create --template comic-catalog`. `/templates/*` is gitignored upstream; `.gitignore` re-includes `templates/comic-catalog/` because it is source, not install state.

## Image path, as verified in the code

1. `@chat-adapter/slack` exposes Slack files as Chat SDK attachments; the bridge calls `fetchData()` and stores the bytes (`src/channels/chat-sdk-bridge.ts:882-904`).
2. The host writes them to `data/v2-sessions/<group>/<session>/inbox/<msgId>/<file>` (`src/session-manager.ts`), mounted at `/workspace` in the container.
3. The agent-runner tells the model only `[image: <name> — saved to /workspace/inbox/...]` (`container/agent-runner/src/formatter.ts:451-466`). No image content block is sent.
4. The ComicCatalog instructions require the agent to `Read` each image. The SDK's `Read` returns image blocks for png/jpg/gif/webp, which is how the model sees the cover.

## Gap list

| Gap | Impact | Plan |
| --- | --- | --- |
| Images only reach the model if the agent chooses to `Read` them | Vision depends on instruction-following | Instruction in template (done). Patch agent-runner to send image blocks only if live testing shows it is unreliable |
| `@chat-adapter/slack` download with bot token unverified | Saved file could be an HTML login page | Verify in Phase 1 live test |
| No size or MIME cap on inbound attachments (core) | Large uploads go base64 through memory and the DB | Document; validate in comic tools (Phase 2); consider upstream issue |
| No per-group tool restriction; all agents run `bypassPermissions` with Bash | Agent instructions cannot be the write-authorization boundary | Enforce in MCP tool code and gateway grants (Phase 4) |
| Gateway holds non-model requests for approval by default | Metron/Airtable calls would each prompt | Configure read-only hosts / grants when tools land |
| Metron HTTP Basic auth via OneCLI generic secret has no repo precedent | Credential injection may need another shape | Test in Phase 2 |
