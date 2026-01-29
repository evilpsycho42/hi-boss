# Hi-Boss Docs

Hi-Boss has two kinds of documentation:

- **Specifications** (`docs/spec/`) — for developers; goals, roadmap, architecture, and design. Implementations should align with these docs.
- **User Guides** (`docs/guide/`) — for users; what you can do with Hi-Boss, how to install it, and how to use it. Keep these readable and concise (tables/diagrams preferred, minimal internals).

## User Guides

- `docs/guide/overview.md` — what Hi-Boss is and what it can do
- `docs/guide/install.md` — install + first-time setup
- `docs/guide/quickstart.md` — 10-minute “happy path”
- `docs/guide/telegram.md` — Telegram usage and binding
- `docs/guide/recipes.md` — copy/paste examples
- `docs/guide/troubleshooting.md` — common issues and fixes

## Specifications

- `docs/spec/goals.md` — product goal, non-goals, principles
- `docs/spec/roadmap.md` — TODO roadmap placeholder
- `docs/spec/architecture.md` — system architecture + invariants
- `docs/spec/cli.md` — CLI output and rendering
- `docs/spec/definitions.md` — field mappings (TypeScript ↔ SQLite ↔ CLI keys)
- `docs/spec/envelope.md` — envelopes, lifecycle, status, scheduling
- `docs/spec/routing.md` — message routing and envelope flow
- `docs/spec/scheduler.md` — deliver-at scheduling details
- `docs/spec/ipc.md` — CLI ↔ daemon IPC (JSON-RPC over local socket)
- `docs/spec/agent.md` — agent model, execution, bindings, providers
- `docs/spec/session.md` — session lifecycle and refresh policy
- `docs/spec/configuration.md` — config sources, CLI flags, DB settings
- `docs/spec/adapters/telegram.md` — Telegram adapter behavior and message schema

## Generated

- `docs/spec/generated/magic-inventory.md` — generated paths/constants (do not edit)
