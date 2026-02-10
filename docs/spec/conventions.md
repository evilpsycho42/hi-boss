# Conventions (Canonical)

This document defines cross-cutting conventions used across the CLI, stored records, and agent-facing prompt rendering.

## Naming (parsing safety)

| Context | Convention | Example |
|---|---|---|
| TypeScript fields | camelCase | `envelope.fromBoss` |
| SQLite columns | snake_case | `from_boss` |
| CLI flags | kebab-case | `--deliver-at` |
| CLI output keys | kebab-case + `:` | `created-at:` |
| Agent instruction keys | kebab-case | `from-boss` |

Canonical mappings live in `docs/spec/definitions.md`.

## Boss marker

When `envelope.fromBoss` is true, rendered sender lines include the `[boss]` suffix.

Rendered `sender:` values (channel envelopes only):
- Group: `sender: <author> [boss] in group "<name>"`
- Direct: `sender: <author> [boss] in private chat`

No `from-boss:` output key is printed in envelope instructions; the boss signal is the `[boss]` suffix.

## Short IDs

All user/agent-visible UUID-backed IDs are rendered as **short IDs** by default:

- short id = first 8 lowercase hex characters of the UUID with hyphens removed
- full UUIDs (hyphens optional) are accepted as input anywhere an `--id` flag exists

Implementation helpers:
- `src/shared/id-format.ts` (`formatShortId`, `normalizeIdPrefixInput`)

