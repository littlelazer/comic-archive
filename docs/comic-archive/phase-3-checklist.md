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
