# comic-archive — Developer Implementation Plan

**Project:** `comic-archive`  
**Status:** Planning; NanoClaw has already been cloned locally.  
**Development host:** Primary Mac.  
**Production host (later):** Older Intel Mac mini, 16 GB RAM, 256 GB SSD + approximately 1 TB HDD, currently running macOS with an Apple Fusion Drive. Linux will be installed **before** deployment.  
**Core workflow:** Slack cover photo → NanoClaw → vision extraction → Metron lookup → cover/edition verification → confirmation as needed → Airtable.

## 0. Working instructions for the coding agent

1. Work **inside the existing local NanoClaw clone**. Do not clone NanoClaw again or assume its path, version, architecture, channel capabilities, or installation state.
2. The user's project/repository is named **`comic-archive`**. Before changing Git remotes, repository names, or directory structure, inspect the existing clone and ask for approval if a rename, fork, or remote change is needed. Do not overwrite the existing Git history.
3. Inspect the checked-out NanoClaw documentation, code, existing skills, tests, and setup commands before implementing anything. NanoClaw changes rapidly; do not assume previously described commands or directory layouts are current.
4. Prefer **agent instructions and standalone integrations/MCP tools** over patches to NanoClaw core. Patch the Slack adapter or runtime only if inspection demonstrates a missing capability.
5. Build and test on the **primary Mac first**. Do not provision, install Linux on, or deploy to the Mac mini until the local application meets the agreed acceptance criteria and the user explicitly starts the deployment phase.
6. Keep credentials, Slack images, runtime state, and agent memory out of Git. Never put secrets in prompts, `CLAUDE.md`, logs, or test fixtures. Verify the actual NanoClaw credential mechanism before using it.
7. Make small, reviewable changes with tests. Before adding dependencies or external APIs, check their current documentation, access rules, limits, and licensing.
8. Do not assume that model vision, Slack image ingestion, interactive buttons, MCP server registration, or credential injection work without testing them in the checked-out version.
9. Before any destructive action (schema modification, record overwrite/delete, Git remote change, host disk operation), obtain explicit user approval.
10. At the end of each phase, report changes, tests, remaining questions, and exact commands to reproduce results.

## 1. Objective and non-goals

### Objective

A user sends a photo of a comic-book cover to a dedicated Slack bot or channel. The agent identifies the **exact issue and, where possible, variant/printing/edition**, verifies it using catalog data and cover comparison, asks for confirmation when ambiguous, checks for an existing collection record, and creates or updates the appropriate Airtable record with the original photograph. The agent replies in the originating Slack thread.

### Non-goals for initial release

- Running a large vision/language model locally on the Mac mini.
- Building a custom NanoClaw agent framework or replacing its execution loop.
- Automatic grading, valuation, resale pricing, or purchasing.
- Unattended changes to the Airtable schema or deletion of records.
- Production deployment before local validation.

## 2. Architecture and component boundaries

```text
Primary Mac (development)
  existing NanoClaw clone / comic-archive Git project
  ├── NanoClaw Slack channel + isolated ComicCatalog agent
  ├── ComicCatalog instructions (CLAUDE.md, at actual supported location)
  ├── comic identification integration (vision, Metron, cover matching, GCD fallback)
  ├── Airtable integration (lookup, create/update, attachment handling)
  ├── automated tests and fixtures
  └── local credentials and state (not committed)

Slack photo -> Slack channel adapter -> NanoClaw agent
  -> image extraction -> candidate search -> match scoring
  -> user confirmation if needed -> duplicate/copy decision
  -> Airtable write -> Slack thread response

Later: deploy tested code to Intel Mac mini running Linux x86-64.
```

**Division of responsibility:** NanoClaw owns message routing, agent sessions, tool invocation, and container isolation where supported. The comic integrations own provider-specific API calls, normalization, scoring, deduplication, and idempotency. Agent instructions define orchestration and confirmation rules; they are **not** the sole enforcement of write authorization.

## 3. Initial repository audit (first coding task)

- [ ] Inspect current directory, `git status`, branches, remotes, NanoClaw commit/version, and package scripts.
- [ ] Verify whether `comic-archive` is the directory name, remote repository name, or both; do not rename automatically.
- [ ] Read current NanoClaw README, relevant skill instructions, agent/group configuration, Slack channel implementation, image handling, MCP/tool support, container mounts, and credential setup.
- [ ] Determine whether Slack file attachments are already downloaded, made accessible to the agent, and accepted by the chosen vision-capable model.
- [ ] Verify actual setup/start/test commands and required Node/runtime/container dependencies.
- [ ] Propose a directory layout consistent with the existing codebase. Avoid creating a parallel framework.
- [ ] Produce a short `docs/architecture.md` explaining extension points and any unavoidable upstream patches.

