# comic-archive Phase 3 — Covers, editions and confirmation (design)

Status: for littlelazer's approval. Context: `/PLAN.md` (Phase 3, "reliable matching and confirmation"; §5.4–5.5), the Phase 2 design (`2026-11-18-comic-archive-phase2-design.md`), `docs/comic-archive/architecture.md`.

## Intent

Phase 2 identifies the **issue**. littlelazer's catalog is for **knowing what they own, and eventually what it is all worth**. Value depends on more than the issue: the cover variant, newsstand vs direct edition, the printing, and original vs reprint or facsimile can change a comic's price many times over. Phase 3 makes "confirmed" mean **the exact comic in hand** wherever the photo and Metron can show it. When they cannot, the uncertainty is settled quickly in the thread or recorded plainly, and is never silently treated as final.

## How it is used (decided by littlelazer)

- Box sessions continue as in Phase 2: one comic per message, short replies, follow-ups in the comic's thread.
- **When the agent knows the issue but not which cover, it settles it on the spot if that can be done quickly** (littlelazer). It compares Metron's covers with the photo itself (approach 1, below). It asks only when it cannot tell, using Slack buttons that littlelazer taps.
- When several issues fit (today's `ambiguous`), the agent shows up to 3 tap buttons instead of a paragraph.
- A tap counts as **confirmed by littlelazer**, and the reply says so.
- No tap within the button window leaves the comic **unconfirmed**. The thread says the buttons expired and littlelazer can reply with a number later (decided by littlelazer). Other threads are never held up.
- `probable` matches keep Phase 2's optional extra photo ("only if you want it confirmed").

```
[cover.jpg]
 └─ ComicCatalog: Absolute Batman (2024) #1 · Cover B (Jim Lee) · direct · Metron 127884 ✓ (barcode)
[cover.jpg]
 └─ ComicCatalog: Spawn (1992) #1 ✓ issue. Two covers look alike. Which one is yours?
                  [ Regular ]  [ Newsstand ]   (links to Metron's images)
      └─ (tap: Newsstand)
      └─ ComicCatalog: Spawn (1992) #1 · Newsstand · Metron … ✓ confirmed by you
[cover.jpg]
 └─ ComicCatalog: Two issues fit. Which is it?
                  [ The Thing (1983) #1 ]  [ The Thing (2006) #1 ]
```

## Goals

1. Identify the **cover variant** when Metron lists variants: by barcode when the add-on digits are read, by printed markings, price and printing, and otherwise by comparing Metron's cover images with the photo.
2. Record the **edition details visible on the cover** with every comic: newsstand or direct, any variant marking as printed (e.g. "Cover B", "1:25", artist name), and the printing. They feed values later, so a box never needs photographing twice.
3. Settle uncertain covers and ambiguous issues with **one tap** when the agent cannot settle them itself.
4. Say **how each answer was settled**: barcode, markings, compared by eye, or confirmed by littlelazer.
5. Fix the Phase 2 carry-overs (below).

## Non-goals (this phase)

- Prices or values of any kind (a later phase). Phase 3 only captures the details values will need.
- Writing records anywhere. The template's "Records" rule stays; Airtable is Phase 4.
- Matching cover fingerprints in code (approach 3, rejected).
- Newsstand vs direct from images: it is read off the barcode box on the photo. Metron's variant list is used where it names a newsstand edition.
- GCD or Comic Vine fallback (Phase 5).
- A numeric confidence score. PLAN.md mentions "scoring"; verdicts stay as rules plus evidence, with the settling method stated (Claude's call: a score adds nothing littlelazer acts on).

## Anti-goals (failure even if it "works")

- Naming a cover variant that did not come from Metron's variant list, the barcode, or a tap.
- Presenting a cover chosen by eye as if a barcode proved it. The reply always says how the cover was settled.
- Holding up a box session: a button question blocks only its own thread.
- Downloading dozens of cover images per comic. The comparison set is capped.
- Anything that weakens Phase 2's rules: no invented IDs, no secrets, matching rules in code.

## Constraints

- Everything from the Phase 2 design still holds: no NanoClaw core patches, the stdio MCP server inside `templates/comic-catalog/`, Bun, the gateway-injected Metron token, the shared rate limit (20/min burst, 5,000/day), strict TDD, ABOUTME headers, no mock modes in the product.
- **Metron variant data** (verified live, Absolute Batman #1, Metron 127884, 74 variants): each issue detail has `variants[]`, each with `name`, `price`, `sku`, `upc` and `image`. Variant barcodes share the main barcode and differ in the 5-digit add-on (e.g. main `…84600111`, 10th printing `…84600110`). Some store variants have no `sku`. Older issues often list no variants and no barcode (Amazing Spider-Man #300, Metron 11854).
- Metron's `upc` filter matches main **or variant** covers (Metron API README), so an exact barcode search can land on an issue through a variant's barcode.
- **Cover images** are on `static.metron.cloud`. Fetching one through the gateway as ComicCatalog works with no approval prompt (verified: Solar #55's cover, 200, image/jpeg, ~100 KB). Image downloads do not go to `metron.cloud/api/`, but the builder should confirm whether they count toward the API rate limit.
- **Slack buttons**: NanoClaw's `ask_user_question` tool (`container/agent-runner/src/mcp-tools/interactive.ts`) is available to every agent. It posts a card with buttons and blocks that agent's turn until a tap or a timeout (default 300 s), then returns the tapped option's value. Each thread is its own container, so a waiting question blocks nothing else.
- **Who can tap:** NanoClaw records which user tapped but does not restrict who may answer (`src/modules/interactive/index.ts`). Anyone in `#comic-archive` could tap. littlelazer is fine with anyone in the channel being able to tap (decided by littlelazer).
- `send_card` cannot show images. Buttons carry text labels; the question text carries links to Metron's cover images.

## Approaches considered

1. **The agent compares covers itself and asks only when unsure — chosen by littlelazer.** The lookup tool narrows Metron's variants using what code can check: barcode add-on, printed markings, price and printing. The few that remain are downloaded for the agent to compare with the photo. When two still look alike, the agent asks with buttons. Most comics need no tap.
2. Always ask with buttons when an issue has more than one cover. Simpler, but means a tap on every variant issue, and Metron's names alone don't always tell covers apart.
3. Fingerprint matching in code against Metron's `cover_hash`. Needs cropping and straightening of phone photos and image libraries, and still can't see newsstand vs direct. Rejected.

## Design

### Clues (additions to `identify_comic`)

| Field | Notes |
| --- | --- |
| `edition` | `newsstand` (price barcode, no direct-market mark) \| `direct` (logo or "Direct Edition" in the barcode box) \| omitted when unclear |
| `variant_marking` | Any variant text as printed, e.g. "Cover B", "1:25", "Virgin", an artist credit on the cover |
| `price` | Already accepted; now normalized and used to narrow variants by `variants[].price` |

All existing fields and rules stay. Omit what can't be read; never guess.

### Settling the cover (code first, eyes second, tap last)

Runs once the issue is settled (confirmed, or chosen by tap) and Metron lists variants. The main cover counts as one of the choices. `probable` and `ambiguous` matches don't run these steps until the issue is settled, so a probable match stays low-friction (Claude's call). The cover steps always fetch the settled issue's detail, outside the search request target. If the detail can't be fetched, the cover is **variants unknown**, never "only cover" (Claude's call, from the builder check).

1. **Barcode.** A read main barcode plus a 5-digit add-on that equals the main `upc` or one `variants[].upc` settles the cover. Settled by: barcode.
2. **Markings.** Otherwise, narrow the choices by what was read and what Metron's names and prices show: printing (a "2nd printing" mark against variant names containing "printing"), price as printed against `variants[].price`, `variant_marking` against variant names, and `edition` against names containing "newsstand" or "direct". A single remaining choice settles it. Settled by: markings.
3. **By eye.** If between 2 and the comparison cap (Claude's proposal: 6) remain, the tool downloads those cover images into the agent's workspace and returns their paths and names. The agent `Read`s them beside the photo. It names one only when the match is clear. Settled by: compared by eye.
4. **Tap.** If the agent can't tell, it asks with `ask_user_question`. There is one button per remaining cover (up to the cap), labeled with Metron's variant name, and the question links Metron's images. Settled by: confirmed by littlelazer.
5. **Too many to compare.** If more than the cap remain after step 2 and no add-on was read, ask for a barcode close-up (the add-on settles it). If the add-on can't help (store variants without a barcode), record the cover as **not determined**.

When Metron lists no variants, the cover is the issue's only cover and no step runs. The reply mentions the cover only when variants exist or an edition detail was read.

### Choosing between issues (`ambiguous`)

When the verdict is `ambiguous` with 2–3 candidates, the agent asks with `ask_user_question`. Each button is labeled "Series (year) #number", with a one-line reason in the question text. The tapped Metron ID then goes through the cover steps above. With more than 3 candidates, the agent keeps Phase 2's behavior: name the top ones and ask for the first `missing` photo. The issue verdict rules themselves don't change.

A tap must turn into a result the code produced, not one the agent typed. So `identify_comic` (or a sibling tool; builder's call) accepts the chosen Metron ID with the same clues. It fetches that issue's detail, runs the conflict checks and the cover steps, and returns the result marked as chosen by the user. A chosen ID with a conflicting clue (e.g. a different issue number) is reported, not confirmed. A chosen cover must be a name in Metron's variant list for that issue, or the main cover. The tool can't see the tap itself: NanoClaw's button tool returns only the chosen option to the agent. So "confirmed by you" rests on the agent reporting the tap honestly, backed by these code checks (Claude's call; a tool-side record of offered choices was judged not worth its size for a single-user catalog).

### When nobody taps

`ask_user_question` times out after its default 300 s (decided by littlelazer: option a). NanoClaw keeps accepting taps on an expired card and marks it answered, but the agent never receives them (`src/modules/interactive/index.ts`; the poll loop drops `system` messages, `container/agent-runner/src/poll-loop.ts`). So on timeout the agent replies that the buttons have expired, the comic is left unconfirmed, and littlelazer can reply in the thread with the number or name of their choice. That later reply is handled like a tap (same tool path). A number typed while the buttons are still waiting reaches the agent only when the wait ends. The instructions say to tap, not type, while buttons are live.

### Result additions

Each result gains, for the settled or leading candidate:

- `cover`: `{ status: 'only_cover' | 'variants_unknown' | 'settled' | 'compare' | 'ask' | 'not_determined', settledBy?: 'barcode' | 'markings' | 'eye' | 'user', variantName?, choices?: [{ label, name, imageUrl, imagePath? }] }`. Names are illustrative; the builder settles the exact shape.
- `edition`: what was read (`newsstand`/`direct`, marking, printing), echoed so the reply and Phase 4 can use it.

### Phase 2 carry-overs

1. **Barcode read, title not.** Add a `series_title` photo hint (e.g. `title`). It comes first when a barcode was read without a title and the barcode search found nothing, so the agent no longer says "no match" there. It also covers the case where nothing could be searched (`searched: false`) and no other hint applies.
2. **Add-on cut-off year.** `FIRST_FULL_ADDON_YEAR = 2008` is wrong: Solar #55 (1996) is stored with a 5-digit add-on. During the build, pin the real start with a handful of live lookups across 1985–2000 and keep the evidence in a comment. Until then, ask for the add-on whenever a main barcode is read without one.
3. **Hardcovers and omnibuses beyond page one.** Follow Metron's `next` page for the bound-trade series search, within a raised per-call request target (Claude's proposal: 5 API requests, up from 4).
4. **Wording.** The `barcode_closeup`/`barcode_addon` reason becomes "the add-on digits pin down the exact issue and cover". The stale ABOUTME in `tools.test.ts` gets fixed.

### Agent instructions

Add:
- the cover steps and when to look by eye;
- that a by-eye choice is named only when clear, and the reply says it was compared by eye;
- how to ask with buttons (labels, links, one question per comic);
- how to handle a tap, a timeout and a later reply with a number;
- that edition details are reported briefly.

Phase 2's rules all stay.

### Deployment

As in Phase 2: commit, build, test, re-stamp the upgrade marker, restart, restamp the template, restart the group.

## Testing

- **Unit** (Bun): variant settling by barcode add-on (main vs variant), narrowing by printing, price, marking and edition, the comparison cap, the "too many" path, the chosen-ID path including a conflicting chosen ID, the new `title` hint, the add-on rule, and trade paging.
- **Integration (live, through the gateway):** Absolute Batman #1 (Metron 127884, 74 variants) with a variant barcode settles by barcode; Solar #55 (no variants) is `only_cover`; a cover image download lands in the workspace.
- **Stand-ins** (Phase 2 decisions apply): a local server may imitate Metron for error paths and for cascade logic, including image download failures. No fake mode in the product.
- **Template test:** pins the new instruction rules (the settling-method wording, buttons, the timeout handling).
- **End-to-end (manual checklist, extending `docs/comic-archive/phase-2-checklist.md` or a Phase 3 sibling):**
  1. A variant cover with the barcode visible: settled by barcode.
  2. The same or another variant with the barcode covered: settled by eye, or buttons.
  3. A cover that gives an ambiguous issue (e.g. a title with several volumes and no year): buttons. Tap one, and confirm the reply says "confirmed by you".
  4. Let one button question time out: the agent says the buttons expired. Then reply with a number and get a result.
  5. A newsstand copy: edition recorded.
  6. Phase 2's three posts still pass (regression).

## Acceptance (PLAN.md, made concrete)

- Known variants and reprints are either distinguished correctly or shown as not determined. The reply always states how the cover was settled.
- No ambiguous identification is final without either rules that settle it or littlelazer's tap.
- A box session is never held up by one comic's question.
- Every edition detail read off the cover appears in the result.

## Left to the builder

- Exact tool shapes (extend `identify_comic` vs a sibling tool for chosen IDs and cover downloads), field names, and the comparison cap if 6 proves wrong.
- Where downloaded covers live in the workspace and when they are cleaned up.
- Exact reply wording, within the rules above.
- Whether cover image downloads count toward Metron's API rate limit.
