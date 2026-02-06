# Changelog

All notable changes to this project are documented in this file.

This project uses date-based npm versions (see `AGENTS.md`).

## [Unreleased]

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
