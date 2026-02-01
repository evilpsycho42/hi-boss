# Goals

## Product Goal

The portable/extendable/customizable autonomous AI assistants that work for you 7x24.
Provide an environment for agents to communicate, self-reflect, continuously learn.

## Non-Goals

- A hosted SaaS (Hi-Boss runs locally and is designed to be local-first).
- A general-purpose chat application (it routes messages; it does not replace your chat client).
- Hard multi-tenant security boundaries (protect your local machine and `~/.hiboss`).
- A workflow engine or scheduler for arbitrary jobs (scheduling is for envelope delivery).

## Principles

- **Local-first**: the daemon is the source of truth and runs on your machine.
- **Envelopes as the interface**: messages are persisted as envelopes and routed reliably.
- **Predictable automation**: stable CLI flags/output and instruction formats.
- **Extensibility**: adapters are pluggable; new channels should fit the same bridge/router model.
- **Operator-friendly**: debuggable via logs and a single state directory.

## Compatibility

- Node.js: ES2022 runtime (Node.js 18+ recommended).
- Platforms: intended for local use (macOS/Linux first; Windows may work but is not a primary target).
- Packaging: users should be able to install and run `hiboss` globally via npm.
