# Phase 2 Slack checklist

Run at Phase 2 acceptance and after any change to what the agent says in Slack (instructions, reply format, photo requests). littlelazer makes the posts in `#comic-archive`; Claude checks the logs and records results below. Post each as its own top-level message (one comic per message).

## Posts

1. **A cover that should confirm** (a common comic with a legible barcode, issue number and date).
   Pass: a one-line confirmed reply with a Metron ID, e.g. `The Thing (1983) #1 · Metron 13806 · barcode + issue + Jul 1983 ✓`.
2. **A cover with the barcode cut off**, then send the requested photo in the same thread.
   Pass: the first reply is not confirmed and asks for exactly one specific photo with its reason. After the photo, the reply is confirmed or explains why not.
3. **A comic Metron lacks** (for example a foreign edition).
   Pass: a no-match reply that says what was read, with no invented Metron ID.

A retryable failure (Metron busy or unavailable) cannot be forced on demand. Check the in-thread *retry* flow when one occurs naturally.

## Where Claude checks

- `data/v2-sessions/<group>/<session>/outbound.db` (`messages_out`): what the agent replied.
- `logs/nanoclaw.log` (and `logs/nanoclaw.error.log`): routing and delivery.
- The session transcript under `.claude-shared/projects` in the session folder: look for `mcp__comic-catalog__identify_comic` calls and confirm the clues sent contained no null or empty values.

## Results

| Date | Post | Pass/fail | Notes |
| --- | --- | --- | --- |
