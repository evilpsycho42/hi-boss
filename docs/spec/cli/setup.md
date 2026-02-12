# CLI: Setup

This document specifies the `hiboss setup` command family.

See also:
- `docs/spec/configuration.md` (config entrypoint)
- `docs/spec/config/sqlite.md` (SQLite state)
- `docs/spec/config/data-dir.md` (data directory layout)
- `docs/spec/cli/agents.md` (agent fields used by setup config files)

## `hiboss setup`

Runs the interactive first-time setup wizard.

Behavior:
- If setup is already healthy (`setup_completed=true`, at least one `speaker`, at least one `leader`, and valid speaker bindings), prints "Setup is already complete" and exits.
- Interactive setup is **bootstrap-only**. If persisted state already exists but is invalid/incomplete, interactive repair is not used.
- For invalid/incomplete persisted state, users must use config export/apply flow:
  1. `hiboss setup export`
  2. edit JSON
  3. `hiboss setup --config-file <path> --token <boss-token> --dry-run`
  4. `hiboss setup --config-file <path> --token <boss-token>`
- Initializes SQLite at `~/hiboss/.daemon/hiboss.db` (WAL sidecars may appear).
- Creates agent home directories under `~/hiboss/agents/<agent-name>/`.
- Creates empty `~/hiboss/BOSS.md` (best-effort).
- Creates one `speaker` and one `leader`.
- Prints speaker/leader/boss tokens once.

Interactive defaults:
- `boss-name`: OS username
- `boss-timezone`: daemon host timezone (IANA)
- `agent.name` (speaker): `nex`
- `agent.workspace`: user home directory
- `agent.permission-level`: `standard`
- `leader.name`: `leader`
- `leader.workspace`: speaker workspace
- `memory.mode`: `default`

## `hiboss setup export`

Exports the current setup configuration to JSON schema `version: 2`.

Usage:
- `hiboss setup export`
- `hiboss setup export --out /path/to/config.json`

Defaults:
- Output path defaults to `${HIBOSS_DIR}/config.json`.
- If no setup DB exists yet, export writes a bootstrap template.

Security:
- Export never includes `boss-token`.
- Export never includes agent tokens.
- Adapter tokens (for bindings) are included, because bindings are part of setup configuration.

## `hiboss setup --config-file <path> --token <boss-token> [--dry-run]`

Applies a declarative setup config from JSON schema `version: 2`.

Flags:
- `--config-file <path>`: required
- `--token <boss-token>`: required (or `HIBOSS_TOKEN`)
- `--dry-run`: optional (validate + diff only, no mutation)

Behavior:
- **v2-only**: `version: 1` is rejected; no backward compatibility path.
- Full reconcile apply (not missing-only patch): config file is treated as desired state.
- Apply is transactional.
- Setup-managed rows are reset and recreated from file (agents/bindings/cron schedules under setup-managed flow).
- Agent tokens are regenerated on apply and printed once.
- Existing agent directories are not removed automatically.
- Daemon must be stopped before apply.

Token semantics:
- If boss token hash already exists, `--token` must verify against stored boss token.
- If boss token hash does not exist yet, `--token` becomes the initial boss token.

### Config Schema (Version 2)

Top-level fields:

Required:
- `version: 2`
- `telegram.adapter-boss-id`
- `memory`
- `agents[]`

Optional (defaults applied if omitted):
- `boss-name` (default: OS username)
- `boss-timezone` (default: daemon host timezone; IANA)

Forbidden:
- `boss-token` (must not be present in v2 config files)

`memory` fields:

Required:
- `enabled: boolean`
- `mode: "default" | "local"`
- `dims: number` (must be `>= 0`; must be `> 0` when `enabled=true`)

Optional (defaults applied if omitted):
- `model-path: string` (default: `""`; required when `enabled=true`)
- `model-uri: string` (default: `""`)
- `last-error: string` (default: `""`)

`agents[]` fields:

Required:
- `name`
- `role` (`speaker` or `leader`)
- `provider` (`claude` or `codex`)
- `bindings[]` (array; may be empty for leaders)

Optional (defaults applied if omitted):
- `description` (default: generated description)
- `workspace` (default: user home directory; must be absolute path)
- `model` (`string | null`; `"default"` accepted and normalized to `null`; default: `null`)
- `reasoning-effort` (`none|low|medium|high|xhigh|default|null`; `"default"` normalized to `null`; default: `null`)
- `permission-level` (`restricted|standard|privileged|boss`; default: `standard`)
- `session-policy` (object; keys optional):
  - `daily-reset-at`
  - `idle-timeout`
  - `max-context-length`
- `metadata` (object)

`bindings[]` fields (required per binding):
  - `adapter-type`
  - `adapter-token`

Invariants:
- At least one `speaker` and one `leader`.
- Every `speaker` has at least one binding.
- Adapter token identity (`adapter-type` + `adapter-token`) must be unique across agents.
- For current adapter support, telegram token format must be valid when `adapter-type=telegram`.

Note:
- Config apply is full reconcile. Missing optional fields are defaulted before apply (so defaults become desired state).
- For re-setup, start from `hiboss setup export` to preserve existing values.

### Example (Version 2)

```json
{
  "version": 2,
  "boss-name": "your-name",
  "boss-timezone": "Asia/Shanghai",
  "telegram": {
    "adapter-boss-id": "your_telegram_username"
  },
  "memory": {
    "enabled": false,
    "mode": "default",
    "model-path": "",
    "model-uri": "",
    "dims": 0,
    "last-error": "Memory model is not configured"
  },
  "agents": [
    {
      "name": "nex",
      "role": "speaker",
      "provider": "claude",
      "description": "A reliable and collaborative professional...",
      "workspace": "/absolute/path/to/workspace",
      "model": null,
      "reasoning-effort": null,
      "permission-level": "standard",
      "session-policy": {
        "daily-reset-at": "06:00",
        "idle-timeout": "30m",
        "max-context-length": 32000
      },
      "metadata": {
        "team": "ops"
      },
      "bindings": [
        {
          "adapter-type": "telegram",
          "adapter-token": "123456789:ABCdef..."
        }
      ]
    },
    {
      "name": "leader",
      "role": "leader",
      "provider": "claude",
      "description": "A reliable and collaborative professional...",
      "workspace": "/absolute/path/to/workspace",
      "model": null,
      "reasoning-effort": null,
      "permission-level": "standard",
      "bindings": []
    }
  ]
}
```

Output keys:
- Dry-run prints parseable summary keys like:
  - `dry-run: true`
  - `first-apply:`
  - `current-agent-count:`
  - `desired-agent-count:`
  - `removed-agents:`
  - `recreated-agents:`
  - `new-agents:`
  - `current-binding-count:`
  - `desired-binding-count:`
- Apply prints the same summary keys with `dry-run: false`, plus per-agent token lines:
  - `agent-name:`
  - `agent-role:`
  - `agent-token:` (printed once)

---

## Persistence (Canonical)

Setup config apply writes to `{{HIBOSS_DIR}}/.daemon/hiboss.db`.

Core mappings:
- `boss-name` → `config.boss_name`
- `boss-timezone` → `config.boss_timezone`
- `telegram.adapter-boss-id` → `config.adapter_boss_id_telegram` (stored without `@`)
- `memory.*` → `config.memory_*`
- `agents[]` → `agents` table rows
- `agents[].bindings[]` → `agent_bindings` rows

Additional effects:
- Boss token hash set/updated from CLI `--token`.
- Setup-managed rows are rebuilt from desired config on apply.
- Run audit rows in `agent_runs` are cleared on apply.
- `config.setup_completed = "true"` is set after successful apply.
