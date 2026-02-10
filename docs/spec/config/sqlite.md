# Config: SQLite State

Hi-Boss persists state in:
- `{{HIBOSS_DIR}}/.daemon/hiboss.db`

Schema source of truth:
- `src/daemon/db/schema.ts`

Tables (high level):
- `config` — global configuration key/value
- `agents` — agent records + settings
- `agent_bindings` — adapter credentials bound to agents (e.g., Telegram bot token)
- `envelopes` — durable message queue + audit
- `cron_schedules` — durable cron definitions (materialize envelopes)
- `agent_runs` — run audit records

## `config` keys (selected)

- `setup_completed`: `"true"` after setup has run
- `boss_name`: boss display name used in prompts/templates
- `boss_timezone`: boss timezone (IANA) used for displayed timestamps
- `boss_token_hash`: hashed boss token (printed once by setup)
- `default_provider`: `"claude"` or `"codex"` (written by setup; informational today)
- `permission_policy`: JSON mapping operations → required permission level
- `adapter_boss_id_<adapter-type>`: boss identity on an adapter (e.g., `adapter_boss_id_telegram`)
- Semantic memory:
  - `memory_enabled`, `memory_model_source`, `memory_model_uri`, `memory_model_path`, `memory_model_dims`, `memory_model_last_error`

## Key invariants

- Envelopes are durable; routing/scheduling operates by querying `envelopes` (see `docs/spec/components/routing.md`, `docs/spec/components/scheduler.md`).
- Agent tokens and adapter tokens are stored in plaintext in SQLite; protect `{{HIBOSS_DIR}}/`.
