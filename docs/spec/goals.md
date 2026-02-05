# Goals

## Product Goal

Hi-Boss is a local-first daemon + `hiboss` CLI for running durable, routable messages (“envelopes”) between humans (via chat adapters) and agents.

It aims to support customizable, long-running assistants that can:
- receive and send messages across channels,
- schedule delivery (`deliver-at` / cron),
- operate predictably via a stable, parseable CLI surface.

## Non-Goals

- A hosted SaaS (Hi-Boss runs locally).
- A general-purpose chat application (it routes messages; it does not replace your chat client).
- Hard multi-tenant security boundaries (protect your local machine and `~/hiboss`).
- A workflow engine or scheduler for arbitrary jobs (scheduling is for envelope delivery).

## Principles

- **Local-first**: the daemon is the source of truth and runs on your machine.
- **Envelopes as the interface**: messages are persisted as envelopes and routed reliably.
- **Predictable automation**: stable CLI flags/output and instruction formats.
- **Simple mental model**: keep user-facing concepts minimal; hide complexity inside the product.
- **First-principles design**: avoid accidental complexity; prefer the simplest design that preserves correctness and operator safety.
- **Extensibility**: adapters are pluggable; new channels should fit the same bridge/router model.
- **Operator-friendly**: debuggable via logs and a single state directory.

## Compatibility

- Node.js: ES2022 runtime (Node.js 18+ recommended).
- Platforms: intended for local use (macOS/Linux first; Windows may work but is not a primary target).
- Packaging: users should be able to install and run `hiboss` globally via npm.
