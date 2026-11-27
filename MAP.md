# MAP.md — comic-archive

Agent guide to what's where. Read this before exploring. Keep it current when the project changes.

## What this is

comic-archive is a **NanoClaw v2 install** (fork of `nanocoai/nanoclaw`) plus one agent, **ComicCatalog**. A user posts a photo of a comic cover in Slack (`#comic-archive`). The agent reads the photo, identifies the exact issue and cover through Metron, asks with Slack buttons when it can't decide, and replies in the thread. A later phase writes the confirmed comic to Airtable.

Everything comic-specific uses NanoClaw's supported extension points: an agent template with a bundled MCP server. **There are no core patches.** Keep it that way so upstream updates merge cleanly.

- Upstream NanoClaw (host, containers, channels, `ncl`, gateways): root `CLAUDE.md` and `docs/`. Don't re-document it here.
- comic-archive's own plan and status: `PLAN.md` (phases 1–6) plus the docs below.

## Status

| Phase | State | Where |
| --- | --- | --- |
| 1 NanoClaw foundation, Slack images | Done | `docs/comic-archive/architecture.md` |
| 2 Read-only identification (Metron) | Done | `docs/superpowers/{specs,plans}/2026-11-18-comic-archive-phase2*.md`, `docs/comic-archive/phase-2-checklist.md` |
| 3 Covers, editions, button confirmation | Nearly done. Checklist posts 1 (variant with barcode), 2 (choosing a cover with buttons) and the button tap itself are still unrun | `docs/superpowers/{specs,plans}/2026-11-18-comic-archive-phase3*.md`, `docs/comic-archive/phase-3-checklist.md` |
| 4 Airtable writes | Not started; needs littlelazer's base/schema/copy-policy approval | `PLAN.md` §6, §8 |
| 5 GCD fallback, hardening | Not started | `PLAN.md` §8 |
| 6 Linux Mac mini deploy | Deferred until littlelazer starts it | `PLAN.md` §8 |

Each phase follows the same pattern: a design spec, then a plan doc, then TDD, then a Slack checklist that littlelazer posts and Claude verifies from logs. The results go into the checklist's table.

## Where the comic code lives

```
templates/comic-catalog/              # agent template (Agent Plugins 1.0.0); tracked via a .gitignore exception
├── plugin.json                       # name, version (bump on change), agentName "ComicCatalog"
├── mcp.json                          # declares stdio MCP server: bun ${PLUGIN_ROOT}/server/index.ts
├── ai.nanoco.nanoclaw/context/instructions.md   # the agent's orchestration rules (reply format, buttons, cover steps)
└── server/                           # dependency-free TypeScript MCP server, run by Bun in the container
    ├── index.ts / mcp-stdio.ts       # entry point + JSON-RPC stdio transport
    ├── tools.ts                      # tool definitions: identify_comic, get_comic, confirm_choice
    ├── clues.ts                      # validates/normalizes cover clues (title, number, barcode, edition, price…)
    ├── metron-client.ts              # Metron API client: rate limits, 60 s wait budget, request target
    ├── identify.ts                   # search cascade (barcode → series+number(+year) → trades), paging
    ├── verdict.ts                    # confirmed / probable / ambiguous / no_match rules, conflicts, choices
    ├── cover.ts                      # cover steps: barcode → markings → compare → tap → not_determined
    ├── cover-images.ts               # runs the cover steps and downloads choice images (≤5 MB, image-only) for comparison
    └── confirm.ts                    # confirm_choice: re-checks a tapped Metron ID / cover label
src/templates/comic-catalog-template.test.ts   # vitest: template parses, MCP server declared, instruction rules pinned
docs/comic-archive/                   # architecture.md (extension points, gap list, Metron findings), local-setup.md, checklists
PLAN.md                               # whole-project plan and acceptance criteria
```

The data contracts (`CoverClues`, verdicts, `CoverResult`) are in `server/clues.ts`, `server/verdict.ts` and `server/cover.ts`. The design rationale is in the Phase 2 and 3 specs.

## How it runs

Slack photo → `@chat-adapter/slack` (Socket Mode) → host saves the file to `data/v2-sessions/<group>/<session>/inbox/` → the agent container sees `[image: … saved to /workspace/inbox/…]` → the instructions make the agent `Read` the image → the agent calls `identify_comic` with clues → the result comes back with a verdict and cover status → `ask_user_question` (buttons, 300 s timeout) if needed → `confirm_choice` → a threaded reply. The full trace with line refs is in `docs/comic-archive/architecture.md`.

