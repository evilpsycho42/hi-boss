# CLI: Setup

This document specifies the `hiboss setup` command.

See also:
- `docs/spec/configuration.md`
- `docs/spec/config/sqlite.md`
- `docs/spec/config/data-dir.md`

## `hiboss setup`

Runs the interactive bootstrap wizard and writes canonical config to:

- `{{HIBOSS_DIR}}/settings.json` (`version: "v0.0.0"`)

Behavior:
- If setup is already healthy, prints "Setup is already complete" and exits.
- Bootstrap-only: if persisted setup state already exists but is invalid, setup does not repair in-place.
- Invalid persisted state should be repaired by editing `settings.json` then restarting daemon.
- Creates agent home directories under `{{HIBOSS_DIR}}/agents/<agent-name>/`.
- Creates empty `{{HIBOSS_DIR}}/BOSS.md` (best effort).
- Creates two baseline agents (`primary` and `secondary`).
- Prints primary/secondary/admin tokens once.
- Writes `settings.json` with owner-only permissions (`0600`, best effort across platforms).

Interactive defaults:
- `boss.name`: OS username
- `boss.timezone`: daemon host timezone (IANA)
- `primary-agent.name`: `nex`
- `primary-agent.workspace`: user home directory
- `primary-agent.permission-level`: `standard`
- `primary-agent.model`: `null` (provider default)
- `primary-agent.reasoning-effort`: `null` (provider default)
- `secondary-agent.name`: `kai`
- `secondary-agent.workspace`: primary-agent workspace
- `secondary-agent.permission-level`: primary-agent value
- `secondary-agent.model`: `null` (provider default)
- `secondary-agent.reasoning-effort`: `null` (provider default)
- `primary/secondary provider env overrides`: default shared env (no per-agent overrides)

## `settings.json` Schema

Top-level required fields:
- `version: "v0.0.0"`
- `boss`
- `admin`
- `telegram`
- `permission-policy`
- `agents[]`

Top-level optional fields:
- `runtime` (defaults are applied when omitted)

Key fields:
- `boss.name`
- `boss.timezone`
- `admin.token` (plaintext)
- `telegram.boss-ids[]` (supports multiple boss usernames)
- `permission-policy` (`version: "v0.0.0"`)
- `permission-policy` (`version: "v0.0.0"`)
- `user-permission-policy` (`version: "v0.0.0"`, required)
- `runtime.session-concurrency.per-agent` (default `4`)
- `runtime.session-concurrency.global` (default `16`, must be `>= per-agent`)
- `agents[].token` (plaintext)
- `agents[].bindings[]`
- `agents[].metadata.providerCli.<provider>.env` (optional per-agent provider CLI env overrides)

Invariants:
- Agent names are unique (case-insensitive).
- Agent tokens are unique.
- Adapter identity (`adapter-type` + `adapter-token`) is unique across agents.

## Persistence (Canonical)

`settings.json` is source-of-truth.

On daemon startup:
1. Read + validate `settings.json`.
2. Mirror settings into SQLite runtime cache (`config`, `agents`, `agent_bindings`).
3. Mark `config.setup_completed = "true"`.

Core mappings:
- `boss.name` → `config.boss_name`
- `boss.timezone` → `config.boss_timezone`
- `admin.token` → `config.admin_token_hash`
- `telegram.boss-ids` → `config.adapter_boss_ids_telegram` (first value also mirrored to `config.adapter_boss_id_telegram` for compatibility)
- `permission-policy` → `config.permission_policy`
- `user-permission-policy` → `config.user_permission_policy`
- `runtime.session-concurrency.per-agent` → `config.runtime_session_concurrency_per_agent`
- `runtime.session-concurrency.global` → `config.runtime_session_concurrency_global`
- `agents[]` → `agents`
- `agents[].bindings[]` → `agent_bindings`
