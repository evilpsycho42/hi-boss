# Hi-Boss Docs

Hi-Boss documentation is specification-first:

- **Specifications** (`docs/spec/`) — goals, architecture, and canonical behavior. Implementations should align with these docs.

Start here:
- `docs/spec/index.md`

## Specifications

Core (top-level):
- `docs/spec/index.md` — spec entrypoint + map
- `docs/spec/goals.md` — product goals, non-goals, principles
- `docs/spec/architecture.md` — system architecture + invariants
- `docs/spec/envelope.md` — envelope concept, lifecycle, and semantics
- `docs/spec/conventions.md` — naming, IDs, boss marker
- `docs/spec/definitions.md` — field mappings (TypeScript <-> SQLite <-> CLI output keys)
- `docs/spec/cli.md` — CLI index (command summary + links to topic specs)
- `docs/spec/ipc.md` — CLI <-> daemon IPC (JSON-RPC over local socket)
- `docs/spec/configuration.md` — config sources, persistence, permission policy
- `docs/spec/compatibility.md` — preserved legacy behavior for safe upgrades

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

Adapters:
- `docs/spec/adapters/telegram.md` — Telegram adapter behavior and message schema

Providers (canonical behavior):
- `docs/spec/provider-clis.md` — provider CLI invocation and token usage semantics

## Experiments

- `docs/experiments/index.md` — experiment index
- `docs/experiments/provider-clis/manual-experiments.md` — dated provider CLI experiments and gotchas

## References

- `docs/refs/index.md` — reference index
- `docs/refs/providers/README.md` — provider CLI third-party references

## Generated

- `docs/spec/generated/magic-inventory.md` — generated paths/constants (do not edit)
