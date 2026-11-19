# comic-archive Phase 2 — Metron identification (design)

Status: for littlelazer's approval. Context: `/PLAN.md` (Phase 2, "thin vertical slice, read-only"), `docs/comic-archive/architecture.md`.

## Intent

littlelazer catalogs a personal comic collection by photographing each comic and sending the photo to the ComicCatalog agent in Slack (`#comic-archive`). Phase 1 proved the agent receives the photo and reads the cover accurately. Phase 2 makes it say **exactly which comic this is**, as a Metron catalog entry, with the evidence for that answer, and say plainly when it cannot tell. This is the foundation that Phase 3 (variant scoring, confirmation) and Phase 4 (Airtable records) build on, so "confirmed" must mean the same thing every time.

### The collection

- US comics from the mid-1970s to current releases; some reprints; some trade paperbacks; few foreign editions.
- Cataloged in **box sessions**: littlelazer sits with a long box and sends cover after cover, plus occasional one-offs.

## How it is used (decided by littlelazer)

- **One comic per Slack message.** Each top-level message is its own thread and its own agent session (already how the Slack wiring behaves). A message may contain several photos of the same comic (e.g. cover + back).
- **Follow-up photos go in that comic's thread.**
- **When more photos would help, the agent asks for the specific photo** that would settle the question and says why, e.g. a barcode close-up (add-on digits give the issue), the indicia/inside front cover (printing), the back cover or copyright page (trade ISBN). It never asks generically for "more photos", and only asks when the answer would change.
- Replies are short in a box session: about one line for a confident match.

```
[cover.jpg]
 └─ ComicCatalog: The Thing (1983) #1 · Metron 13806 · barcode + issue + Jul 1983 ✓
[cover.jpg]
 └─ ComicCatalog: Probably Uncanny X-Men #141, but the barcode is cut off.
                  Send a close-up of the barcode box to confirm.
      └─ [barcode.jpg]
      └─ ComicCatalog: Confirmed: Uncanny X-Men (1963) #141 · Metron …
```

## Goals

1. A photo of a common comic yields its Metron issue (ID, series + volume/year, number, cover date) and the evidence that matched.
2. Every answer carries a verdict: **confirmed**, **probable**, **ambiguous** (several candidates), **no match**, or **lookup failed**.
3. When the verdict is not confirmed, the agent names the specific extra photo that would resolve it, if one would.
4. If the matched issue is itself a reprint/facsimile per Metron, the reply says so.
5. Box sessions never show the user a rate-limit error for normal use.

## Non-goals (this phase)

- Any write anywhere: no Airtable, no Metron writes. The template's "Records" rule stays.
- Cover-image similarity / variant-cover selection and edition scoring (Phase 3). Phase 2 identifies the issue; if Metron lists variants, it may say "variant not determined".
- User confirmation flow / buttons (Phase 3).
- GCD or Comic Vine fallback (Phase 5).
- Foreign editions beyond "no Metron match" + what was read.

## Anti-goals (failure even if it "works")

- A Metron ID, issue number, date or variant that did not come from Metron or the photo.
- "Confirmed" on a match where another candidate is still plausible, or where the photo contradicts the match.
- The Metron token appearing anywhere: repo, `mcp.json`, logs, prompts, tool output.
- Matching rules that live only in prompt text (that was approach 2, rejected).

## Constraints

- **No NanoClaw core patches.** Everything ships inside `templates/comic-catalog/` (repo-tracked) per `docs/comic-archive/architecture.md`.
- Tools are a **stdio MCP server declared in the template's `mcp.json`** (Agent Plugins 1.0.0; parsed by `src/templates/mcp.ts`). No secrets in `mcp.json`; the stamp-time lint rejects anything secret-shaped. Server files live under the plugin root, mounted read-only in the container; `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are the supported path variables. See `docs/templates.md`.
- The agent container runs **Bun** (see `docs/build-and-runtime.md`). The server is TypeScript run by Bun.
- **Credentials:** Metron requests go to `https://metron.cloud/api/…` with no auth header from our code; the OneCLI gateway injects `Authorization: Bearer <token>` (secret `metron`, host `metron.cloud`, path `/api/*`, granted to ComicCatalog only — verified live). The server must honor the container's proxy/CA environment so requests pass through the gateway.
- **Metron API** (from its `api/README.md` and `api/RATELIMIT.md`):
  - `GET /api/issue/` filters used: `upc` (exact, main or variant cover), `upc_starts_with`, `series_name` (all words, case-insensitive), `number` (exact, case-insensitive), `cover_year`, `cover_month`, `publisher_name`. No ISBN filter.
  - `GET /api/issue/<id>/` detail includes `upc`, `isbn`, `variants`, `reprints`. List results show only the main cover.
  - `GET /api/series/` supports `series_type` (partial name, e.g. "Trade Paperback").
  - Limits: 20 requests/minute burst, 5,000/day sustained, per user. Read `X-RateLimit-*` headers, not hard-coded numbers. Over limit → `429` with `Retry-After` seconds.
  - Send an identifying `User-Agent` (e.g. `comic-archive/<version>`).
