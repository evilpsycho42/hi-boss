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

---

## Command Summary

Default permission levels below come from the built-in permission policy (`DEFAULT_PERMISSION_POLICY`).

| Command | Purpose | Token required? | Default permission |
|--------|---------|-----------------|--------------------|
| `hiboss setup` | Initialize Hi-Boss (interactive wizard) | No (bootstrap) | n/a |
| `hiboss setup default` | Initialize Hi-Boss (non-interactive) | No (bootstrap; requires `--config`) | n/a |
| `hiboss daemon start` | Start the daemon | Yes (boss token) | boss |
| `hiboss daemon stop` | Stop the daemon | Yes (boss token) | boss |
| `hiboss daemon status` | Show daemon status | Yes (boss token) | boss |
| `hiboss envelope send` | Send an envelope | Yes (agent/boss token) | restricted |
| `hiboss envelope list` | List envelopes | Yes (agent/boss token) | restricted |
| `hiboss envelope list --as-turn` | Render pending inbox as a turn preview | Yes (agent/boss token) | restricted |
| `hiboss envelope get` | Get an envelope by id | Yes (agent/boss token) | restricted |
| `hiboss cron create` | Create a cron schedule | Yes (agent token) | restricted |
| `hiboss cron list` | List cron schedules | Yes (agent token) | restricted |
| `hiboss cron get` | Get a cron schedule by id | Yes (agent token) | restricted |
| `hiboss cron enable` | Enable a cron schedule | Yes (agent token) | restricted |
| `hiboss cron disable` | Disable a cron schedule | Yes (agent token) | restricted |
| `hiboss cron delete` | Delete a cron schedule | Yes (agent token) | restricted |
| `hiboss reaction set` | Set a reaction on a channel message | Yes (agent token) | restricted |
| `hiboss memory add/search/list/categories/get/delete/delete-category` | Semantic memory operations | Yes (agent/boss token) | restricted |
| `hiboss memory clear` | Clear all semantic memories for an agent | Yes (agent/boss token) | standard |
| `hiboss memory setup` | Configure semantic memory model | Yes (agent/boss token) | privileged |
| `hiboss agent register` | Register a new agent | Yes (boss token) | boss |
| `hiboss agent set` | Update agent settings and bindings | Yes (agent/boss token) | privileged |
| `hiboss agent list` | List agents | Yes (agent/boss token) | restricted |
| `hiboss background` | Run a background task as an agent | Yes (agent token) | standard |

---

## Setup

### `hiboss setup` / `hiboss setup interactive`

Runs the interactive first-time setup wizard (default).

Behavior:
- Initializes the SQLite database at `~/.hiboss/hiboss.db` (configuration is stored in the DB; WAL sidecars like `hiboss.db-wal` / `hiboss.db-shm` may appear)
- Creates the agent home directories under `~/.hiboss/agents/<agent-name>/` (provider homes + copied base configs when available)
- Creates the first agent and prints `agent-token:` once (no “show token” command)
- Prints `boss-token:` once
- Configures/binds a Telegram adapter for the first agent (required)

### `hiboss setup default`

Runs non-interactive setup from a JSON file:

- `--config <path>` (required)

Config file must include:
- `version: 1`
- `boss-token: <token>`
- `agent: { ... }`
- `telegram: { adapter-token, adapter-boss-id }`

Example (`setup.json`):

```json
{
  "version": 1,
  "boss-name": "your-name",
  "boss-token": "your-boss-token",
  "provider": "claude",
  "agent": {
    "name": "nex",
    "description": "nex - AI assistant",
    "workspace": "/absolute/path/to/workspace",
    "model": "opus",
    "reasoning-effort": "medium",
    "auto-level": "high",
    "permission-level": "standard"
  },
  "telegram": {
    "adapter-token": "123456789:ABCdef...",
    "adapter-boss-id": "your_telegram_username"
  }
}
```

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
- `--reply-to <message-id>` (optional; channel destinations only)
- `--parse-mode <mode>` (optional; channel destinations only; `plain|markdownv2|html`)
- `--deliver-at <time>` (ISO 8601 or relative: `+2h`, `+30m`, `+1Y2M`, `-15m`; units: `Y/M/D/h/m/s`)
- Boss-only: `--from <address>`, `--from-boss`, `--from-name <name>`

