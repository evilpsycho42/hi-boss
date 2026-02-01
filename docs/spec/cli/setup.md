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

Example (`setup.json`):

```json
{
  "version": 1,
  "boss-name": "your-name",
  "boss-token": "your-boss-token",
  "provider": "claude",
  "memory": {
    "mode": "local",
    "model-path": "/absolute/path/to/embedding-model.gguf"
  },
  "agent": {
    "name": "nex",
    "description": "nex - AI assistant",
    "workspace": "/absolute/path/to/workspace",
    "model": "opus",
    "reasoning-effort": "medium",
    "auto-level": "high",
    "permission-level": "standard"
  },
  "telegram": {
    "adapter-token": "123456789:ABCdef...",
    "adapter-boss-id": "your_telegram_username"
  }
}
```

Output:
- Prints `agent-token:` and `boss-token:` once.