**Exit criteria:** A documented, reproducible local boot path; an explicit gap list; no speculative modifications to core code.

## 4. Proposed data contracts

Keep provider responses at integration boundaries and normalize to internal typed objects. Exact schemas may be refined after checking API payloads.

```ts
type CoverClues = {
  seriesTitle?: string;
  issueNumber?: string; // preserve 1A, 0.1, etc.
  publisher?: string;
  printedDate?: string;
  upc?: string;
  coverText?: string[];
  visualClues?: string[];
  uncertainties: string[];
};

type ComicCandidate = {
  source: 'metron' | 'gcd' | 'comicvine';
  sourceId: string;
  series: string;
  issueNumber: string;
  publisher?: string;
  coverDate?: string;
  variantOrEdition?: string;
  coverImageUrl?: string;
  upc?: string;
  externalIds?: Record<string, string>;
};

type IdentificationDecision = {
  status: 'confirmed' | 'needs_review' | 'unmatched';
  selected?: ComicCandidate;
  candidates: ComicCandidate[];
  confidence?: number;
  evidence: string[];
  ambiguities: string[];
};
```

Treat numeric confidence as a **calibrated application heuristic**, not as an LLM's unverified claim of certainty. Start with conservative rules; document the score inputs and thresholds after testing representative covers.

## 5. Identification workflow

### 5.1 Slack intake and image preservation

- [ ] Receive image attachments in the dedicated Slack channel/DM using the current supported NanoClaw integration.
- [ ] Download images through authorized Slack APIs; check MIME type, size, HTTP status, and permissions.
- [ ] Store an original copy in a permitted, temporary agent workspace; use an image derivative for vision/comparison if necessary.
- [ ] Retain a stable Slack event/request ID for idempotency; avoid logging private download URLs or tokens.
- [ ] Reply in the originating thread; provide actionable errors for unreadable or inaccessible files.

### 5.2 Vision extraction

- [ ] Send the image to an available vision-capable cloud model using the supported NanoClaw path.
- [ ] Extract `CoverClues` with structured validation and explicit uncertainty.
- [ ] Distinguish a visible UPC from a guessed UPC; do not fabricate dates, numbers, or creators.

### 5.3 Primary catalog lookup: Metron

- [ ] Verify Metron's current API endpoints, authentication, request limits, issue search, cover images, external IDs, and any perceptual-hash fields.
- [ ] Search using verified UPC/barcode when available, then series + issue + publisher/date.
- [ ] Normalize results into `ComicCandidate`; preserve Metron IDs and source metadata.
- [ ] Rate-limit, time out, retry safely, and distinguish not-found from provider errors.

### 5.4 Cover matching and variants

- [ ] Compare candidate cover data/images against the submitted photo when permitted and practical.
- [ ] Combine exact identifier agreement, metadata agreement, and image similarity into documented scoring.
- [ ] Handle variant covers, direct/newsstand differences, reprints, facsimiles, and multiple series with the same title.
- [ ] Do not equate an exact title/issue match with an exact edition match.

### 5.5 Decision and confirmation

- [ ] High confidence **with no unresolved edition ambiguity**: accept identification.
- [ ] Medium confidence or multiple plausible editions: present a short candidate list and request confirmation in Slack.
- [ ] Low confidence/no match: request another cover/barcode photo or manual entry; do not write a definitive record.
- [ ] Validate any confirmation response against the pending request and authorized Slack user; expire stale pending decisions.

### 5.6 Fallback providers (later phase)

- [ ] Add Grand Comics Database (GCD) for obscure/older comics when Metron is insufficient.
- [ ] Add Comic Vine only if needed and if API access and usage terms permit.
- [ ] Preserve cross-reference IDs; never silently merge conflicting editions.

## 6. Airtable collection model

**Default:** one Airtable record per **physical owned copy**, not per unique comic issue. This is a starting policy requiring user approval before schema creation.

| Field | Type | Notes |
| --- | --- | --- |
| Series | Text | Normalized title |
| Issue Number | Text | Preserve alphanumeric issue numbers |
| Publisher | Text/select | Publisher/imprint |
| Cover Date | Date/text | Preserve uncertain/partial dates appropriately |
| Variant / Edition | Text | Printing, cover variant, direct/newsstand, facsimile |
| Writers | Long text | Credits |
| Artists | Long text | Interior credits |
| Cover Artists | Long text | Cover credits |
| UPC | Text | Identifier if verified |
| Metron ID | Text | Primary catalog ID |
| GCD ID | Text | Cross-reference |
| Comic Vine ID | Text | Optional cross-reference |
| Identification Confidence | Number | Scoring heuristic |
| Identification Status | Single select | Confirmed / Needs review / Unmatched |
| Identification Source | Text/select | Primary evidence provider |
| Original Cover Photo | Attachment | Submitted Slack image |
| Catalog Request ID | Text | Idempotency key |
| Copy Number | Number/text | Distinguish owned copies |
| Added At | Created time | Cataloging timestamp |
| Notes | Long text | User-entered notes/condition |

