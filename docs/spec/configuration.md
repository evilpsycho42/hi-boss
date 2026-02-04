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
- `~/.hiboss/memory.lance/` — LanceDB storage for semantic memory (created when memory is enabled)
- `~/.hiboss/models/` — downloaded embedding models (used by semantic memory when configured in default mode)
- `~/.hiboss/daemon.sock` — local IPC socket used by the `hiboss` CLI
- `~/.hiboss/daemon.lock` — daemon single-instance lock file
- `~/.hiboss/daemon.pid` — daemon PID file (informational; not used for locking)
- `~/.hiboss/daemon.log` — daemon stdout/stderr log (when started via `hiboss daemon start`; rotated on each start)
- `~/.hiboss/log_history/` — archived `daemon.log` files from prior starts (timestamped)
- `~/.hiboss/BOSS.md` — boss profile placeholder (created empty by setup; not rendered in the minimal system prompt)
- `~/.hiboss/media/` — Telegram downloads (attachments are saved here for agents to read)
- `~/.hiboss/agents/<agent-name>/SOUL.md` — persona placeholder (created empty by setup/registration; not rendered in the minimal system prompt)
- `~/.hiboss/agents/<agent-name>/internal_space/MEMORY.md` — per-agent long-term memory auto-injected into system instructions (may be truncated; default max 36,000 chars)
- `~/.hiboss/agents/<agent-name>/codex_home/` — provider home for Codex (used as `CODEX_HOME`; includes `skills/`)
- `~/.hiboss/agents/<agent-name>/claude_home/` — provider home for Claude Code (used as `CLAUDE_CONFIG_DIR`; includes `skills/`)

Note: the CLI currently always uses the default location (there is no `--data-dir` flag).

---

## Environment Variables

### `HIBOSS_TOKEN`

Default token (agent or boss) for commands when `--token` is omitted.

Used by:

- `hiboss envelope send`
- `hiboss envelope list`
  - and other commands that accept `--token`

Example:

```bash
export HIBOSS_TOKEN="<agent-token>"
hiboss envelope list --from channel:telegram:<chat-id> --status pending
```

---

## CLI Surfaces

The CLI is the primary way to change runtime settings and persisted configuration.

Specifications:
- Setup: `docs/spec/cli/setup.md`
- Daemon: `docs/spec/cli/daemon.md`
- Agents: `docs/spec/cli/agents.md`
- Envelopes: `docs/spec/cli/envelopes.md`
- Cron: `docs/spec/cli/cron.md`
- Reactions: `docs/spec/cli/reactions.md`
- Memory: `docs/spec/cli/memory.md`

### Setup persistence (`hiboss setup --config-file`)

The setup config JSON fields are persisted as:
- `boss-name` → `config.boss_name`
- `boss-timezone` → `config.boss_timezone` (IANA; used for all displayed timestamps)
- `boss-token` → hashed into `config.boss_token_hash`
- `provider` → `config.default_provider`
- `telegram.adapter-boss-id` → `config.adapter_boss_id_telegram` (stored without `@`)
- `telegram.adapter-token` → creates an initial `agent_bindings` row for the first agent
- `memory.*` → stored in `config.memory_*` keys (model source/path/dims/last error)

---

## Persisted Settings (SQLite)

All persisted settings are stored in:

- `~/.hiboss/hiboss.db`

### `config` table

Keys:

- `setup_completed`: `"true"` after setup has run
- `boss_name`: boss display name used in instructions/templates
- `boss_timezone`: boss timezone (IANA) used for all displayed timestamps
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
| `model` | TEXT | `NULL` | Optional model name. `NULL` means “use the provider default model”. |
| `reasoning_effort` | TEXT | `'medium'` | `"none"`, `"low"`, `"medium"`, `"high"`, or `"xhigh"`. `NULL` means “use the provider default reasoning effort”. |
| `auto_level` | TEXT | `'high'` | `"medium"` or `"high"`. Note: unified-agent-sdk also supports `"low"`, but Hi-Boss disallows it because it can prevent the agent from running `hiboss` commands. |
| `permission_level` | TEXT | `'standard'` | `"restricted"`, `"standard"`, `"privileged"`, or `"boss"` |
| `session_policy` | TEXT | `NULL` | JSON blob for SessionPolicyConfig |
| `created_at` | INTEGER | `CAST(strftime('%s','now') AS INTEGER) * 1000` | Unix epoch ms (UTC) |
| `last_seen_at` | INTEGER | `NULL` | Updated when the agent authenticates RPC calls via token (unix ms UTC) |
| `metadata` | TEXT | `NULL` | JSON blob for extended settings |