Output (parseable):

```
id: <envelope-id>
```

Default permission:
- `restricted`

---

## Cron

Cron schedules are stored per agent and **materialize standard envelopes** with `deliver-at` set to the next cron occurrence (see `docs/spec/cron.md`).

### `hiboss cron create`

Creates a cron schedule.

Flags:
- `--cron <expr>` (required; 5-field or 6-field with optional seconds; `@daily` etc supported)
- `--to <address>` (required)
- `--timezone <iana>` (optional; defaults to local; accepts `local`)
- `--text <text>` or `--text -` (stdin) or `--text-file <path>`
- `--attachment <path>` (repeatable)
- `--reply-to <message-id>` (optional; channel destinations only)
- `--parse-mode <mode>` (optional; channel destinations only; `plain|markdownv2|html`)

Output (parseable):

```
cron-id: <cron-id>
```

Default permission:
- `restricted`

### `hiboss cron list`

Lists cron schedules for the current agent.

Empty output:

```
no-crons: true
```

Default permission:
- `restricted`

### `hiboss cron get`

Gets a cron schedule by id.

Default permission:
- `restricted`

### `hiboss cron enable` / `hiboss cron disable` / `hiboss cron delete`

Parseable output:
- `success: true|false`
- `cron-id: <cron-id>`

Default permission:
- `restricted`

## Reactions

### `hiboss reaction set`

Sets a reaction (emoji) on a channel message.

Flags:
- `--to <address>` (required; channel address e.g., `channel:telegram:<chat-id>`)
- `--channel-message-id <id>` (required; platform message id)
- `--message-id <id>` (deprecated alias for `--channel-message-id`)
- `--emoji <emoji>` (required; unicode emoji)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Example:

```bash
hiboss reaction set --to channel:telegram:<chat-id> --channel-message-id <channel-message-id> --emoji "👍"
```

Output (parseable):
- `success: true|false`

Default permission:
- `restricted`

---

## Envelopes (continued)

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
- `## Pending Envelopes (...)` shows the number of underlying messages, and when batching occurs it also shows the number of grouped blocks (so it can differ from the number of `### Envelope <index>` headers).

Default permission:
- `restricted`

---

## Memory

Hi-Boss provides per-agent **semantic memory** backed by LanceDB.

If memory is disabled or misconfigured, `memory.*` calls fail with an error that suggests running `hiboss memory setup`.

### `hiboss memory add`

Adds a memory entry.

Flags:
- `--text <text>` (required)
- `--category <category>` (optional; defaults to `fact`)
- `--agent-name <name>` (boss token only)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `id: <memory-id>`

Default permission:
- `restricted`

### `hiboss memory search`

Searches memories by semantic similarity.

Flags:
- `--query <query>` (required)
- `--category <category>` (optional)
- `-n, --limit <n>` (optional; default 5)
- `--agent-name <name>` (boss token only)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `count: <n>`
- then repeated blocks with:
  - `id:`
  - `category:`
  - `created-at:`
  - `similarity:` (optional)
  - `text-json:`

Default permission:
- `restricted`

### `hiboss memory list`

Lists stored memories (newest-first).

Flags:
- `--category <category>` (optional)
- `-n, --limit <n>` (optional; default 100)
- `--agent-name <name>` (boss token only)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `count: <n>`
- then repeated blocks (same shape as `memory.search` but without `similarity:`)

Default permission:
- `restricted`

### `hiboss memory categories`

Lists known memory categories.

Flags:
- `--agent-name <name>` (boss token only)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `count: <n>`
- `category: <category>` (one per line)

Default permission:
- `restricted`

