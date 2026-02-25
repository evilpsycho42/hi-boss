# Hi-Boss: Developer / Agent Guide

> Runtime topology (current)
  - Primary runtime host: Windows (Tailscale `100.72.210.95`)
  - Public ingress host: Rainyun HK (Tailscale `100.79.90.57`, public `38.175.194.51`)
  - Public entry: `https://hiboss.ethanelift.com` -> Rainyun Caddy -> Windows `:1201` (via Tailscale)

> Companion services topology (migration target)
  - `hiboss-daemon` (Docker Compose; service/container: `hiboss-daemon`) runs on Windows host.
  - `outlook-rss` (PM2, port `1201`) runs on Windows WSL2 host.
  - `wechatpadpro` + `mysql` + `redis` (Docker Compose) run on Windows Docker.
  - `telegram-bot-api` (Docker) runs on Windows Docker.
  - `rsshub` + `redis` (Docker Compose) run on Windows Docker.
  - `xiaohongshu-mcp` (Docker Compose) runs on Windows Docker.
  - Rainyun remains ingress-only (Caddy TLS + reverse proxy over Tailscale).

Hi-Boss is a local daemon + `hiboss` CLI for routing durable messages (“envelopes”) between agents and chat channels (e.g., Telegram).

## Global rules (source of truth)

- `docs/spec/` is canonical. If behavior and spec disagree, update the spec first (or fix the code to match).
- Prefer PRs as the normal development flow; avoid direct pushes to `main`.
- Keep CLI flags, CLI output keys, and agent instruction keys **stable and parseable** (kebab-case).
- If you change CLI surface/output/DB fields, update `docs/spec/cli.md`, the relevant `docs/spec/cli/*.md` topic doc(s), and `docs/spec/definitions.md` in the same PR.
- Don’t bump the npm version ahead of today’s date (local time). Avoid zero-padded segments (use `2026.2.5`, not `2026.02.05`).
- Npm version scheme (dist-tags; “option A”):
  - Stable daily: `YYYY.M.D` (published with dist-tag `latest`)
  - Preview daily: `YYYY.M.D-rc.N` (published with dist-tag `next`)
  - Same-day follow-up stable: `YYYY.M.D-rev.N` (dist-tag `latest`)
  - Same-day follow-up preview: `YYYY.M.D-rev.N-rc.N` (dist-tag `next`)
- For each file,LOC should be less than 500 lines, split it if needed.

Start here: `docs/index.md`, `docs/spec/goals.md`, `docs/spec/architecture.md`, `docs/spec/definitions.md`.

## Goals & design philosophy (summary)

- Local-first: the daemon is the authority and runs on your machine.
- Envelopes are the interface: persisted, routable, schedulable.
- Predictable automation: stable CLI surface and instruction formats.
- Extensible: adapters bridge external chat apps without changing core semantics.
- Operator-friendly: one data dir + logs + simple reset.

## Core architecture (mental model)

- Daemon owns state and routing; CLI is a thin JSON-RPC client (`docs/spec/ipc.md`).
- SQLite is the durable queue + audit log (`~/hiboss/.daemon/hiboss.db`).
- Scheduler wakes due `deliver-at` envelopes (`docs/spec/components/scheduler.md`).
- Agent executor runs provider sessions and marks envelopes done (`docs/spec/components/agent.md`, `docs/spec/components/session.md`).
- Adapters bridge chat apps ↔ envelopes (e.g. Telegram: `docs/spec/adapters/telegram.md`).

## Naming & parsing safety (must follow)

| Context | Convention | Example |
|---------|------------|---------|
| Code (TypeScript) | camelCase | `envelope.fromBoss` |
| CLI flags | kebab-case, lowercase | `--deliver-at` |
| CLI output keys | kebab-case, lowercase | `sender:` |
| Agent instruction keys | kebab-case, lowercase | `from-boss` |

Canonical mapping (see `docs/spec/definitions.md`):
```
envelope.deliverAt  -> --deliver-at   (flag)
envelope.fromBoss   -> from_boss      (SQLite; affects `[boss]` suffix in prompts)
envelope.createdAt  -> created-at:    (output key)
```

Boss marker:
- When `fromBoss` is true, rendered sender lines include the `[boss]` suffix:
  - direct: `sender: <author> [boss] in private chat`
  - group: `sender: <author> [boss] in group "<name>"`

Short IDs (must follow):
- **All** user/agent-visible UUID-backed ids are rendered as **short ids** by default (first 8 lowercase hex chars of the UUID with hyphens removed).
- Prefer `src/shared/id-format.ts` helpers:
  - `formatShortId(...)` for printing
  - `normalizeIdPrefixInput(...)` for parsing `--id` inputs
- Full UUIDs should be accepted as input where an `--id` flag exists, but should generally not be printed in CLI output or prompts.

