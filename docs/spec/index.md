# Specs Index

`docs/spec/` is the canonical source of truth for Hi-Boss behavior. If code and spec disagree, fix the spec first (or update the code to match).

## Start here

- Goals: `docs/spec/goals.md`
- Architecture + invariants: `docs/spec/architecture.md`
- Conventions (naming, IDs, boss marker): `docs/spec/conventions.md`
- Field mappings + stable output keys: `docs/spec/definitions.md`

## Core concepts

- Envelopes (what they are; how they complete): `docs/spec/envelope.md`
- Routing: `docs/spec/components/routing.md`
- Scheduler (`--deliver-at`): `docs/spec/components/scheduler.md`
- Cron schedules (materialized envelopes): `docs/spec/components/cron.md`

## CLI + IPC

- CLI index: `docs/spec/cli.md`
- CLI conventions (tokens, IDs, output stability): `docs/spec/cli/conventions.md`
- IPC (JSON-RPC): `docs/spec/ipc.md`

## Runtime components

- Agent execution + bindings + providers: `docs/spec/components/agent.md`
- Sessions (refresh policy + resume): `docs/spec/components/session.md`

## Configuration + storage

- Configuration index: `docs/spec/configuration.md`
- Upgrade compatibility (preserved legacy behavior): `docs/spec/compatibility.md`
- Generated inventory (do not edit): `docs/spec/generated/magic-inventory.md`

## Examples + appendix

- Envelope instruction examples: `docs/spec/examples/envelope-instructions.md`
- Provider CLI experiments: `docs/spec/appendix/provider-clis-experiments.md`

## Adapters + providers

- Telegram adapter: `docs/spec/adapters/telegram.md`
- Provider CLIs (how Hi-Boss invokes them): `docs/spec/provider-clis.md`