### `hiboss memory get`

Gets a memory by id.

Flags:
- `--id <id>` (required)
- `--agent-name <name>` (boss token only)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `found: true|false`
- If found, a memory block (same as `memory.list`).

Default permission:
- `restricted`

### `hiboss memory delete`

Deletes a memory by id.

Flags:
- `--id <id>` (required)
- `--agent-name <name>` (boss token only)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `ok: true`

Default permission:
- `restricted`

### `hiboss memory delete-category`

Deletes all memories in the specified category.

Flags:
- `--category <category>` (required)
- `--agent-name <name>` (boss token only)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `ok: true`
- `deleted: <n>`

Default permission:
- `restricted`

### `hiboss memory clear`

Drops all memories for the target agent.

Flags:
- `--agent-name <name>` (boss token only)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `ok: true`

Default permission:
- `standard`

### `hiboss memory setup`

Configures the local embedding model for semantic memory.

Flags:
- `--default` (download and use the default model)
- `--model-path <path>` (use a local GGUF model file)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Output (parseable):
- `memory-enabled: true|false`
- `model-path: <path>|(none)`
- `dims: <n>`
- `last-error: <message>` (optional)

Default permission:
- `privileged`

---

## Agents

### `hiboss agent register`

Registers a new agent.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- `--provider <claude|codex>` (optional)
- `--model <model>` (optional)
- `--reasoning-effort <none|low|medium|high|xhigh>` (optional)
- `--auto-level <low|medium|high>` (optional)
- `--permission-level <restricted|standard|privileged>` (optional)
- `--metadata-json <json>` or `--metadata-file <path>` (optional)
- Optional binding at creation:
  - `--bind-adapter-type <type>`
  - `--bind-adapter-token <token>`
- Optional session policy inputs:
  - `--session-daily-reset-at HH:MM`
  - `--session-idle-timeout <duration>` (units: `d/h/m/s`)
  - `--session-max-tokens <n>`

Output (parseable):
- `name:`
- `description:` (optional)
- `workspace:` (optional)
- `token:` (printed once)

### `hiboss agent set`

Updates agent settings and (optionally) binds/unbinds adapters.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- `--provider <claude|codex>` (optional)
- `--model <model>` (optional)
- `--reasoning-effort <none|low|medium|high|xhigh>` (optional)
- `--auto-level <low|medium|high>` (optional)
- `--permission-level <restricted|standard|privileged>` (optional; boss token only)
- Session policy:
  - `--session-daily-reset-at HH:MM` (optional)
  - `--session-idle-timeout <duration>` (optional; units: `d/h/m/s`)
  - `--session-max-tokens <n>` (optional)
  - `--clear-session-policy` (optional)
- Metadata:
  - `--metadata-json <json>` or `--metadata-file <path>` (optional)
  - `--clear-metadata` (optional)
- Binding:
  - `--bind-adapter-type <type>` + `--bind-adapter-token <token>` (optional)
  - `--unbind-adapter-type <type>` (optional)

Output (parseable):
- `success: true|false`
- `agent-name:`
- Updated fields when present (e.g., `provider:`, `model:`, `reasoning-effort:`, `auto-level:`, `permission-level:`)
- `bindings:` (optional; comma-separated adapter types)

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

### `hiboss background`

Runs a fire-and-forget background task as the agent identified by `--token`.

Flags:
- `--token <agent-token>` (required)
- `--task <text>` (required)

Daemon dependency:
- Requires the daemon to be running (uses `agent.self` over IPC to resolve provider/model/workspace).

Behavior:
- Spawns a detached worker process that runs the agent SDK once (no daemon-side queueing).
- When the background run completes, Hi-Boss sends a single envelope back to `agent:<self>` whose `text:` is the run’s final response.
- If the background run fails, it sends `text: error: ...` back to `agent:<self>`.

Output:
- No stdout output on success (launch failures print `error:` and exit non-zero).

Default permission:
- `standard`
