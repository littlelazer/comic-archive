# Phase 3 Slack checklist

Run at Phase 3 acceptance and after any change to how the agent settles covers, asks with buttons or replies in Slack. littlelazer makes the posts in `#comic-archive`; Claude checks the logs and records results below. Post each as its own top-level message (one comic per message).

## Posts

1. **A variant cover with the barcode visible** (including the 5-digit add-on).
   Pass: a one-line confirmed reply with a Metron ID that names the cover and says it was settled by `barcode`, e.g. `Absolute Batman (2024) #1 · 10th Printing · direct · Metron 127884 ✓ (barcode)`.
2. **The same or another variant with the barcode covered.**
   Pass: the reply names the cover and says `compared by eye`, or asks with one button per remaining cover, each labeled with Metron's name and with links to Metron's images in the question. After a tap, the reply says `confirmed by you`. No cover is named that isn't in Metron's list.
3. **A cover that gives an ambiguous issue** (e.g. a title with several volumes and no year). Tap one.
   Pass: up to 3 buttons labeled "Series (year) #number", with a one-line reason each. After the tap, the reply is confirmed for the tapped issue and says `confirmed by you`.
4. **Let one button question time out** (wait more than 5 minutes), then reply in the thread with the number or name of a choice.
   Pass: on timeout the agent says the buttons have expired, the comic is left unconfirmed, and you can reply with the number. After the reply, the result comes from `confirm_choice` and says `confirmed by you`.
5. **A newsstand copy.**
   Pass: the reply mentions `newsstand`, and the `identify_comic` call sent `edition: newsstand`.
6. **Phase 2's three posts** ([`phase-2-checklist.md`](phase-2-checklist.md)), as a regression.
   Pass: each meets its Phase 2 pass criteria.

A late tap on expired buttons never reaches the agent; that is expected (see `architecture.md`).

## Where Claude checks

- `data/v2-sessions/<group>/<session>/outbound.db` (`messages_out`): what the agent replied, and the button cards.
- `logs/nanoclaw.log` (and `logs/nanoclaw.error.log`): routing, delivery and button responses.
- The session transcript under `.claude-shared/projects` in the session folder: look for `mcp__comic-catalog__identify_comic`, `mcp__nanoclaw__ask_user_question` and `mcp__comic-catalog__confirm_choice` calls. Confirm the clues sent contained no null or empty values, the agent `Read` each `imagePath` before naming a cover by eye, and `confirm_choice` got only the tapped `metron_id` or `cover_label`.

## Results

| Date | Post | Pass/fail | Notes |
| --- | --- | --- | --- |
| 2026-11-22 | 1 · Variant, barcode visible | Not run | No post yet. |
| 2026-11-22 | 2 · Youngblood #0, two covers, no barcode | Fail | Both `probable` (cover prints only "DEC"), so no cover steps ran. Fixed by confirming month-only covers on series, number and month (decided by littlelazer). |
| 2026-11-22 | 3 · The Thing #1 | Fail | `ambiguous` with 3 candidates, but the agent replied in text, no buttons, and claimed a barcode match the result did not list. Instructions fixed: ambiguous with 2–3 candidates asks with buttons; cite only returned evidence. |
| 2026-11-22 | 4 · Button timeout | Not run | Needs post 3 to ask with buttons. |
| 2026-11-22 | 5 · Flash #279 newsstand | Fail | Agent sent no barcode or `edition`; reply had no `newsstand`. Instructions fixed: read any visible barcode, always send `edition` when the barcode box is visible. |
| 2026-11-22 | 6 · Phase 2 regression | Pass | Avengers #329 and Solar #55 `probable` with the optional photo offer; Legacy named the Image candidates and their publisher conflict. |
| 2026-11-22 | 5 · Flash #279 newsstand (re-run) | Pass | Confirmed on month alone, `edition: newsstand` sent, reply ends `· newsstand`. |
| 2026-11-22 | 2 · Youngblood #0 (re-run) | Pass, limited | Confirmed Metron 170612 (month-only rule). Metron lists no variants for #0, so the cover is `only_cover` and two physical covers can't be told apart from Metron data. The same photo was posted twice; the second cover was not re-posted. |
| 2026-11-22 | 3 · The Thing #1 (re-run) | Fail | `ambiguous` with 4 candidates, 2 conflict-free (1983, 2025, both July). The 2–3 limit counted all candidates, so no buttons; the reply also guessed the 1983 issue. Fixed: buttons for 2–3 conflict-free candidates only; never guess. |
| 2026-11-22 | 1 · Variant, barcode visible | Not run | littlelazer had no such variant to hand; left open. Code covered by `cover.live.test.ts` (Absolute Batman #1, 10th Printing). |
| 2026-11-22 | 3 · The Thing #1 (second re-run) | Fail | Agent sent `cover_year: 1983`, which the cover does not print, copied from the instructions' example reply (The Thing (1983) #1), so it confirmed. Fixed: placeholder example, `cover_year` only when printed; the tool now decides buttons by returning `choices`. |
| 2026-11-22 | Button check (text post) | Not a test | Agent declined a non-comic request, so no buttons were tried. Slack app Interactivity was checked and is on. |
| 2026-11-23 | 3 · The Thing #1 (third re-run) | Fail | Result had no `choices`: Metron's "Thing" #1 search has 107 matches over two pages, so the narrowed result was treated as incomplete. Fixed: fetch the second page when it completes the search (live test added). |
