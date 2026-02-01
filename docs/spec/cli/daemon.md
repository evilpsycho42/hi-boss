# CLI: Daemon

This document specifies `hiboss daemon ...`.

## `hiboss daemon start`

Starts the local daemon process in the background.

Flags:
- `--debug` enables verbose logs for inbound/outbound messages

Output (human-oriented):
- `Daemon started successfully`
- `Log file: <path>`

## `hiboss daemon stop`

Stops the daemon process (SIGTERM, then SIGKILL fallback).

Output (human-oriented):
- `Daemon stopped` (or `Daemon forcefully stopped`)

## `hiboss daemon status`

Shows daemon status as parseable keys:

- `running: true|false`
- `start-time: <iso>|(none)`
- `debug: enabled|disabled`
- `adapters: <csv>|(none)`
- `data-dir: <path>`

Meaning of `data-dir`:
- The daemon’s state directory (where it stores `hiboss.db`, `daemon.sock`, `daemon.pid`, `daemon.log`, `media/`, and per-agent homes).
- In the current implementation this is always the default `~/.hiboss/` (there is no `--data-dir` flag).

Default permission:
- `boss`
