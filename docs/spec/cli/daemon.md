# CLI: Daemon

This document specifies `hiboss daemon ...`.

## `hiboss daemon start`

Startup mode selection:
- If `settings.json` contains `runtime.deployment.mode` (`docker` or `pm2`), `hiboss daemon start` delegates to the managed runtime in `runtime.deployment.output-dir`.
- Otherwise, it starts the local daemon process in the background.

Managed-runtime behavior:
- `docker`: runs docker compose `up -d` against `<output-dir>/docker-compose.yml` (and `.env.docker` when present).
- `pm2`: runs `pm2 startOrReload <output-dir>/ecosystem.config.cjs --only hiboss-daemon --update-env`.

Direct local-daemon behavior:
- Starts a detached daemon process from `daemon-entry`.

Log behavior:
- If `~/hiboss/.daemon/daemon.log` exists and is non-empty, it is moved to `~/hiboss/.daemon/log_history/` with a timestamped suffix.
- A new empty `~/hiboss/.daemon/daemon.log` is created for the new daemon process.

Flags:
- `--debug`: Include debug-only fields in `daemon.log` (IDs + token usage), **only** in direct local-daemon mode.

Debug-only fields:
- `agent-run-id`
- `envelope-id`
- `trigger-envelope-id`
- `input-tokens`
- `output-tokens`
- `cache-read-tokens`
- `cache-write-tokens`
- `total-tokens`

Output (human-oriented):
- Managed mode success:
  - Runtime-manager output (docker/pm2)
  - `Managed daemon action 'start' applied via <mode>.`
- Direct mode success:
  - `Daemon started successfully`
  - `Log file: <path>`
- Startup failure (when available):
  - `error: <startup-failure-details>` (value may be multi-line; incomplete-setup guidance is emitted as a single multi-line `error:` payload)
  - `log-file: <path>` (shown for general startup failures; omitted for incomplete-setup guidance)

Validation and fail-fast checks:
- Setup must be complete.
- If setup integrity is missing, daemon start fails with concise CLI guidance:
  - `Daemon start blocked: setup is incomplete.`
  - `1. open {{HIBOSS_DIR}}/settings.json`
  - `2. ensure required settings fields and agent entries are valid`
  - `3. restart daemon: hiboss daemon start`

## `hiboss daemon stop`

Stop mode selection:
- If `runtime.deployment.mode` is configured, delegates stop to runtime manager.
- Otherwise, stops the local daemon process (SIGTERM, then SIGKILL fallback).

Output (human-oriented):
- Managed mode:
  - Runtime-manager output (docker/pm2)
  - `Managed daemon action 'stop' applied via <mode>.`
- Direct mode:
  - `Daemon stopped` (or `Daemon forcefully stopped`)

## `hiboss daemon status`

Status mode selection:
- If `runtime.deployment.mode` is configured, delegates status to runtime manager.
- Otherwise, prints direct local daemon status keys.

Output:
- Managed mode:
  - Runtime-manager status output (`docker compose ps` or `pm2 describe`)
- Direct mode (parseable keys):
  - `running: true|false`
  - `start-time: <boss-iso-with-offset>|(none)`
  - `adapters: <csv>|(none)`
  - `data-dir: <path>`

Meaning of `data-dir`:
- The daemon’s root directory (default `~/hiboss/`, override via `HIBOSS_DIR`).
- Internal daemon files are stored under `{{data-dir}}/.daemon/` (DB/socket/PID/logs).
- User-facing files are stored under `{{data-dir}}/` (agents, media, BOSS.md).

Default permission:
- `admin`