- **Each Slack thread is a separate container**, so each has its own MCP server process. Several comics in quick succession means several servers calling Metron in parallel; an in-process limiter cannot coordinate them.
- Repo rules (`~/.claude/CLAUDE.md`): strict TDD; unit, integration and end-to-end tests; every code file starts with two `ABOUTME:` lines; no mock modes in the product.

## Approaches considered

1. **Comic-lookup MCP server with matching rules in code — chosen.** The agent reads the cover (as in Phase 1) and passes structured clues to a tool that runs the search cascade, applies the verdict rules, and returns ranked candidates with evidence. Deterministic, unit-testable, pacing built in; Phase 3 scoring extends it.
2. Instructions only (agent curls Metron following written rules). Fastest, but matching, evidence and pacing depend on instruction-following every time and cannot be tested. Rejected.
3. Thin search/fetch tools, agent judges the match. Less code, but "confirmed" becomes model judgment rather than readable, adjustable rules. Rejected.

littlelazer chose approach 1 because "confirmed" must be consistent from the first comic of a session to the three-hundredth.

## Design

### Tools

**`identify_comic(clues)`** — clues are what the agent read off the photos, each optional, never guessed:

| Field | Notes |
| --- | --- |
| `series_title` | As printed |
| `issue_number` | As printed (`1A`, `0.1`, `½` preserved) |
| `publisher` | As printed |
| `cover_month`, `cover_year` | Only if printed |
| `price` | As printed, e.g. `60¢` |
| `upc_main` | Digits of the main barcode, only if fully legible |
| `upc_addon` | The small add-on digits beside it, only if legible |
| `isbn` | Only if legible |
| `format` | `single_issue` \| `trade` \| `unknown` (trade = spine/ISBN/"collects…") |
| `printing` | e.g. "2nd printing", "facsimile", if printed |

Returns:

- `verdict`: `confirmed` \| `probable` \| `ambiguous` \| `no_match` \| `lookup_failed`
- `candidates[]` (best first, capped, e.g. 5): Metron ID, series name + volume + year began, number, cover date, publisher, cover image URL, `evidence[]` (which clues agreed, in words), `conflicts[]` (which clues disagreed)
- `missing[]`: machine-readable hints of what evidence would settle it — e.g. `barcode_closeup`, `barcode_addon`, `indicia`, `isbn`, `issue_number`, `cover_date`. The agent turns these into a specific photo request.
- `lookup_failed` carries a reason (`rate_limited`, `metron_unavailable`, `auth`) and never candidates it did not get from Metron. It also carries `retryable` (true for `rate_limited` and `metron_unavailable`, false for `auth`) and, when Metron gave one, the seconds until a retry should work.

**`get_comic(metron_id)`** — issue detail: UPC, ISBN, variants (names only), reprints, so the agent can mention reprint/facsimile status and "variant not determined".

### Search cascade (single issues)

Stop at the first step that yields a decisive result; collect evidence across steps.

1. Full modern barcode (main + 5-digit add-on present) → `upc` exact.
2. Main barcode present → `upc_starts_with` on the main digits, filtered by `number` when the issue number (or the add-on) is known. Older barcodes identify the series; the issue lives in the add-on digits. A barcode hit alone is never decisive.
3. `series_name` + `number`, narrowed by `cover_year` (and `cover_month`) / `publisher_name`.

### Trades

No ISBN search exists. Search series with `series_type` matching trade/hardcover by title, then issue by volume number; fetch detail and compare ISBN if one was read. Without a matching ISBN, a trade is at best `probable`.

### Verdict rules (initial; documented in code next to the tests)

- **confirmed**: exactly one candidate survives, and either (a) a full modern barcode matched exactly and nothing read conflicts, or (b) series, issue number and cover year all agree (cover month too, when read) with no conflicting clue, or (c) no cover year was read, a barcode-prefix search found the issue, and series, issue number and cover month all agree (many covers print only the month; added after the first checklist run); for trades, the ISBN matched.
- **probable**: one leading candidate, but a key clue is missing or unreadable (e.g. no year, barcode cut off).
- **ambiguous**: two or more candidates fit equally (e.g. same title across volumes, no year).
- **no_match**: Metron returned nothing that fits; report what was read.
- Any conflict between a read clue and the candidate (e.g. issue number differs) prevents `confirmed`.
- **Printings and variants** (decided by littlelazer): verdicts are at issue level. A "2nd printing" mark, or an exact barcode hit on a variant cover, can still confirm the issue; the result then carries "variant/printing not determined" when Metron lists variants. A reprint or facsimile mark that disagrees with the candidate (cover says facsimile, candidate is the original, or the reverse) is a conflict and blocks `confirmed`.

No numeric confidence score in Phase 2; the verdict and evidence lists are the output. Phase 3 may add scoring.

### Rate limits and failures

