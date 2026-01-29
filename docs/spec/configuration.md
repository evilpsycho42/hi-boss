# Hi-Boss Configuration

This document describes configurable settings in Hi-Boss, where they live, and how to change them.

Hi-Boss configuration comes from four places:

1. **CLI flags** (`hiboss ... --flag`)
2. **Environment variables** (`HIBOSS_TOKEN`, …)
3. **SQLite state** in `~/.hiboss/hiboss.db` (tables: `config`, `agents`, `agent_bindings`, `envelopes`, …)
4. **Per-agent provider homes** under `~/.hiboss/agents/<agent-name>/` (Codex/Claude settings + session state)

## Defaults

Built-in (code) defaults are centralized in:

- `src/shared/defaults.ts`

---

## Data Directory

By default Hi-Boss stores all state under:

- `~/.hiboss/`

Contents (common):

- `~/.hiboss/hiboss.db` — SQLite database (agents, bindings, envelopes, runs, config)
- `~/.hiboss/daemon.sock` — local IPC socket used by the `hiboss` CLI
- `~/.hiboss/daemon.pid` — daemon PID file (single-instance lock)
- `~/.hiboss/daemon.log` — daemon stdout/stderr log (when started via `hiboss daemon start`)
- `~/.hiboss/BOSS.md` — global boss profile injected into system instructions (optional)
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
  - `--config <path>`: JSON setup config file
    - `boss-name`: stored as `config.boss_name`
    - `boss-token`: stored hashed as `config.boss_token_hash`
    - `provider`: stored as `config.default_provider`
    - `telegram.adapter-boss-id`: stored as `config.adapter_boss_id_telegram` (stored without `@`)
    - `telegram.adapter-token`: creates an initial `agent_bindings` row for the first agent

### Agents

- `hiboss agent register`
  - `--token <boss-token>`
  - `--name <name>`
  - `--description <text>`
  - `--workspace <path>`
  - `--provider <claude|codex>`
  - `--model <model>`
  - `--reasoning-effort <none|low|medium|high|xhigh>`
  - `--auto-level <low|medium|high>`
  - `--permission-level <restricted|standard|privileged>`
  - `--metadata-json <json>` / `--metadata-file <path>`
  - `--bind-adapter-type <type>` / `--bind-adapter-token <token>`
  - Session policy (optional):
    - `--session-daily-reset-at <HH:MM>`
    - `--session-idle-timeout <duration>`
    - `--session-max-tokens <n>`

- `hiboss agent set`
  - Updates agent settings and bindings (see `docs/spec/cli.md` for full flags)

Binding management is done via `hiboss agent set`:

- Bind: `hiboss agent set --name <agent-name> --bind-adapter-type telegram --bind-adapter-token <token>`
- Unbind: `hiboss agent set --name <agent-name> --unbind-adapter-type telegram`

Binding constraints:

- A single bot token can only be bound to **one** agent (`UNIQUE(adapter_type, adapter_token)`).
- An agent can only have **one** binding per adapter type (so no “two telegram bots for one agent” today).

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
  - `--address <address>` (boss token only; required for boss token)
  - `--box <inbox|outbox>` (default: `inbox`)
  - `--status <pending|done>`
  - `-n, --limit <n>` (optional)
  - `--n <n>` (deprecated alias for `--limit`)
  - `--as-turn` (optional; render pending inbox as a turn preview)

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
  - `adapter_boss_id_telegram = "your_username"`

What `adapter_boss_id_<adapter-type>` does:

- When the daemon receives a channel message, it marks `fromBoss: true` if the sender username matches.
- For Telegram, it also controls whether the daemon will show “not configured” instructions when a bot is unbound (only shown to the boss).

### `agents` table

