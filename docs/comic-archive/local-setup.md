# comic-archive local setup (primary Mac)

Boot path for development. Production (Linux Mac mini) is a later phase.

## Prerequisites

- macOS with Homebrew and Docker Desktop running.
- Node at or above the minimum in `setup/lib/node-version.sh` (22.23.4 on the 22 line). Setup installs `node@22` with Homebrew if the Node on `PATH` is older. If you manage Node with nvm, `nvm install 22` before setup works too.
- pnpm comes from corepack (pinned in `package.json` `packageManager`).
- Bun 1.4.4 at `~/.bun/bin/bun`, needed only to run the container test suite and the comic-catalog server tests.

## 1. Install NanoClaw

Run in a real terminal (setup is interactive):

```bash
bash nanoclaw.sh
```

Choose the OneCLI gateway (the default) and Claude auth. The model credential is stored in the gateway, never in `.env` or prompts. Setup can add the Slack channel; otherwise do step 2.

## 2. Add Slack

Run `/add-slack` in Claude Code and choose Socket Mode. It walks through creating the Slack app; scopes include `files:read`, which image intake needs. The bot and app tokens land in `.env` (gitignored).

## 3. Create the ComicCatalog agent

```bash
pnpm run ncl groups create --template comic-catalog --name "ComicCatalog"
```

Then wire it to the dedicated Slack channel with `/manage-channels`. Invite the bot to that channel first.

## 4. Verify

In the Slack channel:

1. Send a text message. Expect a reply in the thread.
2. Send a photo of a comic cover. Expect a threaded reply describing what is visible on that cover (title, issue number). A reply that only repeats the filename means the image was not seen.

If something fails, check `logs/nanoclaw.error.log`, then `logs/nanoclaw.log`, then the session DBs under `data/v2-sessions/` (see the root `CLAUDE.md` troubleshooting table). Saved images are under `data/v2-sessions/<group>/<session>/inbox/`.

## Tests

```bash
pnpm exec vitest run src/templates/comic-catalog-template.test.ts
pnpm test
~/.bun/bin/bun test ./templates/comic-catalog/server
```

Live tests (`*.live.test.ts`) call real Metron and must run through the gateway as ComicCatalog:

```bash
~/.local/bin/onecli run --agent ag-178c5abd-15a6-4159-87be-1a81fc01103c -- ~/.bun/bin/bun test ./templates/comic-catalog/server --test-name-pattern live
```

The Phase 2 Slack acceptance posts are in [phase-2-checklist.md](phase-2-checklist.md).
