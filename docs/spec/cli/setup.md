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
- Interactive setup is bootstrap-only. If persisted state already exists but is invalid/incomplete, interactive repair is not used.
- For invalid/incomplete persisted state, use config export/apply flow:
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
- v2-only: `version: 1` is rejected.
- `boss-token` and `memory` fields in config are rejected.
- Full reconcile apply (not missing-only patch): config file is treated as desired state.
- Apply is transactional.
- Setup-managed rows are reset and recreated from file.
- Agent tokens are regenerated on apply and printed once.
- Existing agent directories are not removed automatically.
- Daemon must be stopped before apply.
- Successful apply stores startup auto-load metadata:
  - `config.setup_config_file` (absolute path)
  - `config.setup_config_fingerprint` (sha256 of normalized config file content)

Token semantics:
- If boss token hash already exists, `--token` must verify against stored boss token.
- If boss token hash does not exist yet, `--token` becomes the initial boss token.

### Config Schema (Version 2)

Top-level fields:

Required:
- `version: 2`
- `adapters.<adapter-type>.adapter-boss-id` (for each adapter type used by speaker bindings)
- `agents[]`

Optional (defaults applied if omitted):
- `boss-name` (default: OS username)
- `boss-timezone` (default: daemon host timezone; IANA)
- `projects[]` (optional; project catalog + leader membership to reconcile)

Backward compatibility:
- Legacy `telegram.adapter-boss-id` is still accepted during config parse.
- Export always writes canonical `adapters.<adapter-type>.adapter-boss-id` and may also include `telegram.adapter-boss-id` for compatibility.

Forbidden:
- `boss-token`
- `memory`

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

`projects[]` fields:

Required per project:
- `id`
- `name`
- `root` (absolute path)
- `speaker-agent` (must reference an existing `speaker` agent in `agents[]`)
- `leaders[]` (array; may be empty)

Optional per project:
- `main-group-channel`

`projects[].leaders[]` fields:
- `agent-name` (required; must reference an existing `leader` agent in `agents[]`)
- `capabilities` (optional string array)
- `active` (optional boolean; default `true`)

Invariants:
- At least one `speaker` and one `leader`.
- Every `speaker` has at least one binding.
- Adapter token identity (`adapter-type` + `adapter-token`) must be unique across agents.
- For each adapter type used by bindings, `adapters.<adapter-type>.adapter-boss-id` is required.
- For current adapter support, telegram token format must be valid when `adapter-type=telegram`.
- Project roots must be absolute paths and unique within one config.
- Project ids must be unique within one config.
- Project speaker/leader references must point to existing agents with matching roles.

### Example (Version 2)

```json
{
  "version": 2,
  "boss-name": "your-name",
  "boss-timezone": "Asia/Shanghai",
  "adapters": {
    "telegram": {
      "adapter-boss-id": "your_telegram_username"
    },
    "feishu": {
      "adapter-boss-id": "ou_xxx"
    }
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
      "name": "kai",
      "role": "leader",
      "provider": "claude",
      "description": "A reliable and collaborative professional...",
      "workspace": "/absolute/path/to/workspace",
      "model": null,
      "reasoning-effort": null,
      "permission-level": "standard",
      "bindings": []
    }
  ],
  "projects": [
    {
      "id": "prj-6f8c0f6fbc67",
      "name": "hiboos-workspace",
      "root": "/Users/jijianming/Project/hiboos-workspace",
      "speaker-agent": "nex",
      "main-group-channel": "channel:feishu:oc_main_xxx",
      "leaders": [
        {
          "agent-name": "kai",
          "capabilities": ["implementation", "review"],
          "active": true
        }
      ]
    }
  ]
}
```

Output keys:
- Dry-run prints parseable summary keys:
  - `dry-run: true`
  - `first-apply:`
  - `current-agent-count:`
  - `desired-agent-count:`
  - `removed-agents:`
  - `recreated-agents:`
  - `new-agents:`
  - `current-binding-count:`
  - `desired-binding-count:`
- Apply prints the same summary keys with `dry-run: false`, plus:
  - `generated-agent-token-count:`
  - `agent-name:`
  - `agent-role:`
  - `agent-token:` (printed once)

---

## Persistence (Canonical)

Setup config apply writes to `{{HIBOSS_DIR}}/.daemon/hiboss.db`.

Core mappings:
- `boss-name` → `config.boss_name`
- `boss-timezone` → `config.boss_timezone`
- `adapters.<type>.adapter-boss-id` → `config.adapter_boss_id_<type>`
- `agents[]` → `agents` rows
- `agents[].bindings[]` → `agent_bindings` rows
- `projects[]` → `projects` rows
- `projects[].leaders[]` → `project_leaders` rows

Additional effects:
- Boss token hash set/updated from CLI `--token`.
- Setup-managed rows are rebuilt from desired config on apply.
- Run audit rows in `agent_runs` are cleared on apply.
- `config.setup_completed = "true"` is set after successful apply.
- `config.setup_config_file` and `config.setup_config_fingerprint` are updated from the applied file.
