# Hi-Boss: Developer / Agent Guide

Hi-Boss is a local daemon + `hiboss` CLI for routing durable messages (“envelopes”) between agents and chat channels (e.g., Telegram).

## Global rules (source of truth)

- `docs/spec/` is canonical. If behavior and spec disagree, update the spec first (or fix the code to match).
- Keep CLI flags, CLI output keys, and agent instruction keys **stable and parseable** (kebab-case).
- If you change CLI surface/output/DB fields, update `docs/spec/cli.md`, the relevant `docs/spec/cli/*.md` topic doc(s), and `docs/spec/definitions.md` in the same PR.
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
- SQLite is the durable queue + audit log (`~/.hiboss/hiboss.db`).
- Scheduler wakes due `deliver-at` envelopes (`docs/spec/components/scheduler.md`).
- Agent executor runs provider sessions and marks envelopes done (`docs/spec/components/agent.md`, `docs/spec/components/session.md`).
- Adapters bridge chat apps ↔ envelopes (e.g. Telegram: `docs/spec/adapters/telegram.md`).

## Naming & parsing safety (must follow)

| Context | Convention | Example |
|---------|------------|---------|
| Code (TypeScript) | camelCase | `envelope.fromBoss` |
| CLI flags | kebab-case, lowercase | `--deliver-at` |
| CLI output keys | kebab-case, lowercase | `from-name:` |
| Agent instruction keys | kebab-case, lowercase | `from-boss` |

Canonical mapping (see `docs/spec/definitions.md`):
```
envelope.deliverAt  -> --deliver-at   (flag)
envelope.fromBoss   -> from_boss      (SQLite; affects `[boss]` suffix in prompts)
envelope.createdAt  -> created-at:    (output key; direct/agent messages only)
```

Boss marker:
- When `fromBoss` is true, rendered sender lines include the `[boss]` suffix:
  - direct: `from-name: <author> [boss]`
  - group: `Author [boss] at <timestamp>:`

## Important settings / operational invariants

- Runtime: Node.js 18+ (ES2022) recommended (`docs/spec/goals.md`).
- Tokens are printed once by `hiboss setup` / `hiboss agent register` (no “show token” command).
- `HIBOSS_TOKEN` is used when `--token` is omitted (`docs/spec/configuration.md`).
- Sending to `channel:<adapter>:...` is only allowed if the sending agent is bound to that adapter type.
- `--deliver-at` supports relative (`+2h`, `+1Y2M3D`) and ISO 8601; units are case-sensitive (`Y/M/D/h/m/s`).
- Security: agent tokens are stored plaintext in `~/.hiboss/hiboss.db`; protect `~/.hiboss/`.

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
hiboss daemon start --debug --token <boss-token>
hiboss agent register --token <boss-token> --name nex --description "AI assistant" --workspace "$PWD"
```

Useful checks (run when relevant):
- `npm run typecheck`
- `npm run prompts:check`
- `npm run defaults:check`
- `npm run verify:token-usage:real` (talks to a real provider; use intentionally)
- `npm run inventory:magic` (updates `docs/spec/generated/magic-inventory.md`; do not hand-edit that file)

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
- `docs/guide/` — user-facing guides

## State & debugging

Default data dir: `~/.hiboss/` (no `--data-dir` flag today)

| Item | Path |
|------|------|
| DB | `~/.hiboss/hiboss.db` |
| IPC socket | `~/.hiboss/daemon.sock` |
| Daemon PID | `~/.hiboss/daemon.pid` |
| Daemon log | `~/.hiboss/daemon.log` |
| Media downloads | `~/.hiboss/media/` |
| Boss profile (optional) | `~/.hiboss/BOSS.md` |
| Per-agent homes | `~/.hiboss/agents/<agent-name>/` |

Reset:
```bash
hiboss daemon stop --token <boss-token> && rm -rf ~/.hiboss && hiboss setup
```
