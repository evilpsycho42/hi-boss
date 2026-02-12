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
- Provider CLIs (canonical invocation + token semantics): `docs/spec/provider-clis.md`
- File-based agent memory (protocol): `docs/spec/components/file-memory.md`

## Configuration + storage

- Configuration index: `docs/spec/configuration.md`
- Upgrade compatibility (preserved legacy behavior): `docs/spec/compatibility.md`
- Generated inventory (do not edit): `docs/spec/generated/magic-inventory.md`

## Examples

- Prompt + envelope instruction examples (generated): run `npm run examples:prompts` (outputs under `examples/prompts/` and `prompts/examples/`)
- CLI output examples (generated): run `npm run examples:cli` (outputs under `examples/cli/`)

## Experiments + references

- Provider CLI manual experiments: `docs/experiments/provider-clis/manual-experiments.md`
- Provider CLI third-party references: `docs/refs/providers/README.md`

## Adapters

- Telegram adapter: `docs/spec/adapters/telegram.md`