**Write rules:**

- [ ] Read the existing base/table schema before proposing changes; never alter schema without approval.
- [ ] Search by source IDs and edition attributes before creating a record.
- [ ] If a matching issue exists, ask whether this is an **additional physical copy** or a correction to an existing record; do not silently reject or overwrite it.
- [ ] Deduplicate repeated Slack deliveries using a durable `Catalog Request ID` and a concurrency-safe strategy. An Airtable search-then-create alone is not sufficient against simultaneous retries; use a serialized write path or local idempotency ledger and reconcile uncertain writes.
- [ ] Attach the original photograph using a supported Airtable attachment/upload flow; do not assume Slack private URLs are usable as public Airtable attachment URLs.
- [ ] Require explicit approval for overwriting existing record content or deleting records.
- [ ] On partial failures, report what was saved and what remains incomplete; retries must not duplicate copies.

## 7. Tools and integration design

Use MCP if the installed NanoClaw version supports the required registration and isolation cleanly; otherwise use its documented tool extension mechanism. Suggested **logical** tool boundaries (not guaranteed built-in tool names):

| Tool | Input | Output / behavior |
| --- | --- | --- |
| `extract_cover_metadata` | Image reference | Validated `CoverClues` |
| `search_metron` | Cover clues | Candidate list |
| `compare_covers` | Original image + candidates | Evidence and similarity signals |
| `search_gcd` | Cover clues | Fallback candidate list |
| `find_comic` | Catalog identifiers + edition | Existing records |
| `create_comic` | Confirmed candidate + copy decision + request ID | Airtable record ID |
| `update_comic` | Record ID + approved changes | Updated record ID |
| `attach_cover` | Record ID + original image | Attachment result |

Validate input and enforce permissions in tool code. Avoid giving the agent generic unrestricted shell, filesystem, or Airtable schema-write access when narrower tools suffice.

## 8. Local development milestones

### Phase 1 — NanoClaw foundation

**Implement**
- [ ] Complete repository audit (Section 3).
- [ ] Run the existing clone locally using its documented setup.
- [ ] Connect a dedicated Slack bot/channel with minimal required scopes; user approves installation.
- [ ] Configure the `ComicCatalog` group and instructions in the supported location.
- [ ] Confirm text messages work and test whether Slack images reach the agent.

**Acceptance:** A Slack message receives a threaded response; an image can be received or the missing ingestion capability is precisely documented and implemented with tests.

### Phase 2 — Thin vertical slice (read-only)

**Implement**
- [ ] Image preservation and vision extraction.
- [ ] Metron search and candidate normalization.
- [ ] Slack response containing probable comic and supporting evidence.
- [ ] No Airtable writes.

**Acceptance:** At least one known common comic cover is identified and supported by a real Metron result; failure paths do not fabricate metadata.

### Phase 3 — Reliable matching and confirmation

**Implement**
- [ ] Cover similarity checks and edition-sensitive scoring.
- [ ] Confirmation for ambiguous matches.
- [ ] Unit tests for normalization, scoring, and edition distinctions.

**Acceptance:** Known variants and reprints trigger correct distinction or explicit uncertainty; no ambiguous identification is silently finalized.

### Phase 4 — Airtable integration

**Implement**
- [ ] User approves base, table, schema, and copy policy.
- [ ] Scoped credentials and integration tools.
- [ ] Existing-record lookup, duplicate/copy decision, idempotent creation, original-photo attachment.
- [ ] Store the verdict on each record. The extra photo for a `probable` match is optional (decided by littlelazer, 2026-11-18), so probable comics are recorded as unconfirmed and can be filtered and rechecked later.
- [ ] Mocked integration tests plus one authorized end-to-end test.

**Acceptance:** A confirmed comic produces one correct record and original photo; a repeated Slack event does not create a second record; a genuine second physical copy can be added deliberately.

### Phase 5 — Provider fallbacks and hardening

**Implement**
- [ ] GCD fallback; Comic Vine only if justified.
- [ ] Retries, rate limits, observability, secret-safe logs, failure recovery, and backups for local agent state.
- [ ] Test cases: common issue, obscure issue, variant, reprint/facsimile, newsstand/direct ambiguity, unreadable photo, missing barcode, API failure, duplicate event, second owned copy, and attachment failure.

