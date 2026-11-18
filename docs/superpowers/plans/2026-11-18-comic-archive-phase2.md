# comic-archive Phase 2 — Metron Identification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ComicCatalog names the exact Metron issue for a cover photo, with evidence and a verdict, asks for a specific extra photo when that would settle it, and lets the user retry temporary lookup failures in the thread.

**Architecture:** A dependency-free stdio MCP server written in TypeScript for Bun ships inside `templates/comic-catalog/server/` and is declared in the template's `mcp.json`. The agent reads the photo itself (Phase 1) and passes clues to `identify_comic`, which runs the search cascade against Metron through the OneCLI gateway and applies verdict rules in code. Template changes reach the live agent by restamping.

**Tech Stack:** TypeScript on Bun 1.4.4 (the agent image's version), `bun:test`, Metron REST API, MCP over stdio (JSON-RPC 2.0, newline-delimited), vitest for the existing host-side template test.

**Spec:** `docs/superpowers/specs/2026-11-18-comic-archive-phase2-design.md`

## Global Constraints

- No NanoClaw core patches. All new code lives under `templates/comic-catalog/`; the only other edits are `src/templates/comic-catalog-template.test.ts` and `docs/comic-archive/*`.
- Every code file starts with two `ABOUTME: ` comment lines.
- No secrets in `mcp.json`, code, tests, fixtures or logs. Requests go to `https://metron.cloud/api/` with no `Authorization` header from our code; the gateway injects it.
- No fake or offline mode in the product. The Metron base URL is a constructor argument; only tests pass a local stand-in URL, and only for error paths (429, low burst remaining, 5xx, timeouts, 401/403). Normal behavior is tested against real Metron.
- Send `User-Agent: comic-archive/0.2.0`.
- Target ≤ 4 Metron requests per `identify_comic` call.
- Verdicts: `confirmed | probable | ambiguous | no_match | lookup_failed`. No numeric confidence.
- Strict TDD: failing test, see it fail, minimal code, see it pass, commit.
- After every commit that will be followed by a host restart: `pnpm run build && pnpm test && pnpm exec tsx scripts/upgrade-state.ts set`.

## Decisions this plan makes (not in the spec)

- **No MCP SDK dependency.** The plugin is mounted read-only with no `node_modules`, so the server implements the small stdio subset it needs (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`) in one module. This avoids committing vendored packages and adding supply-chain exceptions.
- **Launch:** `mcp.json` server `comic-catalog`, `"type": "stdio"`, `"command": "bun"`, `"args": ["${PLUGIN_ROOT}/server/index.ts"]`. Tools appear to the agent as `mcp__comic-catalog__identify_comic` and `mcp__comic-catalog__get_comic`.
- **Tests run with Bun on the Mac:** `bun test ./templates/comic-catalog/server`. Live tests (`*.live.test.ts`) run through the gateway as ComicCatalog: `~/.local/bin/onecli run --agent ag-178c5abd-15a6-4159-87be-1a81fc01103c -- bun test ./templates/comic-catalog/server --test-name-pattern live`.
- **Limits:** per-request timeout 15 s; up to 2 retries for 5xx/timeouts (1 s, then 2 s); total wait budget per tool call 60 s; when `X-RateLimit-Burst-Remaining` ≤ 2, wait until `X-RateLimit-Burst-Reset` (inside the budget); candidate cap 5.

## Review Focus

1. **Issue numbers as printed** (`#1`, `001`, `1A`, `0.1`, `½`, `Annual 1`): `001` and `#1` must equal `1`, but `1A` must never become `1`. Pinned in Task 3.
2. **Misread or partial barcodes** (wrong digit count, spaces, a stray letter): never used for an exact `upc` lookup; treated as missing, which yields `barcode_closeup` in `missing`. Pinned in Task 3.
3. **Same title across volumes with no year read** (e.g. *Thor* #1): `ambiguous`, never `confirmed`. Pinned in Task 4 (pure) and Task 5 (live).
4. **Title wording differences** ("The Thing" vs "Thing"): the series search must still find the series. Pinned live in Task 5.
5. **More Metron results than one page** (`count` > results returned): treated as ambiguous, never as "the only candidate". Pinned in Task 4.

---

### Task 0: Bun on the development Mac (needs littlelazer's approval)

- [ ] **Step 1:** With littlelazer's OK, install Bun 1.4.4: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"`.
- [ ] **Step 2:** Verify: `~/.bun/bin/bun --version` prints `1.4.4`. Use `~/.bun/bin/bun` (or put it on `PATH`) in every later command.

### Task 1: Metron HTTP client

**Files:**
- Create: `templates/comic-catalog/server/metron-client.ts`
- Test: `templates/comic-catalog/server/metron-client.test.ts` (stand-in error paths), `templates/comic-catalog/server/metron-client.live.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type FailureReason = 'rate_limited' | 'metron_unavailable' | 'auth';
  type MetronResult<T> =
    | { ok: true; data: T }
    | { ok: false; reason: FailureReason; retryable: boolean; retryAfterSeconds?: number };
  interface MetronIssueSummary { id: number; series: { id: number; name: string; volume: number; year_began: number }; number: string; issue: string; cover_date: string | null; image: string | null }
  interface MetronIssueDetail extends MetronIssueSummary { publisher?: { name: string }; upc: string | null; isbn: string | null; variants: { name: string }[]; reprints: { id: number; issue: string }[] }
  interface MetronPage<T> { count: number; next: string | null; results: T[] }
  interface MetronClientOptions { baseUrl: string; userAgent: string; totalWaitBudgetMs?: number; requestTimeoutMs?: number; sleep?: (ms: number) => Promise<void> }
  function createMetronClient(opts: MetronClientOptions): {
    searchIssues(params: Record<string, string>): Promise<MetronResult<MetronPage<MetronIssueSummary>>>;
    getIssue(id: number): Promise<MetronResult<MetronIssueDetail>>;
    searchSeries(params: Record<string, string>): Promise<MetronResult<MetronPage<{ id: number; series: string; volume: number; year_began: number }>>>;
  };
  type MetronClient = ReturnType<typeof createMetronClient>;
  export const METRON_BASE_URL = 'https://metron.cloud/api/';
  ```
  Field names in the detail and series types must be checked against a live response in Step 6 and corrected there. Later tasks use whatever this task settles.

- [ ] **Step 1: Write failing stand-in tests** in `metron-client.test.ts`. Each starts `Bun.serve({ port: 0, fetch })` and passes `baseUrl: \`http://127.0.0.1:${server.port}/api/\`` and a `sleep` that records the delays:
  - `retries after Retry-After on 429 then succeeds`: first response 429 with `Retry-After: 3`, second 200 `{count:0,next:null,results:[]}`; expect `ok: true` and recorded sleep `[3000]`.
  - `gives up on 429 beyond the wait budget`: always 429 `Retry-After: 120`, budget 60 000; expect `{ ok:false, reason:'rate_limited', retryable:true, retryAfterSeconds:120 }`.
  - `slows down when burst remaining is low`: 200 with `X-RateLimit-Burst-Remaining: 1` and `X-RateLimit-Burst-Reset` = now+5 s; the *next* call sleeps ≈ 5000 ms before sending.
  - `retries 5xx twice then reports metron_unavailable`: always 503; expect 3 requests, sleeps `[1000, 2000]`, `{ ok:false, reason:'metron_unavailable', retryable:true }`.
  - `times out a hung request`: handler never resolves, `requestTimeoutMs: 50`; expect `metron_unavailable`.
  - `does not retry 401 or 403`: expect 1 request and `{ ok:false, reason:'auth', retryable:false }`.
  - `sends the User-Agent and no Authorization header`: the handler records headers; assert `user-agent` = `comic-archive/0.2.0` and no `authorization`.
- [ ] **Step 2: Run** `bun test ./templates/comic-catalog/server/metron-client.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `createMetronClient`** with the limits in "Decisions". The wait budget is per client call, not per client. The burst slowdown state lives on the client instance.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Write live tests** in `metron-client.live.test.ts` (test names start with `live`), using `METRON_BASE_URL`:
  - `live: finds The Thing 1983 #1 by series and number`: `searchIssues({ series_name:'thing', number:'1', cover_year:'1983' })` returns `count === 1` and `results[0].id === 13806`.
  - `live: issue detail has upc, isbn, variants and reprints fields`: `getIssue(13806)` is `ok` and has those keys.
- [ ] **Step 6: Run** them live through the gateway (command in "Decisions"). Expected: PASS. Correct the detail and series field names from the real response if needed.
- [ ] **Step 7: Commit** `feat(comic-catalog): add Metron client with rate-limit and failure handling`.

### Task 2: stdio MCP server with `get_comic`, checked inside the agent container

**Files:**
- Create: `templates/comic-catalog/server/mcp-stdio.ts`, `templates/comic-catalog/server/index.ts`, `templates/comic-catalog/server/tools.ts`, `templates/comic-catalog/mcp.json`
- Test: `templates/comic-catalog/server/mcp-stdio.test.ts`, `templates/comic-catalog/server/index.test.ts`
- Modify: `src/templates/comic-catalog-template.test.ts`

**Interfaces:**
- Consumes: `createMetronClient`, `METRON_BASE_URL`, `MetronIssueDetail` (Task 1).
- Produces:
  ```ts
  // mcp-stdio.ts
  interface ToolDef { name: string; description: string; inputSchema: object; handler: (args: unknown) => Promise<unknown> }
  function serveStdio(tools: ToolDef[], io?: { input: ReadableStream<Uint8Array>; write: (line: string) => void }): Promise<void>;
  // tools.ts
  function getComicTool(client: MetronClient): ToolDef;
  ```
  A tool result goes back as `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`. A handler throw or invalid arguments gives `isError: true` with a short message.

- [ ] **Step 1: Write failing protocol tests** in `mcp-stdio.test.ts`, feeding lines through the `io` parameter:
  - `answers initialize with the client's protocolVersion, tools capability and serverInfo name "comic-catalog"`.
  - `lists tools with name, description and inputSchema`.
  - `calls a tool and wraps its result as text content`.
  - `returns isError for an unknown tool name`, and `returns JSON-RPC error -32601 for an unknown method`.
  - `ignores notifications (no id) without replying`; `answers ping with an empty result`.
- [ ] **Step 2: Run** `bun test ./templates/comic-catalog/server/mcp-stdio.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `serveStdio`.** Read stdin line by line and write one JSON object per line to stdout. Nothing else goes to stdout; diagnostics go to stderr.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Write the failing `get_comic` and process tests:**
  - In `index.test.ts`, `spawned server lists get_comic`: spawn `bun templates/comic-catalog/server/index.ts`, send `initialize` and then `tools/list`, and assert `get_comic` is present with `inputSchema` requiring integer `metron_id`.
  - Add `live: get_comic returns The Thing #1 detail`, calling the tool handler with `{ metron_id: 13806 }` and asserting the JSON has `id: 13806` and a `reprints` array.
- [ ] **Step 6: Implement `getComicTool` and `index.ts`.** `index.ts` builds the client with `METRON_BASE_URL` and `userAgent: 'comic-archive/0.2.0'`, then calls `serveStdio([getComicTool(client)])`. A failed lookup returns the `MetronResult` failure object as the tool result, not `isError`.
- [ ] **Step 7: Write `mcp.json`** (schema URL `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`, server as in "Decisions").
- [ ] **Step 8: Extend the vitest template test.** Add `it('declares the comic-catalog stdio server run by bun')`, asserting `tpl.mcpServers['comic-catalog']` has `command: 'bun'` and `args: ['${PLUGIN_ROOT}/server/index.ts']`. Keep the existing `tpl.report` toEqual `[]` check.
- [ ] **Step 9: Run** `bun test ./templates/comic-catalog/server` and `pnpm exec vitest run src/templates/comic-catalog-template.test.ts`. Expected: PASS. Then run live through the gateway. Expected: PASS.
- [ ] **Step 10: Commit** `feat(comic-catalog): add stdio MCP server with get_comic`, then run build, test and stamp (Global Constraints).
- [ ] **Step 11: Restamp and check inside the container.** Run `pnpm run ncl groups create --template comic-catalog` (dry run; check that only the plugin, the MCP server and context files change), then the same with `--yes`, then `pnpm run ncl groups restart --id ag-178c5abd-15a6-4159-87be-1a81fc01103c`. **Ask littlelazer** to post in `#comic-archive`: "Use get_comic to look up Metron issue 13806." Expected: the reply contains *The Thing* (1983) #1 data. Check the session's `outbound.db` and `logs/nanoclaw.log`.
  - If the tool is missing, or the request fails with a proxy or certificate error: **stop**. Report to littlelazer with the exact error. The design's gateway assumption failed, and it is their call how to proceed.

### Task 3: Clue normalization

**Files:**
- Create: `templates/comic-catalog/server/clues.ts`
- Test: `templates/comic-catalog/server/clues.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface RawClues { series_title?: string; issue_number?: string; publisher?: string; cover_month?: number; cover_year?: number; price?: string; upc_main?: string; upc_addon?: string; isbn?: string; format?: 'single_issue' | 'trade' | 'unknown'; printing?: string }
  interface Clues { seriesTitle?: string; issueNumber?: string; publisher?: string; coverMonth?: number; coverYear?: number; upcMain?: string; upcAddon?: string; isbn?: string; format: 'single_issue' | 'trade' | 'unknown'; printingKind?: 'original' | 'later_printing' | 'reprint' | 'facsimile' }
  function normalizeClues(raw: RawClues): Clues;
  function normalizeIssueNumber(printed: string): string;
  ```

- [ ] **Step 1: Write failing tests:**
  - `normalizeIssueNumber`: `'#1'`→`'1'`, `'001'`→`'1'`, `'1A'`→`'1A'`, `'0.1'`→`'0.1'`, `'½'`→`'½'`, `'#0'`→`'0'`.
  - `upc_main` keeps digits only after removing spaces. A value that is not 12 digits (UPC-A) is dropped (`upcMain` undefined).
  - `upc_addon` is accepted only as 2 or 5 digits; otherwise dropped.
  - `isbn` is accepted as ISBN-13 (`978`/`979`, 13 digits, hyphens and spaces removed); otherwise dropped.
  - `printing`: "2nd printing" → `later_printing`; "Facsimile Edition" → `facsimile`; "reprint" → `reprint`; absent → undefined.
  - `cover_month` outside 1–12 and `cover_year` outside 1930–(current year + 1) are dropped. `format` defaults to `'unknown'`.
- [ ] **Step 2: Run** `bun test ./templates/comic-catalog/server/clues.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(comic-catalog): normalize cover clues`.

### Task 4: Evidence and verdict rules (pure)

**Files:**
- Create: `templates/comic-catalog/server/verdict.ts`
- Test: `templates/comic-catalog/server/verdict.test.ts`

**Interfaces:**
- Consumes: `Clues` (Task 3), `MetronIssueSummary` / `MetronIssueDetail` (Task 1).
- Produces:
  ```ts
  type Verdict = 'confirmed' | 'probable' | 'ambiguous' | 'no_match';
  type MissingHint = 'barcode_closeup' | 'barcode_addon' | 'indicia' | 'isbn' | 'issue_number' | 'cover_date';
  interface Candidate { metronId: number; series: string; volume: number; yearBegan: number; number: string; coverDate: string | null; publisher?: string; coverImageUrl: string | null; evidence: string[]; conflicts: string[]; variantOrPrintingUndetermined: boolean; isReprintOrFacsimile: boolean }
  interface MatchInput { clues: Clues; issues: (MetronIssueSummary | MetronIssueDetail)[]; totalCount: number; matchedBy: 'upc_exact' | 'upc_prefix' | 'series_number' | 'trade_isbn' | 'trade_title' }
  function evaluateCandidate(clues: Clues, issue: MetronIssueSummary | MetronIssueDetail, matchedBy: MatchInput['matchedBy']): Candidate;
  function decideVerdict(input: MatchInput): { verdict: Verdict; candidates: Candidate[]; missing: MissingHint[] };
  ```

- [ ] **Step 1: Write failing tests**, one per rule. Use issue objects built in the test from the real 13806 response shape:
  - `confirms on exact full modern barcode with no conflicts` (`matchedBy: 'upc_exact'`, one issue).
  - `confirms when series, number and year agree and one candidate remains`.
  - `does not confirm when the issue number conflicts` → `probable`, conflict text names the issue number.
  - `does not confirm when the cover month conflicts`.
  - `is ambiguous with two equally fitting volumes and no year` → `ambiguous`, `missing` contains `cover_date`.
  - `is ambiguous when totalCount exceeds returned results` (Review Focus 5).
  - `is probable with one candidate but no year read` → `missing` contains `cover_date`.
  - `asks for a barcode close-up when the barcode was not read on a barcode-era single issue (cover year ≥ 1977 or unknown)`.
  - `confirms a later printing at issue level and flags variantOrPrintingUndetermined when variants exist`.
  - `facsimile clue against a non-reprint candidate is a conflict` and the reverse (`isReprintOrFacsimile` from a non-empty `reprints`).
  - `trade without matching ISBN is at best probable` with `missing` `['isbn']`; `trade with matching ISBN confirms`.
  - `no issues → no_match` with empty `candidates`.
  - `caps candidates at 5, best first` (fewest conflicts, then most evidence).
- [ ] **Step 2: Run** `bun test ./templates/comic-catalog/server/verdict.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Put a comment block above `decideVerdict` stating the rules exactly as in the spec's "Verdict rules" section, including the littlelazer-decided printing/variant rule.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(comic-catalog): add evidence and verdict rules`.

### Task 5: Search cascade, tested live

**Files:**
- Create: `templates/comic-catalog/server/identify.ts`
- Test: `templates/comic-catalog/server/identify.live.test.ts`, `templates/comic-catalog/server/identify.test.ts` (stand-in failures only)

**Interfaces:**
- Consumes: the Task 1 client, `normalizeClues` (Task 3), `decideVerdict` / `evaluateCandidate` (Task 4).
- Produces:
  ```ts
  type IdentifyResult =
    | { verdict: Verdict; candidates: Candidate[]; missing: MissingHint[] }
    | { verdict: 'lookup_failed'; reason: FailureReason; retryable: boolean; retryAfterSeconds?: number; candidates: [] ; missing: [] };
  function identifyComic(raw: RawClues, client: MetronClient): Promise<IdentifyResult>;
  ```

- [ ] **Step 1: Find live fixtures.** With `onecli run … curl` (as in Phase 1), pick three cases and write their IDs into the test file with a comment on how each was found: (a) a modern issue with a full 17-digit barcode; (b) a trade paperback with an ISBN; (c) a title that exists in two volumes with the same issue number (e.g. *Thor* #1). Settle the barcode digit handling here: whether Metron stores the UPC with its check digit, and the prefix length for `upc_starts_with`. Then update `clues.ts` and its tests if needed.
- [ ] **Step 2: Write failing live tests:**
  - `live: The Thing #1 confirms from series, number, year and month` → `confirmed`, top `metronId: 13806`.
  - `live: The Thing #1 from barcode prefix plus issue number` (`upc_main` from the cover, no series title) → `confirmed` or `probable` with 13806 on top, never another issue on top.
  - `live: "The Thing" and "Thing" both find series 1343` (Review Focus 4).
  - `live: modern full barcode confirms by exact UPC`.
  - `live: trade with ISBN confirms; without ISBN is probable with missing isbn`.
  - `live: same-title volumes with no year are ambiguous`.
  - `live: nonexistent series is no_match`.
  - `live: each call uses at most 4 requests` (count through a wrapper around the client).
- [ ] **Step 3: Write failing stand-in tests** in `identify.test.ts`: a 429 beyond budget gives `{ verdict:'lookup_failed', reason:'rate_limited', retryable:true }`; a 401 gives `reason:'auth', retryable:false`.
- [ ] **Step 4: Run** both test files (live through the gateway). Expected: FAIL.
- [ ] **Step 5: Implement `identifyComic`** following the spec's cascade. Single issues: exact UPC (main+5-digit add-on) → `upc_starts_with` + `number` → `series_name` + `number` (+ `cover_year`, `cover_month`, `publisher_name`). Trades: `searchSeries({ series_type: 'Trade Paperback', name })`, then the issue by volume number, then `getIssue` to compare ISBN. Call `getIssue` only for the leading candidate (variants, reprints). Stop at the first decisive step. Any client failure ends the call as `lookup_failed`.
- [ ] **Step 6: Run** both files. Expected: PASS.
- [ ] **Step 7: Commit** `feat(comic-catalog): add Metron search cascade`.

### Task 6: `identify_comic` tool

**Files:**
- Modify: `templates/comic-catalog/server/tools.ts`, `templates/comic-catalog/server/index.ts`
- Test: `templates/comic-catalog/server/tools.test.ts`, `templates/comic-catalog/server/index.test.ts`

**Interfaces:**
- Consumes: `identifyComic`, `RawClues`.
- Produces: `function identifyComicTool(client: MetronClient): ToolDef`. Its `inputSchema` properties match `RawClues` exactly; every field is optional and has a description that says "only if legible on the photo; never guess". The output is the `IdentifyResult` JSON.

- [ ] **Step 1: Write failing tests:**
  - `index.test.ts`: `spawned server lists identify_comic and get_comic`.
  - `tools.test.ts`: `rejects non-string issue_number with isError`. Also `live: identify_comic tool returns confirmed for The Thing #1 clues`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** and register the tool in `index.ts`.
- [ ] **Step 4: Run** all server tests, unit and live. Expected: PASS.
- [ ] **Step 5: Commit** `feat(comic-catalog): expose identify_comic tool`.

### Task 7: Agent instructions, docs, restamp and the Slack checklist

**Files:**
- Modify: `templates/comic-catalog/ai.nanoco.nanoclaw/context/instructions.md`, `templates/comic-catalog/plugin.json` (version `0.2.0`), `src/templates/comic-catalog-template.test.ts`, `docs/comic-archive/local-setup.md`, `docs/comic-archive/architecture.md`
- Create: `docs/comic-archive/phase-2-checklist.md`

- [ ] **Step 1: Write failing template tests:**
  - `tells the agent to call identify_comic after reading the cover` (matches `identify_comic`).
  - `tells the agent to ask for one specific photo from missing hints` (matches `barcode`, `indicia`, `ISBN`).
  - `offers an in-thread retry only for retryable failures` (matches `/retry/i` and `retryable`).
  - Keep the existing never-guess and no-write tests.
- [ ] **Step 2: Run** `pnpm exec vitest run src/templates/comic-catalog-template.test.ts`. Expected: FAIL.
- [ ] **Step 3: Rewrite `instructions.md`.** Keep the image-Read and never-guess sections. Replace "Catalog lookups … not connected yet" with the workflow from the spec's "Agent instructions" and "Retrying a failed lookup" sections:
  - one line for `confirmed`, e.g. `The Thing (1983) #1 · Metron 13806 · barcode + issue + Jul 1983 ✓`, plus "variant/printing not determined" or "reprint/facsimile" when flagged;
  - best candidates plus one sentence of evidence for other verdicts;
  - turn `missing` into **one** specific photo request, with the reason (barcode close-up → add-on digits identify the issue; indicia → printing and date; back cover or copyright page → ISBN);
  - on a retryable `lookup_failed`, say roughly when to try again and invite *retry* in the thread, then re-run `identify_comic` with the clues already read; on `auth`, say the Metron connection needs fixing;
  - one comic per message.

  Keep the Records rule ("Do not create, update, or delete records anywhere") unchanged.
- [ ] **Step 4: Run** the template test. Expected: PASS.
- [ ] **Step 5: Update docs.** In `local-setup.md`, add the Bun test commands (unit and live through the gateway) under Tests. In `architecture.md`, mark the comic-tools row as built and record the barcode handling settled in Task 5. Write `phase-2-checklist.md` with the three posts from the spec (confirm; cut-off barcode then answer in-thread; Metron lacks it), what a pass looks like for each, and where Claude checks (`outbound.db`, `logs/nanoclaw.log`).
- [ ] **Step 6: Commit** `feat(comic-catalog): identification workflow instructions and Phase 2 docs`, then run build, test and stamp.
- [ ] **Step 7: Restamp and restart** as in Task 2, Step 11.
- [ ] **Step 8: Run the checklist with littlelazer.** Ask them to make the three posts, check each against the checklist, and record the results (date, pass or fail, notes) in `phase-2-checklist.md`. Commit `docs(comic-archive): record Phase 2 acceptance results`, then build, test and stamp.