- **The live group** is folder `groups/comiccatalog/`, agent group id `ag-178c5abd-15a6-4159-87be-1a81fc01103c`. `groups/` is install state (gitignored). Never edit `groups/comiccatalog/CLAUDE.md` or `container.json`, because they are rewritten on every spawn.
- **Template changes reach the live agent only by restamping.** Run `pnpm run ncl groups create --template comic-catalog` (dry run), then add `--yes`, then `pnpm run ncl groups restart --id ag-178c5abd-15a6-4159-87be-1a81fc01103c`. Check that `groups/comiccatalog/plugins/comic-catalog/` matches the template.
- **Credentials** go through the OneCLI gateway. The Metron token is a generic secret granted to ComicCatalog only (host `metron.cloud`, `/api/*`). Never put secrets in `.env`, prompts or fixtures. Slack bot/app tokens are in `.env` (gitignored).

## Tests

| What | Command | Notes |
| --- | --- | --- |
| Template test | `pnpm exec vitest run src/templates/comic-catalog-template.test.ts` | vitest (Node) |
| Host suite | `pnpm test` | vitest; save the output to a file and check it |
| MCP server unit tests | `~/.bun/bin/bun test ./templates/comic-catalog/server` | `bun:test`; a local stand-in Metron steers the cascade logic |
| Live Metron tests | `~/.local/bin/onecli run --agent ag-178c5abd-15a6-4159-87be-1a81fc01103c -- ~/.bun/bin/bun test ./templates/comic-catalog/server --test-name-pattern live` | `*.live.test.ts`; skipped unless `HTTPS_PROXY` is set (provided by `onecli run`) |
| Typecheck / format | `pnpm exec tsc --noEmit`, `pnpm run format:check` | as CI runs them |
| End-to-end | Slack checklists in `docs/comic-archive/` | littlelazer posts; Claude checks `outbound.db`, `logs/nanoclaw.log`, the session transcript |

There is no single canonical `check` script. CI (`.github/workflows/ci.yml`, upstream's) runs format, both tsc configs, sharded vitest, and `bun run test` in `container/agent-runner`. `.github/workflows/comic-catalog.yml` (ours, kept separate so upstream `ci.yml` changes merge cleanly) runs the comic-catalog Bun tests; live tests skip there because there's no gateway. `scripts/comic-catalog-workflow.test.ts` pins that workflow.

`README.md` opens with a comic-archive section above upstream's README. Keep our text in that top section only.

Conventions: every code file starts with two `// ABOUTME:` lines. Server tests use `bun:test`, not vitest. Prefer real Metron data in live tests over mocks.

## Git

- `main` is the working branch. Do work in a worktree on a task branch and merge to main.
- Remotes: `origin`/`github` = `github.com/littlelazer/comic-archive` (`origin` also pushes to the Dropbox mirror); `dropbox` = local Dropbox bare mirror; `upstream` = `nanocoai/nanoclaw` (`main`, `channels`).
- Commits are conventional, with scopes `comic-catalog` (code/template) and `comic-archive` (docs).
- Husky pre-commit runs `pnpm run format:fix` and re-stages `src/**/*.ts`. Never bypass hooks.
- Upstream updates go through `/update-nanoclaw` (stable channel, merge strategy). This install pulls its agent image from the hardened-image registry (`NANOCLAW_HARDENED_IMAGE=true`), so cutover runs `container/build.sh pull`.
- **Every commit merged into `main` trips the upgrade tripwire, docs-only commits included.** Right after merging: `pnpm run build`, `pnpm test`, `pnpm exec tsx scripts/upgrade-state.ts set`, `bash setup/lib/restart.sh`. Otherwise the next restart crash-loops (see `docs/upgrade-recovery.md`).
- **`~/.local/bin` must be on `PATH`** for the registry credential helper (`docker-credential-nanoclaw`) and `onecli`, both installed there. `~/.zshrc` adds it, but non-interactive shells (Claude Code's Bash tool included) don't load that file, so run `export PATH="$HOME/.local/bin:$PATH"` before an update cutover, an image pull, or `onecli`. Without it, the pull fails with `docker-credential-nanoclaw: executable file not found in $PATH`.

## Debugging a Slack run

1. `logs/nanoclaw.error.log`, then `logs/nanoclaw.log`: routing, delivery, button responses.
2. `data/v2-sessions/<group>/<session>/outbound.db` → `messages_out`: replies and button cards. Query it with `pnpm exec tsx scripts/q.ts <db> "<sql>"`.
3. The session transcript under `data/v2-sessions/<group>/<session>/.claude-shared/projects`: look for `mcp__comic-catalog__identify_comic`, `mcp__nanoclaw__ask_user_question` and `mcp__comic-catalog__confirm_choice` calls and their arguments.

## Known limits (details in architecture.md)

- The agent sees the image only if it chooses to `Read` it. The instructions require it.
- A tap on an expired button card never reaches the agent. The user replies in the thread with the number instead.
- Anyone in `#comic-archive` can tap. "Confirmed by you" rests on the agent reporting the tap honestly.
- Pre-2000s UPCs identify the series, not the issue. Metron lacks variants and barcodes for many older issues.
- Printed publisher names are not matched against Metron's (eras rename publishers).
