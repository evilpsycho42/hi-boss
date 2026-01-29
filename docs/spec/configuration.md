# Hi-Boss Configuration

This document describes configurable settings in Hi-Boss, where they live, and how to change them.

Hi-Boss configuration comes from four places:

1. **CLI flags** (`hiboss ... --flag`)
2. **Environment variables** (`HIBOSS_TOKEN`, …)
3. **SQLite state** in `~/.hiboss/hiboss.db` (tables: `config`, `agents`, `agent_bindings`, `envelopes`, …)
4. **Per-agent provider homes** under `~/.hiboss/agents/<agent-name>/` (Codex/Claude settings + session state)

---

## Data Directory

By default Hi-Boss stores all state under:

- `~/.hiboss/`

Contents (common):

- `~/.hiboss/hiboss.db` — SQLite database (agents, bindings, envelopes, runs, config)
- `~/.hiboss/daemon.sock` — local IPC socket used by the `hiboss` CLI
- `~/.hiboss/daemon.pid` — daemon PID file (single-instance lock)
- `~/.hiboss/daemon.log` — daemon stdout/stderr log (when started via `hiboss daemon start`)
- `~/.hiboss/USER.md` — global user profile injected into system instructions (optional)
- `~/.hiboss/media/` — Telegram downloads (attachments are saved here for agents to read)
- `~/.hiboss/agents/<agent-name>/SOUL.md` — per-agent persona injected into system instructions (optional)
- `~/.hiboss/agents/<agent-name>/codex_home/` — provider home for Codex (used as `CODEX_HOME`)
- `~/.hiboss/agents/<agent-name>/claude_home/` — provider home for Claude Code (used as `CLAUDE_CONFIG_DIR`)

Note: the CLI currently always uses the default location (there is no `--data-dir` flag).

---

## Environment Variables

### `HIBOSS_TOKEN`

Default token (agent or boss) for commands when `--token` is omitted.

Used by:

- `hiboss envelope send`
- `hiboss envelope list`
- `hiboss envelope get`
  - and other commands that accept `--token`

Example:

```bash
export HIBOSS_TOKEN="<agent-token>"
hiboss envelope list --box inbox --status pending
```

---

## CLI Configuration

### Daemon

- `hiboss daemon start --token <boss-token> [--debug]`
  - Enables debug logging for message/envelope routing in the daemon process.
  - Not persisted; only affects that daemon run.

### Setup

Setup writes to the SQLite `config` table and creates the first agent.

- `hiboss setup` (interactive)
- `hiboss setup default`
  - `--boss-name <name>`: stored as `config.boss_name`
  - `--boss-token <token>`: stored hashed as `config.boss_token_hash`
  - `--adapter-type <type>`: creates an initial binding (currently only `telegram`)
  - `--adapter-token <token>`: the adapter credential (e.g., Telegram bot token)
  - `--adapter-boss-id <id>`: stored as `config.adapter_boss_id_<type>`
    - For Telegram, this is your username (`@name` or `name`); it is compared case-insensitively.

### Agents

- `hiboss agent register`
  - `--token <boss-token>`
  - `--name <name>`
  - `--description <text>`
  - `--workspace <path>`
  - Session policy (optional):
    - `--session-daily-reset-at <HH:MM>`
    - `--session-idle-timeout <duration>`
    - `--session-max-tokens <n>`

- `hiboss agent bind`
  - `--name <agent-name>`
  - `--adapter-type <type>` (currently `telegram`)
  - `--adapter-token <token>`

Binding constraints:

- A single bot token can only be bound to **one** agent (`UNIQUE(adapter_type, adapter_token)`).
- An agent can only have **one** binding per adapter type (so no “two telegram bots for one agent” today).

- `hiboss agent session-policy`
  - `--name <agent-name>`
  - `--session-daily-reset-at <HH:MM>` (optional)
  - `--session-idle-timeout <duration>` (optional)
  - `--session-max-tokens <n>` (optional)
  - `--clear` (optional): clears the policy entirely

### Envelopes

- `hiboss envelope send`
  - `--to <address>` (required)
  - `--token <token>` (defaults to `HIBOSS_TOKEN`)
  - `--text <text>` (or `--text -` for stdin)
  - `--text-file <path>`
  - `--attachment <path>` (repeatable)
  - `--deliver-at <time>`: schedule future delivery
    - Relative: `+2h`, `+30m`, `+1Y2M3D`, `-15m` (units: `Y/M/D/h/m/s`)
    - ISO 8601: `2026-01-27T16:30:00+08:00`

- `hiboss envelope list`
  - `--box <inbox|outbox>` (default: `inbox`)
  - `--status <pending|done>`
  - `-n, --limit <n>` (optional)
  - `--n <n>` (deprecated alias for `--limit`)

---

## Persisted Settings (SQLite)

