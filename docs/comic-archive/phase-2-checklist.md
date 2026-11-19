# Phase 2 Slack checklist

Run at Phase 2 acceptance and after any change to what the agent says in Slack (instructions, reply format, photo requests). littlelazer makes the posts in `#comic-archive`; Claude checks the logs and records results below. Post each as its own top-level message (one comic per message).

## Posts

1. **A cover that should confirm** (a common comic with a legible barcode, issue number and date).
   Pass: a one-line confirmed reply with a Metron ID, e.g. `The Thing (1983) #1 · Metron 13806 · barcode + issue + Jul 1983 ✓`.
2. **A cover with the barcode cut off**, then send the requested photo in the same thread.
   Pass: the first reply is not confirmed and asks for exactly one specific photo with its reason, from the first `missing` hint. For a `probable` match the request is worded as optional ("only if you want it confirmed"). After the photo, the reply is confirmed or explains why not.
3. **A comic Metron lacks** (for example a foreign edition).
   Pass: a no-match reply that says what was read, with no invented Metron ID. When Metron has a series with the same title, an `ambiguous` reply that points out the publisher difference also passes (the printed publisher is not matched; see `architecture.md`).

A retryable failure (Metron busy or unavailable) cannot be forced on demand. Check the in-thread *retry* flow when one occurs naturally.

## Where Claude checks

- `data/v2-sessions/<group>/<session>/outbound.db` (`messages_out`): what the agent replied.
- `logs/nanoclaw.log` (and `logs/nanoclaw.error.log`): routing and delivery.
- The session transcript under `.claude-shared/projects` in the session folder: look for `mcp__comic-catalog__identify_comic` calls and confirm the clues sent contained no null or empty values.

## Results

| Date | Post | Pass/fail | Notes |
| --- | --- | --- | --- |
| 2026-11-18 | 1 · Avengers #329 | Pass after fix | First run: `probable`, because the cover printed only "FEB". In-thread indicia photo then confirmed Metron 18279 ✓. Fixed so a barcode-prefix match on series, number and month confirms without a year (fb70c3a5). |
| 2026-11-18 | 2 · Solar, Man of the Atom #55 | Fail, then partial | First run: the reply also answered a stale channel message (Metron 13806) left from setup. Fixed (7250cee6). Repost: only Solar, `probable` Metron 140438, no nulls in the clues. But it asked for the barcode (second hint) instead of `cover_date` (first hint). It ran 30 s before the optional-photo change (b5af0035), so the optional wording is untested. |
| 2026-11-18 | 3 · Legacy (Rising Eagle Comics) | Fail, then pass | First run: same stale 13806 answer. Repost: only Legacy, `ambiguous` with Metron's 2003 Image series, publisher difference stated, asked for the issue-number photo (first hint), every ID came from the tool. |
| 2026-11-18 | 2 · Solar, Man of the Atom #55 (second repost) | Partial, then fixed | Only Solar, `probable` Metron 140438, photo worded as optional ✓. Asked for the barcode again (second hint, twice in a row) and gave no reason, which the instructions' own example also lacked. The first-hint rule and the example were tightened in the next commit. |
| 2026-11-18 | 2 · Solar, Man of the Atom #55 (third repost) | Pass | Only Solar, `probable` Metron 140438, first hint (`cover_date`) with its reason, worded as optional. It asked for a "cover-date closeup" though the year is not on the cover, so `cover_date` now maps to the indicia in the next commit. |
