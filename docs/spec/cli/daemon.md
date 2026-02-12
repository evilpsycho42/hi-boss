# CLI: Daemon

This document specifies `hiboss daemon ...`.

## `hiboss daemon start`

Starts the local daemon process in the background.

Log behavior:
- If `~/hiboss/.daemon/daemon.log` exists and is non-empty, it is moved to `~/hiboss/.daemon/log_history/` with a timestamped suffix.
- A new empty `~/hiboss/.daemon/daemon.log` is created for the new daemon process.

Flags:
- `--debug`: Include debug-only fields in `daemon.log` (IDs + token usage).

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
- Success:
  - `Daemon started successfully`
  - `Log file: <path>`
- Startup failure (when available):
  - `error: <startup-failure-details>` (value may be multi-line; incomplete-setup guidance is emitted as a single multi-line `error:` payload)
  - `log-file: <path>` (shown for general startup failures; omitted for incomplete-setup guidance)

Validation and fail-fast checks:
- Setup must be complete.
- Daemon requires role coverage: at least `1 speaker` and `1 leader`.
- Every `speaker` must have at least one adapter binding.
- Duplicate speaker adapter-token bindings block startup until repaired.
- On startup, daemon backfills missing/invalid `metadata.role` for legacy agents using bindings (`>=1` binding => speaker, none => leader), then persists it.
- If role coverage/integrity is missing, daemon start fails with concise CLI guidance:
  - `Daemon start blocked: setup is incomplete.`
  - `1. hiboss setup export`
  - `2. edit the exported JSON config`
  - `3. hiboss setup --config-file <path> --token <boss-token> --dry-run`
  - `4. hiboss setup --config-file <path> --token <boss-token>`

## `hiboss daemon stop`

Stops the daemon process (SIGTERM, then SIGKILL fallback).

Output (human-oriented):
- `Daemon stopped` (or `Daemon forcefully stopped`)

## `hiboss daemon status`

Shows daemon status as parseable keys:

- `running: true|false`
- `start-time: <boss-iso-with-offset>|(none)`
- `adapters: <csv>|(none)`
- `data-dir: <path>`

Meaning of `data-dir`:
- The daemon’s root directory (default `~/hiboss/`, override via `HIBOSS_DIR`).
- Internal daemon files are stored under `{{data-dir}}/.daemon/` (DB/socket/logs/models/memory).
- User-facing files are stored under `{{data-dir}}/` (agents, media, BOSS.md).

Default permission:
- `boss`