All persisted settings are stored in:

- `~/.hiboss/hiboss.db`

### `config` table

Keys:

- `setup_completed`: `"true"` after setup has run
- `boss_name`: boss display name used in instructions/templates
- `boss_token_hash`: hashed admin token (not currently surfaced via CLI commands beyond setup)
- `default_provider`: `"claude"` or `"codex"` (used by setup as a default)
- `permission_policy`: JSON permission policy mapping operations → required permission level
- `adapter_boss_id_<adapter-type>`: boss identity on an adapter, e.g.:
  - `adapter_boss_id_telegram = "@your_username"`

What `adapter_boss_id_<adapter-type>` does:

- When the daemon receives a channel message, it marks `from-boss: true` if the sender username matches.
- For Telegram, it also controls whether the daemon will show “not configured” instructions when a bot is unbound (only shown to the boss).

### `agents` table

Per-agent settings:

- `name`: agent identifier (used in addresses like `agent:<name>`)
- `token`: agent auth token (stored **plaintext** in the DB; printed by setup/register)
  - There is no CLI command to show it again; you can retrieve it by querying `~/.hiboss/hiboss.db`.
- `description`
- `workspace`: passed to the provider runtime as the session working directory
- `provider`: `"claude"` or `"codex"`
  - Agents created via `hiboss agent register` currently default to `"claude"` (no CLI flag yet).
- `model`: optional model name (set by setup for the initial agent)
- `reasoning_effort`: setup currently sets `"low" | "medium" | "high"` for the initial agent
- `auto_level`: `"low" | "medium" | "high"` (set by setup for the initial agent)
- `last_seen_at`: updated when the agent authenticates RPC calls via token (e.g., `hiboss envelope list --token ...`)
- `metadata`: JSON blob for extended settings (see session policy below)
  - `permissionLevel`: `"restricted" | "standard" | "privileged"` (defaults to `"standard"` when unset)
    - Set via: `hiboss agent permission set --name <agent-name> --permission-level <level> --token <boss-token>`

### `agent_bindings` table

Bindings connect an agent to an adapter credential:

- `agent_name`
- `adapter_type` (currently `telegram`)
- `adapter_token` (e.g., Telegram bot token)

---

## Session Reset Policy (Per Agent)

Session reset strategy is configured per agent in:

- `agents.metadata.sessionPolicy`

Important behavior:

- The daemon maintains **one shared provider session per agent** (not per chat).
- Session resets are applied at **safe points** (before a run, or after the current queue drains), not mid-run.
- Policy-based resets are **silent** (no adapter message), except that Telegram `/new` always replies `Session refresh requested.`

### Policy fields

All fields are optional (unset = disabled):

- `session-daily-reset-at` (`dailyResetAt` in metadata)
  - Format: `HH:MM` (24-hour), interpreted in the daemon host’s **local timezone**.
  - On the next run, if the current session was created before the most recent daily boundary, the daemon refreshes the session first.

- `session-idle-timeout` (`idleTimeout` in metadata)
  - Format: `<n><unit>[<n><unit>]...` where unit is `d/h/m/s` (e.g. `2h`, `30m`, `1h30m`).
  - Idle is measured from the **last completed run** (or session creation if no runs yet).
  - On the next run, if idle time is greater than the threshold, the daemon refreshes first.

- `session-max-tokens` (`maxTokens` in metadata)
  - After each successful run completes, the daemon computes `tokensUsed`:
    - Prefer `usage.total_tokens`
    - Else `usage.input_tokens + usage.output_tokens`
    - If usage is missing, the token rule is skipped
  - If `tokensUsed > session-max-tokens`, the daemon refreshes the session so the **next** run starts fresh.

### Manual refresh (`/new`)

If a Telegram bot is bound to an agent:

- Sending `/new` in Telegram requests a refresh for the bound agent.
- The adapter acknowledges immediately with `Session refresh requested.`
- The refresh is queued safely and takes effect at the next safe point.

---

## “Settings” That Are Not Yet Exposed

Some settings exist in the database/schema but do not yet have dedicated CLI setters:

- Updating an agent’s `provider`, `model`, `reasoning_effort`, or `auto_level` after creation
- Updating `boss_name`, `default_provider`, `adapter_boss_id_<type>` after setup
- Changing the default data directory from `~/.hiboss/`

Today, changing those requires a reset + re-setup, or direct DB edits.

---

## Permission Policy

Hi-Boss authorizes operations via a configurable policy stored at:

- `config.permission_policy`

The policy maps an operation name to a minimum permission level:

- `restricted < standard < privileged < boss`

If an operation is missing from the policy, it defaults to `boss` (safe-by-default).

Manage the policy with:

```bash
hiboss permission policy get --token <boss-token>
hiboss permission policy set --token <boss-token> --file ./permission-policy.json
```