## Important settings / operational invariants

- Runtime: Node.js 18+ (ES2022) recommended (`docs/spec/goals.md`).
- Tokens are printed once by `hiboss setup` / `hiboss agent register` (no “show token” command).
- `HIBOSS_TOKEN` is used when `--token` is omitted (`docs/spec/configuration.md`).
- Sending to `channel:<adapter>:...` is only allowed if the sending agent is bound to that adapter type.
- `--deliver-at` supports relative (`+2h`, `+1Y2M3D`) and ISO 8601; units are case-sensitive (`Y/M/D/h/m/s`).
- Security: agent tokens are stored plaintext in `~/hiboss/.daemon/hiboss.db`; protect `~/hiboss/`.

## Dev workflow

Must-do (after code changes):
```bash
npm run build && npm link
```

Fast path (dev):
```bash
npm i
npm run build && npm link

hiboss setup
hiboss daemon start --token <boss-token>
hiboss agent register --token <boss-token> --name nex --description "AI assistant" --workspace "$PWD"
```

## Windows access & runtime operations

Use this as the authoritative runbook for the current Windows-primary runtime.

Access Windows (Termius/SSH):
- Connect to Windows host via Tailscale: `ssh administrator@100.72.210.95`
- Runtime base dir on Windows: `C:\hiboss`
- Repo on Windows: `C:\hiboss\agents\Shieru\workspace\hi-boss-dev`

`hiboss` command model (important):
- Use only daemon subcommands: `hiboss daemon start|stop|status --token <boss-token>`.
- Do not use `hiboss start`.
- On this host, `hiboss daemon start/stop/status` is the canonical entrypoint and manages Docker-backed daemon lifecycle.

Apply code changes on Windows (after Syncthing has synced code):
```powershell
cd C:\hiboss\agents\Shieru\workspace\hi-boss-dev
npx tsc
npm link
hiboss daemon stop --token <boss-token>
hiboss daemon start --token <boss-token>
hiboss daemon status --token <boss-token>
docker logs hiboss-daemon --tail 80
```

Windows build note:
- Do **not** run `npm run build` directly in Windows cmd/PowerShell for runtime apply.
- This repo has `postbuild: chmod +x dist/bin/hiboss.js`, and `chmod` is unavailable in native Windows shells.
- Use `npx tsc` (or run `npm run build` only inside a Unix-like shell where `chmod` exists).

If `hiboss` CLI points to a broken link/module on Windows:
```powershell
cd C:\hiboss\agents\Shieru\workspace\hi-boss-dev
npm i
npx tsc
npm link
hiboss --version
```

Quick recovery for daemon issues:
```powershell
hiboss daemon stop --token <boss-token>
hiboss daemon start --token <boss-token>
hiboss daemon status --token <boss-token>
docker logs hiboss-daemon --tail 200
```

Syncthing current setup (Mac <-> Windows bidirectional):
- Windows runs native Syncthing binary via Task Scheduler task `Syncthing` (not Docker).
- Windows Syncthing paths:
  - binary: `C:\hiboss\services\syncthing-native\bin\syncthing.exe`
  - home/config: `C:\hiboss\services\syncthing-native\home`
  - log: `C:\hiboss\services\syncthing-native\syncthing.log`
- Folder mode: `hiboss` folder on `C:\hiboss`, type `sendreceive`, with versioning enabled (`staggered`).

Check Syncthing service health on Windows:
```powershell
Get-ScheduledTask -TaskName Syncthing | Select-Object TaskName,State
Get-Process syncthing
Get-Content C:\hiboss\services\syncthing-native\syncthing.log -Tail 80
```

Check Syncthing sync status on Windows (queue should converge to 0):
```powershell
[xml]$cfg = Get-Content C:\hiboss\services\syncthing-native\home\config.xml
$apiKey = $cfg.configuration.gui.apikey
Invoke-RestMethod -Headers @{ "X-API-Key" = $apiKey } -Uri "http://127.0.0.1:8384/rest/db/status?folder=hiboss"
```

`rest/db/status` healthy expectation:
- `state` eventually becomes `idle`
- `needFiles/needDirectories/needDeletes/needBytes` become `0`

`.stignore` policy reminders:
- Keep `.stignore` identical on both ends (Mac and Windows).
- `credentials.md` is intentionally **not** ignored.
- Ignore cross-platform problematic entries (`._*`, `__MACOSX`, `nul/NUL`, etc.) to avoid Windows sync stalls.

Ingress note:
- Rainyun host is ingress-only (Caddy/TLS + reverse proxy). Do not treat Rainyun as canonical runtime state.

Credentials policy:
- Read server credentials from local private knowledge files (for Shieru: `agents/Shieru/internal_space/knowledge/credentials.md`).
- Never copy passwords/tokens/keys into repo files, specs, plans, commits, or PR comments.

