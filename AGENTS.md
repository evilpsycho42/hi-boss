# Hi-Boss: Developer / Agent Guide

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

Default data dir: `~/hiboss/` (override via `HIBOSS_DIR`; no `--data-dir` flag today)

| Item | Path |
|------|------|
| DB | `~/hiboss/.daemon/hiboss.db` |
| IPC socket | `~/hiboss/.daemon/daemon.sock` |
| Daemon PID | `~/hiboss/.daemon/daemon.pid` |
| Daemon log | `~/hiboss/.daemon/daemon.log` |
| Media downloads | `~/hiboss/media/` |
| Boss profile (optional) | `~/hiboss/BOSS.md` |
| Per-agent homes | `~/hiboss/agents/<agent-name>/` |

Reset:
```bash
hiboss daemon stop --token <boss-token> && rm -rf ~/hiboss && hiboss setup
```
