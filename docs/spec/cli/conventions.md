# CLI Conventions (Canonical)

This document is shared by all `docs/spec/cli/*.md` topic specs.

## Token resolution

- Most commands accept `--token`.
- If omitted, the CLI uses `HIBOSS_TOKEN`.
- Boss tokens cannot perform agent-token operations like `hiboss envelope send` / `hiboss envelope list`.

## Clearing nullable overrides

Some agent settings are nullable (e.g., `model`, `reasoning-effort`). When cleared, Hi-Boss omits these overrides when opening provider sessions so provider defaults apply.

To clear via CLI, use the sentinel value `default`, for example:
- `hiboss agent set --name <agent> --model default`
- `hiboss agent set --name <agent> --reasoning-effort default`

## Output stability

- Most operational commands print parseable `key: value` lines with kebab-case keys.
- Envelope instruction keys are specified in `docs/spec/definitions.md`.

## IDs (short ids + prefix input)

- UUID-backed IDs are printed as short IDs by default (see `docs/spec/conventions.md`).
- Where a command accepts `--id`, input may be:
  - the short id, or
  - any longer prefix, or
  - the full UUID (hyphens optional)
- If a prefix matches multiple records, the CLI exits non-zero and prints an `error: ambiguous-id-prefix` block with `candidate-*` lines.

## Provider homes

- Provider CLI state is shared across all agents (no per-agent provider homes).
- Hi-Boss always uses the user’s shared default homes:
  - Claude: `~/.claude`
  - Codex: `~/.codex`
- When spawning provider processes, Hi-Boss clears `CLAUDE_CONFIG_DIR` and `CODEX_HOME` so overrides do not change behavior.
- Hi-Boss does not create per-agent provider homes or copy/import provider config files.
- `--provider-source-home <path>` is accepted for backwards compatibility but is currently a no-op (validation only).
