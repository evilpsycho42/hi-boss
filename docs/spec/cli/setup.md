# CLI: Setup

This document specifies the `hiboss setup` command.

See also:
- `docs/spec/configuration.md`
- `docs/spec/config/sqlite.md`
- `docs/spec/config/data-dir.md`

## `hiboss setup`

Runs the interactive bootstrap wizard and writes canonical config to:

- `{{HIBOSS_DIR}}/settings.json` (`version: 4`)

Behavior:
- If setup is already healthy, prints "Setup is already complete" and exits.
- Bootstrap-only: if persisted setup state already exists but is invalid, setup does not repair in-place.
- Invalid persisted state should be repaired by editing `settings.json` then restarting daemon.
- Creates agent home directories under `{{HIBOSS_DIR}}/agents/<agent-name>/`.
- Creates empty `{{HIBOSS_DIR}}/BOSS.md` (best effort).
- Creates one speaker and one leader.
- Prints speaker/leader/admin tokens once.
- Writes `settings.json` with owner-only permissions (`0600`, best effort across platforms).
- Interactive setup binds speaker to one selected adapter (`telegram` or `wechatpadpro`).

Interactive defaults:
- `boss.name`: OS username
- `boss.timezone`: daemon host timezone (IANA)
- `speaker.name`: `nex`
- `speaker.workspace`: user home directory
- `speaker.permission-level`: `standard`
- `speaker.model`: `null` (provider default)
- `speaker.reasoning-effort`: `null` (provider default)
- `leader.name`: `kai`
- `leader.workspace`: speaker workspace
- `leader.permission-level`: speaker value
- `leader.model`: `null` (provider default)
- `leader.reasoning-effort`: `null` (provider default)

## `settings.json` Schema (Version 4)

Top-level required fields:
- `version: 4`
- `boss`
- `admin`
- `permission-policy`
- `agents[]`

Top-level optional fields:
- `telegram`
- `wechatpadpro`
- `runtime` (defaults are applied when omitted)

Key fields:
- `boss.name`
- `boss.timezone`
- `admin.token` (plaintext)
- `telegram.boss-ids[]` (optional; supports multiple boss usernames)
- `wechatpadpro.boss-ids[]` (optional; supports multiple wxids)
- `permission-policy` (`version: 1`)
- `runtime.session-concurrency.per-agent` (default `4`)
- `runtime.session-concurrency.global` (default `16`, must be `>= per-agent`)
- `agents[].token` (plaintext)
- `agents[].bindings[]`

Invariants:
- At least one `speaker` and one `leader`.
- Every `speaker` has at least one binding.
- At least one channel boss allowlist is configured: `telegram.boss-ids` or `wechatpadpro.boss-ids`.
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
- `wechatpadpro.boss-ids` → `config.adapter_boss_ids_wechatpadpro` (first value also mirrored to `config.adapter_boss_id_wechatpadpro` for compatibility)
- `permission-policy` → `config.permission_policy`
- `runtime.session-concurrency.per-agent` → `config.runtime_session_concurrency_per_agent`
- `runtime.session-concurrency.global` → `config.runtime_session_concurrency_global`
- `agents[]` → `agents`
- `agents[].bindings[]` → `agent_bindings`
