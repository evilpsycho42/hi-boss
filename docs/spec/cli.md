# CLI

This document describes the `hiboss` CLI command surface and how output is rendered for agent-facing and human-facing use.

Implementation references:
- `src/cli/cli.ts` (CLI surface)
- `src/cli/commands/*.ts` (RPC calls + printing)
- `src/cli/instructions/format-envelope.ts` (envelope instruction rendering)
- `src/shared/prompt-renderer.ts` + `src/shared/prompt-context.ts` (prompt system)
- `prompts/` (Nunjucks templates)

---

## Conventions

### Tokens

Many commands accept `--token`; if omitted, the CLI uses the `HIBOSS_TOKEN` environment variable.

### Output stability

- Most operational commands print key-value lines like `key: value` with kebab-case keys (intended to be parseable).
- `hiboss setup interactive` prints a wizard with human-friendly prose plus a final key-value summary.

### Daemon dependency

- Commands that call IPC (`envelope.*`, most `agent.*`) require the daemon to be running.
- Some admin commands edit the local SQLite DB directly and do not require a running daemon:
  - `hiboss agent permission set`
  - `hiboss agent permission get`
  - `hiboss permission policy get|set`

---

## Command Summary

Default permission levels below come from the built-in permission policy (`DEFAULT_PERMISSION_POLICY`). They can be changed via `hiboss permission policy set`.

| Command | Purpose | Token required? | Default permission |
|--------|---------|-----------------|--------------------|
| `hiboss setup` | Initialize Hi-Boss (interactive wizard) | No (bootstrap) | n/a |
| `hiboss setup default` | Initialize Hi-Boss (non-interactive) | No (bootstrap; requires `--boss-token`) | n/a |
| `hiboss daemon start` | Start the daemon | Yes (boss token) | boss |
| `hiboss daemon stop` | Stop the daemon | Yes (boss token) | boss |
| `hiboss daemon status` | Show daemon status | Yes (boss token) | boss |
| `hiboss envelope send` | Send an envelope | Yes (agent/boss token) | restricted |
| `hiboss envelope list` | List envelopes | Yes (agent/boss token) | restricted |
| `hiboss envelope list --as-turn` | Render pending inbox as a turn preview | Yes (agent/boss token) | restricted |
| `hiboss envelope get` | Get an envelope by id | Yes (agent/boss token) | restricted |
| `hiboss agent register` | Register a new agent | Yes (boss token) | boss |
| `hiboss agent list` | List agents | Yes (agent/boss token) | restricted |
| `hiboss agent bind` | Bind an adapter to an agent | Yes (agent/boss token) | privileged |
| `hiboss agent unbind` | Unbind an adapter from an agent | Yes (agent/boss token) | privileged |
| `hiboss agent session-policy` | Set/clear agent session policy | Yes (agent/boss token) | privileged |
| `hiboss agent background` | Run a background task as an agent | Yes (agent token) | standard |
| `hiboss agent permission get` | Get agent permission level | Yes (agent/boss token) | privileged |
| `hiboss agent permission set` | Set agent permission level | Yes (boss token) | boss |
| `hiboss permission policy get` | Print permission policy JSON | Yes (boss token) | boss |
| `hiboss permission policy set` | Set permission policy from a JSON file | Yes (boss token) | boss |

---

## Setup

### `hiboss setup` / `hiboss setup interactive`

Runs the interactive first-time setup wizard (default).

Behavior:
- Initializes the SQLite database at `~/.hiboss/hiboss.db` (configuration is stored in the DB; WAL sidecars like `hiboss.db-wal` / `hiboss.db-shm` may appear)
- Creates the agent home directories under `~/.hiboss/agents/<agent-name>/` (provider homes + copied base configs when available)
- Creates the first agent and prints `agent-token:` once (no “show token” command)
- Optionally configures/binds an adapter (e.g., Telegram)

### `hiboss setup default`

Runs non-interactive setup with flags:

- `--boss-token <token>` (required)
- `--boss-name <name>` (optional)
- `--adapter-type <type>` / `--adapter-token <token>` / `--adapter-boss-id <id>` (optional)

Output:
- Prints `agent-token:` and `boss-token:` once.

---

## Daemon

### `hiboss daemon start`

Starts the local daemon process in the background.

Flags:
- `--debug` enables verbose logs for inbound/outbound messages

Output (human-oriented):
- `Daemon started successfully`
- `Log file: <path>`

### `hiboss daemon stop`

Stops the daemon process (SIGTERM, then SIGKILL fallback).

Output (human-oriented):
- `Daemon stopped` (or `Daemon forcefully stopped`)

### `hiboss daemon status`

Shows daemon status as parseable keys:

- `running: true|false`
- `start-time: <iso>|(none)`
- `debug: enabled|disabled`
- `adapters: <csv>|(none)`
- `data-dir: <path>`

Meaning of `data-dir`:
- The daemon’s state directory (where it stores `hiboss.db`, `daemon.sock`, `daemon.pid`, `daemon.log`, `media/`, and per-agent homes).
- In the current implementation this is always the default `~/.hiboss/` (there is no `--data-dir` flag).

Default permission:
- `boss`

---

## Envelopes

### `hiboss envelope send`

Sends an envelope to an agent or channel.

