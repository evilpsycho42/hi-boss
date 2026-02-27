# Config: SQLite State

Hi-Boss persists state in:
- `{{HIBOSS_DIR}}/.daemon/hiboss.db`

Schema source of truth:
- `src/daemon/db/schema.ts`

Tables (high level):
- `config` — global configuration key/value
- `agents` — agent records + settings
- `teams` — team metadata (status, description)
- `team_members` — team membership links (team ↔ agent)
- `agent_bindings` — adapter credentials bound to agents (e.g., Telegram bot token)
- `envelopes` — durable message queue + audit
- `cron_schedules` — durable cron definitions (materialize envelopes)
- `agent_runs` — run audit records
- `agent_sessions` — session registry (provider session/thread handles)
- `channel_session_bindings` — active session mapping per channel chat
- `channel_session_links` — historical/visibility links for session browser scopes

## `config` keys (selected)

- `setup_completed`: `"true"` after setup has run
- `boss_name`: boss display name used in prompts/templates
- `boss_timezone`: boss timezone (IANA) used for displayed timestamps
- `admin_token_hash`: hashed admin token (printed once by setup)
- `permission_policy`: JSON mapping operations → required permission level
- `adapter_boss_id_<adapter-type>`: boss identity on an adapter (e.g., `adapter_boss_id_telegram`)
- `adapter_boss_ids_<adapter-type>`: comma-separated boss identity list (e.g., `adapter_boss_ids_telegram`)
- `runtime_session_concurrency_per_agent`: per-agent session concurrency limit
- `runtime_session_concurrency_global`: global session concurrency limit

## Key invariants

- Envelopes are durable; routing/scheduling operates by querying `envelopes` (see `docs/spec/components/routing.md`, `docs/spec/components/scheduler.md`).
- Agent tokens and adapter tokens are stored in plaintext in SQLite; protect `{{HIBOSS_DIR}}/`.
