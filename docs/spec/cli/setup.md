# CLI: Setup

This document specifies the `hiboss setup` command family.

See also:
- `docs/spec/configuration.md` (config entrypoint)
- `docs/spec/config/sqlite.md` (SQLite state)
- `docs/spec/config/data-dir.md` (data directory layout)
- `docs/spec/cli/agents.md` (agent fields used by setup config files)

## `hiboss setup`

Runs the interactive first-time setup wizard (default).

Behavior:
- Initializes the SQLite database at `~/hiboss/.daemon/hiboss.db` (WAL sidecars like `hiboss.db-wal` / `hiboss.db-shm` may appear)
- Creates the agent home directories under `~/hiboss/agents/<agent-name>/`
- Creates an empty `~/hiboss/BOSS.md` placeholder (best-effort; not rendered in minimal system prompt)
- Creates an empty `~/hiboss/agents/<agent-name>/SOUL.md` placeholder (best-effort)
- Provider CLIs use shared default homes (`~/.claude` / `~/.codex`). Hi-Boss clears `CLAUDE_CONFIG_DIR` / `CODEX_HOME` when spawning provider processes, and does not create per-agent provider homes or import/copy provider config files.
- Creates the first agent and prints `agent-token:` once (no “show token” command)
- Prints `boss-token:` once
- Prompts for `boss-timezone` (IANA) used for all displayed timestamps; defaults to the daemon host timezone
- Configures and binds a Telegram adapter for the first agent

Interactive defaults (when you press Enter):
- `provider`: no default; required input (`claude` or `codex`)
- `boss-name`: current OS username
- `boss-timezone`: daemon host timezone (IANA)
- `agent.name`: `nex`
- `agent.description`: generated default description
- `agent.workspace`: user home directory
- `agent.model`: `null` (use provider default)
- `agent.reasoning-effort`: `null` (use provider default)
- `agent.permission-level`: `standard`
- `session-policy`: unset
- `metadata`: unset
- `memory.mode`: `default` (download default embedding model)

## `hiboss setup --config-file <path>`

Runs non-interactive setup from a JSON file (no prompts; errors on invalid/missing fields):

- `--config-file <path>` (required)

Usage:
- `hiboss setup --config-file setup.json`

Config file must include:
- `version: 1`
- `boss-token: <token>`
- `provider: <claude|codex>`
- `boss-timezone: <iana>` (optional; defaults to daemon host timezone)
- `agent: { ... }`
- `telegram: { adapter-token, adapter-boss-id }`

Optional:
- `memory: { mode, model-path }`
  - `mode`: `default` (download the default embedding model) or `local` (use a local GGUF)
  - `model-path`: required when `mode: local` (absolute path to a `.gguf`)

Config-file defaults (when omitted):
- `boss-name`: current OS username
- `boss-timezone`: daemon host timezone (IANA)
- `agent.name`: `nex`
- `agent.description`: generated default description
- `agent.workspace`: user home directory
- `agent.model`: `null` (use provider default)
- `agent.reasoning-effort`: `null` (use provider default)
- `agent.permission-level`: `standard`
- `memory.mode`: `default`

Example (`setup.json`):

```json
{
  "version": 1,
  "boss-name": "your-name",
  "boss-timezone": "Asia/Shanghai",
  "boss-token": "your-boss-token",
  "provider": "claude",
  "memory": {
    "mode": "local",
    "model-path": "/absolute/path/to/embedding-model.gguf"
  },
	  "agent": {
	    "name": "nex",
	    "description": "A reliable and collaborative professional who delivers results with clarity and respect for others, and consistently makes teamwork more effective and enjoyable.",
	    "workspace": "/absolute/path/to/workspace",
	    "model": null,
	    "reasoning-effort": null,
	    "permission-level": "standard"
	  },
  "telegram": {
    "adapter-token": "123456789:ABCdef...",
    "adapter-boss-id": "your_telegram_username"
  }
}
```

Notes:
- `agent.model: null` means “use the provider default model”.
- `agent.reasoning-effort: null` means “use the provider default reasoning effort”.
- For parity with `hiboss agent set`, the string `"default"` is also accepted for both fields (treated as `null`).
- Setup model choices are provider-specific plus `null` plus custom input:
  - `codex`: `null`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`, custom model id
  - `claude`: `null`, `haiku`, `sonnet`, `opus`, custom model id

Output:
- Setup prints tokens once, plus a small block of stable key/value lines (keys are kebab-case and may be indented in the human UI).
- `hiboss setup` (interactive) prints: `daemon-timezone:`, `boss-timezone:`, `agent-name:`, `agent-token:`, `boss-token:`, `memory-enabled:`, and (when applicable) `memory-model-path:`, `memory-model-dims:`, `memory-last-error:`.
- `hiboss setup --config-file ...` prints: `daemon-timezone:`, `boss-timezone:`, `boss-name:`, `agent-name:`, `agent-token:`, `boss-token:`, `provider:`, `model:`, `memory-enabled:`.

---

## Persistence (canonical)

Setup persists configuration into SQLite (`{{HIBOSS_DIR}}/.daemon/hiboss.db`).

From the setup config JSON:
- `boss-name` → `config.boss_name`
- `boss-timezone` → `config.boss_timezone` (IANA; used for displayed timestamps)
- `boss-token` → hashed into `config.boss_token_hash` (token is printed once; no “show token” command)
- `provider` → `config.default_provider` (informational today)
- `telegram.adapter-boss-id` → `config.adapter_boss_id_telegram` (stored without `@`)

Other side effects:
- Creates the first agent row in `agents` and prints `agent-token:` once.
- Creates an initial `agent_bindings` row for the first agent from `telegram.adapter-token`.
- Writes semantic memory config keys when memory is configured:
  - `config.memory_enabled`, `config.memory_model_source`, `config.memory_model_uri`, `config.memory_model_path`, `config.memory_model_dims`, `config.memory_model_last_error`
- Marks setup complete: `config.setup_completed = "true"`.
