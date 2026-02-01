# Hi-Boss Docs

Hi-Boss has two kinds of documentation:

- **Specifications** (`docs/spec/`) — for developers; goals, architecture, and design. Implementations should align with these docs.
- **User Guides** (`docs/guide/`) — for users; what you can do with Hi-Boss, how to install it, and how to use it. Keep these readable and concise (tables/diagrams preferred, minimal internals).

## User Guides

- `docs/guide/overview.md` — what Hi-Boss is and what it can do
- `docs/guide/install.md` — install + first-time setup
- `docs/guide/quickstart.md` — 10-minute “happy path”
- `docs/guide/telegram.md` — Telegram usage and binding
- `docs/guide/recipes.md` — copy/paste examples
- `docs/guide/troubleshooting.md` — common issues and fixes

## Specifications

Core (top-level):
- `docs/spec/goals.md` — product goals, non-goals, principles
- `docs/spec/architecture.md` — system architecture + invariants
- `docs/spec/envelope.md` — envelope concept, lifecycle, and semantics
- `docs/spec/definitions.md` — field mappings (TypeScript ↔ SQLite ↔ CLI output keys)
- `docs/spec/cli.md` — CLI index (command summary + links to topic specs)
- `docs/spec/ipc.md` — CLI ↔ daemon IPC (JSON-RPC over local socket)
- `docs/spec/configuration.md` — config sources, persistence, permission policy

Components:
- `docs/spec/components/routing.md` — message routing and envelope flow
- `docs/spec/components/scheduler.md` — `deliver-at` scheduling details
- `docs/spec/components/cron.md` — persistent cron schedules (materialized envelopes)
- `docs/spec/components/agent.md` — agent model, execution, bindings, providers
- `docs/spec/components/session.md` — session lifecycle and refresh policy

CLI topics (details):
- `docs/spec/cli/setup.md`
- `docs/spec/cli/daemon.md`
- `docs/spec/cli/envelopes.md`
- `docs/spec/cli/cron.md`
- `docs/spec/cli/reactions.md`
- `docs/spec/cli/agents.md`
- `docs/spec/cli/memory.md`

Adapters:
- `docs/spec/adapters/telegram.md` — Telegram adapter behavior and message schema

Reference:
- `docs/spec/reference/token-usage.md` — token usage semantics + provider differences

## Generated

- `docs/spec/generated/magic-inventory.md` — generated paths/constants (do not edit)