**Acceptance:** Documented behavior for each test case, with no unapproved writes or leaked secrets.

### Phase 6 — Linux Mac mini deployment (**deferred**)

**Prerequisites:** Phases 1–4 pass locally, user approves deployment, and Linux has already been installed on the Mac mini.

- [ ] User backs up macOS and Fusion Drive data before any disk changes.
- [ ] Separately plan the destructive Fusion Drive split and Linux installation; do **not** include automatic disk-wiping commands in this project.
- [ ] Verify Linux x86-64, SSD/HDD mounts, network access, SSH/Tailscale, Docker, Node/runtime requirements, and available resources.
- [ ] Clone/pull the `comic-archive` Git repository on the Mac mini; build native dependencies and containers for Linux x86-64.
- [ ] Provision production credentials separately; never copy the development secrets file into Git.
- [ ] Restore/migrate only necessary agent state and approved files.
- [ ] Configure supervised service startup, restart-on-failure, log rotation, backups, and health checks.
- [ ] Run Slack → identification → Airtable end-to-end smoke test, and verify reboot recovery.
- [ ] Document deploy, rollback, backup, restore, and upstream NanoClaw update procedures.

**Acceptance:** The agent runs independently when the primary Mac is offline and recovers after a Mac mini reboot.

## 9. Testing strategy

- **Unit:** title/issue normalization, date handling, candidate ranking, confidence rules, edition/variant matching, payload validation, and copy numbering.
- **Integration (mocked):** Slack attachment retrieval, vision output parsing, Metron/GCD responses, Airtable lookup/create/attachment, rate limits, errors, and retries.
- **End-to-end (authorized):** actual Slack photo to cataloged Airtable record, threaded acknowledgment, user confirmation, and repeated-event idempotency.
- **Security:** unauthorized confirmations, malicious prompt content in cover text or API metadata, inaccessible files, oversized uploads, credential exposure, and restricted tool permissions.

Use a test base/table for Airtable. Keep test photographs licensed/owned and avoid embedding real tokens or private Slack URLs in fixtures.

## 10. User-owned setup and approvals

- [ ] Confirm existing NanoClaw clone location and desired `comic-archive` Git remote arrangement.
- [ ] Authorize Slack app installation, scopes, and intended channel/DM.
- [ ] Choose and authorize model provider and billing.
- [ ] Create Metron account/API credentials and approve terms.
- [ ] Create/choose Airtable base/table, approve schema and one-record-per-copy policy.
- [ ] Create a least-privilege Airtable PAT for the approved base and actions.
- [ ] Approve optional fallback providers and their terms.
- [ ] Confirm high-confidence auto-accept policy versus requiring confirmation for **every** Airtable write.
- [ ] Later: back up Mac mini, install Linux, and explicitly authorize production deployment.

The coding agent may guide setup and verify nonsecret configuration, but must not request that long-lived credentials be pasted into Slack or source files.

## 11. Deliverables

1. Working `ComicCatalog` NanoClaw group and instructions.
2. Tested comic-identification integration with Metron and edition-aware verification.
3. Tested Airtable integration with copy-aware deduplication, idempotency, and original image attachments.
4. Slack threaded identification and confirmation workflow.
5. `docs/architecture.md`, `docs/local-setup.md`, `docs/airtable-schema.md`, `docs/testing.md`.
6. Later, `docs/deployment-mac-mini.md` with Linux x86-64 deployment and recovery instructions.
7. Phase-by-phase implementation notes, tests, and known limitations.

## 12. First task to give the coding agent

> You are working on **comic-archive**. NanoClaw has **already been cloned** on this Mac. First inspect the existing repository, its Git state, documentation, Slack/image support, agent configuration, MCP/tool extension points, and credential mechanism. Do not clone or rename anything, change remotes, install Linux, or deploy to the Mac mini. Produce a brief gap analysis and a concrete implementation proposal for **Phase 1**. Then implement the smallest safe Phase 1 changes, with tests, after identifying any user-required Slack/model authorizations. Keep comic-specific integrations modular and preserve upstream NanoClaw compatibility.

## 13. Reference material

- User-supplied **Comic Cover Catalog Agent — NanoClaw + Slack + Metron + Airtable implementation plan** (November 2026). The matching, schema, ambiguity, manual-approval, and security requirements above are derived from that document.
- NanoClaw: https://github.com/qwibitai/nanoclaw (verify current official upstream from existing clone).
- Metron API documentation: https://github.com/Metron-Project/metron/blob/master/api/README.md
- Airtable API: https://airtable.com/developers/web/api/introduction
- Grand Comics Database: https://www.comics.org/

**Implementation principle:** Inspect the actual checked-out code and current provider documentation before translating this plan into commands or APIs.