Set permission level via: `hiboss agent set --name <agent-name> --permission-level <level> --token <boss-privileged-token>` (daemon required)

### `agent_bindings` table

Bindings connect an agent to an adapter credential:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT | — | Primary key |
| `agent_name` | TEXT | — | References `agents(name)` |
| `adapter_type` | TEXT | — | e.g., `"telegram"` |
| `adapter_token` | TEXT | — | Adapter credential (e.g., Telegram bot token) |
| `created_at` | INTEGER | `CAST(strftime('%s','now') AS INTEGER) * 1000` | Unix epoch ms (UTC) |

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
| `deliver_at` | INTEGER | `NULL` | Unix epoch ms (UTC) (scheduled delivery) |
| `status` | TEXT | `'pending'` | `"pending"` or `"done"` |
| `created_at` | INTEGER | `CAST(strftime('%s','now') AS INTEGER) * 1000` | Unix epoch ms (UTC) |
| `metadata` | TEXT | `NULL` | JSON blob |

### `cron_schedules` table

Cron schedules are stored per agent and materialize as normal envelopes (see `docs/spec/components/cron.md`).

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT | — | Primary key |
| `agent_name` | TEXT | — | Owner agent (also the sender of materialized envelopes) |
| `cron` | TEXT | — | Cron expression |
| `timezone` | TEXT | `NULL` | IANA timezone; `NULL` means inherit `config.boss_timezone` |
| `enabled` | INTEGER | `1` | `1` for enabled, `0` for disabled |
| `to_address` | TEXT | — | Destination address (`agent:*` or `channel:*`) |
| `content_text` | TEXT | `NULL` | Template message text |
| `content_attachments` | TEXT | `NULL` | Template attachments (JSON array) |
| `metadata` | TEXT | `NULL` | Template metadata (JSON blob; e.g., parse mode) |
| `pending_envelope_id` | TEXT | `NULL` | Next scheduled envelope id (nullable) |
| `created_at` | INTEGER | `CAST(strftime('%s','now') AS INTEGER) * 1000` | Unix epoch ms (UTC) |
| `updated_at` | INTEGER | `NULL` | Unix epoch ms (UTC) |

### `agent_runs` table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT | — | Primary key |
| `agent_name` | TEXT | — | Agent that ran |
| `started_at` | INTEGER | — | Unix timestamp (ms) |
| `completed_at` | INTEGER | `NULL` | Unix timestamp (ms) |
| `envelope_ids` | TEXT | `NULL` | JSON array of processed envelope IDs |
| `final_response` | TEXT | `NULL` | Stored for auditing |
| `context_length` | INTEGER | `NULL` | Context length (tokens) for the run when available |
| `status` | TEXT | `'running'` | `"running"`, `"completed"`, or `"failed"` |
| `error` | TEXT | `NULL` | Error message if failed |

---

## Session Policy (Per Agent)

Session refresh behavior is configured per agent in:
- `agents.session_policy` (`Agent.sessionPolicy`)

Fields are optional (unset = disabled):
- `dailyResetAt`: `"HH:MM"` (24-hour), interpreted in the daemon host’s local timezone
- `idleTimeout`: duration string (units: `d/h/m/s`; examples: `2h`, `30m`, `1h30m`)
- `maxContextLength`: number; if a successful run’s **context length** exceeds this, the daemon refreshes the session so the *next* run starts fresh (uses `usage.context_length` when present; skipped when missing)

Set/clear via `hiboss agent set` (see `docs/spec/cli/agents.md`):
- `--session-daily-reset-at`
- `--session-idle-timeout`
- `--session-max-context-length`
- `--clear-session-policy`

Manual refresh:
- Boss-only: Telegram `/new` requests a session refresh for the bound agent (applies at the next safe point).

See `docs/spec/components/session.md` for lifecycle and evaluation details.

---

## “Settings” That Are Not Yet Exposed

Some settings exist in the database/schema but do not yet have dedicated CLI setters:

- Updating `boss_name`, `default_provider`, `adapter_boss_id_<type>` after setup
- Editing `config.permission_policy`
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
| `message.send` | `restricted` |
| `message.list` | `restricted` |
| `daemon.status` | `boss` |
| `daemon.ping` | `standard` |
| `daemon.start` | `boss` |
| `daemon.stop` | `boss` |
| `agent.register` | `boss` |
| `agent.list` | `restricted` |
| `agent.bind` | `privileged` |
| `agent.unbind` | `privileged` |
| `agent.status` | `restricted` |
| `agent.refresh` | `boss` |
| `agent.set` | `privileged` |
| `agent.session-policy.set` | `privileged` |