Useful checks (run when relevant):
- `npm run typecheck`
- `npm run prompts:check`
- If you change CLI output/formatting, regenerate CLI examples via `scripts/gen-cli-examples.ts` (`npm run examples:cli`).
- If you change prompt templates/context/rendering, regenerate prompt examples via `scripts/gen-prompt-examples.ts` (`npm run examples:prompts`).
- After changes, ensure everything under `examples/` is up-to-date (regenerate as needed).
- Examples must use realistic values for IDs and times (match what agents actually see): e.g., UUIDs for internal IDs, compact base36 for Telegram `channel-message-id`, and stable UTC timestamps in generated docs.
- `npm run defaults:check`
- `npm run verify:token-usage:real` (talks to a real provider; use intentionally)
- `npm run inventory:magic` (updates `docs/spec/generated/magic-inventory.md`; do not hand-edit that file)

Real provider verification policy (required for provider/dependency/runtime changes):
- If code or dependencies affect agent runtime/provider behavior (including `@unified-agent-sdk/*` changes), verify with **real** Codex + Claude requests before merging.
- By default, use the official provider homes: `~/.codex` and `~/.claude`.
  - Do not pass `--codex-home` / `--claude-home` unless explicitly testing overrides.
- Keep tests isolated from normal operator state:
  - Use a dedicated temporary Hi-Boss directory: `export HIBOSS_DIR="$(mktemp -d /tmp/hiboss-verify-XXXX)"`
  - Never run destructive reset commands against default `~/hiboss` during verification.
- Minimum real-request verification checklist:
  - `npm run verify:token-usage:real -- --provider both --session-mode fresh --turns 1`
  - `npm run verify:token-usage:real -- --provider both --session-mode continuous --turns 2`
  - Run one isolated daemon-level smoke flow (setup/start/register/send/list) in the temp `HIBOSS_DIR` and confirm both provider-backed agents complete at least one run.

## Versioning & publishing

Terminology:
- `rc` = release candidate (preview build that may become stable)
- Stable installs use `latest`; preview installs use `next`
- `CHANGELOG.md` is retired; GitHub Releases are the canonical changelog surface.

Routine:
1. Bump `package.json#version` (and `package-lock.json`) to the exact version string.
2. Publish to npm:
   - Preview: `npm publish --tag next`
   - Stable: `npm publish --tag latest`
3. Create a GitHub release with the same version tag (`v<version>`):
   - Preview release: changelog body is optional/minimal.
   - Stable release: include changelog/release notes in the GitHub release body.

Suggestion helper:
- `npm run version:suggest -- --type preview` (or `stable`) prints a suggested version for today’s date.

## Repo layout (what lives where)

- `bin/` — TypeScript CLI entry for dev (`npm run hiboss`)
- `dist/` — build output used by the published `hiboss` binary (do not hand-edit)
- `scripts/` — dev/CI helper scripts (prompt validation, inventory generation, etc.)
- `src/daemon/` — daemon core (routing, scheduler, IPC server, DB)
- `src/cli/` — CLI surface, RPC calls, and instruction rendering
- `src/agent/` — provider integration + session policy
- `src/adapters/` — channel adapters (Telegram, …)
- `src/envelope/`, `src/cron/`, `src/shared/` — core models + shared utilities
- `prompts/` — Nunjucks templates for agent instructions / turns
- `docs/spec/` — developer-facing specs (canonical)

## State & debugging

Default data dir:
- Windows runtime: `C:\\hiboss` (recommended)
- Linux/macOS runtime: `~/hiboss`
- Override via `HIBOSS_DIR` (no `--data-dir` flag today)

| Item | Path |
|------|------|
| DB | `<HIBOSS_DIR>/.daemon/hiboss.db` |
| IPC socket | `<HIBOSS_DIR>/.daemon/daemon.sock` |
| Daemon PID | `<HIBOSS_DIR>/.daemon/daemon.pid` |
| Daemon log | `<HIBOSS_DIR>/.daemon/daemon.log` |
| Media downloads | `<HIBOSS_DIR>/media/` |
| Boss profile (optional) | `<HIBOSS_DIR>/BOSS.md` |
| Per-agent homes | `<HIBOSS_DIR>/agents/<agent-name>/` |

Reset:
```bash
hiboss daemon stop --token <boss-token> && rm -rf "<HIBOSS_DIR>" && hiboss setup
```
Windows PowerShell reset:
```powershell
hiboss daemon stop --token <boss-token>
$dir = if ($env:HIBOSS_DIR) { $env:HIBOSS_DIR } else { "C:\hiboss" }
Remove-Item -Recurse -Force $dir
hiboss setup
```
