# comic-archive Phase 3 — Covers, editions and confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ComicCatalog settle the exact cover variant (by barcode, markings, the agent's own comparison, or littlelazer's tap), record visible edition details, and let littlelazer settle ambiguous issues with one tap, plus the Phase 2 carry-overs.

**Architecture:** The template's stdio MCP server (`templates/comic-catalog/server/`) gains a pure cover-settling module (`cover.ts`), an image download in the Metron client, a `confirm_choice` tool for tapped choices, and new clues (`edition`, `variant_marking`, normalized `price`). The agent compares downloaded covers itself and asks with NanoClaw's existing `mcp__nanoclaw__ask_user_question` buttons; no NanoClaw core changes.

**Tech Stack:** TypeScript on Bun 1.4.4 (`bun:test`), the existing hand-rolled newline JSON-RPC MCP server, vitest for the template test, Metron API through the OneCLI gateway.

**Spec:** `docs/superpowers/specs/2026-11-18-comic-archive-phase3-design.md` (builds on `docs/superpowers/specs/2026-11-18-comic-archive-phase2-design.md`).

## Global Constraints

- No NanoClaw core patches. All product code lives under `templates/comic-catalog/`.
- Strict TDD: failing test first, run it, minimal code, run it, commit. Every code file starts with two `ABOUTME:` lines. No mock modes in the product. Stand-in HTTP servers are allowed only inside tests, for error paths and cascade logic.
- Never put secrets anywhere. Our code sends no auth header; the gateway injects it for `metron.cloud/api/*`.
- Metron quota (20/min burst, 5,000/day) is shared: live tests stay few, and live exploration in Task 6 is capped at 8 requests.
- Per-call Metron API request target: **5** (was 4). The cover step's detail fetch and image downloads don't count toward it.
- Comparison cap: **6** cover choices (main cover counts as one).
- Button window: `ask_user_question` default **300 s**. On timeout the agent says the buttons have expired and invites a reply with a number (littlelazer's decision, option a).
- Anyone in `#comic-archive` may tap (littlelazer's decision).
- How a cover was settled is always stated: `barcode`, `markings`, `eye` (agent-side, in the reply only), or `user`.
- `probable` and `ambiguous` don't run the cover steps; only `confirmed` results and `confirm_choice` do.
- If the settled issue's detail can't be fetched, the cover status is `variants_unknown`, never `only_cover`.
- Unit tests: `~/.bun/bin/bun test ./templates/comic-catalog/server`. Live tests: `~/.local/bin/onecli run --agent ag-178c5abd-15a6-4159-87be-1a81fc01103c -- ~/.bun/bin/bun test <file>`. Template test: `pnpm exec vitest run src/templates/comic-catalog-template.test.ts`.
- After any commit: `pnpm run build`, `pnpm test`, `pnpm exec tsx scripts/upgrade-state.ts set`. Restart the host only in Task 8 (`bash setup/lib/restart.sh`).
- Commit only on `comic-archive/phase-3`. Never `--no-verify`. Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A barcode read with a leading zero Metron dropped** (Metron stores Solar #55 as `71689287064405511`, 17 digits, while a printed UPC-A can start with `0`). Expected: still settles by barcode. Pinned in Task 3 (`ignores leading zeros when matching a barcode`).
2. **A variant with no image** (`image: null` or `""`). Expected: it stays a choice with `imageUrl: null`, no download, and the agent uses buttons for it. Pinned in Tasks 3 and 4.
3. **Two variants with the same name.** Expected: labels stay unique (`Name`, `Name (2)`), and `confirm_choice` accepts either label. Pinned in Tasks 3 and 5.
4. **`confirm_choice` with an ID Metron doesn't have (404).** Expected: `no_match`, not a crash or `isError`. Pinned in Task 5.
5. **A cover download that returns HTML, an error status, or more than 5 MB.** Expected: no file written, the choice has no `imagePath`, and the rest still download. Pinned in Tasks 1 and 4.

---

### Task 1: Metron variant fields and image download

**Files:**
- Modify: `templates/comic-catalog/server/metron-client.ts`
- Test: `templates/comic-catalog/server/metron-client.test.ts`

**Interfaces:**
- Produces:
  - `MetronVariant = { name: string; price: string | null; sku: string; upc: string; image: string | null }`
  - `MetronIssueDetail.variants: MetronVariant[]` and `MetronIssueDetail.price: string | null`
  - `client.getImage(url: string): Promise<MetronResult<Uint8Array>>`
  - `MAX_IMAGE_BYTES = 5_000_000`

- [ ] **Step 1: Write failing tests** against a `Bun.serve` stand-in:
  - `getImage returns the bytes of an image/jpeg response`
  - `getImage fails for a non-image content type` → `{ ok: false, reason: 'metron_unavailable', retryable: false }`
  - `getImage fails for a 404` → `reason: 'not_found'`
  - `getImage fails for a body over MAX_IMAGE_BYTES` → `reason: 'metron_unavailable', retryable: false`
  - `getImage sends the User-Agent and no Authorization header`
- [ ] **Step 2: Run them** and confirm they fail. `getImage` isn't defined yet.
- [ ] **Step 3: Implement `getImage`** with:
  - one GET, the client's request timeout and User-Agent, and no retries;
  - the size check using `Content-Length` when present, and the byte length after reading;
  - a timeout or network error mapped to `metron_unavailable` with `retryable: true`.

  Widen the detail types. `getIssue` already returns the parsed JSON, so this changes only the types.
- [ ] **Step 4: Run** `~/.bun/bin/bun test ./templates/comic-catalog/server/metron-client.test.ts`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(comic-catalog): fetch cover images and type Metron variants`.

### Task 2: Edition, variant-marking and price clues

**Files:**
- Modify: `templates/comic-catalog/server/clues.ts`, `templates/comic-catalog/server/tools.ts`
- Test: `templates/comic-catalog/server/clues.test.ts`, `templates/comic-catalog/server/tools.test.ts`

**Interfaces:**
- Produces:
  - `RawClues.edition?: 'newsstand' | 'direct'`, `RawClues.variant_marking?: string`
  - `Clues.edition?`, `Clues.variantMarking?: string`, `Clues.price?: number` (in dollars)
  - `Clues.printingOrdinal?: number` (e.g. 2 for "2nd printing", 10 for "10th printing")
  - `normalizePrice(printed: string): number | undefined`

- [ ] **Step 1: Write failing tests:**
  - `normalizePrice('$4.99')` → `4.99`
  - `normalizePrice('60¢')` → `0.6`
  - `normalizePrice('$1.00 US / $1.25 CAN')` → `1`
  - `normalizePrice('free')` → `undefined`
  - `normalizeClues({ printing: '10th printing' }).printingOrdinal` → `10`
  - `normalizeClues({ printing: 'second printing' }).printingOrdinal` → `2`
  - `normalizeClues({ edition: 'direct', variant_marking: ' Cover B ' })` → `{ edition: 'direct', variantMarking: 'Cover B' }`
  - `parseClues` rejects `edition: 'foil'` with `edition must be one of newsstand, direct`
  - the `identify_comic` input schema lists `edition` and `variant_marking` with `additionalProperties: false`
- [ ] **Step 2: Run them** and confirm they fail.
- [ ] **Step 3: Implement.** `normalizePrice` takes the first `$N(.NN)` or `N¢` amount. The ordinal comes from the existing `LATER_PRINTING` forms (digits or English words up to tenth). The schema descriptions follow the existing `LEGIBLE` wording:
  - `edition`: "newsstand (price barcode, no direct-market mark) or direct (logo or "Direct Edition" in the barcode box)"
  - `variant_marking`: "variant text as printed, e.g. "Cover B", "1:25", "Virgin", an artist credit"
- [ ] **Step 4: Run** the server tests. Expected: all pass.
- [ ] **Step 5: Commit** `feat(comic-catalog): read edition, variant marking and price clues`.

### Task 3: Settling the cover (pure)

**Files:**
- Create: `templates/comic-catalog/server/cover.ts`
- Test: `templates/comic-catalog/server/cover.test.ts`

**Interfaces:**
- Consumes: `Clues` (Task 2), `MetronIssueDetail`, `MetronVariant` (Task 1), `MissingHint` from `verdict.ts`.
- Produces:
  - `COVER_COMPARE_CAP = 6`
  - `MAIN_COVER_LABEL = 'Main cover'`
  - `CoverChoice = { label: string; name: string; imageUrl: string | null; upc: string; price: number | null; imagePath?: string }`
  - `CoverResult = { status: 'only_cover' | 'variants_unknown' | 'settled' | 'compare' | 'not_determined'; settledBy?: 'barcode' | 'markings' | 'user'; label?: string; choices?: CoverChoice[]; hint?: MissingHint }`
  - `coverChoices(detail: MetronIssueDetail): CoverChoice[]`: the main cover first, then the variants in Metron's order, with unique labels.
  - `settleCover(clues: Clues, detail: MetronIssueDetail): CoverResult`

Rules, in order. Each narrowing filter applies only if at least one choice survives it:
1. **No variants:** `only_cover`, with `label: 'Main cover'`.
2. **Barcode:** a 5-digit add-on was read, and `upcMain + upcAddon` with leading zeros stripped equals a choice's `upc` with leading zeros stripped. Result: `settled`, `settledBy: 'barcode'`.
3. **Narrowing**, by markings:
   - **printing:** with `printingOrdinal`, keep names whose words start with that ordinal (e.g. `10th`, case-insensitive). With no printing mark, drop names matching `/print/i`.
   - **price:** keep choices whose price equals `clues.price`.
   - **variant marking:** keep names containing every word of `variantMarking`, case-insensitive.
   - **edition:** `newsstand` keeps names matching `/newsstand/i`; `direct` drops them.
4. **After narrowing:**
   - One choice left, and at least one filter removed something: `settled`, `settledBy: 'markings'`.
   - 2 to `COVER_COMPARE_CAP` left: `compare`, with those choices.
   - More than the cap left: `not_determined`. The `hint` is `barcode_addon` when a main barcode was read without a 5-digit add-on, `barcode_closeup` when no barcode was read and any remaining choice has a `upc`, and absent otherwise.

- [ ] **Step 1: Write failing tests.** Use detail fixtures shaped like Absolute Batman #1 (Metron 127884): main `upc` `76194138584600111`, price `4.99`, plus variants copied from the live data in the spec (`10Th Printing` `…600110` `4.99`, `10Th Printing Inhyuk Lee` `…600187` `5.99`, `10Th Printing Inhyuk Lee Foil Virgin Variant` `…600188` `7.99`), plus enough plain variants to exceed 6 where a test needs it. Tests:
   - `a detail with no variants is only_cover`
   - `a read add-on equal to a variant upc settles that variant by barcode`
   - `a read add-on equal to the main upc settles the main cover by barcode`
   - `ignores leading zeros when matching a barcode` (read `071689287064` + `05511` against Metron `71689287064405511`)
   - `10th printing at $5.99 settles the Inhyuk Lee variant by markings`
   - `no printing mark drops printing variants`
   - `a filter that would remove every choice is skipped`
   - `two to six choices left is compare with those choices`
   - `more than six left with a main barcode but no add-on is not_determined with the barcode_addon hint`
   - `more than six left with no barcode is not_determined with the barcode_closeup hint`
   - `duplicate variant names get unique labels`
   - `a variant with no image keeps imageUrl null`
- [ ] **Step 2: Run them** and confirm they fail.
- [ ] **Step 3: Implement `cover.ts`** to the rules above.
- [ ] **Step 4: Run** the server tests. Expected: all pass.
- [ ] **Step 5: Commit** `feat(comic-catalog): settle cover variants from barcode and markings`.

### Task 4: Downloading covers for comparison

**Files:**
- Create: `templates/comic-catalog/server/cover-images.ts`
- Test: `templates/comic-catalog/server/cover-images.test.ts`

**Interfaces:**
- Consumes: `client.getImage` (Task 1), `CoverChoice` (Task 3).
- Produces: `fetchCoverImages(choices: CoverChoice[], getImage: MetronClient['getImage'], dir: string): Promise<CoverChoice[]>`. It returns the choices with `imagePath` set for each image that is now on disk.

Files go to `<dir>/<basename of imageUrl>`; `dir` is `${PLUGIN_DATA}/covers` (Task 7). An existing file is reused without downloading. Choices with a null `imageUrl` or a failed download get no `imagePath`. Downloads run one after another, and a failure never throws.

- [ ] **Step 1: Write failing tests**, using a temp dir and a `Bun.serve` stand-in:
  - `writes each image and sets imagePath`
  - `reuses an existing file without a request`
  - `a failed download leaves that choice without imagePath and still fetches the rest`
  - `a choice with no imageUrl is skipped`
- [ ] **Step 2: Run them** and confirm they fail.
- [ ] **Step 3: Implement.** Create `dir` recursively when needed.
- [ ] **Step 4: Run** the tests. Expected: they pass.
- [ ] **Step 5: Commit** `feat(comic-catalog): download cover choices for comparison`.

### Task 5: Covers in identify results, and `confirmChoice`

**Files:**
- Modify: `templates/comic-catalog/server/identify.ts`
- Create: `templates/comic-catalog/server/confirm.ts`
- Test: `templates/comic-catalog/server/identify.test.ts`, `templates/comic-catalog/server/confirm.test.ts`

**Interfaces:**
- Consumes: `settleCover`, `coverChoices`, `MAIN_COVER_LABEL` (Task 3); `fetchCoverImages` (Task 4); `evaluateCandidate` (`verdict.ts`).
- Produces:
  - `IdentifyResult`'s non-failure branch gains `cover?: CoverResult`, `edition?: { edition?: 'newsstand' | 'direct'; variantMarking?: string; printing?: string }` and `chosenBy?: 'user'`.
  - `identifyComic(raw: RawClues, client: MetronClient, coversDir?: string)`
  - `confirmChoice(input: { metronId: number; coverLabel?: string; clues: RawClues }, client: MetronClient, coversDir?: string): Promise<IdentifyResult>`

Behavior:
- **`identifyComic`:**
  - Only a `confirmed` verdict gets `cover`. It uses the leader's detail when it was fetched. Otherwise it fetches the detail once, outside the request target; a failed fetch gives `{ status: 'variants_unknown' }`.
  - A `compare` result gets its images through `fetchCoverImages` when `coversDir` is set.
  - `edition` echoes the edition, variant marking and printing clues whenever any of them was read.
- **`confirmChoice`:**
  - It fetches the detail. A `not_found` gives `{ verdict: 'no_match', candidates: [], missing: [], searched: true }`. Other failures give `lookup_failed` as in `identifyComic`.
  - It builds the candidate with `evaluateCandidate(clues, detail, 'series_number')`. Conflicts give `probable` with that candidate. Otherwise the verdict is `confirmed` with `chosenBy: 'user'`.
  - A `coverLabel` must equal one of `coverChoices(detail)`'s labels, giving `settled` with `settledBy: 'user'`. Otherwise it throws `Error('cover is not in Metron's variant list: <label>')`.
  - Without a `coverLabel`, `settleCover` runs as in `identifyComic`.

- [ ] **Step 1: Write failing tests**, using stand-in Metron pages per the Phase 2 testing decisions:
  - identify: `a confirmed exact barcode on a variant returns the cover settled by barcode`
  - identify: `a probable verdict has no cover`
  - identify: `a confirmed match whose detail fetch fails has cover variants_unknown`
  - identify: `a compare cover downloads its choices when a covers dir is given`
  - identify: `edition clues are echoed`
  - confirm: `a chosen id with no conflicts is confirmed by the user`
  - confirm: `a chosen id whose issue number conflicts is probable with the conflict`
  - confirm: `a chosen cover label settles the cover by the user`
  - confirm: `a chosen cover label not in Metron's list throws`
  - confirm: `the second of two same-named variants is accepted by its label`
  - confirm: `a chosen id Metron doesn't have is no_match`
- [ ] **Step 2: Run them** and confirm they fail.
- [ ] **Step 3: Implement.** Keep `identify.ts` focused on the cascade by putting the cover attachment in a small exported helper that both functions use (e.g. `attachCover` in `confirm.ts` or `cover.ts`).
- [ ] **Step 4: Run** the server tests. Expected: all pass.
- [ ] **Step 5: Commit** `feat(comic-catalog): settle covers on confirmed matches and confirm tapped choices`.

### Task 6: Phase 2 carry-overs in the cascade and verdicts

**Files:**
- Modify: `templates/comic-catalog/server/verdict.ts`, `templates/comic-catalog/server/identify.ts`, `templates/comic-catalog/server/tools.test.ts` (ABOUTME only)
- Test: `templates/comic-catalog/server/verdict.test.ts`, `templates/comic-catalog/server/identify.test.ts`

**Interfaces:**
- Produces:
  - `MissingHint` gains `'title'`
  - `MAX_REQUESTS = 5`
  - `FIRST_FULL_ADDON_YEAR`: either removed, or set from the evidence in Step 0

- [ ] **Step 0: Pin the add-on start year.** Make at most 8 live lookups (`onecli run … curl`) of issues with known barcodes, cover years 1985–2000, from Marvel and DC.
  - Record each issue and its stored `upc` length in a comment above the constant.
  - If a clear first year shows (5-digit add-ons from year Y on), set `FIRST_FULL_ADDON_YEAR = Y`.
  - Otherwise remove the year gate, so `barcode_addon` is asked whenever a main barcode is read without an add-on.
- [ ] **Step 1: Write failing tests:**
  - verdict: `title comes first in missing when no title was read`
  - verdict: `barcode_addon is asked for a 1996 cover with a main barcode and no add-on`
  - identify: `a barcode-only search that finds nothing is no_match with missing ['title']`
  - identify: `a thin clue set that searched nothing asks for the title when no other hint applies`
  - identify: `a bound-trade title search follows page 2 when page 1 has no Hardcover or Omnibus`
  - identify: `a lookup uses at most 5 requests`
- [ ] **Step 2: Run them** and confirm they fail.
- [ ] **Step 3: Implement:**
  - `title` is pushed first in `missingHints` when `seriesTitle` is undefined.
  - The searched no-match returns `missing: clues.seriesTitle ? [] : ['title']`.
  - Paging requests `page: '2'` on the unfiltered series search only when `next` is non-null and page 1 has no bound type.
  - Update the verdict-rules comment to match.
  - Fix `tools.test.ts`'s stale ABOUTME so it describes the file as it is.
- [ ] **Step 4: Run** the server tests. Expected: all pass.
- [ ] **Step 5: Commit** `fix(comic-catalog): ask for the title, the add-on on 1990s covers, and page bound trades`.

### Task 7: Tool wiring

**Files:**
- Modify: `templates/comic-catalog/server/tools.ts`, `templates/comic-catalog/server/index.ts`, `templates/comic-catalog/plugin.json`
- Test: `templates/comic-catalog/server/tools.test.ts`, `templates/comic-catalog/server/index.test.ts`

**Interfaces:**
- Consumes: `confirmChoice` (Task 5), `identifyComic(raw, client, coversDir)`.
- Produces:
  - tool `confirm_choice` with input `{ metron_id: integer (required), cover_label?: string, ...every identify_comic clue property }` and `additionalProperties: false`;
  - `identify_comic` and `confirm_choice` both receive `coversDir = process.env.PLUGIN_DATA ? join(PLUGIN_DATA, 'covers') : undefined`;
  - plugin version `0.3.0` and User-Agent `comic-archive/0.3.0`.

- [ ] **Step 1: Write failing tests:**
  - `confirm_choice requires a positive integer metron_id`
  - `confirm_choice rejects unknown properties`
  - `confirm_choice passes clues through parseClues`
  - `the server lists identify_comic, confirm_choice and get_comic`
  - The `confirm_choice` description says to call it only with an id and cover label the user tapped or replied with.
- [ ] **Step 2: Run them** and confirm they fail.
- [ ] **Step 3: Implement.** Reuse `CLUE_PROPERTIES` and `parseClues` by splitting off `metron_id` and `cover_label` first.
- [ ] **Step 4: Run** the server tests plus `pnpm exec vitest run src/templates/comic-catalog-template.test.ts`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(comic-catalog): add confirm_choice and pass the covers directory`.

### Task 8: Agent instructions, live tests, docs and rollout

**Files:**
- Modify: `templates/comic-catalog/ai.nanoco.nanoclaw/context/instructions.md`, `src/templates/comic-catalog-template.test.ts`, `docs/comic-archive/architecture.md`, `docs/comic-archive/local-setup.md` (only if the commands change)
- Create: `templates/comic-catalog/server/cover.live.test.ts`, `docs/comic-archive/phase-3-checklist.md`

**Interfaces:**
- Consumes: the tool names and result fields from Tasks 5–7.

- [ ] **Step 1: Write failing template tests.** Each one pins one instruction rule with a short exact phrase written into the instructions:
  - **Compare:** on `cover.status` `compare`, `Read` every `imagePath` beside the photo.
  - **Name a cover by eye only when clear:** the reply then says `compared by eye`.
  - **Buttons:** ask with `mcp__nanoclaw__ask_user_question`.
    - Use one button per remaining choice (labels from `label`), and up to 3 issue buttons for `ambiguous` with 2–3 candidates.
    - Use buttons whenever a choice has no `imagePath`.
  - **After a tap,** call `confirm_choice` with the tapped `metron_id` and/or `cover_label`.
    - Never call it with a choice the user didn't make.
    - The reply says `confirmed by you`.
  - **Timeout:** reply that the buttons have expired and the user can reply with the number.
    - A later number or name is handled like a tap.
    - While buttons are live, tell the user to tap, not type.
  - **`not_determined` with a `hint`:** ask for that photo, worded as optional.
  - **`variants_unknown`:** say the cover couldn't be checked.
  - **Settling method:** state how the cover was settled: `barcode`, `markings`, `compared by eye`, `confirmed by you`.
  - **Edition details:** mention them briefly when read.
  - **`no_match` with a non-empty `missing`:** say Metron found nothing for what could be read, and ask for the first hint, e.g. the title.
  - **Hint reasons:** the `barcode_closeup`/`barcode_addon` reason reads "the add-on digits pin down the exact issue and cover", and add the `title` hint's photo request.
- [ ] **Step 2: Run them** and confirm they fail.
- [ ] **Step 3: Edit `instructions.md`** to those rules. Keep every Phase 2 rule and existing pinned phrase.
- [ ] **Step 4: Live test.** `cover.live.test.ts` is gated like the other `*.live.test.ts` files:
  - `identifyComic` on Absolute Batman #1 with the 10th-printing barcode (`761941385846` + `00110`) returns `cover.settledBy === 'barcode'`.
  - `getImage` of Solar #55's cover (`https://static.metron.cloud/media/issue/2025/03/24/c415c91e00f8481c947e61f986457860.jpg`) returns bytes.

  Run it through `onecli run`; it makes 4 API requests at most. Note in the test whether image downloads showed any effect on `X-RateLimit` headers (the spec leaves this open).
- [ ] **Step 5: Docs:**
  - `architecture.md`: add the variant data shape, the cover steps, the late-tap limitation, and who can tap.
  - `phase-3-checklist.md`: the spec's six posts, with pass criteria and an empty results table, in the Phase 2 checklist's format.
- [ ] **Step 6: Run everything:** the server tests, the template test, `pnpm run build`, `pnpm test`. Expected: all pass, and no new output in the test log.
- [ ] **Step 7: Commit** `feat(comic-catalog): instruct cover comparison, buttons and confirm_choice`.
- [ ] **Step 8: Roll out:**
  - `pnpm exec tsx scripts/upgrade-state.ts set` and `bash setup/lib/restart.sh`;
  - `pnpm run --silent ncl groups create --template comic-catalog --yes` and `pnpm run --silent ncl groups restart --id ag-178c5abd-15a6-4159-87be-1a81fc01103c`;
  - check that `groups/comiccatalog/plugins/comic-catalog/` has the new instructions;
  - ask littlelazer for the checklist posts.
