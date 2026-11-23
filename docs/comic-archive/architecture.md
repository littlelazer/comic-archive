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
| Comic tools (built, Phase 2) | stdio MCP server `comic-catalog` shipped inside the template (`mcp.json`), mounted read-only at `/workspace/agent/plugins/comic-catalog`; tools `identify_comic`, `get_comic` and (Phase 3) `confirm_choice`; buttons through NanoClaw's `ask_user_question` | `templates/comic-catalog/` |

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
| Slack Interactivity is off in Socket Mode (upstream `/add-slack` Socket Mode steps never enable it; `src/provisioning/slack-app.ts` sets `interactivity.is_enabled: false`) | `ask_user_question` taps never reach NanoClaw | littlelazer turns on Interactivity & Shortcuts in the Slack app (no Request URL needed in Socket Mode); consider an upstream issue |
| Pre-2000s UPCs identify the series, not the issue (issue is in the add-on digits) | `upc_starts_with` returns many issues, and Metron lacks UPCs for some | Use UPC to narrow the series, then `series_name` + `number` (+ `cover_year`); never accept a UPC hit alone |

## Metron lookup

Findings that shape `identify_comic`:

- Modern barcodes are stored as 17 digits: the 12-digit main code with its check digit, plus a 5-digit add-on.
- Older Marvel barcodes are stored as an 11-digit body plus a 2-digit add-on (the cover month), with no check digit.
- `upc_starts_with` takes 11 digits.
- Some issues (for example 13806) have no barcode in Metron, so a barcode miss is not a no-match.
- Trades: there is no ISBN search. A multi-type `series_type_id` returns 400, so the lookup runs a TPB search, then one unfiltered title search keeping Hardcover and Omnibus.
- A 60 s total wait budget applies per lookup; beyond it the tool returns `lookup_failed`.
- The printed publisher is not matched against Metron's: names change across eras (Solar, Man of the Atom #55 reads "Acclaim Comics", Metron lists "Valiant"). So a comic from a publisher Metron lacks can come back `ambiguous` rather than `no_match` when Metron has a same-titled series.

## Covers and confirmation (Phase 3)

Design: [`../superpowers/specs/2026-11-18-comic-archive-phase3-design.md`](../superpowers/specs/2026-11-18-comic-archive-phase3-design.md).

### Metron variant data

Each issue detail has `variants[]`, each with `name`, `price`, `sku`, `upc` and `image` (verified on Absolute Batman (2024) #1, Metron 127884, 74 variants). Variant barcodes share the main barcode and differ in the 5-digit add-on (main add-on `00111`, 10th printing `00110`). Some store variants have no `sku` or `upc`, and some have no `image`. Older issues often list no variants and no barcode. Metron's `upc` filter matches main or variant barcodes, so an exact barcode search can land on an issue through a variant. Metron may drop a barcode's leading zero (Solar #55 is stored as 17 digits), so barcodes are compared without leading zeros.

Cover images live on `static.metron.cloud`, outside the API. A download through the gateway carries no rate-limit headers and does not use up the API's burst or sustained allowance (observed in `cover.live.test.ts`).

### The cover steps

They run only on a `confirmed` result (from `identify_comic` or `confirm_choice`); `probable` and `ambiguous` results get no `cover`. The steps always use the settled issue's detail, fetched outside the per-call request target if the search skipped it. If that fetch fails, the cover is `variants_unknown`, never `only_cover`. The main cover counts as one choice, labeled `Main cover`; a repeated variant name gets a numbered label (`Name (2)`).

1. **Barcode.** A main barcode plus 5-digit add-on equal to the main `upc` or one variant's `upc` settles it (`settledBy: 'barcode'`).
2. **Markings.** Otherwise the choices are narrowed by printing, printed price, `variant_marking` and `edition` against Metron's names and prices. One left settles it (`settledBy: 'markings'`).
3. **Compare.** With 2 to 6 left, the tool downloads their images into the agent's workspace and returns `compare` with each choice's `imagePath`. A download that fails, is not an image or exceeds 5 MB leaves that choice without an `imagePath`. The agent compares by eye and names one only when clear; the reply says `compared by eye` (agent-side only, not in the result).
4. **Tap.** If the agent can't tell, or a choice has no image, it asks with `ask_user_question`, one button per choice, and settles the tap with `confirm_choice` (`settledBy: 'user'`).
5. **Too many.** More than 6 left gives `not_determined`, with a barcode hint when the add-on would help.

An issue with no variants is `only_cover`. `ambiguous` results with 2–3 conflict-free candidates, when Metron returned every match, carry numbered `choices` (candidates with conflicts are left out), and the agent asks with one button per choice; the tapped Metron ID goes through `confirm_choice`, which re-checks the clues (a conflict comes back `probable`) and runs the cover steps. A chosen cover label must be one Metron lists for that issue.

### Limits of the buttons

- **Late taps.** `ask_user_question` waits 300 s. NanoClaw still accepts a tap on an expired card and marks it answered, but the agent never receives it (`src/modules/interactive/index.ts`; the poll loop drops `system` messages). So on timeout the agent says the buttons have expired and the user replies in the thread with the number or name of their choice, which is handled like a tap. A reply typed while the buttons are live reaches the agent only after the wait ends.
- **Who can tap.** NanoClaw records who tapped but does not restrict it: anyone in `#comic-archive` can tap (decided by littlelazer). "Confirmed by you" rests on the agent reporting the tap honestly; `confirm_choice` checks the choice against the clues and Metron's variant list.
