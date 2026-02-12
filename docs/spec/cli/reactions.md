# CLI: Reactions

This document specifies `hiboss reaction ...`.

## `hiboss reaction set`

Sets a reaction (emoji) on a channel message.

Flags:
- `--envelope-id <id>` (required; envelope id of the channel message to react to; short id, longer prefix, or full UUID)
- `--emoji <emoji>` (required; unicode emoji)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Example:

```bash
hiboss reaction set --envelope-id <envelope-id> --emoji "👍"
```

Output (parseable):
- `success: true|false`

Default permission:
- `restricted`
