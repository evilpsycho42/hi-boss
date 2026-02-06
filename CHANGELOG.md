# Changelog

All notable changes to this project are documented in this file.

This project uses date-based npm versions (see `AGENTS.md`).

## [Unreleased]

## [2026.2.6-rev.3] - 2026-02-06

### Added
- Boss-only `hiboss agent abort` CLI command and `agent.abort` RPC method to cancel an in-flight run and clear due pending non-cron inbox items.
- Telegram boss command `/abort` mapped to the bound agent abort flow.

### Changed
- Agent runs now support a terminal `cancelled` status in storage and status surfaces.
- Session bootstrap logic extracted from the executor into `src/agent/executor-session.ts`.

### Docs
- Updated CLI, IPC, configuration, agent component, definitions, and Telegram adapter specs for abort behavior and cancelled-run semantics.

## [2026.2.6-rev.3-rc.1] - 2026-02-06

### Added
- Boss-only `hiboss agent abort` CLI command and `agent.abort` RPC method to cancel an in-flight run and clear due pending non-cron inbox items.
- Telegram boss command `/abort` mapped to the bound agent abort flow.

### Changed
- Agent runs now support a terminal `cancelled` status in storage and status surfaces.
- Session bootstrap logic extracted from the executor into `src/agent/executor-session.ts`.

### Docs
- Updated CLI, IPC, configuration, agent component, definitions, and Telegram adapter specs for abort behavior and cancelled-run semantics.

## [2026.2.6-rev.2] - 2026-02-06

### Changed
- Setup wizard provider selection now uses an arrow-key selector instead of free-text input.
- Setup wizard agent description now pre-fills the default value for inline editing instead of showing it in the prompt label.
- Setup wizard default auto-level changed from "medium" to "high".

## [2026.2.6-rev.1] - 2026-02-06

### Added
- Built-in/global/provider-private skill sync on new session creation, with precedence: provider-private > global > built-in.
- Built-in `agent-browser` skill package content under `skills/.system/agent-browser`.
- Built-in source tracking in codebase via `docs/spec/skills/builtin-sources.json`.
- User-facing README skills guide for built-in/global/private skills and precedence.

### Changed
- Session creation now syncs managed skills before instruction file generation.
- Package publishing now includes `skills/` so built-ins are available from npm artifacts.
- Provider home setup now ensures provider state directories for managed skill metadata.

### Fixed
- Claude `auto-level=medium` sandbox now allows IPC socket access by scoping `additionalDirs` to the daemon directory (`~/hiboss/.daemon/`) instead of the entire hiboss root, so the shallow socket scanner discovers `daemon.sock`.
- `defaults:check` now validates `agents.reasoning_effort` as a nullable column (no SQL default), matching runtime behavior where omitted reasoning effort stores `NULL` (provider default).
- Scheduler orphan-envelope cleanup now queues follow-up ticks when the per-tick cleanup cap is reached, preventing leftover due orphan envelopes from remaining pending indefinitely.

### Docs
- Updated configuration docs to reflect `agents.reasoning_effort` default as `NULL`.
- Updated scheduler docs to describe orphan cleanup batching/cap and follow-up tick behavior.
- Updated `Agent` interface docs to require `provider`.

## [2026.2.6-rc.1] - 2026-02-06

### Added
- Built-in/global/provider-private skill sync on new session creation, with precedence: provider-private > global > built-in.
- Built-in `agent-browser` skill package content under `skills/.system/agent-browser`.
- Built-in source tracking in codebase via `docs/spec/skills/builtin-sources.json`.
- User-facing README skills guide for built-in/global/private skills and precedence.

### Changed
- Session creation now syncs managed skills before instruction file generation.
- Package publishing now includes `skills/` so built-ins are available from npm artifacts.
- Provider home setup now ensures provider state directories for managed skill metadata.

### Fixed
- `defaults:check` now validates `agents.reasoning_effort` as a nullable column (no SQL default), matching runtime behavior where omitted reasoning effort stores `NULL` (provider default).
- Scheduler orphan-envelope cleanup now queues follow-up ticks when the per-tick cleanup cap is reached, preventing leftover due orphan envelopes from remaining pending indefinitely.

### Docs
- Updated configuration docs to reflect `agents.reasoning_effort` default as `NULL`.
- Updated scheduler docs to describe orphan cleanup batching/cap and follow-up tick behavior.
- Updated `Agent` interface docs to require `provider`.

## [2026.2.5-rev.1-rc.1] - 2026-02-05

### Added
- Documented npm versioning + publishing routine in `AGENTS.md`.
- Added `CHANGELOG.md`.
- Added a version suggestion helper (`npm run version:suggest`).

## [2026.2.5] - 2026-02-05

### Notes
- Existing stable release prior to adopting `CHANGELOG.md`.