Flags:
- `--to <address>` (required)
- `--text <text>` or `--text -` (stdin) or `--text-file <path>`
- `--attachment <path>` (repeatable)
- `--deliver-at <time>` (ISO 8601 or relative: `+2h`, `+30m`, `+1Y2M`, `-15m`; units: `Y/M/D/h/m/s`)
- Boss-only: `--from <address>`, `--from-boss`, `--from-name <name>`

Output (parseable):

```
id: <envelope-id>
```

Default permission:
- `restricted`

### `hiboss envelope get`

Gets an envelope by id and prints an agent-facing envelope instruction.

Rendering:
- `src/cli/instructions/format-envelope.ts` → `prompts/envelope/instruction.md`

Default permission:
- `restricted`

### `hiboss envelope list`

Lists envelopes (defaults: `--box inbox`).

Empty output:

```
no-envelopes: true
```

Rendering (default):
- Prints one envelope instruction per envelope, separated by a blank line.
- Each envelope is formatted by `formatEnvelopeInstruction()` using `prompts/envelope/instruction.md`.

Flags:
- `--address <address>` (boss token only)
- `--box inbox|outbox`
- `--status pending|done`
- `--limit <n>` (or deprecated `--n <n>`)

Default permission:
- `restricted`

### `hiboss envelope list --as-turn`

Prints a **turn preview** (same format as agent turn input).

Constraints:
- Requires `--box inbox --status pending` (the CLI enforces this).
- Boss token must specify the target agent via `--address agent:<name>`.

Meaning:
- Uses pending, due inbox envelopes for the agent (oldest first, same selection as agent runs).
- Consecutive group-chat envelopes with the same `from:` are batched under one `### Envelope <index>` header.

Note:
- `## Pending Envelopes (<n>)` is the number of underlying envelopes (messages). With batching, the number of `### Envelope <index>` sections may be smaller.

Default permission:
- `restricted`

---

## Agents

### `hiboss agent register`

Registers a new agent.

Flags:
- `--name <name>` (required)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- Optional session policy inputs:
  - `--session-daily-reset-at HH:MM`
  - `--session-idle-timeout <duration>` (units: `d/h/m/s`)
  - `--session-max-tokens <n>`

Output (parseable):
- `name:`
- `description:` (optional)
- `workspace:` (optional)
- `token:` (printed once)

### `hiboss agent list`

Lists all agents.

Empty output:

```
no-agents: true
```

Output (parseable, one block per agent):
- `name:`
- `description:` (optional)
- `workspace:` (optional)
- `provider:` / `model:` / `reasoning-effort:` / `auto-level:` (optional)
- `permission-level:` (optional)
- `session-daily-reset-at:` / `session-idle-timeout:` / `session-max-tokens:` (optional)
- `bindings:` (optional; comma-separated adapter types)
- `created-at:` (local timezone offset)
- `last-seen-at:` (optional; local timezone offset)

Default permission:
- `restricted`

### `hiboss agent bind`

Binds an adapter credential (e.g., a Telegram bot token) to an agent.

Flags:
- `--name <name>` (required)
- `--adapter-type <type>` (required)
- `--adapter-token <token>` (required)

Output (parseable):
- `id:`
- `agent-name:`
- `adapter-type:`
- `created-at:` (local timezone offset)

Default permission:
- `privileged`

### `hiboss agent unbind`

Unbinds an adapter credential from an agent.

Output (parseable):
- `agent-name:`
- `adapter-type:`
- `unbound: true`

Default permission:
- `privileged`

### `hiboss agent session-policy`

Sets or clears session refresh policy for an agent.

Flags:
- `--name <name>` (required)
- `--session-daily-reset-at HH:MM` (optional)
- `--session-idle-timeout <duration>` (optional; units: `d/h/m/s`)
- `--session-max-tokens <n>` (optional)
- `--clear` clears the policy

Output (parseable):
- `agent-name:`
- `success: true|false`
- `session-daily-reset-at:` / `session-idle-timeout:` / `session-max-tokens:` (when present)

Default permission:
- `privileged`

### `hiboss agent background`

Runs a fire-and-forget background task as the agent identified by `--token`.

Behavior:
- Spawns a detached local worker process.
- Sends exactly one envelope back to `agent:<self>` containing the final response text.

Output:
- No output (success is “silent”).

Default permission:
- `standard`

### `hiboss agent permission get`

Gets an agent permission level from the local DB.

Note:
- This command reads `~/.hiboss/hiboss.db` directly (no daemon IPC).

Flags:
- `--name <name>` (required)

Output (parseable):
- `agent-name:`
- `permission-level:`

Default permission:
- `privileged`

### `hiboss agent permission set`

Sets an agent permission level in the local DB.

Note:
- This command edits `~/.hiboss/hiboss.db` directly (no daemon IPC).

Flags:
- `--name <name>` (required)
- `--permission-level restricted|standard|privileged` (required)

Output (parseable):
- `success: true|false`
- `agent-name:`
- `permission-level:`

Default permission:
- `boss`

---

## Permission Policy

### `hiboss permission policy get`

Prints the effective permission policy JSON from the local DB:

- `policy-json: <json>`

### `hiboss permission policy set`

Sets permission policy from a JSON file.

Flags:
- `--file <path>` (required)

Output (parseable):
- `success: true`