Per-agent settings:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | TEXT | — | Agent identifier (used in addresses like `agent:<name>`) |
| `token` | TEXT | — | Agent auth token (stored plaintext; printed by setup/register). No CLI command to show it again. |
| `description` | TEXT | `NULL` | Optional description |
| `workspace` | TEXT | `NULL` | Passed to the provider runtime as the session working directory |
| `provider` | TEXT | `'claude'` | `"claude"` or `"codex"` |
| `model` | TEXT | `NULL` | Optional model name (set by setup for the initial agent) |
| `reasoning_effort` | TEXT | `'medium'` | `"none"`, `"low"`, `"medium"`, `"high"`, or `"xhigh"` |
| `auto_level` | TEXT | `'high'` | `"low"`, `"medium"`, or `"high"` |
| `permission_level` | TEXT | `'standard'` | `"restricted"`, `"standard"`, or `"privileged"` |
| `session_policy` | TEXT | `NULL` | JSON blob for SessionPolicyConfig |
| `created_at` | TEXT | `datetime('now')` | ISO 8601 timestamp |
| `last_seen_at` | TEXT | `NULL` | Updated when the agent authenticates RPC calls via token |
| `metadata` | TEXT | `NULL` | JSON blob for extended settings |

Set permission level via: `hiboss agent set --name <agent-name> --permission-level <level> --token <boss-token>` (daemon required)

### `agent_bindings` table

Bindings connect an agent to an adapter credential:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT | — | Primary key |
| `agent_name` | TEXT | — | References `agents(name)` |
| `adapter_type` | TEXT | — | e.g., `"telegram"` |
| `adapter_token` | TEXT | — | Adapter credential (e.g., Telegram bot token) |
| `created_at` | TEXT | `datetime('now')` | ISO 8601 timestamp |

Constraints:
- `UNIQUE(adapter_type, adapter_token)` — each adapter binds to one agent
- Each agent can have at most one binding per adapter type

### `envelopes` table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT | — | Primary key |
| `from` | TEXT | — | Sender address |
| `to` | TEXT | — | Recipient address |
| `from_boss` | INTEGER | `0` | `1` if sent by boss, `0` otherwise |
| `content_text` | TEXT | `NULL` | Message text |
| `content_attachments` | TEXT | `NULL` | JSON array of attachments |
| `deliver_at` | TEXT | `NULL` | ISO 8601 UTC timestamp (scheduled delivery) |
| `status` | TEXT | `'pending'` | `"pending"` or `"done"` |
| `created_at` | TEXT | `datetime('now')` | ISO 8601 timestamp |
| `metadata` | TEXT | `NULL` | JSON blob |

### `agent_runs` table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT | — | Primary key |
| `agent_name` | TEXT | — | Agent that ran |
| `started_at` | INTEGER | — | Unix timestamp (ms) |
| `completed_at` | INTEGER | `NULL` | Unix timestamp (ms) |
| `envelope_ids` | TEXT | `NULL` | JSON array of processed envelope IDs |
| `final_response` | TEXT | `NULL` | Stored for auditing |
| `status` | TEXT | `'running'` | `"running"`, `"completed"`, or `"failed"` |
| `error` | TEXT | `NULL` | Error message if failed |

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

### Default Policy

| Operation | Default Level |
|-----------|---------------|
| `envelope.send` | `restricted` |
| `envelope.list` | `restricted` |
| `envelope.get` | `restricted` |
| `turn.preview` | `restricted` |
| `message.send` | `restricted` |
| `message.list` | `restricted` |
| `message.get` | `restricted` |
| `daemon.status` | `boss` |
| `daemon.ping` | `standard` |
| `daemon.start` | `boss` |
| `daemon.stop` | `boss` |
| `agent.register` | `boss` |
| `agent.list` | `restricted` |
| `agent.bind` | `privileged` |
| `agent.unbind` | `privileged` |
| `agent.refresh` | `boss` |
| `agent.set` | `privileged` |
| `agent.session-policy.set` | `privileged` |
| `agent.background` | `standard` |
