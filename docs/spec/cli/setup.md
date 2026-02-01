# CLI: Setup

This document specifies the `hiboss setup` command family.

See also:
- `docs/spec/configuration.md` (what setup persists and where)
- `docs/spec/cli/agents.md` (agent fields used by `setup default`)

## `hiboss setup` / `hiboss setup interactive`

Runs the interactive first-time setup wizard (default).

Behavior:
- Initializes the SQLite database at `~/.hiboss/hiboss.db` (WAL sidecars like `hiboss.db-wal` / `hiboss.db-shm` may appear)
- Creates the agent home directories under `~/.hiboss/agents/<agent-name>/`
- Imports provider config files for the chosen provider into the agent’s provider home
- Creates the first agent and prints `agent-token:` once (no “show token” command)
- Prints `boss-token:` once
- Configures and binds a Telegram adapter for the first agent

## `hiboss setup default`

Runs non-interactive setup from a JSON file:

- `--config <path>` (required)

Config file must include:
- `version: 1`
- `boss-token: <token>`
- `agent: { ... }`
- `telegram: { adapter-token, adapter-boss-id }`

Optional:
- `memory: { mode, model-path }`
  - `mode`: `default` (download the default embedding model) or `local` (use a local GGUF)
  - `model-path`: required when `mode: local` (absolute path to a `.gguf`)
- `provider-source-home: <path>` (optional; imports provider config from this directory; defaults to `~/.codex/` or `~/.claude/` based on `provider`)

Example (`setup.json`):

```json
{
  "version": 1,
  "boss-name": "your-name",
  "boss-token": "your-boss-token",
  "provider": "claude",
  "provider-source-home": "~/.claude",
  "memory": {
    "mode": "local",
    "model-path": "/absolute/path/to/embedding-model.gguf"
  },
  "agent": {
    "name": "nex",
    "description": "nex - AI assistant",
    "workspace": "/absolute/path/to/workspace",
    "model": null,
    "reasoning-effort": null,
    "auto-level": "high",
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

Output:
- Prints `agent-token:` and `boss-token:` once.