- Each identification makes few requests (target ≤ 4).
- On `429`, wait `Retry-After` and retry, within a bounded total wait; beyond it, return `lookup_failed: rate_limited`. Watch the `Burst-Remaining` header and slow down when it is low. This is how parallel per-thread servers stay within limits without coordination.
- Timeouts and 5xx: bounded retry, then `lookup_failed: metron_unavailable`. `401/403`: `lookup_failed: auth` (gateway grant or token problem), no retry.
- Not-found is `no_match`, never an error.

### Retrying a failed lookup in the thread (decided by littlelazer)

When a lookup fails for a temporary reason (`retryable: true`), the reply says so, says roughly when it should work, and invites a retry: e.g. "Metron is busy. Reply *retry* here in a minute or so." Any reply in that thread asking to try again ("retry", "try again") makes the agent call `identify_comic` again with the clues it already read; the photos need not be re-sent. The thread is the comic's own session (one comic per message), so the agent still has those clues. `auth` failures are not offered a retry; the reply says the Metron connection needs fixing. Each retry is one more bounded attempt, not an automatic loop.

### Agent instructions (template `instructions.md`)

Extend the Phase 1 instructions: read every image; extract clues without guessing; call `identify_comic`; reply in one line for `confirmed`; for other verdicts, give the best candidate(s) with the evidence in a sentence and turn `missing[]` into one specific photo request; mention reprint/facsimile and "variant not determined" when `get_comic` shows them; on `lookup_failed` say what was read, without inventing a match, and for a retryable failure invite a reply of *retry* in the thread (see above). The "Records" rule (no writes) stays.

### Deployment of the change

The group was stamped from the template; template changes reach it by restamping (`src/templates/restamp.ts` / the `ncl` path the builder finds) and a group restart. After committing, the upgrade marker must be re-stamped before a host restart (build, test, `pnpm exec tsx scripts/upgrade-state.ts set`).

## Testing

- **Unit** (Bun test): clue normalization (issue numbers, barcode main/add-on splitting), cascade step selection, verdict rules (each rule and each conflict case), `missing[]` derivation, 429/Retry-After and failure handling.
- **Integration**: the server against Metron through the gateway as ComicCatalog (`onecli run --agent <ComicCatalog identifier> -- …`), using known issues: *The Thing* (1983) #1 (Metron 13806, barcode prefix `07148602966`), a modern issue with a full 17-digit barcode, a trade, and a nonexistent issue.
- **Error paths** (decided by littlelazer): normal behavior is tested only against real Metron. For 429/`Retry-After`, low `Burst-Remaining`, 5xx, timeouts and 401/403, tests start a throwaway local HTTP server that answers the way Metron does, and point the server's Metron base URL at it. The stand-in exists only inside tests; the product has no fake or offline mode. Later decision (littlelazer, final review): stand-ins may also imitate successful Metron replies in tests of the lookup cascade's logic, where real Metron cannot reproduce the case on demand.
- **End-to-end** (decided by littlelazer): a written manual checklist, not an automated Slack harness. littlelazer posts in `#comic-archive` (1) a cover that should confirm, (2) a cover with a cut-off barcode, then answers the photo request in-thread, (3) a comic Metron lacks. A retryable failure cannot be forced on demand against real Metron, so the in-thread retry is checked when one occurs naturally; the tool's `retryable` output is covered by the error-path tests. Claude checks the logs and session DBs and records results in `docs/comic-archive/`. Run at Phase 2 acceptance and after any change to what the agent says in Slack (instructions, reply format, photo requests). Revisit automation if this becomes frequent.
- The existing template test (`src/templates/comic-catalog-template.test.ts`) gains checks that `mcp.json` declares the server and the instructions keep the no-guess and no-write rules.

## Acceptance (from PLAN.md, made concrete)

- At least one known common comic cover is identified with a real Metron result and evidence.
- A photo with insufficient evidence yields a non-confirmed verdict and a specific photo request.
- Failure paths (no match, Metron down, rate-limited) never fabricate metadata.
- No Metron token in repo, logs or tool output.

## Known from the repo (builder check)

- `container/agent-runner/src/plugin-mcp.ts` expands `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`, resolves `./` commands against the plugin root, and passes an explicit `env` to plugin servers. `src/gateway-providers/onecli.ts` sets `SSL_CERT_FILE` to a combined CA bundle.
- Unverified: whether the plugin server's env carries the proxy/CA variables, and whether Bun's `fetch` honors them. **The plan starts with a spike: a minimal server inside the ComicCatalog container that fetches one Metron issue.** (Claude's call.)
- `vitest.config.ts` does not include `templates/`, so the server's Bun tests need their own invocation wired into the documented test commands. (Builder's call.)
- `instructions.md` currently says lookups are "not connected yet"; that wording changes. The template test pins only "never guess" and "do not create, update, or delete", which survive.

## Left to the builder

- Server file layout under `templates/comic-catalog/`, module boundaries, and how the server gets its MCP SDK dependency within the read-only plugin mount and the repo's supply-chain rules.
- Exact barcode normalization (check digits, `upc_starts_with` prefix length) — settle with live Metron data.
- Candidate cap, retry counts and total wait bound.
- Exact reply wording, within the rules above.
